import http from 'node:http';
import type { Duplex } from 'node:stream';
import type { HubConfig } from '../config.js';
import { authorize, type Decision, type PolicyContext } from './policy.js';
import { SecretStore } from './secrets.js';
import { OWNER_LABEL, OWNER_VALUE, SERVER_LABEL } from '../sandbox/container-spec.js';
import { DOCKER_POLICY_NAME, DOCKER_POLICY_PATH, DOCKER_POLICY_VERSION, type DockerPolicyHandshake } from '../sandbox/policy-protocol.js';

const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15 * 60_000;
const POLICY_CHECK_TIMEOUT_MS = 5_000;
const MAX_INSPECT_BYTES = 1024 * 1024;

export interface ProxyOptions {
  /** Where the real daemon listens. */
  dockerSocket: string;
  /** Live view of the hub's configuration; the policy is read from it per request. */
  config: () => HubConfig;
  secretsDir: string;
}

function refuse(response: http.ServerResponse, status: number, reason: string, closeConnection = false): void {
  const body = JSON.stringify({ message: `mcp-hub-docker-proxy: ${reason}` });
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...(closeConnection ? { Connection: 'close' } : {})
  });
  response.end(body);
}

function readBody(request: http.IncomingMessage): Promise<Buffer | { tooLarge: true }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: Buffer | { tooLarge: true }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading, but leave the socket alive: destroying it here would
        // reach the caller as a connection reset instead of the 413 that says
        // what went wrong. The response closes the connection instead.
        request.pause();
        settle({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => settle(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function daemonRequest(options: ProxyOptions, method: string, path: string, maxBytes: number, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: options.dockerSocket, method, path, headers: { Host: 'docker' } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new Error(`daemon response exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timed out')));
    request.on('error', reject);
    request.end();
  });
}

async function policyHandshake(options: ProxyOptions): Promise<DockerPolicyHandshake> {
  const ping = await daemonRequest(options, 'GET', '/_ping', 1024, POLICY_CHECK_TIMEOUT_MS);
  if (ping.status !== 200 || ping.body.toString('utf8').trim() !== 'OK') {
    throw new Error(`Docker daemon ping failed with status ${ping.status}`);
  }
  return { name: DOCKER_POLICY_NAME, policyVersion: DOCKER_POLICY_VERSION, daemon: 'ok' };
}

async function verifyContainer(
  options: ProxyOptions,
  decision: Extract<Decision, { allow: true }>
): Promise<{ status: number; reason: string } | undefined> {
  if (!decision.container) return undefined;
  const version = /^\/v\d+\.\d+/.exec(decision.path)?.[0] ?? '';
  const inspected = await daemonRequest(
    options,
    'GET',
    `${version}/containers/${encodeURIComponent(decision.container.id)}/json`,
    MAX_INSPECT_BYTES,
    POLICY_CHECK_TIMEOUT_MS
  );
  if (inspected.status !== 200) {
    return {
      status: inspected.status === 404 ? 404 : 403,
      reason: `cannot inspect container "${decision.container.id}" (status ${inspected.status})`
    };
  }
  let labels: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(inspected.body.toString('utf8')) as { Config?: { Labels?: Record<string, unknown> } };
    labels = parsed.Config?.Labels;
  } catch {
    return { status: 403, reason: `inspect response for container "${decision.container.id}" is not valid JSON` };
  }
  if (labels?.[OWNER_LABEL] !== OWNER_VALUE || labels?.[SERVER_LABEL] !== decision.container.server) {
    return { status: 403, reason: `container "${decision.container.id}" does not have the exact mcp-hub owner and server labels` };
  }
  return undefined;
}

/**
 * A Docker socket proxy that enforces mcp-hub's sandbox policy.
 *
 * Two properties are worth stating outright, because they are what make this
 * different from the usual path-filtering socket proxies:
 *
 * 1. Requests are never forwarded verbatim. Every allowed request is rebuilt
 *    — method, path, query, body — from the decision the policy made. Nothing
 *    the caller sent can ride along: not a duplicate query parameter, not an
 *    extra JSON key, not a second Content-Length.
 * 2. The daemon connection carries only the headers this file writes.
 *
 * The only request that keeps a caller-supplied stream is `attach`, where the
 * whole point is the raw bidirectional connection — and by then the policy has
 * already decided which container it belongs to.
 */
export function createDockerProxy(options: ProxyOptions): http.Server {
  const secrets = new SecretStore(options.secretsDir);
  const context = (): PolicyContext => ({ config: options.config(), secrets });

  const decide = (method: string, url: string, body: unknown): Decision => {
    const decision = authorize(method, url, body, context());
    // The URL is caller-controlled and this log is read by fail2ban: a
    // percent-encoded newline in a container name would otherwise let the
    // caller write its own log lines.
    const safeUrl = url.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 500);
    if (!decision.allow) console.warn(`docker-proxy: DENY ${method} ${safeUrl}: ${decision.reason}`);
    else console.log(`docker-proxy: allow ${decision.method} ${decision.path.split('?')[0]}`);
    return decision;
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      if ('tooLarge' in raw) {
        refuse(response, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`, true);
        response.on('finish', () => request.socket?.destroy());
        return;
      }
      let body: unknown;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          refuse(response, 400, 'request body is not valid JSON');
          return;
        }
      }
      if (request.method === 'GET' && request.url === DOCKER_POLICY_PATH && raw.length === 0) {
        try {
          const handshake = Buffer.from(JSON.stringify(await policyHandshake(options)), 'utf8');
          response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(handshake.length) });
          response.end(handshake);
        } catch (error) {
          refuse(response, 503, `policy proxy cannot reach Docker daemon: ${(error as Error).message}`);
        }
        return;
      }
      const decision = decide(request.method ?? 'GET', request.url ?? '/', body);
      if (!decision.allow) {
        refuse(response, decision.status, decision.reason);
        return;
      }
      const ownershipError = await verifyContainer(options, decision);
      if (ownershipError) {
        refuse(response, ownershipError.status, ownershipError.reason);
        return;
      }
      const payload = decision.body === undefined ? undefined : Buffer.from(JSON.stringify(decision.body), 'utf8');
      const upstream = http.request(
        {
          socketPath: options.dockerSocket,
          method: decision.method,
          path: decision.path,
          headers: {
            Host: 'docker',
            'Content-Type': 'application/json',
            'Content-Length': String(payload?.length ?? 0)
          }
        },
        upstreamResponse => {
          response.writeHead(upstreamResponse.statusCode ?? 502, {
            'Content-Type': upstreamResponse.headers['content-type'] ?? 'application/json'
          });
          upstreamResponse.pipe(response);
        }
      );
      upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('timed out')));
      upstream.on('error', error => {
        console.error(`docker-proxy: upstream error on ${decision.method} ${decision.path}: ${(error as Error).message}`);
        if (!response.headersSent) refuse(response, 502, `docker daemon unreachable: ${(error as Error).message}`);
        else response.end();
      });
      if (payload) upstream.write(payload);
      upstream.end();
    })().catch(error => {
      console.error(`docker-proxy: request failed: ${(error as Error).message}`);
      if (!response.headersSent) refuse(response, 500, 'internal error');
    });
  });

  // `attach` is an HTTP upgrade: the daemon answers 101 and the connection
  // becomes the container's stdio. Both sides are hijacked and spliced.
  server.on('upgrade', (request, clientSocket: Duplex, head: Buffer) => {
    void (async () => {
    const decision = decide(request.method ?? 'GET', request.url ?? '/', undefined);
    // An upgrade is answered on the raw socket, and a refused one must not
    // leave the caller holding a half-open connection: write, then destroy.
    const hangUp = (status: number, reason: string) =>
      clientSocket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`, () =>
        clientSocket.destroy()
      );
    if (!decision.allow || !decision.upgrade) {
      hangUp(decision.allow ? 403 : decision.status, decision.allow ? 'this endpoint does not support upgrades' : decision.reason);
      return;
    }
    const ownershipError = await verifyContainer(options, decision);
    if (ownershipError) {
      hangUp(ownershipError.status, ownershipError.reason);
      return;
    }
    const upstream = http.request({
      socketPath: options.dockerSocket,
      method: decision.method,
      path: decision.path,
      headers: { Host: 'docker', 'Content-Type': 'application/json', Connection: 'Upgrade', Upgrade: 'tcp' }
    });
    upstream.on('upgrade', (_response, upstreamSocket, upstreamHead) => {
      clientSocket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      if (upstreamHead?.length) clientSocket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      // An MCP session is idle most of the time; neither side may time out.
      upstreamSocket.setTimeout(0);
      (clientSocket as unknown as { setTimeout?: (ms: number) => void }).setTimeout?.(0);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      // Either half going away ends the session, and both halves are torn down
      // on the spot. Relying on the pipe to propagate the end is not enough:
      // a peer that only half-closes (FIN without closing) would leave this
      // process holding the other socket for as long as it runs, and a proxy
      // that leaks a socket per restart of a crash-looping sandbox is a slow
      // file-descriptor leak in the one component that must stay up.
      const drop = () => {
        clientSocket.destroy();
        upstreamSocket.destroy();
      };
      for (const event of ['end', 'close', 'error']) {
        clientSocket.on(event, drop);
        upstreamSocket.on(event, drop);
      }
    });
    upstream.on('response', upstreamResponse => {
      upstreamResponse.resume();
      hangUp(502, `docker daemon answered ${upstreamResponse.statusCode} instead of upgrading`);
    });
    upstream.on('error', error => {
      console.error(`docker-proxy: upstream error on attach: ${(error as Error).message}`);
      hangUp(502, `docker daemon unreachable: ${(error as Error).message}`);
    });
    upstream.end();
    })().catch(error => {
      console.error(`docker-proxy: attach authorization failed: ${(error as Error).message}`);
      clientSocket.destroy();
    });
  });

  return server;
}
