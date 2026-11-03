import { matches } from '../tool-filter.js';

/** `unlock` in mcp.json: the locked tools and the longest unlock. */
export interface UnlockPolicy {
  tools: string[];
  maxMinutes: number;
}

export interface UnlockConfig {
  unlock?: UnlockPolicy;
}

export const UNLOCK_MAX_MINUTES = 240;
export const UNLOCK_PRESETS: readonly number[] = [15, 30, 60, 120, 240];
export const UNLOCK_DEFAULT_MINUTES = 30;

export type UnlockDuration = 'once' | number;

export function locksWholeServer(policy: UnlockPolicy | undefined): boolean {
  return policy?.tools.includes('*') ?? false;
}

export function locksTool(policy: UnlockPolicy | undefined, tool: string): boolean {
  return policy !== undefined && matches(policy.tools, tool);
}

/** The durations the page offers, up to the cap. */
export function durationChoices(policy: UnlockPolicy, hasCall: boolean): UnlockDuration[] {
  const minutes = UNLOCK_PRESETS.filter(preset => preset <= policy.maxMinutes);
  if (policy.maxMinutes > 0 && !minutes.includes(policy.maxMinutes)) minutes.push(policy.maxMinutes);
  return [...(hasCall ? (['once'] as const) : []), ...minutes];
}

/** The duration preselected on the page. */
export function defaultDuration(choices: readonly UnlockDuration[]): UnlockDuration | undefined {
  const minutes = choices.filter((choice): choice is number => choice !== 'once');
  if (minutes.includes(UNLOCK_DEFAULT_MINUTES)) return UNLOCK_DEFAULT_MINUTES;
  return minutes.filter(choice => choice < UNLOCK_DEFAULT_MINUTES).at(-1) ?? minutes[0] ?? choices[0];
}

/** Patterns that match none of the server's tools. */
export function unmatchedUnlockPatterns(policy: UnlockPolicy | undefined, tools: readonly { name: string }[]): string[] {
  if (!policy) return [];
  return policy.tools.filter(pattern => pattern !== '*' && !tools.some(tool => matches([pattern], tool.name)));
}

/** "all tools" or the list, for log lines and pages. */
export function describeLock(policy: UnlockPolicy): string {
  return locksWholeServer(policy) ? 'all tools' : policy.tools.join(', ');
}
