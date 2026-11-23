'use client';

import { Button } from '@onlook/ui/button';
import { Input } from '@onlook/ui/input';
import { useState } from 'react';
import { emailLogin } from './actions';

export function EmailLogin() {
    const [email, setEmail] = useState('');
    const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setStatus('sending');
        setError(null);
        const res = await emailLogin(email);
        if (res.ok) {
            setStatus('sent');
        } else {
            setStatus('idle');
            setError(res.error ?? '登录失败');
        }
    };

    if (status === 'sent') {
        return <p className="text-regular">登录链接已发到 {email}，请打开邮件点击链接。</p>;
    }

    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <label htmlFor="login-email" className="text-small">
                邮箱
            </label>
            <Input
                id="login-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
            />
            <Button type="submit" disabled={status === 'sending'}>
                {status === 'sending' ? '发送中…' : '发送登录链接'}
            </Button>
            {error && (
                <p role="alert" className="text-small text-red-500">
                    {error}
                </p>
            )}
        </form>
    );
}
