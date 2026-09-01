#!/usr/bin/env tsx
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * A recording reverse proxy, for capturing what a real client puts on the wire.
 *
 *   npm run e2e:record -- --upstream-port 7690 --port 7691 \
 *     --out e2e/transcripts/chatgpt/connector-add.jsonl
 *
 * Point a real client at the proxy, do the thing once by hand, stop it. This is
 * a one-off act outside the suite, never part of a test run: a suite that
 * needed a live client would be a suite nobody could run.
 *
 * Redaction happens on the way to disk rather than on the way back out, so a
 * secret never reaches the file at all. The repository runs Trivy's secret
 * scanner over the whole tree, and a leaked bearer token in a transcript would
 * break CI on main — which is the *good* outcome, and still one worth not
 * relying on.
 *
 * A capture is raw. Run `npm run e2e:curate` on it before committing: that
 * replays it twice and keeps only what both runs agreed on, which is the step
 * that makes a golden deterministic instead of merely plausible.
 */

interface Options {
  /** Where the hub is listening, on this machine. */
  upstreamPort: number;
  /** Where the recorder listens, and what the client is pointed at. */
  port: number;
  out: string;
  client: string;
}

/**
 * The upstream is a port, not a URL, and that is deliberate.
 *
 * A URL from the command line, forwarded to verbatim, is a reverse proxy's
 * whole job and is also — read literally, and CodeQL reads literally — a
 * server-side request forgery. A runtime loopback check answers the objection
 * for a person and not for a scanner, which leaves an alert somebody has to
 * keep dismissing.
 *
 * Taking a port removes the argument instead of guarding it: the host is the
 * literal below and nothing a caller writes can move it. Nothing is lost,
 * because the only upstream this tool was ever allowed to have is a throwaway
 * hub on this machine — a capture aimed at a deployed one would put its real
 * tokens through redact() and one missed pattern from a file in git.
 */
const UPSTREAM_HOST = '127.0.0.1';

function parseArgs(argv: string[]): Options {
  const flag = (name: string, fallback?: string): string => {
    const index = argv.indexOf(`--${name}`);
    const value = index === -1 ? fallback : argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`record: missing --${name}`);
      process.exit(2);
    }
    return value;
  };
  const port = (name: string, fallback: string): number => {
    const value = Number(flag(name, fallback));
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
      console.error(`record: --${name} must be a port number`);
      process.exit(2);
    }
    return value;
  };
  return {
    upstreamPort: port('upstream-port', '7690'),
    port: port('port', '7691'),
    out: flag('out'),
    client: flag('client', 'unknown')
  };
}

/**
 * Everything that is a credential, a session or a per-run identifier.
 *
 * Deliberately aggressive: a placeholder that turns out to be unnecessary costs
 * one substitution in the replayer, and one that was needed and missing costs a
 * rotated secret.
 */
function redact(text: string, upstream: string, externalUrl: string): string {
  return text
    .replaceAll(upstream, '${EXTERNAL_URL}')
    .replaceAll(externalUrl, '${EXTERNAL_URL}')
    .replace(/Bearer [A-Za-z0-9._~+/-]+=*/g, 'Bearer ${TOKEN}')
    .replace(/"(access_token|refresh_token|client_secret|code|registration_access_token)":"[^"]+"/g, '"$1":"${TOKEN}"')
    .replace(/\bcode=[A-Za-z0-9._~-]+/g, 'code=${CODE}');
}

const SECRET_SHAPES = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{20,}\./];

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const upstream = `http://${UPSTREAM_HOST}:${options.upstreamPort}`;
  const externalUrl = `http://${UPSTREAM_HOST}:${options.port}`;
  // Overwriting an existing golden is the thing that turns a collection of
  // assertions into a collection of snapshots: a file breaks, somebody
  // re-records it, and within six months none of them assert anything anybody
  // chose. Re-recording stays possible and becomes deliberate.
  if (fs.existsSync(options.out) && process.env.MCP_HUB_RERECORD !== '1') {
    console.error(`record: ${options.out} already exists. Re-recording replaces an assertion somebody made on purpose.`);
    console.error('record: if that is what you want, set MCP_HUB_RERECORD=1 and say why in the commit message.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  const lines: string[] = [
    JSON.stringify({
      t: 'meta',
      client: options.client,
      captured: new Date().toISOString().slice(0, 10),
      did: 'REPLACE ME: say what the client did and what wire behaviour this pins.'
    })
  ];
  let step = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const proxied = http.request(
        {
          host: UPSTREAM_HOST,
          port: options.upstreamPort,
          path: req.url ?? '/',
          method: req.method,
          headers: { ...req.headers, host: `${UPSTREAM_HOST}:${options.upstreamPort}` }
        },
        upstreamRes => {
          const out: Buffer[] = [];
          upstreamRes.on('data', chunk => out.push(chunk as Buffer));
          upstreamRes.on('end', () => {
            const responseBody = Buffer.concat(out).toString('utf8');
            step += 1;
            lines.push(
              redact(
                JSON.stringify({
                  t: 'http',
                  step,
                  // Headers exactly as sent, including case and order: that is
                  // the half a client's SDK chooses and the half worth pinning.
                  req: { method: req.method, path: req.url, headers: clientHeaders(req.headers), ...(body ? { body: safeJson(body) } : {}) },
                  res: { status: upstreamRes.statusCode, headers: Object.fromEntries(Object.entries(upstreamRes.headers)), body: safeJson(responseBody) }
                }),
                upstream,
                externalUrl
              )
            );
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            res.end(responseBody);
          });
        }
      );
      proxied.on('error', error => {
        res.writeHead(502).end(String(error));
      });
      proxied.end(body);
    });
  });

  const finish = (): void => {
    const text = `${lines.join('\n')}\n`;
    for (const shape of SECRET_SHAPES) {
      if (shape.test(text)) {
        console.error('record: refusing to write — the capture still matches a secret shape. Extend redact() before retrying.');
        process.exit(1);
      }
    }
    fs.writeFileSync(options.out, text);
    console.error(`record: wrote ${step} step(s) to ${options.out}`);
    console.error('record: now fill in meta.did, then run `npm run e2e:curate -- --file <that file>`.');
    process.exit(0);
  };

  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  server.listen(options.port, '127.0.0.1', () => {
    console.error(`record: proxying ${externalUrl} -> ${upstream}`);
    console.error('record: point the client at the first URL, do the thing once, then Ctrl-C.');
  });
}

/**
 * Headers that belong to the hop rather than to the client.
 *
 * `host` names the proxy's port, `content-length` is recomputed on replay, and
 * `connection`/`accept-encoding` are the transport's business. Keeping them
 * would make a transcript unreplayable at any other port — which is every
 * replay — while pinning nothing about the client's protocol choices. Note what
 * is deliberately *not* here: `accept`, `content-type` and
 * `mcp-protocol-version` are exactly the ones worth replaying byte for byte.
 */
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'proxy-connection']);

function clientHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !HOP_HEADERS.has(name.toLowerCase()))
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value ?? '')])
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

main();
