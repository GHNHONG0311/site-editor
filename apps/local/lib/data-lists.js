// Finds lists of records written in the site's code (e.g. `export const PRODUCTS = [{ name: 'A', price: 5 }, ...]`)
// so they can be edited as a table, and edits single cells / rows in place without touching anything else.
import fs from 'node:fs';
import path from 'node:path';
import { listSourceFiles } from './source-edit.js';

const SIMPLE = new Set(['string', 'number', 'literal']);
const ID = /[A-Za-z_$][\w$]*/y;

function skipWs(src, i) {
    for (;;) {
        while (/\s/.test(src[i] ?? '')) i++;
        if (src.startsWith('//', i)) i = (src.indexOf('\n', i) + 1) || src.length;
        else if (src.startsWith('/*', i)) i = src.indexOf('*/', i) + 2 || src.length;
        else return i;
    }
}

function stringEnd(src, i) {
    const q = src[i];
    for (i++; i < src.length; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === q) return i + 1;
        else if (q !== '`' && src[i] === '\n') break;
    }
    throw new Error('bad string');
}

/** Skips an expression we do not edit (identifier, call, JSX...) up to the next , ] } ) or ; at depth 0. */
function skipOther(src, i) {
    let depth = 0;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') i = stringEnd(src, i) - 1;
        else if (src.startsWith('//', i) || src.startsWith('/*', i)) i = skipWs(src, i) - 1;
        else if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) {
            if (depth === 0) return i;
            depth--;
        } else if ((c === ',' || c === ';') && depth === 0) return i;
    }
    return i;
}

function decode(raw) {
    return raw.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, e) => {
        if (e[0] === 'u' || e[0] === 'x') return String.fromCodePoint(parseInt(e.replace(/[ux{}]/g, ''), 16));
        return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' }[e] ?? e;
    });
}

function parseValue(src, i) {
    i = skipWs(src, i);
    const c = src[i];
    if (c === '{') return parseObject(src, i);
    if (c === '[') return parseArray(src, i);
    if (c === '"' || c === "'" || c === '`') {
        const end = stringEnd(src, i);
        const raw = src.slice(i, end);
        if (c === '`' && raw.includes('${')) return { type: 'other', start: i, end };
        return { type: 'string', start: i, end, value: decode(raw), quote: c };
    }
    const num = /-?(\d[\d_]*\.?\d*|\.\d+)(e[+-]?\d+)?/iy;
    num.lastIndex = i;
    let m = num.exec(src);
    if (m && !/[\w$]/.test(src[i + m[0].length] ?? '')) return { type: 'number', start: i, end: i + m[0].length, value: Number(m[0].replace(/_/g, '')) };
    const word = /(null|true|false|undefined)(?![\w$])/y;
    word.lastIndex = i;
    if ((m = word.exec(src))) return { type: 'literal', start: i, end: i + m[0].length, value: m[1] };
    const end = skipOther(src, i);
    if (end === i) throw new Error('empty value');
    return { type: 'other', start: i, end };
}

function parseObject(src, start) {
    const props = new Map();
    let i = skipWs(src, start + 1);
    while (src[i] !== '}') {
        let key;
        if (src.startsWith('...', i)) {
            i = skipOther(src, i);
        } else {
            if (src[i] === '"' || src[i] === "'") {
                const end = stringEnd(src, i);
                key = decode(src.slice(i, end));
                i = end;
            } else {
                ID.lastIndex = i;
                const m = ID.exec(src) ?? /\d+/y.exec(src);
                if (!m) throw new Error('bad key');
                key = m[0];
                i += m[0].length;
            }
            i = skipWs(src, i);
            if (src[i] === ':') {
                const v = parseValue(src, i + 1);
                props.set(key, v);
                i = v.end;
            } else if (src[i] !== ',' && src[i] !== '}') throw new Error('unsupported property');
        }
        i = skipWs(src, i);
        if (src[i] === ',') i = skipWs(src, i + 1);
        else if (src[i] !== '}') throw new Error('expected , or }');
    }
    return { type: 'object', start, end: i + 1, props };
}

function parseArray(src, start) {
    const items = [];
    let i = skipWs(src, start + 1);
    while (src[i] !== ']') {
        const v = parseValue(src, i);
        items.push(v);
        i = skipWs(src, v.end);
        if (src[i] === ',') i = skipWs(src, i + 1);
        else if (src[i] !== ']') throw new Error('expected , or ]');
    }
    return { type: 'array', start, end: i + 1, items };
}

