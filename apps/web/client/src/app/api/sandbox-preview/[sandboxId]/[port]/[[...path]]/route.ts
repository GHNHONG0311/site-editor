import { verifySandboxAccess } from '@/server/api/routers/project/helper';
import { isAllowedEmail } from '@/utils/allowed-email';
import { createClient } from '@/utils/supabase/server';
import { VercelSandboxProvider } from '@onlook/code-provider/vercel-sandbox';
import { db } from '@onlook/db/src/client';
import { type NextRequest } from 'next/server';

export const maxDuration = 300; // first wake may install deps and boot `next dev`

/**
 * Stable preview URL for a sandbox. Vercel Sandbox domains change between sessions, so frames
 * store this URL; it wakes the sandbox, makes sure the dev server runs, and redirects.
 */
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ sandboxId: string; port: string; path?: string[] }> },
) {
    const { sandboxId, path } = await params;
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user || !isAllowedEmail(user.email)) return new Response('Unauthorized', { status: 401 });
    try {
        await verifySandboxAccess(db, user.id, sandboxId);
    } catch {
        return new Response('Not found', { status: 404 });
    }

    const provider = new VercelSandboxProvider({ sandboxId });
    await provider.initialize({});
    const { previewUrl } = await provider.ensureRunning();
    const target = new URL(`/${(path ?? []).join('/')}`, previewUrl);
    target.search = req.nextUrl.search;
    return Response.redirect(target.toString(), 307);
}
