import { trackEvent } from '@/utils/analytics/server';
import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';
import { NextResponse } from 'next/server';
import { api } from '~/trpc/server';

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get('code');

    if (code) {
        const supabase = await createClient();
        const { error, data } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
            // A database failure must land on the error page, not a bare 500.
            const user = await api.user
                .upsert({ id: data.user.id })
                .catch((e: unknown) => {
                    console.error('User upsert failed', e);
                    return null;
                });

            if (!user) {
                console.error(`Failed to create user for id: ${data.user.id}`, { user });
                return NextResponse.redirect(`${origin}/auth/auth-code-error`);
            }

            trackEvent({
                distinctId: data.user.id,
                event: 'user_signed_in',
                properties: {
                    name: data.user.user_metadata.name,
                    email: data.user.email,
                    avatar_url: data.user.user_metadata.avatar_url,
                    $set_once: {
                        signup_date: new Date().toISOString(),
                    }
                }
            });

            // Always use the request origin to prevent open redirect via X-Forwarded-Host header manipulation
            return NextResponse.redirect(`${origin}${Routes.AUTH_REDIRECT}`);
        }
        console.error(`Error exchanging code for session: ${error}`);
        // A repeated hit on the same link (double load, mail-app prefetch) fails here even though
        // the first one already signed the user in; send them on instead of to the error page.
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (user) {
            return NextResponse.redirect(`${origin}${Routes.AUTH_REDIRECT}`);
        }
    }

    // return the user to an error page with instructions
    return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}