/** Top-level values worth looking at: `const X = ...`, `export default ...`, or a whole JSON file. */
function roots(src, json) {
    if (json) return [{ name: '', node: parseValue(src, 0) }];
    const out = [];
    const decl = /(?:^|[\s;])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)|export\s+default\s+(?=[[{])/g;
    for (let m; (m = decl.exec(src)); ) {
        let i = m.index + m[0].length;
        if (m[1]) {
            // Skip a type annotation up to the `=` (not `=>`).
            let depth = 0;
            for (; i < src.length; i++) {
                const c = src[i];
                if ('([{<'.includes(c)) depth++;
                else if (')]}>'.includes(c) && src[i - 1] !== '=') depth--;
                else if (c === '=' && depth === 0 && src[i + 1] !== '>' && src[i + 1] !== '=') break;
                else if (c === ';' && depth === 0) {
                    i = -1;
                    break;
                }
            }
            if (i < 0 || i >= src.length) continue;
            i++;
        }
        try {
            out.push({ name: m[1] ?? 'default', node: parseValue(src, i) });
        } catch {
            // not a literal we understand
        }
    }
    return out;
}

const NAME_KEYS = ['zh', 'nameZh', 'name', 'title', 'label', 'en', 'id', 'slug'];
const rowName = (obj) => {
    for (const k of NAME_KEYS) if (obj.props.get(k)?.type === 'string') return obj.props.get(k).value;
    return null;
};

/** A table row: an object literal, or a short list of plain values like ['/', 'Home'] (columns 1, 2, ...). */
function asRow(n) {
    if (n.type === 'object') return n;
    if (n.type === 'array' && n.items.length >= 2 && n.items.every((x) => SIMPLE.has(x.type))) {
        return { ...n, type: 'object', tuple: true, props: new Map(n.items.map((x, i) => [String(i + 1), x])) };
    }
    return null;
}

/** Every array of rows in the tree, with a readable label. */
function collect(node, label, out) {
    if (node.type === 'array') {
        const rows = node.items.map(asRow);
        if (rows.length && rows.every(Boolean)) out.push({ label, node, rows });
        node.items.forEach((n, i) => collect(n, n.type === 'object' ? `${label} › ${rowName(n) ?? i + 1}` : label, out));
    } else if (node.type === 'object') {
        for (const [k, v] of node.props) collect(v, `${label} › ${k}`, out);
    }
}

/** Tables in one file's source. */
export function tablesIn(src, json = false) {
    const found = [];
    for (const { name, node } of roots(src, json)) collect(node, name, found);
    const tables = [];
    for (const { label, node, rows: rowNodes } of found) {
        const columns = [];
        const types = {};
        for (const row of rowNodes) {
            for (const [k, v] of row.props) {
                if (!SIMPLE.has(v.type)) continue;
                if (!columns.includes(k)) columns.push(k);
                if (v.type === 'number' || v.type === 'string') types[k] = types[k] === 'string' ? 'string' : v.type;
                else if (v.value === 'true' || v.value === 'false') types[k] ??= 'boolean';
            }
        }
        if (!columns.some((k) => types[k] === 'string')) continue;
        const rows = rowNodes.map((row) => ({
            start: row.start,
            cells: Object.fromEntries(columns.filter((k) => SIMPLE.has(row.props.get(k)?.type)).map((k) => {
                const v = row.props.get(k);
                return [k, v.type === 'literal' ? (v.value === 'null' || v.value === 'undefined' ? '' : v.value) : String(v.value)];
            })),
        }));
        tables.push({ label: label.replace(/^ › /, ''), start: node.start, columns, types, rows, tuple: !!rowNodes[0].tuple });
    }
    return tables;
}

const isData = (f) => /\.(m?[jt]sx?|json)$/.test(f) && !/\.d\.ts$|(^|[\\/])(package(-lock)?|tsconfig|components|vercel)\.json$/.test(f);

/** All editable tables in the site. */
export function listTables(root) {
    const out = [];
    for (const abs of listSourceFiles(root).filter(isData)) {
        const src = fs.readFileSync(abs, 'utf8');
        if (!src.includes('{')) continue;
        try {
            for (const t of tablesIn(src, abs.endsWith('.json'))) out.push({ file: path.relative(root, abs), ...t });
        } catch {
            // a file we cannot read as data
        }
    }
    return out;
}

function encode(text, quote) {
    let s = text.replace(/\\/g, '\\\\').split(quote).join('\\' + quote);
    if (quote === '`') return '`' + s.replace(/\$\{/g, '\\${') + '`';
    return quote + s.replace(/\n/g, '\\n').replace(/\r/g, '') + quote;
}

/** The literal to write for a cell, keeping numbers as numbers. Throws a message for the user. */
function literal(text, kind, quote, json) {
    if (kind === 'boolean') {
        const t = text.trim();
        if (t === 'true' || t === 'false') return t;
        throw new Error('这一格只能是 true 或 false');
    }
    if (kind === 'number') {
        const t = text.trim();
        if (t === '') return 'null';
        if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error('这一格只能填数字（不填就留空）');
        return t;
    }
    return encode(text, json ? '"' : quote);
}

/** Re-finds a table/row in the current file so edits never land somewhere else. */
function findRow(src, json, tableStart, rowStart) {
    const t = tablesIn(src, json).find((x) => x.start === tableStart);
    let arr = null;
    const visit = (n) => {
        if (arr) return;
        if (n.type === 'array' && n.start === tableStart) arr = n;
        else if (n.type === 'array') n.items.forEach(visit);
        else if (n.type === 'object') [...n.props.values()].forEach(visit);
    };
    if (t) roots(src, json).forEach((r) => visit(r.node));
    const index = arr ? arr.items.findIndex((r) => r.start === rowStart) : -1;
    if (index < 0) throw new Error('文件已经变了，请重新打开资料表格');
    return { table: t, arr, index, row: asRow(arr.items[index]) };
}

/**
 * One edit to a table. op: 'set' (row, key, value), 'duplicate' (row), 'delete' (row).
 * Returns { file, before } for undo.
 */
export function editTable(root, { file, table, row, op, key, value }) {
    const abs = path.resolve(root, String(file));
    if (!abs.startsWith(root + path.sep) || !isData(abs) || !fs.existsSync(abs)) throw new Error('找不到这个资料文件');
    const before = fs.readFileSync(abs, 'utf8');
    const json = abs.endsWith('.json');
    const { table: t, arr, index, row: obj } = findRow(before, json, table, row);
    let after;
    if (op === 'set') {
        if (!t.columns.includes(key)) throw new Error('不认识的栏目');
        const cell = obj.props.get(key);
        const kind = cell?.type === 'string' ? 'string' : t.types[key] ?? (cell?.type === 'literal' ? 'number' : 'string');
        const quote = arr.items.map(asRow).flatMap((r) => [...r.props.values()]).find((v) => v.type === 'string')?.quote ?? "'";
        const lit = literal(String(value ?? ''), kind, cell?.type === 'string' ? cell.quote : quote, json);
        if (cell) {
            if (obj.tuple && lit === 'null' && cell.type !== 'literal') throw new Error('这一格不能留空');
            after = before.slice(0, cell.start) + lit + before.slice(cell.end);
        } else {
            if (obj.tuple) throw new Error('这一格不能改');
            // Add the property before the closing brace.
            const close = obj.end - 1;
            let j = close - 1;
            while (/\s/.test(before[j])) j--;
            const name = json || !/^[A-Za-z_$][\w$]*$/.test(key) ? JSON.stringify(key) : key;
            const sep = before[j] === ',' || before[j] === '{' ? ' ' : ', ';
            after = before.slice(0, j + 1) + `${sep}${name}: ${lit}` + (before[j] === '{' ? ' ' : '') + before.slice(j + 1);
        }
    } else if (op === 'duplicate') {
        const text = before.slice(obj.start, obj.end);
        const lineStart = before.lastIndexOf('\n', obj.start) + 1;
        const indent = before.slice(lineStart, obj.start);
        const ownLine = /^\s*$/.test(indent);
        after = before.slice(0, obj.end) + (ownLine ? `,\n${indent}` : ', ') + text + before.slice(obj.end);
    } else if (op === 'delete') {
        let from = obj.start;
        let to = obj.end;
        const next = skipWs(before, to);
        if (before[next] === ',') to = next + 1;
        else if (index > 0) from = arr.items[index - 1].end; // last item: drop the comma before it instead
        // When the row sits on its own lines, remove those lines whole (with a comment at the end of the line).
        const lineStart = before.lastIndexOf('\n', from - 1) + 1;
        const lineEnd = before.indexOf('\n', to);
        if (/^[ \t]*$/.test(before.slice(lineStart, from)) && lineEnd >= 0 && /^[ \t]*(\/\/.*)?$/.test(before.slice(to, lineEnd))) {
            from = lineStart;
            to = lineEnd + 1;
        }
        after = before.slice(0, from) + before.slice(to);
    } else throw new Error('不认识的操作');
    fs.writeFileSync(abs, after);
    return { file: path.relative(root, abs), before };
}
