// Editor page: lists sites, shows the preview, and turns clicks in the preview into file edits.
const $ = (id) => document.getElementById(id);
const preview = $('preview');
const STATUS = { idle: '', cloning: '正在下载…', installing: '正在安装（第一次要几分钟）…', starting: '正在启动网站…', ready: '', error: '出错了' };
let state = {};
let mode = 'edit';
let selection = null;

async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    return res.json();
}

function toast(text, isError = false) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.className = ''), isError ? 6000 : 2500);
}

const toFrame = (msg) => preview.contentWindow?.postMessage({ source: 'site-editor-host', ...msg }, '*');
// The preview is another origin (port 4001), so ask it to reload itself.
const reloadPreview = () => toFrame({ type: 'reload' });

async function refreshSites() {
    const { sites, sitesDir } = await api('/api/sites');
    $('sites-dir').textContent = `网站文件夹：${sitesDir}`;
    const ul = $('sites');
    ul.replaceChildren(
        ...sites.map((s) => {
            const li = document.createElement('li');
            const b = document.createElement('button');
            b.textContent = s.name;
            b.className = s.path === state.site ? 'current' : '';
            b.onclick = () => openSite(s.path);
            li.append(b);
            return li;
        }),
    );
    if (!sites.length) ul.innerHTML = '<li class="hint">还没有网站。从 GitHub 下载，或把网站文件夹放进上面的文件夹。</li>';
}

async function openSite(p) {
    selection = null;
    renderProps();
    const r = await api('/api/open', { path: p });
    if (!r.ok) toast(r.message || '打不开', true);
    await poll();
    refreshSites();
}

async function poll() {
    const prev = state;
    state = await api('/api/state');
    const label = STATUS[state.status] || '';
    $('title').innerHTML = '';
    $('title').append('网站编辑器' + (state.siteName ? ` · ${state.siteName}` : ''));
    if (label) {
        const s = document.createElement('span');
        s.className = 'status';
        s.textContent = label;
        $('title').append(s);
    }
    $('log').textContent = state.log.join('\n');
    $('log').scrollTop = 1e9;
    $('undo').disabled = !state.canUndo;
    $('undo').title = state.undoLabel ? `撤销：${state.undoLabel}` : '撤销上一次修改';
    $('restart').hidden = !state.site;
    const ready = state.status === 'ready';
    $('data').disabled = !ready;
    if (ready && (prev.status !== 'ready' || prev.site !== state.site)) {
        preview.src = state.previewUrl;
        preview.hidden = false;
        $('placeholder').hidden = true;
    } else if (!ready) {
        preview.hidden = true;
        $('placeholder').hidden = false;
        $('placeholder').textContent = state.site ? label || '网站没有运行' : '在左边选一个网站开始';
    }
}

const TAGS = { h1: '大标题', h2: '标题', h3: '小标题', p: '段落', a: '链接/按钮', button: '按钮', img: '图片', section: '区块', div: '区块', header: '页头', footer: '页脚', nav: '菜单', li: '列表项', span: '文字', ul: '列表' };
const toHex = (c) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(c || '');
    if (!m || m[4] === '0') return '';
    return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
};
const px = (v) => Math.round(parseFloat(v) || 0);

