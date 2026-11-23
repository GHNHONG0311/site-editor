import type { SandboxTemplate } from '@onlook/models';

export enum Templates {
    BLANK = 'BLANK',
    EMPTY_NEXTJS = 'EMPTY_NEXTJS',
}

export const SandboxTemplates: Record<Templates, SandboxTemplate> = {
    BLANK: {
        id: 'xzsy8c',
        port: 3000,
    },
    EMPTY_NEXTJS: {
        id: 'pt_EphPmsurimGCQdiB44wa7s',
        port: 3000,
    },
};

export const CSB_PREVIEW_TASK_NAME = 'dev';
export const CSB_DOMAIN = 'csb.app';

/**
 * Stable preview URL served by this app. It wakes the Vercel Sandbox and redirects to its
 * current domain, which changes between sandbox sessions.
 */
export function getSandboxPreviewUrl(sandboxId: string, port: number) {
    const base = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
    return `${base}/api/sandbox-preview/${sandboxId}/${port}`;
}
