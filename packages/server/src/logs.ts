// What the request log may show of an address: everything but the values that open something.

/** Query values that open something (the "forgot your password?" link, codes for one use, keys) and the key in the
 *  path of the internal git server are replaced by "[hidden]". */
export function hideSecrets(url: string): string {
  return String(url ?? '')
    .replace(/([?&](?:t|code|token|key)=)[^&#]*/gi, '$1[hidden]')
    .replace(/^(\/git\/)[^/]+/, '$1[hidden]');
}
