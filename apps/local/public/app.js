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

function renderProps() {
    const el = $('props');
    if (!selection) {
        el.innerHTML = '<p class="hint">单击网页上的东西来选中它。<br>双击文字可以直接修改，按 Enter 保存，按 Esc 取消。<br>想点链接换页面时，切换到上面的「浏览」。</p>';
        return;
    }
    if (selection.kind === 'text') {
        el.innerHTML = '<h3>文字</h3><textarea id="text-input"></textarea><div class="actions"><button class="primary" id="text-save">保存</button></div>';
        $('text-input').value = selection.text;
        $('text-save').onclick = () => editText(selection.text, $('text-input').value.trim());
        return;
    }
    if (selection.kind === 'image') {
        el.innerHTML = '<h3>图片</h3><img class="img-preview" alt=""><p class="hint" id="img-src"></p><div class="actions"><button class="primary" id="img-pick">换一张图片</button></div><input type="file" id="img-file" accept="image/*" hidden>';
        el.querySelector('img').src = new URL(selection.src, state.previewUrl).href;
        $('img-src').textContent = selection.src;
        $('img-pick').onclick = () => $('img-file').click();
        $('img-file').onchange = (e) => e.target.files[0] && replaceImage(selection.src, e.target.files[0]);
        return;
    }
    el.innerHTML = '<p class="hint">这是一个区块，里面有好几样东西。请直接点里面的文字或图片。</p>';
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
    poll();
};
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
