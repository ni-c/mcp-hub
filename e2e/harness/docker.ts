import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Whether this machine can host the docker tier — and whether it was supposed
 * to.
 *
 * The existing `test/docker-e2e.test.ts` probes the socket and skips without
 * one, which is right locally and useless in CI: a skip and a pass render as
 * the same green tick, so a runner that lost its daemon would keep reporting
 * that the sandbox transport works. The probe stays; what is added is the
 * ability to say "this environment was supposed to have a daemon", and to fail
 * loudly when it does not.
 */
export const DOCKER_SOCKET = '/var/run/docker.sock';

export const hasDockerSocket = ((): boolean => {
  try {
    // accessSync returns undefined on success and throws on failure.
    return fs.statSync(DOCKER_SOCKET).isSocket() && fs.accessSync(DOCKER_SOCKET, fs.constants.R_OK | fs.constants.W_OK) === undefined;
  } catch {
    return false;
  }
})();

/** Set in the nightly's docker job, and nowhere else. Never in ci.yml. */
export function dockerWasPromised(): boolean {
  return process.env.MCPHUB_EXPECT_DOCKER === '1';
}

/**
 * Proves the daemon and compose are really there.
 *
 * Throws rather than returning false: called from the preflight, where a
 * failure has to be a failure. A socket that exists but belongs to a daemon
 * that is not answering is the case the socket probe alone cannot see.
 */
export async function assertDockerUsable(): Promise<void> {
  if (!hasDockerSocket) {
    throw new Error(
      `mcp-hub e2e: ${DOCKER_SOCKET} is not a readable, writable socket, but the ` +
        'docker tier was requested. This environment was supposed to have a daemon; ' +
        'a silent skip here would report green for a tier that ran nothing.'
    );
  }
  for (const args of [['version', '--format', '{{.Server.Version}}'], ['compose', 'version', '--short']]) {
    try {
      await run('docker', args, { timeout: 30_000 });
    } catch (error) {
      throw new Error(`mcp-hub e2e: \`docker ${args.join(' ')}\` failed: ${String(error)}`);
    }
  }
}

export async function docker(args: string[], options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const { stdout } = await run('docker', args, {
    timeout: options.timeoutMs ?? 180_000,
    cwd: options.cwd,
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024
  });
  return stdout;
}
