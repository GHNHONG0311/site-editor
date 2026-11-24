import { Sandbox } from '@vercel/sandbox';
import { isImageFile } from '@onlook/utility';
import {
    Provider,
    type CopyFileOutput,
    type CopyFilesInput,
    type CreateDirectoryInput,
    type CreateDirectoryOutput,
    type CreateProjectInput,
    type CreateProjectOutput,
    type CreateSessionInput,
    type CreateSessionOutput,
    type CreateTerminalInput,
    type CreateTerminalOutput,
    type DeleteFilesInput,
    type DeleteFilesOutput,
    type DownloadFilesInput,
    type DownloadFilesOutput,
    type GetTaskInput,
    type GetTaskOutput,
    type GitStatusInput,
    type GitStatusOutput,
    type InitializeInput,
    type InitializeOutput,
    type ListFilesInput,
    type ListFilesOutput,
    type ListProjectsInput,
    type ListProjectsOutput,
    type PauseProjectInput,
    type PauseProjectOutput,
    type ReadFileInput,
    type ReadFileOutput,
    type RenameFileInput,
    type RenameFileOutput,
    type SetupInput,
    type SetupOutput,
    type StatFileInput,
    type StatFileOutput,
    type StopProjectInput,
    type StopProjectOutput,
    type TerminalBackgroundCommandInput,
    type TerminalBackgroundCommandOutput,
    type TerminalCommandInput,
    type TerminalCommandOutput,
    type WatchFilesInput,
    type WatchFilesOutput,
    type WriteFileInput,
    type WriteFileOutput,
} from '../../types';
import { CommandTerminal, DevTask, LogCommand, PollingFileWatcher } from '../polling';

/** The user's project lives here inside the VM; every relative path resolves against it. */
export const VSB_ROOT = '/vercel/sandbox';
export const VSB_PORT = 3000;
const DEV_LOG = '/tmp/onlook-dev.log';
const SESSION_TIMEOUT_MS = 45 * 60 * 1000; // Hobby max; Pro allows longer via extendTimeout
/** Template ids (see @onlook/constants SandboxTemplates.BLANK) that mean "start empty". */
const BLANK_TEMPLATE_IDS = ['xzsy8c'];
const WATCH_EXCLUDES = ['node_modules', '.next', '.git'];

export interface VercelSandboxProviderOptions {
    /** Sandbox name (we use it as Onlook's sandboxId). */
    sandboxId?: string;
}

/** Single-quote a value for bash. */
export const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const abs = (p: string) => (p.startsWith('/') ? p : `${VSB_ROOT}/${p.replace(/^\.?\/*/, '')}`);

/** Detects the package manager from lockfiles, then installs and starts `next dev` on 0.0.0.0. */
const DEV_SCRIPT = `cd ${VSB_ROOT}
if [ -f bun.lock ] || [ -f bun.lockb ]; then command -v bun >/dev/null || npm i -g bun >/dev/null 2>&1; PM=bun
elif [ -f pnpm-lock.yaml ]; then corepack enable >/dev/null 2>&1; PM=pnpm
elif [ -f yarn.lock ]; then corepack enable >/dev/null 2>&1; PM=yarn
else PM=npm; fi
[ -d node_modules ] || $PM install
# Bracket pattern so pkill does not match (and kill) this very bash, whose command line contains it.
pkill -f "[n]ext dev" >/dev/null 2>&1
nohup $PM run dev -- -H 0.0.0.0 -p ${VSB_PORT} > ${DEV_LOG} 2>&1 &`;

/** A sandbox created without a source has no project folder yet; create it, owned by the default user. */
async function ensureRoot(sandbox: Sandbox) {
    const who = await sandbox.runCommand({ cmd: 'bash', args: ['-c', 'echo $(id -u):$(id -g)'], cwd: '/' });
    const owner = (await who.stdout()).trim();
    const r = await sandbox.runCommand({
        cmd: 'bash',
        args: ['-c', `mkdir -p ${VSB_ROOT} && chown ${owner} ${VSB_ROOT}`],
        cwd: '/',
        sudo: true,
    });
    if (r.exitCode !== 0) throw new Error(`Could not create ${VSB_ROOT}: ${await r.stderr()}`);
}

async function bash(sandbox: Sandbox, script: string) {
    const r = await sandbox.runCommand({ cmd: 'bash', args: ['-c', script], cwd: VSB_ROOT });
    const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
    return { exitCode: r.exitCode, stdout, stderr };
}

async function bashOk(sandbox: Sandbox, script: string) {
    const r = await bash(sandbox, script);
    if (r.exitCode !== 0) throw new Error(r.stderr || `Command failed: ${script}`);
    return r.stdout;
}

export async function startDevServer(sandbox: Sandbox) {
    await bashOk(sandbox, DEV_SCRIPT);
}

export class VercelSandboxProvider extends Provider {
    private sandbox: Sandbox | null = null;

