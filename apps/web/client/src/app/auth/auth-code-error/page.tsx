import Link from 'next/link';

// The auth callback redirects here when the login link cannot be completed.
export default function AuthCodeErrorPage() {
    return (
        <main className="flex h-screen flex-col items-center justify-center gap-4 p-6 text-center">
            <h1 className="text-xl">登录没有成功</h1>
            <p className="text-foreground-secondary max-w-md text-sm">
                登录链接可能已经用过或过期了，请回到登录页重新发送一次，并在同一个浏览器里打开邮件中的链接。
            </p>
            <Link href="/login" className="underline">
                回到登录页
            </Link>
        </main>
    );
}
