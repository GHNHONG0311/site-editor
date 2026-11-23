import { env } from '@/env';

/** True when ALLOWED_LOGIN_EMAILS is unset (open, e.g. local dev) or lists this email. */
export function isAllowedEmail(email: string | null | undefined): boolean {
    const allowed = (env.ALLOWED_LOGIN_EMAILS ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
    if (allowed.length === 0) return true;
    return !!email && allowed.includes(email.trim().toLowerCase());
}
