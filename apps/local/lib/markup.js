// A small scanner for JSX and HTML: finds where each element starts and ends in a source file,
// so the editor can delete, duplicate, move and restyle an element without a full parser.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const isWord = (c) => !!c && /[\p{L}\p{N}_$]/u.test(c);

/** Index just past a quoted string starting at i (quote char at src[i]). */
function skipString(src, i) {
    const q = src[i];
    for (i++; i < src.length; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === q) return i + 1;
        else if (q === '`' && src[i] === '$' && src[i + 1] === '{') i = skipBraces(src, i + 1) - 1;
    }
    return src.length;
}

/** Index just past a balanced {...} starting at i. JSX inside is skipped as a whole element. */
function skipBraces(src, i) {
    let depth = 0;
    for (; i < src.length; i++) {
        const c = src[i];
        if ((c === '"' || c === "'" || c === '`') && !isWord(src[i - 1])) i = skipString(src, i) - 1;
        else if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) - 1;
        else if (c === '/' && src[i + 1] === '*') i = src.indexOf('*/', i) + 1;
        else if (c === '<' && /[A-Za-z>]/.test(src[i + 1] || '') && !isWord(src[i - 1]) && src[i - 1] !== ')') {
            const end = elementEnd(src, i);
            if (end > 0) i = end - 1;
        } else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i + 1;
    }
    return src.length;
}

/** Parses the opening tag at `start`: its name, where it ends, whether it closes itself. */
export function openTag(src, start, html = false) {
    const m = /^<([A-Za-z][\w.:-]*)?/.exec(src.slice(start, start + 200));
    if (!m) return null;
    const name = m[1] ?? ''; // '' = fragment <>
    let i = start + m[0].length;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'") i = skipString(src, i) - 1;
        else if (c === '{' && !html) i = skipBraces(src, i) - 1;
        else if (c === '/' && src[i + 1] === '>') return { name, end: i + 2, selfClosing: true };
        else if (c === '>') return { name, end: i + 1, selfClosing: html && VOID.has(name.toLowerCase()) };
    }
    return null;
}

/** Index just past the element starting at `start` (a '<'), or -1 if it does not parse. */
export function elementEnd(src, start, html = false) {
    const tag = openTag(src, start, html);
    if (!tag) return -1;
    if (tag.selfClosing) return tag.end;
    let i = tag.end;
    while (i < src.length) {
        const c = src[i];
        if (c === '{' && !html) i = skipBraces(src, i);
        else if (html && src.startsWith('<!--', i)) i = src.indexOf('-->', i) + 3;
        else if (html && /^<(script|style)\b/i.test(src.slice(i, i + 8))) {
            const close = src.toLowerCase().indexOf(`</${src.slice(i + 1, i + 7).toLowerCase().startsWith('script') ? 'script' : 'style'}`, i);
            i = src.indexOf('>', close) + 1;
        } else if (c === '<' && src[i + 1] === '/') {
            const close = src.indexOf('>', i);
            if (close < 0) return -1;
            // HTML may leave a tag unclosed (<p>a<b>c</p>): a closing tag for another name ends this element just before it.
            if (html && src.slice(i + 2, close).trim().toLowerCase() !== tag.name.toLowerCase()) return i;
            return close + 1;
        } else if (c === '<' && /[A-Za-z>]/.test(src[i + 1] || '')) {
            const end = elementEnd(src, i, html);
            if (end < 0) return -1;
            i = end;
        } else i++;
    }
    return -1;
}

/** Every element in the file as {start, end, name}, outer before inner. */
export function allElements(src, html = false) {
    const out = [];
    const walk = (from, to) => {
        let i = from;
        while (i < to) {
            const c = src[i];
            if ((c === '"' || c === "'" || c === '`') && !html && !isWord(src[i - 1])) i = skipString(src, i);
            else if (c === '/' && src[i + 1] === '/' && !html) i = src.indexOf('\n', i) + 1 || to;
            else if (c === '/' && src[i + 1] === '*' && !html) i = src.indexOf('*/', i) + 2;
            else if (html && src.startsWith('<!--', i)) i = src.indexOf('-->', i) + 3;
            else if (c === '<' && /[A-Za-z>]/.test(src[i + 1] || '') && (html || !isWord(src[i - 1]))) {
                const end = elementEnd(src, i, html);
                const tag = end > 0 && openTag(src, i, html);
                if (!tag) {
                    i++;
                    continue;
                }
                out.push({ start: i, end, name: tag.name });
                walk(tag.end, end);
                i = end;
            } else i++;
        }
    };
    walk(0, src.length);
    return out;
}

