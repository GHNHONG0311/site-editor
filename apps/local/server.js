// Site Editor, local version: run with `node server.js`, then open http://localhost:4000.
// Only listens on 127.0.0.1, so nothing outside this computer can reach it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReplace, findMatches } from './lib/source-edit.js';
import { SiteRunner } from './lib/site-runner.js';
import { editElement, locate } from './lib/target.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR_PORT = 4000;
const PREVIEW_PORT = 4001;
const SITES_DIR = process.env.SITE_EDITOR_SITES || path.join(os.homedir(), 'site-editor-sites');
fs.mkdirSync(SITES_DIR, { recursive: true });

const runner = new SiteRunner(path.join(HERE, 'public', 'inject.js'));
const history = []; // [{ label, files: [{file, before}] }]
let cloning = null;

const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
};

const readBody = (req) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 30 * 1024 * 1024) reject(new Error('文件太大（最多 20MB）'));
            else chunks.push(c);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch {
                reject(new Error('请求格式不对'));
            }
        });
    });

function listSites() {
    return fs
        .readdirSync(SITES_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(SITES_DIR, e.name) }));
}

function requireSite() {
    if (!runner.root) throw new Error('请先打开一个网站');
    return runner.root;
}

/** Shared by text and image edits: find, then replace one match, all, or ask which. */
function replaceOrAsk(root, matches, choice, value, label, opts) {
    if (!matches.length) return { ok: false, error: 'not-found' };
    // Exactly one place holds this as a whole value: that is what was clicked; partial hits elsewhere don't count.
    if (choice === undefined && matches.filter((m) => m.whole).length === 1) choice = 0;
    if (matches.length > 1 && choice === undefined) {
        return { ok: false, error: 'ambiguous', choices: matches.map((m) => ({ file: m.file, line: m.line, snippet: m.snippet })) };
    }
    const files = applyReplace(root, matches, choice ?? 0, value, opts);
    history.push({ label, files });
    return { ok: true, files: files.map((f) => f.file) };
}

const routes = {
    'GET /api/state': () => ({
        sitesDir: SITES_DIR,
        site: runner.root,
        siteName: runner.root && path.basename(runner.root),
        kind: runner.kind,
        status: cloning ? 'cloning' : runner.status,
        log: runner.log.slice(-40),
        previewUrl: `http://localhost:${PREVIEW_PORT}/`,
        canUndo: history.length > 0,
        undoLabel: history.at(-1)?.label,
    }),
    'GET /api/sites': () => ({ sites: listSites(), sitesDir: SITES_DIR }),
    'POST /api/open': async (b) => {
        const p = path.resolve(String(b.path || ''));
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('找不到这个文件夹');
        history.length = 0;
        await runner.open(p);
        return { ok: true };
    },
    'POST /api/clone': async (b) => {
        const url = String(b.url || '').trim();
        if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(url)) throw new Error('请贴 GitHub 仓库网址，例如 https://github.com/名字/仓库');
        const name = url.replace(/\/$/, '').replace(/\.git$/, '').split('/').pop();
        const dest = path.join(SITES_DIR, name);
        if (fs.existsSync(dest)) throw new Error(`「${name}」已经下载过了，直接在列表里打开`);
        cloning = name;
        try {
            await new Promise((resolve, reject) => {
                const win = process.platform === 'win32';
                // With shell on Windows, quote the path: user folders often contain spaces.
                const c = spawn('git', ['clone', '--depth', '1', url, win ? `"${dest}"` : dest], { shell: win });
                c.stderr.on('data', (d) => runner.addLog(d));
                c.on('error', () => reject(new Error('找不到 git，请先安装 Git for Windows')));
                c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('下载失败，请检查网址，或这个仓库需要登录'))));
            });
        } finally {
            cloning = null;
        }
        history.length = 0;
        await runner.open(dest);
        return { ok: true };
    },
    'POST /api/edit-text': async (b) => {
        const root = requireSite();
        const matches = findMatches(root, String(b.old || ''));
        return replaceOrAsk(root, matches, b.choice, String(b.new ?? ''), `改文字「${String(b.old).slice(0, 20)}」`);
    },
    'POST /api/replace-image': async (b) => {
        const root = requireSite();
        const oldSrc = String(b.oldSrc || '');
        const matches = findMatches(root, oldSrc, { exact: true });
        if (!matches.length) return { ok: false, error: 'not-found' };
        if (matches.length > 1 && b.choice === undefined) return replaceOrAsk(root, matches, undefined, '', '');
        const ext = (path.extname(String(b.fileName || '')).toLowerCase().match(/^\.(png|jpe?g|webp|gif|svg|avif)$/) || [])[0];
        if (!ext) throw new Error('只能用图片文件（jpg、png、webp、gif、svg）');
        const base = path.basename(String(b.fileName), path.extname(String(b.fileName))).replace(/[^\w-]+/g, '-').slice(0, 40) || 'image';
        // Next.js and plain HTML both serve public/ (or the site root for plain HTML) at "/".
        const publicDir = runner.kind === 'static' ? root : path.join(root, 'public');
        const dir = path.join(publicDir, 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        const fileName = `${base}-${Date.now().toString(36)}${ext}`;
        fs.writeFileSync(path.join(dir, fileName), Buffer.from(String(b.data || ''), 'base64'));
        return replaceOrAsk(root, matches, b.choice, `/uploads/${fileName}`, '换图片', { raw: true });
    },
    'POST /api/locate': async (b) => {
        const root = requireSite();
        const { file, el, repeated } = await locate(root, runner.kind, b.target ?? {});
        return { ok: true, file, name: el.name, repeated };
    },
    'POST /api/element': async (b) => {
        const root = requireSite();
        const labels = { delete: '删除', duplicate: '复制', up: '上移', down: '下移', style: '改样式' };
        const undo = await editElement(root, runner.kind, b.target ?? {}, b.op, b.styles);
        history.push({ label: labels[b.op] ?? b.op, files: [undo] });
        return { ok: true };
    },
    'POST /api/undo': async () => {
        const root = requireSite();
        const last = history.pop();
        if (!last) return { ok: false };
        for (const f of last.files) fs.writeFileSync(path.join(root, f.file), f.before);
        return { ok: true, label: last.label };
    },
    'POST /api/restart': async () => {
        await runner.open(requireSite());
        return { ok: true };
    },
};

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };

const openBrowser = () => {
    const url = `http://localhost:${EDITOR_PORT}`;
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {});
};

const editor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
        try {
            json(res, 200, await route(req.method === 'POST' ? await readBody(req) : {}));
        } catch (e) {
            json(res, 400, { ok: false, error: 'message', message: e.message });
        }
        return;
    }
    const file = STATIC[url.pathname];
    if (!file) return res.writeHead(404).end();
    const type = { html: 'text/html', js: 'text/javascript', css: 'text/css' }[file.split('.').pop()];
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(HERE, 'public', file)));
});
editor.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    // Already running (e.g. double-clicked twice): just show it.
    console.log('网站编辑器已经在运行了，正在打开浏览器。');
    if (process.env.SITE_EDITOR_OPEN) openBrowser();
    setTimeout(() => process.exit(0), 1000);
});
editor.listen(EDITOR_PORT, '127.0.0.1', () => {
    console.log(`网站编辑器已启动：http://localhost:${EDITOR_PORT}`);
    console.log('使用时请不要关闭这个窗口。');
    if (process.env.SITE_EDITOR_OPEN) openBrowser();
    runner.previewServer().listen(PREVIEW_PORT, '127.0.0.1');
});


const shutdown = async () => {
    await runner.stop();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
