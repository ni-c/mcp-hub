/**
 * The three lines every fixture in this directory would otherwise repeat.
 *
 * Kept deliberately tiny. A fixture has to be readable on its own — the whole
 * value of a `.mjs` file with no build step is that you can see what it does
 * without following it anywhere — so anything that would need explaining stays
 * in the fixture that needs it.
 */

/** A non-negative integer from the environment, or the fallback. */
export function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function envFlag(name) {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
