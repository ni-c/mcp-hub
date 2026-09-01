import fs from 'node:fs';
import path from 'node:path';

import { docker } from './docker.js';
import { REPO_ROOT, type Workspace } from './workspace.js';

/**
 * The published image, run the way the README tells people to run it.
 *
 * `demo/compose.yml` is never edited. It is a file the project asks strangers
 * to `docker compose up`, so a suite that had to change it in order to test it
 * would be testing something nobody runs. Everything this tier needs — a port
 * that does not collide, a config it can rewrite, a fixture fleet — arrives
 * through a generated override file passed as a second `-f`.
 *
 * Two details in the override are load-bearing rather than convenient:
 *
 *   - the fixtures are mounted at `/app/e2e-servers`, not at `/e2e-servers`.
 *     Node resolves `@modelcontextprotocol/server` and `zod` by walking up from
 *     the script, so only a path *under* `/app` finds `/app/node_modules`. It
 *     is the same trick `demo/Dockerfile` uses for its own servers, and a
 *     fixture mounted anywhere else fails with a module-not-found that looks
 *     like a broken image.
 *   - the bind works despite `read_only: true`, because a read-only root
 *     filesystem says nothing about what may be mounted into it. Worth knowing
 *     before spending an hour deciding the demo cannot be extended.
 */

export const DEMO_DIR = path.join(REPO_ROOT, 'demo');
export const COMPOSE_FILE = path.join(DEMO_DIR, 'compose.yml');
/** Built by the nightly job, or by hand with `docker build -t mcp-hub:e2e .`. */
export const IMAGE = process.env.MCPHUB_E2E_IMAGE ?? 'mcp-hub:e2e';

export interface ComposeStack {
  project: string;
  port: number;
  overrideFile: string;
  logs(tail?: number): Promise<string>;
  exec(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  down(): Promise<void>;
}

export function writeOverride(workspace: Workspace, project: string, port: number, environment: Record<string, string>): string {
  // Written as YAML rather than JSON so the `!override` tags are available.
  // Compose *merges* sequence-valued keys instead of replacing them, which is
  // usually what you want and is wrong for both of these: appending a port
  // leaves the demo's fixed 127.0.0.1:7690 in place, so the second stack fails
  // with "port is already allocated", and appending a volume leaves two mounts
  // fighting over /config. `!override` replaces the base list outright.
  // Requires Compose 2.24 or newer.
  const lines = [
    'services:',
    '  mcp-hub:',
    '    build:',
    '      context: .',
    '      args:',
    `        BASE_IMAGE: ${IMAGE}`,
    // `demo/compose.yml` pins `container_name: mcp-hub-demo`, which is right
    // for a demo — one stack, a predictable name to exec into — and wrong here,
    // where two stacks must be able to run at once.
    `    container_name: ${project}`,
    '    ports: !override',
    `      - "127.0.0.1:${port}:80"`,
    '    volumes: !override',
    `      - "${workspace.config}:/config:ro"`,
    `      - "${workspace.servers}:/app/e2e-servers:ro"`,
    // A named volume per project, so `down -v` really is a blank slate and two
    // stacks never share credentials.
    `      - "${project}-data:/data"`,
    // So a fixture inside the container can reach an HTTP upstream the test
    // started on the host.
    '    extra_hosts:',
    '      - "host.docker.internal:host-gateway"',
    '    environment:',
    `      EXTERNAL_URL: "http://127.0.0.1:${port}"`,
    ...Object.entries(environment).map(([key, value]) => `      ${key}: ${JSON.stringify(String(value))}`),
    'volumes:',
    `  ${project}-data:`
  ];
  const file = path.join(workspace.root, 'compose.override.yml');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

export async function composeUp(project: string, overrideFile: string, timeoutMs = 300_000): Promise<void> {
  await docker(['compose', '-p', project, '-f', COMPOSE_FILE, '-f', overrideFile, 'up', '-d', '--build', '--wait'], {
    cwd: DEMO_DIR,
    timeoutMs
  });
}

export function composeStack(project: string, overrideFile: string, port: number): ComposeStack {
  const base = ['compose', '-p', project, '-f', COMPOSE_FILE, '-f', overrideFile];
  return {
    project,
    port,
    overrideFile,
    logs: async (tail = 200) => docker([...base, 'logs', '--tail', String(tail)], { cwd: DEMO_DIR }).catch(error => String(error)),
    exec: async argv => {
      try {
        const stdout = await docker([...base, 'exec', '-T', 'mcp-hub', ...argv], { cwd: DEMO_DIR });
        return { code: 0, stdout, stderr: '' };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error) };
      }
    },
    // `-v` as well as `down`: the data volume holds tokens and registrations,
    // and a stack that inherited the last run's would not be a fresh start.
    down: async () => {
      await docker([...base, 'down', '-v', '--remove-orphans'], { cwd: DEMO_DIR, timeoutMs: 120_000 }).catch(() => undefined);
    }
  };
}
