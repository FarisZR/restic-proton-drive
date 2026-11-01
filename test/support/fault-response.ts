import { isCodeOk } from '../../sdk/client/js/src/internal/apiService/errorCodes';

export function confirmedMutation(result: any, requestedIds?: readonly string[]): boolean {
    if (!isCodeOk(result?.Code)) return false;
    if (!requestedIds) return true;
    if (!Array.isArray(result.Responses) || result.Responses.length !== requestedIds.length) return false;
    const expected = new Set(requestedIds);
    if (expected.size !== requestedIds.length) return false;
    for (const item of result.Responses)
        if (!expected.delete(item.LinkID) || !isCodeOk(item.Response?.Code) || item.Response?.Error) return false;
    return expected.size === 0;
}
