import { Language } from '@onlook/constants';
import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

export default getRequestConfig(async () => {
    const locale = await getLanguage();
    return {
        locale,
        messages: (await import(`../../messages/${locale}.json`)).default,
    };
});

export async function getLanguage(): Promise<Language> {
    const cookieStore = await cookies();
    const locale = cookieStore.get('locale');

    // Default to Chinese; the language picker still sets the cookie.
    return (locale?.value as Language | undefined) ?? Language.Chinese;
}
