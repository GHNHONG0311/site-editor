// Finds the source text behind what the user clicked and rewrites it in place.
// Works on any text file (JSX, TS data files, HTML), so no build plugin is needed.
import fs from 'node:fs';
import path from 'node:path';

const EXTS = new Set(['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mdx', '.md', '.json', '.html', '.htm']);
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', '.vercel', '.turbo']);
const ROOT_SKIP = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'next.config.js', 'next.config.mjs', 'next.config.ts']);

export function listSourceFiles(root, exts = EXTS) {
    const out = [];
    const walk = (dir, depth) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (depth < 8) walk(p, depth + 1);
            } else if (exts.has(path.extname(e.name)) && !(depth === 0 && (ROOT_SKIP.has(e.name) || e.name.endsWith('.md')))) {
                out.push(p);
            }
        }
    };
    walk(root, 0);
    return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text as shown in the page: any run of whitespace in the source may stand for one space. */
function textPattern(text) {
    const words = text.trim().split(/\s+/).map(escapeRe);
    return new RegExp(words.join('\\s+'), 'g');
}

/** Every place `text` occurs. `exact` skips whitespace folding (used for image paths). */
export function findMatches(root, text, { exact = false } = {}) {
    if (!text || !text.trim()) return [];
    const re = exact ? new RegExp(escapeRe(text), 'g') : textPattern(text);
    const matches = [];
    for (const file of listSourceFiles(root)) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(re)) {
            const line = src.slice(0, m.index).split('\n').length;
            const lineText = src.split('\n')[line - 1].trim();
            const prev = src.slice(0, m.index).trimEnd().at(-1);
            const next = src.slice(m.index + m[0].length).trimStart()[0];
            matches.push({
                file: path.relative(root, file),
                index: m.index,
                length: m[0].length,
                // The match is a whole string value or a whole piece of JSX/HTML text, not part of a longer one.
                whole: /["'`>}]/.test(prev ?? '') && /["'`<{]/.test(next ?? ''),
                line,
                snippet: lineText.length > 120 ? lineText.slice(0, 117) + '...' : lineText,
            });
        }
    }
    // Whole-value matches first: they are the likely meaning of what was clicked.
    return matches.sort((a, b) => b.whole - a.whole);
}

/** Escapes the replacement for where it sits: inside a quoted string, or as JSX/HTML text. */
export function escapeFor(src, index, value) {
    const before = src.slice(Math.max(0, index - 200), index);
    // An opening quote (not an apostrophe inside a word) with no closing one = inside a string literal.
    const quote = /(^|[^\p{L}\p{N}])(["'`])[^"'`\n]*$/u.exec(before);
    if (quote && !/[<>]/.test(before.slice(quote.index))) {
        const q = quote[2];
        return value.replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), '\\' + q).replace(/\n/g, '\\n');
    }
    return value.replace(/[{}<>]/g, (c) => `{'${c}'}`);
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Replaces the chosen matches. `choice` = index into `matches`, or 'all'.
 * Returns the list of {file, before} for undo.
 */
export function applyReplace(root, matches, choice, newText, { raw = false } = {}) {
    const picked = choice === 'all' ? matches : [matches[choice]];
    if (!picked.length || picked.some((m) => !m)) throw new Error('bad-choice');
    const byFile = new Map();
    for (const m of picked) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
    const undo = [];
    for (const [file, ms] of byFile) {
        const abs = path.join(root, file);
        const before = fs.readFileSync(abs, 'utf8');
        let src = before;
        const isHtml = /\.html?$/.test(file);
        const isMarkdown = /\.mdx?$/.test(file);
        // Replace from the end so earlier indexes stay valid.
        for (const m of [...ms].sort((a, b) => b.index - a.index)) {
            const value = raw || isMarkdown ? newText : isHtml ? escapeHtml(newText) : escapeFor(src, m.index, newText);
            src = src.slice(0, m.index) + value + src.slice(m.index + m.length);
        }
        fs.writeFileSync(abs, src);
        undo.push({ file, before });
    }
    return undo;
}
