// Runs inside the previewed website. Highlights what the mouse is over, reports clicks to the
// editor, and lets the user edit text in place (double-click). Talks to the editor via postMessage.
(() => {
    if (window.__siteEditor) return;
    window.__siteEditor = true;
    const parentWin = window.parent;
    if (parentWin === window) return; // opened directly, not inside the editor
    let mode = 'edit';
    let selected = null;
    let editing = null;

    const box = (color, style) => {
        const d = document.createElement('div');
        d.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;border:2px ${style} ${color};border-radius:3px;display:none;`;
        document.documentElement.appendChild(d);
        return d;
    };
    const hoverBox = box('#3b82f6', 'dashed');
    const selectBox = box('#2563eb', 'solid');

    const place = (b, el) => {
        if (!el || !el.isConnected) return (b.style.display = 'none');
        const r = el.getBoundingClientRect();
        Object.assign(b.style, { display: 'block', left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 4 + 'px', height: r.height + 4 + 'px' });
    };

    const isOurs = (el) => el === hoverBox || el === selectBox;
    const textOnly = (el) => [...el.childNodes].every((n) => n.nodeType === 3 || n.nodeName === 'BR') && el.textContent.trim() !== '';

    /** The image path as written in the source: next/image wraps it in /_next/image?url=... */
    const imageSrc = (img) => {
        const raw = img.getAttribute('src') || '';
        if (raw.startsWith('/_next/image')) return new URL(raw, location.href).searchParams.get('url') || raw;
        return raw;
    };

    const describe = (el) => {
        if (el.tagName === 'IMG') return { kind: 'image', src: imageSrc(el), alt: el.getAttribute('alt') || '' };
        if (textOnly(el)) return { kind: 'text', text: el.innerText.trim() };
        return { kind: 'block', text: el.innerText.trim().slice(0, 200) };
    };

    /** What the editor needs to find this element in the source. */
    const target = (el) => {
        const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
        const fibers = [];
        for (let f = fiberKey && el[fiberKey]; f && fibers.length < 30; f = f.return) {
            // Index 0 is always the clicked element itself, even without a stack.
            if (fibers.length === 0 || f._debugStack) fibers.push({ stack: f._debugStack?.stack || '' });
        }
        const domPath = [];
        for (let n = el; n && n !== document.body && n.parentElement; n = n.parentElement) {
            domPath.unshift([...n.parentElement.children].filter((c) => !isOurs(c)).indexOf(n));
        }
        return {
            fibers,
            tag: el.tagName.toLowerCase(),
            className: typeof el.className === 'string' ? el.className : '',
            text: el.innerText?.trim().slice(0, 80) || '',
            domPath,
            page: location.pathname,
        };
    };

    const STYLE_KEYS = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'textAlign', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'borderRadius'];
    const styles = (el) => {
        const cs = getComputedStyle(el);
        return Object.fromEntries(STYLE_KEYS.map((k) => [k, cs[k]]));
    };

    const send = (msg) => parentWin.postMessage({ source: 'site-editor', ...msg }, '*');

    document.addEventListener('mouseover', (e) => {
        if (mode !== 'edit' || editing || isOurs(e.target)) return;
        place(hoverBox, e.target);
    }, true);
    document.addEventListener('mouseleave', () => (hoverBox.style.display = 'none'));

    const block = (e) => {
        if (mode !== 'edit' || (editing && editing.contains(e.target))) return;
        e.preventDefault();
        e.stopPropagation();
    };
    // Swallow clicks so links and buttons do nothing while editing.
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit']) document.addEventListener(t, block, true);

    document.addEventListener('click', (e) => {
        if (mode !== 'edit' || (editing && editing.contains(e.target))) return;
        e.preventDefault();
        e.stopPropagation();
        if (editing) finishEdit(true);
        selected = e.target;
        place(selectBox, selected);
        send({ type: 'select', tag: selected.tagName.toLowerCase(), ...describe(selected), target: target(selected), styles: styles(selected) });
    }, true);

    document.addEventListener('dblclick', (e) => {
        if (mode !== 'edit' || editing) return;
        e.preventDefault();
        e.stopPropagation();
        if (textOnly(e.target)) startEdit(e.target);
    }, true);

    function startEdit(el) {
        editing = el;
        el.dataset.seOld = el.innerText.trim();
        el.contentEditable = 'plaintext-only';
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        el.addEventListener('keydown', onKey);
        el.addEventListener('blur', onBlur);
        hoverBox.style.display = 'none';
    }
    const onKey = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            finishEdit(true);
        } else if (e.key === 'Escape') finishEdit(false);
    };
    const onBlur = () => finishEdit(true);

    function finishEdit(save) {
        const el = editing;
        if (!el) return;
        editing = null;
        el.removeEventListener('keydown', onKey);
        el.removeEventListener('blur', onBlur);
        el.contentEditable = 'false';
        const oldText = el.dataset.seOld;
        const newText = el.innerText.trim();
        delete el.dataset.seOld;
        if (!save || newText === oldText) {
            el.innerText = oldText;
            return;
        }
        send({ type: 'edit-text', old: oldText, new: newText });
    }

    window.addEventListener('message', (e) => {
        const m = e.data;
        if (!m || m.source !== 'site-editor-host') return;
        if (m.type === 'mode') {
            mode = m.mode;
            hoverBox.style.display = selectBox.style.display = 'none';
        }
        if (m.type === 'reload') location.reload();
    });

    const follow = () => {
        place(selectBox, selected);
        requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
    send({ type: 'page', path: location.pathname, title: document.title });
})();
