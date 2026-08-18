import http from 'node:http';
import type { Duplex } from 'node:stream';
import { OWNER_LABEL, OWNER_VALUE, serverNameFromContainer } from './container-spec.js';
import { DOCKER_POLICY_NAME, DOCKER_POLICY_PATH, DOCKER_POLICY_VERSION, type DockerPolicyHandshake } from './policy-protocol.js';

/**
 * The slice of the Docker Engine API the hub needs, over a Unix socket or TCP.
 *
 * Deliberately hand-rolled instead of pulling in dockerode: the hub is meant
 * to be small enough to audit and to run on a Pi, and everything used here is
 * five endpoints plus one connection upgrade. The upgrade is the interesting
 * part — `POST /containers/{id}/attach` hands back the raw connection, and
 * that connection is the container's stdio.
 */

const DEFAULT_SOCKET = '/var/run/docker.sock';
/** Highest API version this client was written against; older daemons win. */
const MAX_API_VERSION = '1.44';
const REQUEST_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface DockerEndpoint {
  socketPath?: string;
  host?: string;
  port?: number;
}

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

/** `unix:///var/run/docker.sock`, `/var/run/docker.sock` or `tcp://host:2375`. */
export function parseDockerHost(value?: string): DockerEndpoint {
  if (!value || value.length === 0) return { socketPath: DEFAULT_SOCKET };
  if (value.startsWith('/')) return { socketPath: value };
  if (value.startsWith('unix://')) return { socketPath: value.slice('unix://'.length) };
  if (value.startsWith('tcp://') || value.startsWith('http://')) {
    const url = new URL(value.replace(/^tcp:\/\//, 'http://'));
    return { host: url.hostname, port: Number(url.port || 2375) };
  }
  throw new Error(`DOCKER_HOST must be a unix:// path or a tcp:// address, got "${value}"`);
}

/**
 * Docker sandboxing is safe only through the matching policy proxy. An absent
 * variable used to fall back to the root-equivalent daemon socket; refuse that
 * configuration before making any request.
 */
export function parseSandboxDockerHost(value?: string): DockerEndpoint {
  if (!value) throw new Error('DOCKER_HOST is required for docker servers and must point to the mcp-hub Docker policy proxy');
  const endpoint = parseDockerHost(value);
  if (endpoint.socketPath === DEFAULT_SOCKET) {
    throw new Error('DOCKER_HOST points directly at /var/run/docker.sock; use the mcp-hub Docker policy proxy socket');
  }
  return endpoint;
}

function compareApiVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split('.').map(Number);
  const [bMajor = 0, bMinor = 0] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

export function splitImageRef(ref: string): { fromImage: string; tag: string } {
  const at = ref.indexOf('@');
  if (at !== -1) return { fromImage: ref.slice(0, at), tag: ref.slice(at + 1) };
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) return { fromImage: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { fromImage: ref, tag: 'latest' };
}

export class DockerClient {
  private apiVersion?: string;
  private policyVerified = false;

  constructor(private readonly endpoint: DockerEndpoint = { socketPath: DEFAULT_SOCKET }) {}

  describe(): string {
    return this.endpoint.socketPath ?? `${this.endpoint.host}:${this.endpoint.port}`;
  }

  /**
   * Pin the API version once per process. Unversioned requests are served by
   * whatever the daemon currently defaults to, which is a moving target for a
   * client that hard-codes field names.
   */
  private async version(): Promise<string> {
    if (this.apiVersion) return this.apiVersion;
    await this.verifyPolicyProxy();
    const info = await this.send<{ ApiVersion?: string }>('GET', '/version', { versioned: false });
    const daemon = info?.ApiVersion ?? MAX_API_VERSION;
    this.apiVersion = compareApiVersions(daemon, MAX_API_VERSION) < 0 ? daemon : MAX_API_VERSION;
    return this.apiVersion;
  }

  async verifyPolicyProxy(): Promise<void> {
    if (this.policyVerified) return;
    let handshake: DockerPolicyHandshake;
    try {
      handshake = await this.send<DockerPolicyHandshake>('GET', DOCKER_POLICY_PATH, { versioned: false });
    } catch (error) {
      throw new DockerError(
        `Docker endpoint ${this.describe()} is not a reachable mcp-hub policy proxy: ${(error as Error).message}`,
        (error as DockerError).status
      );
    }
    if (handshake?.name !== DOCKER_POLICY_NAME || handshake.daemon !== 'ok') {
      throw new DockerError(`Docker endpoint ${this.describe()} did not return a valid policy handshake`);
    }
    if (handshake.policyVersion !== DOCKER_POLICY_VERSION) {
      throw new DockerError(
        `Docker policy version mismatch: hub requires ${DOCKER_POLICY_VERSION}, proxy provides ${String(handshake.policyVersion)}`
      );
    }
    this.policyVerified = true;
  }

  private async path(path: string, query?: Record<string, string>): Promise<string> {
    const search = query ? `?${new URLSearchParams(query).toString()}` : '';
    return `/v${await this.version()}${path}${search}`;
  }

  private connectionOptions(): http.RequestOptions {
    return this.endpoint.socketPath ? { socketPath: this.endpoint.socketPath } : { host: this.endpoint.host, port: this.endpoint.port };
  }

  private send<T>(
    method: string,
    path: string,
    options: { body?: unknown; versioned?: boolean; timeoutMs?: number; expectStream?: boolean } = {}
  ): Promise<T> {
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8');
    return new Promise<T>((resolve, reject) => {
      const request = http.request(
        {
          ...this.connectionOptions(),
          method,
          path,
          headers: {
            Host: 'docker',
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': String(payload.length) } : {})
          }
        },
        response => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              response.destroy();
              reject(new DockerError(`response from ${method} ${path} exceeded ${MAX_RESPONSE_BYTES} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = response.statusCode ?? 0;
            if (status >= 400) {
              let message = text.slice(0, 500);
              try {
                message = (JSON.parse(text) as { message?: string }).message ?? message;
              } catch {
                // Not JSON; the raw body is the best message we have.
              }
              reject(new DockerError(`${method} ${path}: ${status} ${message}`, status));
              return;
            }
            if (options.expectStream) {
              // Progress streams (image pull) report failures inside the body
              // with a 200 status, so the status code alone means nothing.
              const failure = text
                .split('\n')
                .filter(Boolean)
                .map(line => {
                  try {
                    return JSON.parse(line) as { error?: string };
                  } catch {
                    return {};
                  }
                })
                .find(entry => entry.error);
              if (failure?.error) {
                reject(new DockerError(`${method} ${path}: ${failure.error}`));
                return;
              }
              resolve(undefined as T);
              return;
            }
            if (text.length === 0) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(new DockerError(`${method} ${path}: response is not JSON`));
            }
          });
        }
      );
      request.setTimeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS, () => {
        request.destroy(new DockerError(`${method} ${path}: timed out`));
      });
      request.on('error', error => reject(new DockerError(`${method} ${path}: ${(error as Error).message}`)));
      if (payload) request.write(payload);
      request.end();
    });
  }

  async ping(): Promise<void> {
    await this.version();
  }

  async createContainer(name: string, body: Record<string, unknown>): Promise<string> {
    const created = await this.send<{ Id: string }>('POST', await this.path('/containers/create', { name }), { body });
    return created.Id;
  }

  async startContainer(id: string): Promise<void> {
    await this.send('POST', await this.path(`/containers/${encodeURIComponent(id)}/start`));
  }

  async removeContainer(id: string): Promise<void> {
    try {
      await this.send('DELETE', await this.path(`/containers/${encodeURIComponent(id)}`, { force: '1', v: '0' }));
    } catch (error) {
      // 404 (already gone) and 409 (removal already in progress, which is what
      // AutoRemove looks like from here) are the normal endings, not failures.
      const status = (error as DockerError).status;
      if (status !== 404 && status !== 409) throw error;
    }
  }

  async imageExists(ref: string): Promise<boolean> {
    try {
      await this.send('GET', await this.path(`/images/${encodeURIComponent(ref)}/json`));
      return true;
    } catch (error) {
      if ((error as DockerError).status === 404) return false;
      throw error;
    }
  }

  async pullImage(ref: string): Promise<void> {
    const { fromImage, tag } = splitImageRef(ref);
    await this.send('POST', await this.path('/images/create', { fromImage, tag }), {
      expectStream: true,
      timeoutMs: PULL_TIMEOUT_MS
    });
  }

  /** Containers this hub created, whether running or not. */
  async listOwnedContainers(): Promise<{ id: string; name: string; server?: string }[]> {
    const filters = JSON.stringify({ label: [`${OWNER_LABEL}=${OWNER_VALUE}`] });
    const containers = await this.send<{ Id: string; Names: string[] }[]>(
      'GET',
      await this.path('/containers/json', { all: '1', filters })
    );
    return (containers ?? []).map(container => {
      const name = (container.Names?.[0] ?? '').replace(/^\//, '');
      return { id: container.Id, name, server: serverNameFromContainer(name) };
    });
  }

  /**
   * Attach to a container's stdio and return the raw connection.
   *
   * Docker answers `101 UPGRADED` and then hands over the socket, so this has
   * to go through Node's upgrade event rather than a normal response. Bytes
   * that arrived in the same packet as the headers are unshifted back, or the
   * first protocol frame would be lost.
   */
  async attach(id: string): Promise<Duplex> {
    const path = await this.path(`/containers/${encodeURIComponent(id)}/attach`, {
      stream: '1',
      stdin: '1',
      stdout: '1',
      stderr: '1'
    });
    return new Promise<Duplex>((resolve, reject) => {
      const request = http.request({
        ...this.connectionOptions(),
        method: 'POST',
        path,
        headers: {
          Host: 'docker',
          'Content-Type': 'application/json',
          Connection: 'Upgrade',
          Upgrade: 'tcp'
        }
      });
      request.on('upgrade', (_response, socket, head) => {
        if (head?.length) socket.unshift(head);
        socket.setTimeout(0);
        resolve(socket);
      });
      request.on('response', response => {
        response.resume();
        reject(new DockerError(`attach to ${id}: daemon answered ${response.statusCode} instead of upgrading`, response.statusCode));
      });
      request.on('error', error => reject(new DockerError(`attach to ${id}: ${(error as Error).message}`)));
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new DockerError(`attach to ${id}: timed out`)));
      request.end();
    });
  }
}
