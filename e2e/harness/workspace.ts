import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The directories one gateway owns, and the way its config is replaced.
 *
 * `config/` is a directory rather than a single file on purpose, twice over.
 * The hub warns about a single-file bind mount because `fs.watch` never fires
 * for one — an editor saves by writing a new inode and renaming over the old
 * name, and a mount that points at the old inode keeps showing the old
 * contents. The suite has to reproduce the shape a deployment is told to use,
 * and it has to exercise the rename path, which is the one hot reload actually
 * sees in the field.
 */
export interface Workspace {
  root: string;
  config: string;
  configPath: string;
  data: string;
  servers: string;
  /** Replaces mcp.json the way an editor does: write elsewhere, rename over. */
  writeConfig(servers: Record<string, unknown>): void;
  /** Writes mcp.json in place, byte by byte — the other half of the watcher. */
  writeConfigInPlace(servers: Record<string, unknown>): void;
  /** Drops a file into the config directory, for the malformed-config cases. */
  writeRaw(name: string, contents: string): void;
  remove(): void;
}

export function makeWorkspace(prefix: string): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mcp-hub-e2e-${prefix}-`));
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  const servers = path.join(root, 'servers');
  for (const dir of [config, data, servers]) fs.mkdirSync(dir, { recursive: true });
  // The container runs as uid 1000 against a bind mount owned by whoever ran
  // the tests. Group- and world-readable so the docker tier can read the same
  // directories without a chown step nobody would remember to undo.
  fs.chmodSync(root, 0o755);
  const configPath = path.join(config, 'mcp.json');

  const write = (servers_: Record<string, unknown>, viaRename: boolean): void => {
    const body = `${JSON.stringify({ mcpServers: servers_ }, null, 2)}\n`;
    if (!viaRename) {
      fs.writeFileSync(configPath, body, { mode: 0o644 });
      return;
    }
    const staged = path.join(config, `.mcp.json.${process.pid}.${fs.readdirSync(config).length}`);
    fs.writeFileSync(staged, body, { mode: 0o644 });
    fs.renameSync(staged, configPath);
  };

  return {
    root,
    config,
    configPath,
    data,
    servers,
    writeConfig: s => write(s, true),
    writeConfigInPlace: s => write(s, false),
    writeRaw: (name, contents) => fs.writeFileSync(path.join(config, name), contents, { mode: 0o644 }),
    remove: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

/** Where a spawned or containerised hub finds the built code. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
export const DIST_STDIO = path.join(REPO_ROOT, 'dist', 'stdio.js');
export const DIST_ADMIN = path.join(REPO_ROOT, 'dist', 'admin.js');
export const DIST_DOCKER_PROXY = path.join(REPO_ROOT, 'dist', 'docker-proxy', 'index.js');

/**
 * Refuses to run against a build that predates the source.
 *
 * The spawned tiers run `dist/`, and the single most expensive way to lose an
 * hour on this suite is to fix something in `src/`, watch the test fail exactly
 * as before, and conclude the fix was wrong. Checked in the preflight and again
 * in `startGateway`, because a suite run with `-t` skips the preflight file.
 */
export function assertBuildIsFresh(): void {
  if (!fs.existsSync(DIST_ENTRY)) {
    throw new Error(`mcp-hub e2e: ${DIST_ENTRY} does not exist. Run npm run build.`);
  }
  const built = fs.statSync(DIST_ENTRY).mtimeMs;
  const newest = newestMtime(path.join(REPO_ROOT, 'src'));
  if (newest > built) {
    throw new Error(
      `mcp-hub e2e: dist/ is older than src/ (${new Date(newest).toISOString()} > ` +
        `${new Date(built).toISOString()}). Run npm run build — the spawned and ` +
        'containerised tiers execute dist/, so a stale build tests the old code ' +
        'while showing you the new source.'
    );
  }
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const stat = fs.statSync(path.join(entry.parentPath, entry.name));
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}