function renderProps() {
    const el = $('props');
    if (!selection) {
        el.innerHTML = '<p class="hint">单击网页上的东西来选中它。<br>双击文字可以直接修改，按 Enter 保存，按 Esc 取消。<br>想点链接换页面时，切换到上面的「浏览」。</p>';
        return;
    }
    const parts = [`<p class="kind">已选中：<b>${TAGS[selection.tag] ?? selection.tag}</b></p>`];
    if (selection.kind === 'text') parts.push('<h3>文字</h3><textarea id="text-input"></textarea><div class="actions"><button class="primary" id="text-save">保存文字</button></div>');
    if (selection.kind === 'image') parts.push('<h3>图片</h3><img class="img-preview" alt=""><p class="hint" id="img-src"></p><div class="actions"><button class="primary" id="img-pick">换一张图片</button></div><input type="file" id="img-file" accept="image/*" hidden>');
    parts.push('<div id="structure"><p class="hint">正在查找它在代码里的位置…</p></div>');
    el.innerHTML = parts.join('');
    if (selection.kind === 'text') {
        $('text-input').value = selection.text;
        $('text-save').onclick = () => editText(selection.text, $('text-input').value.trim());
    }
    if (selection.kind === 'image') {
        el.querySelector('img').src = new URL(selection.src, state.previewUrl).href;
        $('img-src').textContent = selection.src;
        $('img-pick').onclick = () => $('img-file').click();
        $('img-file').onchange = (e) => e.target.files[0] && replaceImage(selection.src, e.target.files[0]);
    }
    renderStructure(selection);
}

async function renderStructure(sel) {
    const r = await api('/api/locate', { target: sel.target });
    if (sel !== selection) return; // selection changed meanwhile
    const box = $('structure');
    if (!r.ok) {
        box.innerHTML = '<p class="hint"></p>';
        box.firstChild.textContent = (r.message || '找不到它在代码里的位置') + ' 可以点外面一层或里面的文字试试。如果它是列表里的一项（产品、链接等），请用「资料表格」改。';
        const b = document.createElement('button');
        b.textContent = '打开资料表格';
        b.onclick = openTables;
        box.append(b);
        return;
    }
    const st = sel.styles || {};
    box.innerHTML = `
        ${r.repeated ? '<p class="warn">这是列表里重复的一项，改它会影响列表里的每一项。</p>' : ''}
        <h3>位置</h3>
        <div class="actions wrap">
            <button data-op="up">↑ 上移</button><button data-op="down">↓ 下移</button>
            <button data-op="duplicate">复制</button><button data-op="delete" class="danger">删除</button>
        </div>
        <h3>样式</h3>
        <div class="form">
            <label>文字颜色 <input type="color" data-style="color"></label>
            <label>背景颜色 <span class="row"><input type="color" data-style="backgroundColor"><button type="button" data-clear="backgroundColor">无</button></span></label>
            <label>字号（px） <input type="number" min="8" max="200" data-style="fontSize" data-unit="px"></label>
            <label>粗细 <select data-style="fontWeight"><option value="400">正常</option><option value="600">半粗</option><option value="700">粗</option></select></label>
            <label>对齐 <select data-style="textAlign"><option value="left">靠左</option><option value="center">居中</option><option value="right">靠右</option></select></label>
            <label>上内边距（px） <input type="number" min="0" max="400" data-style="paddingTop" data-unit="px"></label>
            <label>下内边距（px） <input type="number" min="0" max="400" data-style="paddingBottom" data-unit="px"></label>
            <label>上外边距（px） <input type="number" min="-200" max="400" data-style="marginTop" data-unit="px"></label>
            <label>下外边距（px） <input type="number" min="-200" max="400" data-style="marginBottom" data-unit="px"></label>
            <label>圆角（px） <input type="number" min="0" max="200" data-style="borderRadius" data-unit="px"></label>
        </div>`;
    for (const input of box.querySelectorAll('[data-style]')) {
        const k = input.dataset.style;
        input.value = input.type === 'color' ? toHex(st[k]) || '#000000' : input.dataset.unit ? px(st[k]) : st[k] === 'start' ? 'left' : String(st[k] ?? '');
        if (k === 'fontWeight') input.value = Number(st[k]) >= 650 ? '700' : Number(st[k]) >= 550 ? '600' : '400';
        input.onchange = () => elementOp('style', { [k]: input.dataset.unit ? `${input.value}px` : input.value });
    }
    for (const b of box.querySelectorAll('[data-clear]')) b.onclick = () => elementOp('style', { [b.dataset.clear]: 'transparent' });
    for (const b of box.querySelectorAll('[data-op]')) {
        b.onclick = () => {
            if (b.dataset.op === 'delete' && !confirm('确定删除这个部分？（可以按「撤销」恢复）')) return;
            elementOp(b.dataset.op);
        };
    }
}

