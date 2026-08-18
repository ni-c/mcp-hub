import fs from 'node:fs';
import path from 'node:path';

/**
 * Environment files the *proxy* owns.
 *
 * This is what keeps a sandbox's credentials out of the hub: the hub's config
 * only names a secret set (`"secretsFrom": "scraper"`), and the proxy appends the
 * actual variables to the create request after it has validated it. The hub
 * process — and therefore every stdio child running under the same uid, which
 * can read /proc/1/environ — never sees them.
 */

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_SECRET_FILE_BYTES = 64 * 1024;
export const MAX_SECRET_ENTRIES = 100;

export class SecretError extends Error {}

export function parseEnvFile(content: string): Record<string, string> {
  if (content.includes('\0')) throw new SecretError('contains a NUL byte');
  const result: Record<string, string> = {};
  let entries = 0;
  for (const [index, raw] of content.split('\n').entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator === -1) throw new SecretError(`line ${index + 1} is not KEY=VALUE`);
    const key = withoutExport.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) throw new SecretError(`line ${index + 1} has an invalid variable name "${key}"`);
    if (Object.hasOwn(result, key)) throw new SecretError(`line ${index + 1} duplicates variable "${key}"`);
    if (++entries > MAX_SECRET_ENTRIES) throw new SecretError(`contains more than ${MAX_SECRET_ENTRIES} variables`);
    let value = withoutExport.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

export class SecretStore {
  constructor(private readonly dir: string) {}

  /** Absolute path of a secret set, refusing anything that escapes the directory. */
  pathFor(name: string): string {
    if (!NAME_PATTERN.test(name)) throw new SecretError(`invalid secret set name "${name}"`);
    const file = path.resolve(this.dir, `${name}.env`);
    if (path.dirname(file) !== path.resolve(this.dir)) throw new SecretError(`secret set "${name}" escapes ${this.dir}`);
    return file;
  }

  load(name: string): Record<string, string> {
    const file = this.pathFor(name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw new SecretError(`secret file ${file} does not exist`);
    }
    if (stat.isSymbolicLink()) throw new SecretError(`secret file ${file} must not be a symlink`);
    if (!stat.isFile()) throw new SecretError(`secret file ${file} is not a regular file`);
    if (stat.size > MAX_SECRET_FILE_BYTES) {
      throw new SecretError(`secret file ${file} exceeds ${MAX_SECRET_FILE_BYTES} bytes`);
    }
    // Owner read/write and group read are sufficient. Reject group write,
    // every permission for other users, and execute bits.
    if (stat.mode & 0o137) {
      throw new SecretError(`secret file ${file} is world-readable or has otherwise unsafe permissions (use chmod 640 or stricter)`);
    }
    try {
      const content = fs.readFileSync(file);
      if (content.length > MAX_SECRET_FILE_BYTES) {
        throw new SecretError(`secret file ${file} exceeds ${MAX_SECRET_FILE_BYTES} bytes`);
      }
      return parseEnvFile(content.toString('utf8'));
    } catch (error) {
      if (error instanceof SecretError) throw new SecretError(`${file}: ${error.message}`);
      throw new SecretError(`cannot read ${file}: ${(error as Error).message}`);
    }
  }
}

/** Validate every referenced set as one atomic policy operation. */
export function validateConfigSecrets(config: import('../config.js').HubConfig, store: SecretStore): void {
  for (const [name, entry] of config) {
    if (entry.kind !== 'docker' || entry.secretsFrom === undefined) continue;
    try {
      const secrets = store.load(entry.secretsFrom);
      const collision = Object.keys(secrets).find(key => Object.hasOwn(entry.env, key));
      if (collision) throw new SecretError(`secret "${collision}" collides with a configured env key`);
    } catch (error) {
      throw new SecretError(`server "${name}": ${(error as Error).message}`);
    }
  }
}
