// Site-wide design values: CSS custom properties declared in :root (or Tailwind's @theme) blocks.
import fs from 'node:fs';
import path from 'node:path';
import { listSourceFiles } from './source-edit.js';

const BLOCK = /(?:^|[}\s])(:root|html|@theme(?:\s+inline)?)\s*\{([^{}]*)\}/g;
const DECL = /(--[\w-]+)\s*:\s*([^;{}]+?)\s*(?=;|$)/g;

const kindOf = (name, value) => {
    if (/^#[0-9a-f]{3,8}$/i.test(value) || /^(rgb|hsl|oklch)a?\(/i.test(value)) return 'color';
    if (/font/i.test(name) && !/size|weight/i.test(name)) return 'font';
    if (/^-?[\d.]+(px|rem|em|%)$/.test(value)) return 'size';
    return 'other';
};

/** Variables in one CSS source: [{ name, value, start, end, kind }] (start/end = the value's range). */
export function varsIn(src) {
    const out = [];
    for (const b of src.matchAll(BLOCK)) {
        const bodyStart = b.index + b[0].length - b[2].length - 1;
        for (const d of b[2].matchAll(DECL)) {
            const start = bodyStart + d.index + d[0].indexOf(d[2], d[1].length);
            out.push({ name: d[1], value: d[2], start, end: start + d[2].length, kind: kindOf(d[1], d[2]) });
        }
    }
    return out;
}

export function listVars(root) {
    const out = [];
    for (const abs of listSourceFiles(root, new Set(['.css', '.scss']))) {
        const src = fs.readFileSync(abs, 'utf8');
        for (const v of varsIn(src)) out.push({ file: path.relative(root, abs), ...v });
    }
    return out;
}

/** Changes one variable's value. `old` must still match. Returns { file, before } for undo. */
export function setVar(root, { file, name, old, value }) {
    const abs = path.resolve(root, String(file));
    if (!abs.startsWith(root + path.sep) || !/\.(css|scss)$/.test(abs) || !fs.existsSync(abs)) throw new Error('找不到这个样式文件');
    value = String(value ?? '').trim();
    if (!value || /[;{}<>]/.test(value)) throw new Error('这个值不能用');
    const before = fs.readFileSync(abs, 'utf8');
    const v = varsIn(before).find((x) => x.name === name && x.value === old);
    if (!v) throw new Error('文件已经变了，请重新打开全站设置');
    fs.writeFileSync(abs, before.slice(0, v.start) + value + before.slice(v.end));
    return { file: path.relative(root, abs), before };
}
