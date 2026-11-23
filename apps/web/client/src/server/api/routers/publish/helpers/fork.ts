import type { Provider } from '@onlook/code-provider';
import { VercelSandboxProvider } from '@onlook/code-provider/vercel-sandbox';

export async function forkBuildSandbox(
    sandboxId: string,
    userId: string,
    deploymentId: string,
): Promise<{ provider: Provider; sandboxId: string }> {
    const project = await VercelSandboxProvider.createProject({
        source: 'template',
        id: sandboxId,
        title: 'Deployment Fork of ' + sandboxId,
        description: 'Forked sandbox for deployment',
        tags: ['deployment', 'preview', userId, deploymentId],
    });

    const forkedProvider = new VercelSandboxProvider({ sandboxId: project.id });
    await forkedProvider.initialize({});

    return {
        provider: forkedProvider,
        sandboxId: project.id,
    };
}
