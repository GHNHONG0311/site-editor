import { api } from '@/trpc/client';
import {
    CommandTerminal,
    DevTask,
    LogCommand,
    PollingFileWatcher,
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
} from '@onlook/code-provider';

type Method = Parameters<typeof api.sandbox.exec.mutate>[0]['method'];

const toBase64 = (bytes: Uint8Array) => {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Browser-side provider for Vercel Sandbox. The Sandbox SDK only runs on the server,
 * so every call goes through the `sandbox` tRPC router.
 */
export class RemoteSandboxProvider extends Provider {
    constructor(private readonly sandboxId: string) {
        super();
    }

    private async call<T>(method: Method, args: Record<string, unknown> = {}): Promise<T> {
        let base64Content: string | undefined;
        if (args.content instanceof Uint8Array) {
            base64Content = toBase64(args.content);
            args = { ...args, content: undefined };
        }
        return (await api.sandbox.exec.mutate({
            sandboxId: this.sandboxId,
            method,
            args,
            base64Content,
        })) as T;
    }

    async initialize(_: InitializeInput): Promise<InitializeOutput> {
        await api.sandbox.start.mutate({ sandboxId: this.sandboxId });
        return {};
    }
    reload() {
        return this.call<boolean>('reload');
    }
    async reconnect() {}
    async ping() {
        try {
            await this.call('runCommand', { command: 'echo ping' });
            return true;
        } catch {
            return false;
        }
    }
    async destroy() {}

    static createProject(_: CreateProjectInput): Promise<CreateProjectOutput> {
        throw new Error('Create projects on the server');
    }
    async pauseProject(_: PauseProjectInput): Promise<PauseProjectOutput> {
        await api.sandbox.hibernate.mutate({ sandboxId: this.sandboxId });
        return {};
    }
    async stopProject(_: StopProjectInput): Promise<StopProjectOutput> {
        return {};
    }
    async listProjects(_: ListProjectsInput): Promise<ListProjectsOutput> {
        return {};
    }

    writeFile({ args }: WriteFileInput) {
        return this.call<WriteFileOutput>('writeFile', args);
    }
    renameFile({ args }: RenameFileInput) {
        return this.call<RenameFileOutput>('renameFile', args);
    }
    statFile({ args }: StatFileInput) {
        return this.call<StatFileOutput>('statFile', args);
    }
    deleteFiles({ args }: DeleteFilesInput) {
        return this.call<DeleteFilesOutput>('deleteFiles', args);
    }
    listFiles({ args }: ListFilesInput) {
        return this.call<ListFilesOutput>('listFiles', args);
    }
    async readFile({ args }: ReadFileInput): Promise<ReadFileOutput> {
        const f = await this.call<
            | { type: 'text'; path: string; content: string }
            | { type: 'binary'; path: string; base64: string }
        >('readFile', args);
        if (f.type === 'binary') {
            return {
                file: { type: 'binary', path: f.path, content: fromBase64(f.base64), toString: () => f.base64 },
            };
        }
        return { file: { type: 'text', path: f.path, content: f.content, toString: () => f.content } };
    }
    async downloadFiles(_: DownloadFilesInput): Promise<DownloadFilesOutput> {
        return {};
    }
    copyFiles({ args }: CopyFilesInput) {
        return this.call<CopyFileOutput>('copyFiles', args);
    }
    createDirectory({ args }: CreateDirectoryInput) {
        return this.call<CreateDirectoryOutput>('createDirectory', args);
    }

    async watchFiles(input: WatchFilesInput): Promise<WatchFilesOutput> {
        const watcher = new PollingFileWatcher((path, excludes) =>
            api.sandbox.mtimes.query({ sandboxId: this.sandboxId, path, excludes }),
        );
        await watcher.start(input);
        if (input.onFileChange) watcher.registerEventCallback(input.onFileChange);
        return { watcher };
    }

    async createTerminal(_: CreateTerminalInput): Promise<CreateTerminalOutput> {
        return {
            terminal: new CommandTerminal(async (command) => (await this.runCommand({ args: { command } })).output),
        };
    }

    async getTask({ args }: GetTaskInput): Promise<GetTaskOutput> {
        if (args.id !== 'dev') throw new Error(`Task ${args.id} not found`);
        const readLog = () => api.sandbox.devLog.query({ sandboxId: this.sandboxId });
        const restart = async () => {
            await this.reload();
        };
        return { task: new DevTask(readLog, restart, async () => {}) };
    }

    runCommand({ args }: TerminalCommandInput) {
        return this.call<TerminalCommandOutput>('runCommand', args);
    }

    async runBackgroundCommand({ args }: TerminalBackgroundCommandInput): Promise<TerminalBackgroundCommandOutput> {
        // shortcut: runs to completion and replays its output; fine for install/build commands.
        let output = '';
        const run = async () => {
            output = (await this.runCommand({ args })).output;
        };
        void run();
        return { command: new LogCommand(args.command, async () => output, run) };
    }

    gitStatus(_: GitStatusInput) {
        return this.call<GitStatusOutput>('gitStatus');
    }
    setup(_: SetupInput) {
        return this.call<SetupOutput>('setup');
    }
    async createSession(_: CreateSessionInput): Promise<CreateSessionOutput> {
        return {};
    }
}
