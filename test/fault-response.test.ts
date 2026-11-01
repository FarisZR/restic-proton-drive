import { expect, test } from 'bun:test';
import { confirmedMutation } from './support/fault-response';

test('live checkpoint accepts Proton multi-status success only when every requested object succeeds', () => {
    expect(confirmedMutation({ Code: 1000 })).toBe(true);
    expect(confirmedMutation({ Code: 1001, Responses: [{ LinkID: 'a', Response: { Code: 1000 } }] }, ['a'])).toBe(true);
    for (const result of [
        { Code: 1002 }, { Code: 5000 }, {},
        { Code: 1001, Responses: [] },
        { Code: 1001, Responses: [{ LinkID: 'b', Response: { Code: 1000 } }] },
        { Code: 1001, Responses: [{ LinkID: 'a', Response: { Code: 2500 } }] },
        { Code: 1001, Responses: [{ LinkID: 'a', Response: { Code: 1000, Error: 'failed' } }] },
    ]) expect(confirmedMutation(result, ['a'])).toBe(false);
    expect(confirmedMutation({ Code: 1001, Responses: [{ LinkID: 'a', Response: { Code: 1000 } }, { LinkID: 'a', Response: { Code: 1000 } }] }, ['a', 'b'])).toBe(false);
});
