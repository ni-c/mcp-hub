import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether this module is the entry point node was started with.
 *
 * The obvious check — does `import.meta.url` end with the basename of
 * `process.argv[1]` — is wrong for an installed package: npm links a `bin`
 * entry as `node_modules/.bin/<name>`, a symlink whose basename is the command
 * name, not the file name. `npx @ni-c/mcp-hub` therefore matched nothing and
 * the process exited silently with status 0, doing nothing at all.
 *
 * Comparing real paths handles both: `node dist/index.js` and the symlink
 * resolve to the same file, and `import.meta.url` is already a real path.
 * A missing or unreadable argv[1] simply means "not the entry point".
 */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}
