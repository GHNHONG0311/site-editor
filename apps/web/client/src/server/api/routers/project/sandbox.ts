import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { VercelSandboxProvider } from '@onlook/code-provider/vercel-sandbox';
import { getSandboxPreviewUrl, SandboxTemplates, Templates } from '@onlook/constants';
import { shortenUuid } from '@onlook/utility/src/id';

import { createTRPCRouter, protectedProcedure } from '../../trpc';
import { listAccessibleSandboxIds, verifySandboxAccess } from './helper';

async function getProvider({ sandboxId }: { sandboxId: string; userId?: string }) {
    const provider = new VercelSandboxProvider({ sandboxId });
    await provider.initialize({});
    return provider;
}

/** Provider methods the browser may call through `sandbox.call`; all take `{ args }`. */
const REMOTE_METHODS = [
    'writeFile',
    'renameFile',
    'statFile',
    'deleteFiles',
    'listFiles',
    'readFile',
    'copyFiles',
    'createDirectory',
    'runCommand',
    'gitStatus',
    'setup',
    'reload',
] as const;

export const sandboxRouter = createTRPCRouter({
    create: protectedProcedure
        .input(
            z.object({
                title: z.string().optional(),
            }),
        )
        .mutation(async ({ input }) => {
            // Create a new sandbox using the static provider
            // Use the empty Next.js template
            const template = SandboxTemplates[Templates.EMPTY_NEXTJS];

            const newSandbox = await VercelSandboxProvider.createProject({
                source: 'template',
                id: template.id,
                title: input.title || 'Onlook Test Sandbox',
                description: 'Test sandbox for Onlook sync engine',
                tags: ['onlook-test'],
            });

            return {
                sandboxId: newSandbox.id,
                previewUrl: getSandboxPreviewUrl(newSandbox.id, template.port),
            };
        }),

    start: protectedProcedure
        .input(
            z.object({
                sandboxId: z.string(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            const userId = ctx.user.id;
            await verifySandboxAccess(ctx.db, userId, input.sandboxId);
            const provider = await getProvider({
                sandboxId: input.sandboxId,
                userId,
            });
            const session = await provider.createSession({
                args: {
                    id: shortenUuid(userId, 20),
                },
            });
            await provider.destroy();
            return session;
        }),
    call: protectedProcedure
        .input(
            z.object({
                sandboxId: z.string(),
                method: z.enum(REMOTE_METHODS),
                args: z.record(z.string(), z.unknown()).default({}),
                // binary writes arrive base64-encoded
                base64Content: z.string().optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            await verifySandboxAccess(ctx.db, ctx.user.id, input.sandboxId);
            const provider = await getProvider({ sandboxId: input.sandboxId });
            const args = { ...input.args } as Record<string, unknown>;
            if (input.base64Content !== undefined) {
                args.content = new Uint8Array(Buffer.from(input.base64Content, 'base64'));
            }
            if (input.method === 'reload') return provider.reload();
            if (input.method === 'readFile') {
                const { file } = await provider.readFile({ args: args as { path: string } });
                return file.type === 'binary'
                    ? { type: 'binary' as const, path: file.path, base64: file.toString() }
                    : { type: 'text' as const, path: file.path, content: file.content };
            }
            // Each remaining method takes `{ args }` with the shape the browser provider sent.
            const fn = provider[input.method] as (i: { args: unknown }) => Promise<unknown>;
            return fn.call(provider, { args });
        }),
    mtimes: protectedProcedure
        .input(
            z.object({
                sandboxId: z.string(),
                path: z.string(),
                excludes: z.array(z.string()).optional(),
            }),
        )
        .query(async ({ input, ctx }) => {
            await verifySandboxAccess(ctx.db, ctx.user.id, input.sandboxId);
            const provider = await getProvider({ sandboxId: input.sandboxId });
            return provider.listMtimes(input.path, input.excludes);
        }),
    devLog: protectedProcedure
        .input(z.object({ sandboxId: z.string() }))
        .query(async ({ input, ctx }) => {
            await verifySandboxAccess(ctx.db, ctx.user.id, input.sandboxId);
            const provider = await getProvider({ sandboxId: input.sandboxId });
            const { task } = await provider.getTask({ args: { id: 'dev' } });
            return task.open();
        }),
    hibernate: protectedProcedure
        .input(
            z.object({
                sandboxId: z.string(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            await verifySandboxAccess(ctx.db, ctx.user.id, input.sandboxId);
            const provider = await getProvider({ sandboxId: input.sandboxId });
            try {
                await provider.pauseProject({});
            } finally {
                await provider.destroy().catch(() => {});
            }
        }),
    list: protectedProcedure.input(z.object({ sandboxId: z.string() })).query(async ({ input, ctx }) => {
        await verifySandboxAccess(ctx.db, ctx.user.id, input.sandboxId);
        const provider = await getProvider({ sandboxId: input.sandboxId });
        const res = await provider.listProjects({});
        // TODO future iteration of code provider abstraction will need this code to be refactored
        if ('projects' in res) {
            // `listProjects` returns the entire account's sandboxes. Scope the
            // result to the caller's own so this can't enumerate other tenants'
            // sandboxes (the input id doesn't constrain the provider output).
            const accessible = await listAccessibleSandboxIds(ctx.db, ctx.user.id);
            const projectList = res.projects as Array<{ id: string }>;
            return projectList.filter((project) => accessible.has(project.id));
        }
        return [];
    }),
    fork: protectedProcedure
        .input(
            z.object({
                sandbox: z.object({
                    id: z.string(),
                    port: z.number(),
                }),
                config: z
                    .object({
                        title: z.string().optional(),
                        tags: z.array(z.string()).optional(),
                    })
                    .optional(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            // Forking a sandbox tied to another user's project would clone their
            // source tree. Templates / fresh sandboxes resolve to no project and
            // are allowed (blank-project + local-import flows fork a template).
            await verifySandboxAccess(ctx.db, ctx.user.id, input.sandbox.id);
            const MAX_RETRY_ATTEMPTS = 3;
            let lastError: Error | null = null;

            for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
                try {
                    const sandbox = await VercelSandboxProvider.createProject({
                        source: 'template',
                        id: input.sandbox.id,

                        // Metadata
                        title: input.config?.title,
                        tags: input.config?.tags,
                    });

                    const previewUrl = getSandboxPreviewUrl(sandbox.id, input.sandbox.port);

                    return {
                        sandboxId: sandbox.id,
                        previewUrl,
                    };
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));

                    if (attempt < MAX_RETRY_ATTEMPTS) {
                        await new Promise((resolve) =>
                            setTimeout(resolve, Math.pow(2, attempt) * 1000),
                        );
                    }
                }
            }

            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: `Failed to create sandbox after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message}`,
                cause: lastError,
            });
        }),
    delete: protectedProcedure
        .input(
            z.object({
                sandboxId: z.string(),
            }),
        )
        .mutation(async ({ input, ctx }) => {
            await verifySandboxAccess(ctx.db, ctx.user.id, input.sandboxId);
            const provider = await getProvider({ sandboxId: input.sandboxId });
            try {
                await provider.stopProject({});
            } finally {
                await provider.destroy().catch(() => {});
            }
        }),
    createFromGitHub: protectedProcedure
        .input(
            z.object({
                repoUrl: z.string(),
                branch: z.string(),
            }),
        )
        .mutation(async ({ input }) => {
            const MAX_RETRY_ATTEMPTS = 3;
            const DEFAULT_PORT = 3000;
            let lastError: Error | null = null;

            for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
                try {
                    const sandbox = await VercelSandboxProvider.createProjectFromGit({
                        repoUrl: input.repoUrl,
                        branch: input.branch,
                    });

                    const previewUrl = getSandboxPreviewUrl(sandbox.id, DEFAULT_PORT);

                    return {
                        sandboxId: sandbox.id,
                        previewUrl,
                    };
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));

                    if (attempt < MAX_RETRY_ATTEMPTS) {
                        await new Promise((resolve) =>
                            setTimeout(resolve, Math.pow(2, attempt) * 1000),
                        );
                    }
                }
            }

            throw new TRPCError({
                code: 'INTERNAL_SERVER_ERROR',
                message: `Failed to create GitHub sandbox after ${MAX_RETRY_ATTEMPTS} attempts: ${lastError?.message}`,
                cause: lastError,
            });
        }),
});
