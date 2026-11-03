import crypto from 'node:crypto';

/** Calls larger than this get no "only this call". */
export const ARGS_DISPLAY_LIMIT = 2048;

/** Sorted own keys, built as a string so "__proto__" survives. */
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
