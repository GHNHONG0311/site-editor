'use client';

import { LocalForageKeys } from '@/utils/constants';
import { sanitizeReturnUrl } from '@/utils/url';
import localforage from 'localforage';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

// Login is already limited by the email allowlist, so there is no subscription gate here.
export default function AuthRedirect() {
    const router = useRouter();

    useEffect(() => {
        const handleRedirect = async () => {
            const returnUrl = await localforage.getItem<string>(LocalForageKeys.RETURN_URL);
            await localforage.removeItem(LocalForageKeys.RETURN_URL);
            router.replace(sanitizeReturnUrl(returnUrl));
        };
        handleRedirect();
    }, [router]);

    return (
        <div className="flex h-screen w-screen items-center justify-center">
            <p className="text-foreground-secondary">正在进入…</p>
        </div>
    );
}
