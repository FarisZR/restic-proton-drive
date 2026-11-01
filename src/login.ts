import type { Auth } from 'proton-drive-sdk-account';

export async function headlessLogin(auth: Pick<Auth, 'authViaWeb'>, print: (line: string) => void = console.log, signal?: AbortSignal) {
    print('Open this URL on any device and complete sign-in, including 2FA.');
    print('Keep this command running. Proton sends approval directly; no redirect URL needs to be pasted.');
    await auth.authViaWeb(url => { print(url); }, signal);
}