async function elementOp(op, styles) {
    const r = await api('/api/element', { target: selection.target, op, styles });
    if (!r.ok) return toast(r.message || '修改失败', true);
    toast({ delete: '已删除', duplicate: '已复制', up: '已上移', down: '已下移', style: '样式已改' }[op]);
    if (op !== 'style') {
        selection = null;
        renderProps();
    }
    if (state.kind === 'static') reloadPreview();
    poll();
}

/** Ask which place to change when the same text sits in several. Resolves to an index, 'all', or null. */
function chooseMatch(choices) {
    const box = $('choices');
    box.replaceChildren();
    return new Promise((resolve) => {
        const add = (label, sub, value) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'choice';
            b.textContent = label;
            if (sub) {
                const s = document.createElement('small');
                s.textContent = sub;
                b.append(s);
            }
            b.onclick = () => {
                $('choose').close();
                resolve(value);
            };
            box.append(b);
        };
        choices.forEach((c, i) => add(`${c.file} 第 ${c.line} 行`, c.snippet, i));
        add('全部都改', null, 'all');
        $('choose').onclose = () => resolve(null);
        $('choose').showModal();
    });
}

async function send(path, body) {
    let r = await api(path, body);
    if (r.error === 'ambiguous') {
        const choice = await chooseMatch(r.choices);
        if (choice === null) return null;
        r = await api(path, { ...body, choice });
    }
    if (r.ok) return r;
    if (r.error === 'not-found') toast('在网站文件里找不到这段内容。它可能是程序算出来的，第 2 步会加「资料表格」来改。', true);
    else toast(r.message || '修改失败', true);
    return null;
}

async function editText(oldText, newText) {
    if (!newText || newText === oldText) return;
    const r = await send('/api/edit-text', { old: oldText, new: newText });
    if (r) {
        toast('已保存');
        selection = { ...selection, text: newText };
        renderProps();
        // Next.js reloads by itself; plain HTML needs a refresh.
        if (state.kind === 'static') reloadPreview();
    } else reloadPreview();
    poll();
}

async function replaceImage(oldSrc, file) {
    if (file.size > 20 * 1024 * 1024) return toast('图片太大（最多 20MB）', true);
    const data = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1]);
        fr.readAsDataURL(file);
    });
    const r = await send('/api/replace-image', { oldSrc, fileName: file.name, data });
    if (!r) return;
    toast('图片已换好');
    selection = null;
    renderProps();
    if (state.kind === 'static') reloadPreview();
    poll();
}

window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.source !== 'site-editor') return;
    if (m.type === 'page') toFrame({ type: 'mode', mode });
    if (m.type === 'select') {
        selection = m;
        renderProps();
    }
    if (m.type === 'edit-text') editText(m.old, m.new);
});

$('undo').onclick = async () => {
    const r = await api('/api/undo', {});
    if (r.ok) toast(`已撤销：${r.label}`);
    if (state.kind === 'static') reloadPreview();
    if ($('data-dialog').open) renderTables();
    poll();
};

