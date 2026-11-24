// Finds the source element for what was clicked in the preview, then applies structural edits.
import fs from 'node:fs';
import path from 'node:path';
import { locateFrame, locateFramesViaNext } from './locate.js';
import { DEV_PORT } from './site-runner.js';
import { listSourceFiles } from './source-edit.js';
import { allElements, children, deleteElement, duplicateElement, elementAt, moveElement, openTag, setStyles } from './markup.js';

const indexOf = (src, line, column) => src.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column;

/** How well a source element matches the clicked DOM element. */
function score(src, el, dom) {
    const open = src.slice(el.start, openTag(src, el.start).end);
    const cls = /\sclassName="([^"]*)"/.exec(open)?.[1];
    let s = 0;
    if (dom.className && cls === dom.className) s += 3;
    if (el.name === dom.tag) s += 1;
    if (dom.text && dom.text.length < 80 && src.slice(el.start, el.end).includes(dom.text)) s += 1;
    return s;
}

/** True when the element sits inside a {...} expression (e.g. a .map over a list), so it repeats. */
function isRepeated(src, el) {
    const parent = allElements(src).filter((p) => p.start < el.start && el.end <= p.end).sort((a, b) => b.start - a.start)[0];
    if (!parent) return false; // the component's top element
    const outer = openTag(src, parent.start).end;
    let depth = 0;
    for (let i = outer; i < el.start; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
    }
    return depth > 0;
}

/**
 * target = { fibers: [{stack, host}], tag, className, text, domPath } from the preview script.
 * Returns { file, el, repeated } or throws a message for the user.
 */
export async function locate(root, kind, target) {
    if (kind === 'static') {
        const file = target.page && target.page !== '/' ? target.page.replace(/^\//, '').replace(/\/$/, '/index') : 'index';
        const rel = [`${file}.html`, file].find((f) => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile());
        if (!rel) throw new Error('找不到这个页面的文件');
        const src = fs.readFileSync(path.join(root, rel), 'utf8');
        let el = allElements(src, true).find((e) => e.name.toLowerCase() === 'body');
        for (const i of target.domPath ?? []) {
            el = children(src, el, true)[i];
            if (!el) throw new Error('网页和文件对不上，请刷新后再试');
        }
        return { file: rel, el, repeated: false };
    }
    const fibers = target.fibers ?? [];
    const viaNext = await locateFramesViaNext(root, fibers.map((f) => f.stack ?? ''), DEV_PORT);
    for (let i = 0; i < fibers.length; i++) {
        const loc = viaNext[i] ?? locateFrame(root, fibers[i].stack ?? '');
        if (!loc) continue;
        const src = fs.readFileSync(path.join(root, loc.file), 'utf8');
        let at = indexOf(src, loc.line, loc.column);
        if (src[at] !== '<') at = src.indexOf('<', at);
        const hit = elementAt(src, at);
        if (!hit) continue;
        // The clicked element itself was located.
        if (i === 0) return { file: loc.file, el: hit, repeated: isRepeated(src, hit) };
        // Only an ancestor was located (e.g. the element came from a library component): pick the best match inside it.
        const inside = allElements(src).filter((e) => e.start >= hit.start && e.end <= hit.end);
        const ranked = inside.map((e) => ({ e, s: score(src, e, target) })).sort((a, b) => b.s - a.s);
        if (ranked[0]?.s >= 2 && ranked[0].s > (ranked[1]?.s ?? -1)) {
            return { file: loc.file, el: ranked[0].e, repeated: isRepeated(src, ranked[0].e) };
        }
        break;
    }
    // Last resort: an element anywhere in the site with exactly this class list (e.g. inside a server component).
    if (target.className) {
        const found = [];
        for (const abs of listSourceFiles(root).filter((f) => /\.(tsx|jsx)$/.test(f))) {
            const src = fs.readFileSync(abs, 'utf8');
            for (const e of allElements(src)) if (score(src, e, target) >= 3) found.push({ file: path.relative(root, abs), src, e, s: score(src, e, target) });
        }
        found.sort((a, b) => b.s - a.s);
        if (found.length && (found.length === 1 || found[0].s > found[1].s)) {
            return { file: found[0].file, el: found[0].e, repeated: isRepeated(found[0].src, found[0].e) };
        }
    }
    throw new Error('这个部分是程序生成的，没法直接在这里改。');
}

/** Applies one edit to the located element. Returns { file, before } for undo. */
export async function editElement(root, kind, target, op, styles) {
    const { file, el } = await locate(root, kind, target);
    const abs = path.join(root, file);
    const before = fs.readFileSync(abs, 'utf8');
    const html = kind === 'static';
    let after;
    if (op === 'delete') after = deleteElement(before, el);
    else if (op === 'duplicate') after = duplicateElement(before, el);
    else if (op === 'up' || op === 'down') {
        after = moveElement(before, el, op === 'up' ? -1 : 1, html);
        if (after === null) throw new Error(op === 'up' ? '已经在最上面了' : '已经在最下面了');
    } else if (op === 'style') {
        try {
            after = setStyles(before, el, styles ?? {}, html);
        } catch {
            throw new Error('这个部分的样式写法比较复杂，暂时不能在这里改');
        }
    } else throw new Error('不认识的操作');
    fs.writeFileSync(abs, after);
    return { file, before };
}
