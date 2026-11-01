import { expect, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { Auth, AccountApiError } from 'proton-drive-sdk-account';
import { headlessLogin } from '../src/login';

// Emulate Proton's browser-approved fork: login/2FA stays in the browser,
// and the headless client receives an authenticated encrypted session payload.
test('headless browser approval supports pending 2FA without a callback listener or redirect paste', async () => {
    let approved = false;
    let polls = 0;
    let payload = '';
    const stored: Record<string, unknown> = {};
    const auth = new Auth('external-drive', {
        async sessionForksInit() { return { UserCode: 'browser-code', Selector: 'poll-selector' }; },
        async sessionForksStatus(selector: string) {
            expect(selector).toBe('poll-selector');
            if (polls++ === 0) {
                approved = true;
                throw new AccountApiError('Approval pending', { httpCode: 422, debug: { Error: 'Awaiting second factor' } });
            }
            expect(approved).toBe(true);
            return { Payload: payload, UID: 'test-uid', AccessToken: 'access', RefreshToken: 'refresh' };
        },
        async settings() { return {}; },
    } as any, {
        async setUserKeyPassword(value: string) { stored.password = value; },
        async setSessionInfo(value: unknown) { stored.session = value; },
        async setTelemetryEnabled() {},
    } as any, {} as any, { debug() {}, info() {}, warn() {}, error() {} });
    const lines: string[] = [];
    await headlessLogin(auth, line => {
        lines.push(line);
        if (!line.startsWith('https:')) return;
        const url = new URL(line);
        expect(url.hostname).toBe('account.proton.me');
        const challenge = new URLSearchParams(url.hash.slice(1)).get('payload')!.split(':');
        expect(challenge[1]).toBe('browser-code');
        const key = Buffer.from(challenge[2], 'base64');
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(Buffer.from('fork'));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ keyPassword: 'browser-decrypted-key-password' })), cipher.final()]);
        payload = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
        // A user completes the password and second factor on another device.
    });
    expect(lines.some(line => line.includes('any device'))).toBe(true);
    expect(polls).toBe(2);
    expect(stored.password).toBe('browser-decrypted-key-password');
    expect(stored.session).toEqual({ uid: 'test-uid', accessToken: 'access', refreshToken: 'refresh' });
}, 15000);

test('headless approval can be canceled while waiting', async () => {
    const controller = new AbortController();
    const auth = new Auth('external-drive', { async sessionForksInit() { return { UserCode: 'code', Selector: 'selector' }; } } as any,
        {} as any, {} as any, { debug() {}, info() {}, warn() {}, error() {} });
    await expect(headlessLogin(auth, () => { controller.abort(new Error('canceled')); }, controller.signal)).rejects.toThrow();
});
