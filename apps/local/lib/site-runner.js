// Runs the opened website (Next.js dev server, or plain HTML files) and serves it through a
// preview port that adds the editing script to every page.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export const DEV_PORT = 4100;
const INJECT = '<script src="/__se/inject.js"></script>';
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
const isWin = process.platform === 'win32';

export class SiteRunner {
    root = null;
    kind = null; // 'node' | 'static'
    status = 'idle'; // idle | installing | starting | ready | error
    log = [];
    child = null;

    constructor(injectFile) {
        this.injectFile = injectFile;
    }

    addLog(text) {
        this.log.push(...String(text).split(/\r?\n/).filter(Boolean));
        if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    }

    async open(root) {
        await this.stop();
        this.root = root;
        this.log = [];
        const pkgFile = path.join(root, 'package.json');
        if (!fs.existsSync(pkgFile)) {
            if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error('这个文件夹里没有网站（找不到 package.json 或 index.html）');
            this.kind = 'static';
            this.status = 'ready';
            return;
        }
        this.kind = 'node';
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (!pkg.scripts?.dev) throw new Error('这个网站没有 dev 启动命令（package.json 里的 scripts.dev）');
        this.run(pkg).catch((e) => {
            this.status = 'error';
            this.addLog(e.message);
        });
    }

    async run(pkg) {
        const pm = fs.existsSync(path.join(this.root, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(this.root, 'yarn.lock')) ? 'yarn' : 'npm';
        if (!fs.existsSync(path.join(this.root, 'node_modules'))) {
            this.status = 'installing';
            await this.exec(pm, ['install']);
        }
        this.status = 'starting';
        // `next dev` takes -p; other dev servers usually read PORT.
        const args = /\bnext\s+dev\b/.test(pkg.scripts.dev)
            ? ['exec', '--', 'next', 'dev', '-p', String(DEV_PORT), '-H', '127.0.0.1']
            : ['run', 'dev'];
        this.child = this.spawn(pm === 'npm' ? 'npm' : pm, pm === 'npm' ? args : args.filter((a) => a !== '--'));
        this.child.on('exit', (code) => {
            if (this.child && this.status !== 'idle') {
                this.status = 'error';
                this.addLog(`网站程序停止了（代码 ${code}）`);
            }
        });
        for (let i = 0; i < 180 && this.status === 'starting'; i++) {
            if (await this.answers()) {
                this.status = 'ready';
                return;
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
        if (this.status === 'starting') throw new Error('网站 3 分钟内没有启动，请看下面的记录');
    }

    spawn(cmd, args) {
        const child = spawn(cmd, args, { cwd: this.root, shell: isWin, detached: !isWin, env: { ...process.env, PORT: String(DEV_PORT), BROWSER: 'none', NEXT_TELEMETRY_DISABLED: '1' } });
        child.stdout.on('data', (d) => this.addLog(d));
        child.stderr.on('data', (d) => this.addLog(d));
        return child;
    }

    exec(cmd, args) {
        return new Promise((resolve, reject) => {
            const c = this.spawn(cmd, args);
            c.on('error', reject);
            c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 失败（代码 ${code}）`))));
        });
    }

    answers() {
        return new Promise((resolve) => {
            const req = http.get({ host: '127.0.0.1', port: DEV_PORT, path: '/', timeout: 3000 }, (res) => {
                res.resume();
                resolve(true);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => req.destroy());
        });
    }

    async stop() {
        const c = this.child;
        this.child = null;
        this.status = 'idle';
        if (!c) return;
        // npm spawns next as a grandchild; kill the whole tree.
        if (isWin) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F']);
        else process.kill(-c.pid, 'SIGTERM'); // the whole process group
        await new Promise((r) => setTimeout(r, 500));
    }

    /** The preview server: proxies to the dev server (or serves static files) and adds the editing script. */
    previewServer() {
        const server = http.createServer((req, res) => {
            if (req.url.startsWith('/__se/inject.js')) {
                res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
                return res.end(fs.readFileSync(this.injectFile));
            }
            if (!this.root || this.status !== 'ready') {
                res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
                return res.end('<p style="font-family:sans-serif;color:#666">网站还没准备好…</p>');
            }
            if (this.kind === 'static') return this.serveStatic(req, res);
            const up = http.request(
                { host: '127.0.0.1', port: DEV_PORT, path: req.url, method: req.method, headers: { ...devHeaders(req.headers), 'accept-encoding': 'identity' } },
                (r) => {
                    const isHtml = (r.headers['content-type'] || '').includes('text/html');
                    if (!isHtml) {
                        res.writeHead(r.statusCode, r.headers);
                        return r.pipe(res);
                    }
                    const chunks = [];
                    r.on('data', (c) => chunks.push(c));
                    r.on('end', () => {
                        const body = addInject(Buffer.concat(chunks).toString('utf8'));
                        const headers = { ...r.headers };
                        delete headers['content-length'];
                        delete headers['transfer-encoding'];
                        res.writeHead(r.statusCode, headers);
                        res.end(body);
                    });
                },
            );
            up.on('error', () => {
                res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('网站暂时没有响应');
            });
            req.pipe(up);
        });
        // Hot reload websocket: pass the raw connection straight through.
        server.on('upgrade', (req, socket, head) => {
            if (this.kind !== 'node') return socket.destroy();
            const up = net.connect(DEV_PORT, '127.0.0.1', () => {
                up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(devHeaders(req.headers)).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
                up.write(head);
                up.pipe(socket);
                socket.pipe(up);
            });
            up.on('error', () => socket.destroy());
            socket.on('error', () => up.destroy());
        });
        return server;
    }

    serveStatic(req, res) {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let file = path.join(this.root, urlPath);
        if (!file.startsWith(this.root)) return res.writeHead(403).end();
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
        if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
        if (!fs.existsSync(file)) return res.writeHead(404).end('Not found');
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'content-type': (MIME[ext] || 'application/octet-stream') + (ext === '.html' ? '; charset=utf-8' : ''), 'cache-control': 'no-store' });
        res.end(ext === '.html' ? addInject(fs.readFileSync(file, 'utf8')) : fs.readFileSync(file));
    }
}

/** Present preview requests as same-origin to the dev server, which refuses cross-origin dev requests. */
function devHeaders(h) {
    const out = { ...h, host: `127.0.0.1:${DEV_PORT}` };
    if (out.origin) out.origin = `http://127.0.0.1:${DEV_PORT}`;
    delete out.referer;
    return out;
}

export function addInject(html) {
    return html.includes('</head>') ? html.replace('</head>', `${INJECT}</head>`) : INJECT + html;
}
