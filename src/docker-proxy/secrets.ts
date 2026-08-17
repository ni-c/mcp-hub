import fs from 'node:fs';
import path from 'node:path';

/**
 * Environment files the *proxy* owns.
 *
 * This is what keeps a sandbox's credentials out of the hub: the hub's config
 * only names a secret set (`"secretsFrom": "eve"`), and the proxy appends the
 * actual variables to the create request after it has validated it. The hub
 * process — and therefore every stdio child running under the same uid, which
 * can read /proc/1/environ — never sees them.
 */

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class SecretError extends Error {}

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, raw] of content.split('\n').entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator === -1) throw new SecretError(`line ${index + 1} is not KEY=VALUE`);
    const key = withoutExport.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) throw new SecretError(`line ${index + 1} has an invalid variable name "${key}"`);
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
      stat = fs.statSync(file);
    } catch {
      throw new SecretError(`secret file ${file} does not exist`);
    }
    if (!stat.isFile()) throw new SecretError(`secret file ${file} is not a regular file`);
    // Group-readable is normal (the operator mounts it); world-readable means
    // every process on the host can read the sandbox's credentials.
    if (stat.mode & 0o004) throw new SecretError(`secret file ${file} is world-readable (chmod 640)`);
    try {
      return parseEnvFile(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error instanceof SecretError) throw new SecretError(`${file}: ${error.message}`);
      throw new SecretError(`cannot read ${file}: ${(error as Error).message}`);
    }
  }
}
