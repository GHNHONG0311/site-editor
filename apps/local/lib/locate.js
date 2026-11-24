// Turns a React dev-mode stack frame (where a JSX element was created, in a compiled chunk)
// into the original source file + line + column, using the chunk's source map on disk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes a v3 `mappings` string into lines of [genCol, srcIdx, srcLine, srcCol] (all 0-based). */
export function decodeMappings(mappings) {
    const lines = [];
    let src = 0, sLine = 0, sCol = 0;
    for (const line of mappings.split(';')) {
        const segs = [];
        let gCol = 0;
        for (const seg of line.split(',')) {
            if (!seg) continue;
            const v = [];
            let shift = 0, value = 0;
            for (const ch of seg) {
                const d = B64.indexOf(ch);
                value += (d & 31) << shift;
                if (d & 32) shift += 5;
                else {
                    v.push(value & 1 ? -(value >> 1) : value >> 1);
                    shift = value = 0;
                }
            }
            gCol += v[0];
            if (v.length >= 4) {
                src += v[1];
                sLine += v[2];
                sCol += v[3];
                segs.push([gCol, src, sLine, sCol]);
            }
        }
        lines.push(segs);
    }
    return lines;
}

/** Original position for a generated one (line 1-based, column 0-based), in a plain or sectioned map. */
export function originalPosition(map, line, column) {
    if (map.sections) {
        let hit = null;
        for (const s of map.sections) {
            const { line: l, column: c } = s.offset;
            if (l + 1 < line || (l + 1 === line && c <= column)) hit = s;
        }
        if (!hit) return null;
        const l = line - hit.offset.line;
        return originalPosition(hit.map, l, l === 1 ? column - hit.offset.column : column);
    }
    map._decoded ??= decodeMappings(map.mappings);
    const segs = map._decoded[line - 1];
    if (!segs?.length) return null;
    let best = null;
    for (const s of segs) if (s[0] <= column) best = s;
    if (!best) return null;
    return { source: map.sources[best[1]], line: best[2] + 1, column: best[3] };
}

const mapCache = new Map();
function loadMap(file) {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) return null;
    const hit = mapCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.map;
    const map = JSON.parse(fs.readFileSync(file, 'utf8'));
    mapCache.set(file, { mtime: st.mtimeMs, map });
    return map;
}

/** The chunk file on disk for a stack-frame URL (server chunks are file:// URLs, client ones are served from .next). */
function chunkFile(root, url) {
    const u = url.replace(/^about:\/\/React\/Server\//, '').replace(/\?.*$/, '');
    if (u.startsWith('file://')) {
        // After a hot reload the URL comes double-encoded (%255B); decode until the file exists.
        let p = fileURLToPath(u);
        for (let i = 0; i < 2 && !fs.existsSync(p) && p.includes('%'); i++) p = decodeURIComponent(p);
        return p;
    }
    const m = /\/_next\/(static\/.+)$/.exec(u);
    return m ? path.join(root, '.next', 'dev', decodeURIComponent(m[1])) : null;
}

/** Turbopack and webpack name sources in several ways; return an absolute path inside the site, or null. */
function sourcePath(root, source) {
    let s = source.replace(/^turbopack:\/\/\/\[project\]\//, '').replace(/^webpack:\/\/[^/]*\//, '');
    if (s.startsWith('file://')) s = fileURLToPath(s);
    const abs = path.isAbsolute(s) ? s : path.join(root, s);
    if (!abs.startsWith(root) || abs.includes(`${path.sep}node_modules${path.sep}`) || abs.includes(`${path.sep}.next${path.sep}`)) return null;
    return fs.existsSync(abs) ? abs : null;
}

// After a hot reload the URL's query holds "(site)", "(ecmascript)" and a second "?", so take everything
// from the scheme up to the trailing :line:col instead of stopping at the first ")".
const FRAME = /((?:about:\/\/React\/Server\/)?(?:file|https?):\/\/.+?):(\d+):(\d+)\)?\s*$/;

/** Parses one stack line into [url, line, column], or null. */
export function parseFrame(line) {
    const m = FRAME.exec(line.trim());
    return m ? [m[1], Number(m[2]), Number(m[3])] : null;
}

/** First frame of a stack that maps into the site's own source files. */
export function locateFrame(root, stack) {
    for (const line of stack.split('\n')) {
        const m = parseFrame(line);
        if (!m) continue;
        const file = chunkFile(root, m[0]);
        const map = file && loadMap(file + '.map');
        if (!map) continue;
        const pos = originalPosition(map, m[1], m[2] - 1);
        const abs = pos && sourcePath(root, pos.source);
        if (abs) return { file: path.relative(root, abs), line: pos.line, column: pos.column };
    }
    return null;
}

/**
 * Asks the running Next dev server to resolve stack frames (it knows hot-reloaded module versions,
 * which the chunk files on disk no longer match). Returns one { file, line, column } or null per stack.
 */
export async function locateFramesViaNext(root, stacks, port) {
    const parsed = stacks.map((s) => s.split('\n').map(parseFrame).filter(Boolean));
    const out = stacks.map(() => null);
    for (const isServer of [true, false]) {
        const frames = [];
        parsed.forEach((list, i) => list.forEach(([file, line1, column1]) => {
            if (/^(about:|file:)/.test(file) === isServer) frames.push({ i, file, line1, column1 });
        }));
        if (!frames.length) continue;
        let res;
        try {
            const r = await fetch(`http://127.0.0.1:${port}/__nextjs_original-stack-frames`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ frames, isServer, isEdgeServer: false, isAppDirectory: true }),
                signal: AbortSignal.timeout(5000),
            });
            res = r.ok ? await r.json() : [];
        } catch {
            continue;
        }
        res.forEach((r, k) => {
            const f = r?.status === 'fulfilled' && r.value?.originalStackFrame;
            const { i } = frames[k];
            if (!f?.file || !f.line1 || out[i]) return;
            const abs = sourcePath(root, f.file);
            if (abs) out[i] = { file: path.relative(root, abs), line: f.line1, column: (f.column1 ?? 1) - 1 };
        });
    }
    return out;
}
