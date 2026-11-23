import {
    ProviderBackgroundCommand,
    ProviderFileWatcher,
    ProviderTask,
    ProviderTerminal,
    type WatchEvent,
    type WatchFilesInput,
} from '../types';

/** Polls file mtimes and reports add/change/remove. */
export class PollingFileWatcher extends ProviderFileWatcher {
    private timer: ReturnType<typeof setInterval> | null = null;
    private callbacks: ((event: WatchEvent) => Promise<void>)[] = [];
    private last: Record<string, number> = {};

    constructor(
        private readonly list: (path: string, excludes?: string[]) => Promise<Record<string, number>>,
        private readonly intervalMs = 2000,
    ) {
        super();
    }

    async start(input: WatchFilesInput): Promise<void> {
        const { path, excludes } = input.args;
        this.last = await this.list(path, excludes);
        let busy = false;
        this.timer = setInterval(async () => {
            if (busy) return;
            busy = true;
            try {
                const next = await this.list(path, excludes);
                const events = diffMtimes(this.last, next);
                this.last = next;
                for (const e of events) for (const cb of this.callbacks) await cb(e);
            } catch (error) {
                console.error('File watch poll failed', error);
            } finally {
                busy = false;
            }
        }, this.intervalMs);
    }

    registerEventCallback(callback: (event: WatchEvent) => Promise<void>): void {
        this.callbacks.push(callback);
    }

    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.callbacks = [];
    }
}

export function diffMtimes(prev: Record<string, number>, next: Record<string, number>): WatchEvent[] {
    const add: string[] = [];
    const change: string[] = [];
    const remove: string[] = [];
    for (const [p, t] of Object.entries(next)) {
        if (!(p in prev)) add.push(p);
        else if (prev[p] !== t) change.push(p);
    }
    for (const p of Object.keys(prev)) if (!(p in next)) remove.push(p);
    const events: WatchEvent[] = [];
    if (add.length) events.push({ type: 'add', paths: add });
    if (change.length) events.push({ type: 'change', paths: change });
    if (remove.length) events.push({ type: 'remove', paths: remove });
    return events;
}

type Listener = (data: string) => void;

/** Non-interactive terminal: each `run`/`write` executes the line and emits its output. */
export class CommandTerminal extends ProviderTerminal {
    private listeners = new Set<Listener>();
    constructor(private readonly exec: (cmd: string) => Promise<string>) {
        super();
    }
    get id() {
        return 'terminal';
    }
    get name() {
        return 'Terminal';
    }
    async open() {
        return '';
    }
    async write(input: string) {
        const cmd = input.trim();
        if (!cmd) return;
        const out = await this.exec(cmd);
        this.listeners.forEach((l) => l(`$ ${cmd}\r\n${out.replace(/\n/g, '\r\n')}`));
    }
    run(input: string) {
        return this.write(input);
    }
    async kill() {}
    onOutput(callback: Listener) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }
}

/** Streams a log file by polling it. */
function pollLog(read: () => Promise<string>, callback: Listener) {
    let seen = 0;
    const timer = setInterval(async () => {
        try {
            const text = await read();
            if (text.length < seen) seen = 0; // log restarted
            if (text.length > seen) callback(text.slice(seen));
            seen = text.length;
        } catch {
            // sandbox may be resuming; try again next tick
        }
    }, 2000);
    return () => clearInterval(timer);
}

export class DevTask extends ProviderTask {
    constructor(
        private readonly readLog: () => Promise<string>,
        private readonly start: () => Promise<void>,
        private readonly kill: () => Promise<void>,
    ) {
        super();
    }
    get id() {
        return 'dev';
    }
    get name() {
        return 'dev';
    }
    get command() {
        return 'next dev';
    }
    open() {
        return this.readLog();
    }
    run() {
        return this.start();
    }
    restart() {
        return this.start();
    }
    stop() {
        return this.kill();
    }
    onOutput(callback: Listener) {
        return pollLog(this.readLog, callback);
    }
}

export class LogCommand extends ProviderBackgroundCommand {
    constructor(
        private readonly cmd: string,
        private readonly readLog: () => Promise<string>,
        private readonly start: () => Promise<void>,
    ) {
        super();
    }
    get name() {
        return undefined;
    }
    get command() {
        return this.cmd;
    }
    open() {
        return this.readLog();
    }
    restart() {
        return this.start();
    }
    async kill() {}
    onOutput(callback: Listener) {
        return pollLog(this.readLog, callback);
    }
}