    constructor(private readonly options: VercelSandboxProviderOptions) {
        super();
    }

    private get sb(): Sandbox {
        if (!this.sandbox) throw new Error('Sandbox not initialized');
        return this.sandbox;
    }

    async initialize(_: InitializeInput): Promise<InitializeOutput> {
        if (this.options.sandboxId) {
            this.sandbox = await Sandbox.get({ name: this.options.sandboxId });
        }
        return {};
    }

    /** Resumes the VM if needed, makes sure the dev server runs, returns the preview URL. */
    async ensureRunning(): Promise<{ previewUrl: string }> {
        const sandbox = this.sb;
        const isUp = async () =>
            (
                await bash(
                    sandbox,
                    `curl -s -o /dev/null --max-time 2 http://localhost:${VSB_PORT} && echo up || true`,
                )
            ).stdout.includes('up');
        if (!(await isUp())) {
            await startDevServer(sandbox);
            // `next dev` takes a while on a cold VM; wait up to ~2 minutes for it to answer.
            for (let i = 0; i < 60 && !(await isUp()); i++) {
                await new Promise((r) => setTimeout(r, 2000));
            }
        }
        return { previewUrl: sandbox.domain(VSB_PORT) };
    }

    async reload(): Promise<boolean> {
        await startDevServer(this.sb);
        return true;
    }
    async reconnect(): Promise<void> {}
    async ping(): Promise<boolean> {
        try {
            return (await bash(this.sb, 'echo ping')).exitCode === 0;
        } catch {
            return false;
        }
    }
    async destroy(): Promise<void> {
        this.sandbox = null;
    }

    static async createProject(input: CreateProjectInput): Promise<CreateProjectOutput> {
        const name = crypto.randomUUID();
        let existing: Sandbox | null = null;
        try {
            // `id` may be an existing sandbox (fork/branch) or a template id.
            existing = await Sandbox.get({ name: input.id, resume: false });
        } catch {
            existing = null;
        }
        if (existing) {
            const snap = await existing.snapshot();
            await Sandbox.create({
                name,
                ports: [VSB_PORT],
                timeout: SESSION_TIMEOUT_MS,
                source: { type: 'snapshot', snapshotId: snap.snapshotId },
            });
            return { id: name };
        }
        const sandbox = await Sandbox.create({ name, ports: [VSB_PORT], timeout: SESSION_TIMEOUT_MS });
        await ensureRoot(sandbox);
        if (BLANK_TEMPLATE_IDS.includes(input.id)) {
            return { id: name }; // empty VM; the caller uploads the project files
        }
        // shortcut: every template becomes a blank Next.js + Tailwind app; add real template repos when needed.
        await bashOk(
            sandbox,
            `cd ${VSB_ROOT} && npx -y create-next-app@latest . --ts --tailwind --app --eslint --use-npm --yes --disable-git`,
        );
        await startDevServer(sandbox);
        return { id: name };
    }

    static async createProjectFromGit(input: {
        repoUrl: string;
        branch: string;
    }): Promise<CreateProjectOutput> {
        const name = crypto.randomUUID();
        const sandbox = await Sandbox.create({
            name,
            ports: [VSB_PORT],
            timeout: SESSION_TIMEOUT_MS,
            source: { type: 'git', url: input.repoUrl, revision: input.branch, depth: 1 },
        });
        await startDevServer(sandbox);
        return { id: name };
    }

    async pauseProject(_: PauseProjectInput): Promise<PauseProjectOutput> {
        await this.sandbox?.stop();
        return {};
    }
    async stopProject(_: StopProjectInput): Promise<StopProjectOutput> {
        await this.sandbox?.stop();
        return {};
    }
    async listProjects(_: ListProjectsInput): Promise<ListProjectsOutput> {
        return {};
    }

    async writeFile({ args }: WriteFileInput): Promise<WriteFileOutput> {
        const content =
            typeof args.content === 'string' ? Buffer.from(args.content) : Buffer.from(args.content);
        const path = abs(args.path);
        await bashOk(this.sb, `mkdir -p "$(dirname ${sh(path)})"`);
        await this.sb.writeFiles([{ path, content }]);
        return { success: true };
    }

    async renameFile({ args }: RenameFileInput): Promise<RenameFileOutput> {
        const to = abs(args.newPath);
        await bashOk(this.sb, `mkdir -p "$(dirname ${sh(to)})" && mv ${sh(abs(args.oldPath))} ${sh(to)}`);
        return {};
    }

    async statFile({ args }: StatFileInput): Promise<StatFileOutput> {
        const out = await bashOk(this.sb, `stat -L -c '%F|%s|%Y' ${sh(abs(args.path))}`);
        const [kind, size, mtime] = out.trim().split('|');
        return {
            type: kind === 'directory' ? 'directory' : 'file',
            size: Number(size),
            mtime: Number(mtime) * 1000,
        };
    }