// ---- Data tables: lists of records written in the site's code (products, branches, menu links...)
const openTables = async () => {
    $('data-dialog').showModal();
    await renderTables();
};
async function renderTables() {
    const box = $('tables');
    const open = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.key));
    const r = await api('/api/tables');
    if (!r.ok) return (box.textContent = r.message || '读取失败');
    if (!r.tables.length) return (box.innerHTML = '<p class="hint">这个网站里没有找到列表资料。</p>');
    box.replaceChildren();
    for (const t of r.tables) {
        const key = `${t.file}|${t.label}`;
        const d = document.createElement('details');
        d.dataset.key = key;
        d.open = open.has(key) || (open.size === 0 && box.children.length === 0);
        const sum = document.createElement('summary');
        sum.textContent = t.label;
        const small = document.createElement('small');
        small.textContent = `${t.rows.length} 行 · ${t.file}`;
        sum.append(small);
        const wrap = document.createElement('div');
        wrap.className = 'tbl-wrap';
        const table = document.createElement('table');
        table.className = 'tbl';
        const head = table.insertRow();
        for (const c of [...t.columns, '']) head.append(Object.assign(document.createElement('th'), { textContent: t.tuple ? `第 ${c} 栏` : c }));
        if (t.tuple) head.lastChild.textContent = '';
        for (const row of t.rows) {
            const tr = table.insertRow();
            for (const c of t.columns) {
                const td = tr.insertCell();
                const has = c in row.cells;
                const input = document.createElement('input');
                if (t.types[c] === 'boolean') {
                    input.type = 'checkbox';
                    input.checked = row.cells[c] === 'true';
                    input.onchange = () => tableOp(t, row, 'set', c, String(input.checked));
                } else {
                    input.type = 'text';
                    input.value = row.cells[c] ?? '';
                    input.placeholder = has ? '' : '（没填）';
                    if (t.types[c] === 'number') input.inputMode = 'decimal';
                    input.onchange = () => tableOp(t, row, 'set', c, input.value);
                    input.onkeydown = (e) => e.key === 'Enter' && input.blur();
                }
                if (t.tuple && !has) input.disabled = true;
                td.append(input);
            }
            const ops = tr.insertCell();
            ops.className = 'ops';
            const dup = Object.assign(document.createElement('button'), { textContent: '复制' });
            dup.onclick = () => tableOp(t, row, 'duplicate');
            const del = Object.assign(document.createElement('button'), { textContent: '删除', className: 'danger' });
            del.onclick = () => confirm('确定删除这一行？（可以按「撤销」恢复）') && tableOp(t, row, 'delete');
            ops.append(dup, del);
        }
        wrap.append(table);
        d.append(sum, wrap);
        box.append(d);
    }
}
async function tableOp(t, row, op, key, value) {
    const r = await api('/api/table', { file: t.file, table: t.start, row: row.start, op, key, value });
    if (!r.ok) toast(r.message || '保存失败', true);
    else toast({ set: '已保存', duplicate: '已复制一行', delete: '已删除一行' }[op]);
    if (state.kind === 'static') reloadPreview();
    await renderTables();
    poll();
}
$('data').onclick = openTables;
$('data-close').onclick = () => $('data-dialog').close();
const setMode = (m) => {
    mode = m;
    $('mode-edit').classList.toggle('on', m === 'edit');
    $('mode-browse').classList.toggle('on', m === 'browse');
    toFrame({ type: 'mode', mode });
};
$('mode-edit').onclick = () => setMode('edit');
$('mode-browse').onclick = () => setMode('browse');
const setSize = (phone) => {
    document.querySelector('.stage').classList.toggle('phone', phone);
    $('size-phone').classList.toggle('on', phone);
    $('size-desktop').classList.toggle('on', !phone);
};
$('size-desktop').onclick = () => setSize(false);
$('size-phone').onclick = () => setSize(true);
$('restart').onclick = async () => {
    await api('/api/restart', {});
    poll();
};
$('open-form').onsubmit = (e) => {
    e.preventDefault();
    if ($('open-path').value.trim()) openSite($('open-path').value.trim());
};
$('clone-form').onsubmit = async (e) => {
    e.preventDefault();
    const url = $('clone-url').value.trim();
    if (!url) return;
    const pending = api('/api/clone', { url });
    setTimeout(poll, 300);
    const r = await pending;
    if (!r.ok) toast(r.message || '下载失败', true);
    else $('clone-url').value = '';
    await poll();
    refreshSites();
};

renderProps();
await poll();
refreshSites();
setInterval(poll, 1500);