/** The element starting at an exact index, or the innermost one containing it. */
export function elementAt(src, index, html = false) {
    let best = null;
    for (const el of allElements(src, html)) if (el.start <= index && index < el.end && (!best || el.start >= best.start)) best = el;
    return best;
}

const parentOf = (els, el) => els.filter((p) => p.start < el.start && el.end <= p.end).sort((a, b) => b.start - a.start)[0] ?? null;
const childrenOf = (els, parent) => els.filter((e) => e !== parent && parentOf(els, e) === parent);

/** Elements under `parent` in order (the top level when parent is null). */
export function children(src, parent, html = false) {
    const els = allElements(src, html);
    const p = parent && els.find((e) => e.start === parent.start);
    return childrenOf(els, p ?? null).sort((a, b) => a.start - b.start);
}

const lineStart = (src, i) => src.lastIndexOf('\n', i - 1) + 1;
const indentAt = (src, i) => /^[ \t]*/.exec(src.slice(lineStart(src, i)))[0];

export function deleteElement(src, el) {
    let s = el.start, e = el.end;
    // Remove the whole line when the element was alone on it.
    const ls = lineStart(src, s);
    const le = src.indexOf('\n', e);
    if (!src.slice(ls, s).trim() && !src.slice(e, le < 0 ? src.length : le).trim()) {
        s = ls;
        e = le < 0 ? src.length : le + 1;
    }
    return src.slice(0, s) + src.slice(e);
}

export function duplicateElement(src, el) {
    const copy = src.slice(el.start, el.end);
    return src.slice(0, el.end) + '\n' + indentAt(src, el.start) + copy + src.slice(el.end);
}

/** Swaps the element with its previous (-1) or next (+1) sibling. Returns null when there is none. */
export function moveElement(src, el, dir, html = false) {
    const els = allElements(src, html);
    const me = els.find((e) => e.start === el.start);
    const sibs = childrenOf(els, parentOf(els, me)).sort((a, b) => a.start - b.start);
    const i = sibs.indexOf(me);
    const other = sibs[i + dir];
    if (!other) return null;
    const [a, b] = dir < 0 ? [other, me] : [me, other];
    return src.slice(0, a.start) + src.slice(b.start, b.end) + src.slice(a.end, b.start) + src.slice(a.start, a.end) + src.slice(b.end);
}

const cssName = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const jsName = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * Sets inline styles on the element's opening tag, merging with a simple existing style.
 * `styles` = { color: '#123', fontSize: '20px' }; an empty value removes that property.
 */
export function setStyles(src, el, styles, html = false) {
    const tag = openTag(src, el.start, html);
    const open = src.slice(el.start, tag.end);
    const current = {};
    let attr = null;
    if (html) {
        attr = /\sstyle\s*=\s*"([^"]*)"/.exec(open);
        for (const decl of (attr?.[1] ?? '').split(';')) {
            const [k, ...v] = decl.split(':');
            if (k?.trim()) current[jsName(k.trim())] = v.join(':').trim();
        }
    } else {
        attr = /\sstyle=\{\{([^{}]*)\}\}/.exec(open);
        if (!attr && /\sstyle=/.test(open)) throw new Error('style-complex');
        for (const m of (attr?.[1] ?? '').matchAll(/([\w$]+)\s*:\s*(['"])(.*?)\2/g)) current[m[1]] = m[3];
        if (attr && attr[1].replace(/([\w$]+)\s*:\s*(['"])(.*?)\2\s*,?/g, '').trim()) throw new Error('style-complex');
    }
    for (const [k, v] of Object.entries(styles)) {
        if (v === '' || v == null) delete current[k];
        else current[k] = String(v);
    }
    const entries = Object.entries(current);
    const value = !entries.length
        ? ''
        : html
          ? ` style="${entries.map(([k, v]) => `${cssName(k)}: ${v.replace(/"/g, "'")}`).join('; ')}"`
          : ` style={{ ${entries.map(([k, v]) => `${k}: '${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')} }}`;
    let next;
    if (attr) next = open.slice(0, attr.index) + value + open.slice(attr.index + attr[0].length);
    else {
        // Insert right after the tag name.
        const nameEnd = 1 + tag.name.length;
        next = open.slice(0, nameEnd) + value + open.slice(nameEnd);
    }
    return src.slice(0, el.start) + next + src.slice(tag.end);
}