    async deleteFiles({ args }: DeleteFilesInput): Promise<DeleteFilesOutput> {
        await bashOk(this.sb, `rm ${args.recursive ? '-rf' : '-f'} ${sh(abs(args.path))}`);
        return {};
    }

    async listFiles({ args }: ListFilesInput): Promise<ListFilesOutput> {
        const out = await bashOk(
            this.sb,
            `find ${sh(abs(args.path))} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n'`,
        );
        const files = out
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [t, name] = line.split('\t') as [string, string];
                return { name, type: t === 'd' ? 'directory' : 'file', isSymlink: t === 'l' } as const;
            });
        return { files };
    }

    async readFile({ args }: ReadFileInput): Promise<ReadFileOutput> {
        const buf = await this.sb.readFileToBuffer({ path: abs(args.path) });
        if (!buf) throw new Error(`Failed to read file ${args.path}`);
        if (isImageFile(args.path)) {
            const content = new Uint8Array(buf);
            return {
                file: {
                    type: 'binary',
                    path: args.path,
                    content,
                    toString: () => buf.toString('base64'),
                },
            };
        }
        const content = buf.toString('utf8');
        return { file: { type: 'text', path: args.path, content, toString: () => content } };
    }

    async downloadFiles(_: DownloadFilesInput): Promise<DownloadFilesOutput> {
        return {};
    }

    async copyFiles({ args }: CopyFilesInput): Promise<CopyFileOutput> {
        const flags = `${args.recursive ? '-r' : ''} ${args.overwrite === false ? '-n' : ''}`;
        await bashOk(this.sb, `cp ${flags} ${sh(abs(args.sourcePath))} ${sh(abs(args.targetPath))}`);
        return {};
    }

    async createDirectory({ args }: CreateDirectoryInput): Promise<CreateDirectoryOutput> {
        await bashOk(this.sb, `mkdir -p ${sh(abs(args.path))}`);
        return {};
    }

    /** path -> mtime (ms) for every file under `path`, minus excluded folders. Used for polling watches. */
    async listMtimes(path: string, excludes: string[] = []): Promise<Record<string, number>> {
        const prune = [...WATCH_EXCLUDES, ...excludes]
            .map((e) => `-name ${sh(e)} -prune`)
            .join(' -o ');
        const root = abs(path);
        const out = await bashOk(this.sb, `cd ${sh(root)} && find . \\( ${prune} \\) -o -type f -printf '%P\\t%T@\\n'`);
        const map: Record<string, number> = {};
        for (const line of out.split('\n')) {
            const [p, t] = line.split('\t');
            if (p && t) map[path === '.' || path === './' ? p : `${path.replace(/\/$/, '')}/${p}`] = Number(t) * 1000;
        }
        return map;
    }

    async watchFiles(input: WatchFilesInput): Promise<WatchFilesOutput> {
        const watcher = new PollingFileWatcher((p, ex) => this.listMtimes(p, ex));
        await watcher.start(input);
        if (input.onFileChange) watcher.registerEventCallback(input.onFileChange);
        return { watcher };
    }

    async createTerminal(_: CreateTerminalInput): Promise<CreateTerminalOutput> {
        return { terminal: new CommandTerminal((cmd) => this.runCommand({ args: { command: cmd } }).then((r) => r.output)) };
    }

    async getTask({ args }: GetTaskInput): Promise<GetTaskOutput> {
        if (args.id !== 'dev') throw new Error(`Task ${args.id} not found`);
        return {
            task: new DevTask(
                () => bash(this.sb, `tail -c 20000 ${DEV_LOG} 2>/dev/null`).then((r) => r.stdout),
                () => startDevServer(this.sb),
                () => bashOk(this.sb, 'pkill -f "[n]ext dev" || true').then(() => undefined),
            ),
        };
    }

    async runCommand({ args }: TerminalCommandInput): Promise<TerminalCommandOutput> {
        const r = await bash(this.sb, args.command);
        return { output: r.stdout + r.stderr };
    }

    async runBackgroundCommand({ args }: TerminalBackgroundCommandInput): Promise<TerminalBackgroundCommandOutput> {
        const log = `/tmp/onlook-bg-${Date.now()}.log`;
        const start = () => bashOk(this.sb, `nohup bash -c ${sh(args.command)} > ${log} 2>&1 &`).then(() => undefined);
        await start();
        return {
            command: new LogCommand(
                args.command,
                () => bash(this.sb, `cat ${log} 2>/dev/null`).then((r) => r.stdout),
                start,
            ),
        };
    }

    async gitStatus(_: GitStatusInput): Promise<GitStatusOutput> {
        const out = await bash(this.sb, 'git status --porcelain 2>/dev/null');
        return { changedFiles: out.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)) };
    }

    async setup(_: SetupInput): Promise<SetupOutput> {
        await startDevServer(this.sb);
        return {};
    }

    async createSession(_: CreateSessionInput): Promise<CreateSessionOutput> {
        return this.ensureRunning();
    }
}

