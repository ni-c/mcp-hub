import crypto from 'node:crypto';

/** Above this the page cannot show a call in full, so it offers no "only this call" for it. */
export const ARGS_DISPLAY_LIMIT = 2048;

/** Sorted keys, own properties only, built as a string so a "__proto__" key is kept and shown. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).toSorted();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export function canonicalArgs(args: unknown): string {
  return canonicalJson(args ?? {});
}

export function argsHash(canonical: string): string {
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

export function fitsOnPage(canonical: string): boolean {
  return Buffer.byteLength(canonical) <= ARGS_DISPLAY_LIMIT;
}
