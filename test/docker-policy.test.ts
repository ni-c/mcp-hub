import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig, type DockerServerConfig, type HubConfig } from '../src/config.js';
import { buildCreateRequest } from '../src/sandbox/container-spec.js';
import { authorize, diffCreateBody, hardDenials, type Decision } from '../src/docker-proxy/policy.js';
import { SecretStore, parseEnvFile, SecretError } from '../src/docker-proxy/secrets.js';

/**
 * The policy is the only thing standing between a compromised hub and a root
 * shell on the host, so this suite is written as an attack list: for every way
 * of turning a legitimate create request into a host takeover, one test.
 */

const CONFIG_JSON = JSON.stringify({
  mcpServers: {
    scraper: {
      type: 'docker',
      image: 'scraper-mcp:1.4.2',
      env: { HOME: '/data' },
      secretsFrom: 'scraper',
      volumes: ['/srv/scraper:/data'],
      ports: ['127.0.0.1:8686:8000'],
      network: 'scraper-net',
      memory: '384m'
    },
    pullable: { type: 'docker', image: 'ghcr.io/example/thing:1.2.3', pull: 'missing' },
    paperless: { command: 'paperless-mcp' }
  }
});

let dir: string;
let config: HubConfig;
let secrets: SecretStore;

function context() {
  return { config, secrets };
}

/** A request exactly as DockerTransport builds it. */
function legitimateCreate(server = 'scraper') {
  const entry = config.get(server) as DockerServerConfig;
  return buildCreateRequest(server, entry);
}

function createWith(mutate: (body: Record<string, unknown>) => void, server = 'scraper'): Decision {
  const { name, body } = legitimateCreate(server);
  mutate(body);
  return authorize('POST', `/v1.44/containers/create?name=${name}`, body, context());
}

function denial(decision: Decision): string {
  expect(decision.allow).toBe(false);
  return (decision as { reason: string }).reason;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-policy-'));
  fs.writeFileSync(path.join(dir, 'scraper.env'), '# API credentials\nSCRAPER_API_KEY=abc\nexport SCRAPER_API_SECRET="s3cr3t"\n', { mode: 0o640 });
  // The proxy parses without expansion; it holds none of the hub's variables.
  config = parseConfig(CONFIG_JSON, {} as NodeJS.ProcessEnv, { expand: false });
  secrets = new SecretStore(dir);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the request the hub actually sends', () => {
  it('is allowed, and comes back canonicalised with the secrets added', () => {
    const { name, body } = legitimateCreate();

    const decision = authorize('POST', `/v1.44/containers/create?name=${name}`, body, context());

    expect(decision.allow).toBe(true);
    const allowed = decision as { path: string; body: Record<string, unknown> };
    // The caller's API version is kept; everything else about the path is ours.
    expect(allowed.path).toBe('/v1.44/containers/create?name=mcp-sandbox-scraper');
    // The hub's env keys survive; the SSO credentials are added by the proxy,
    // which is the only party that has them.
    expect(allowed.body.Env).toEqual(['HOME=/data', 'SCRAPER_API_KEY=abc', 'SCRAPER_API_SECRET=s3cr3t']);
    expect((allowed.body.HostConfig as Record<string, unknown>).Binds).toEqual(['/srv/scraper:/data']);
  });

  it('works for a server without secrets too', () => {
    const { name, body } = legitimateCreate('pullable');
    expect(authorize('POST', `/containers/create?name=${name}`, body, context()).allow).toBe(true);
  });
});

describe('host takeover attempts', () => {
  it('refuses a privileged container', () => {
    expect(denial(createWith(body => ((body.HostConfig as Record<string, unknown>).Privileged = true)))).toMatch(/Privileged/);
  });

  it('refuses added capabilities', () => {
    expect(denial(createWith(body => ((body.HostConfig as Record<string, unknown>).CapAdd = ['SYS_ADMIN'])))).toMatch(/CapAdd/);
  });

  it('refuses devices', () => {
    const decision = createWith(body => ((body.HostConfig as Record<string, unknown>).Devices = [{ PathOnHost: '/dev/sda' }]));
    expect(denial(decision)).toMatch(/Devices/);
  });

  it('refuses the host filesystem, however it is spelled', () => {
    for (const bind of ['/:/host', '/etc:/etc', '/var/run/docker.sock:/var/run/docker.sock', '/srv/scraper/../../:/data', '/proc:/proc', '/root:/r']) {
      const decision = createWith(body => ((body.HostConfig as Record<string, unknown>).Binds = [bind]));
      expect(denial(decision)).toMatch(/bind source|does not match/);
    }
  });

  it('refuses Mounts, the other way to say Binds', () => {
    const decision = createWith(
      body => ((body.HostConfig as Record<string, unknown>).Mounts = [{ Type: 'bind', Source: '/', Target: '/host' }])
    );
    expect(denial(decision)).toMatch(/Mounts are never allowed/);
  });

  it('refuses host namespaces', () => {
    for (const field of ['PidMode', 'IpcMode', 'UTSMode', 'NetworkMode', 'CgroupnsMode']) {
      const decision = createWith(body => ((body.HostConfig as Record<string, unknown>)[field] = 'host'));
      expect(denial(decision)).toMatch(new RegExp(`${field}=host|does not match`));
    }
    const joined = createWith(body => ((body.HostConfig as Record<string, unknown>).NetworkMode = 'container:mcp-hub'));
    expect(denial(joined)).toMatch(/network namespace/);
  });

  it('refuses a container that drops the sandbox flags', () => {
    for (const [field, value] of [
      ['CapDrop', []],
      ['SecurityOpt', ['seccomp=unconfined']],
      ['ReadonlyRootfs', false],
      ['AutoRemove', false],
      ['RestartPolicy', { Name: 'always' }],
      ['Memory', 0]
    ] as [string, unknown][]) {
      const decision = createWith(body => ((body.HostConfig as Record<string, unknown>)[field] = value));
      expect(denial(decision)).toMatch(/does not match the configuration/);
    }
  });

  it('refuses a foreign image, even under a configured name', () => {
    expect(denial(createWith(body => (body.Image = 'alpine:latest')))).toMatch(/HostConfig|\.Image|does not match/);
  });

  it('refuses extra ports and extra mounts', () => {
    const ports = createWith(body => {
      (body.HostConfig as Record<string, unknown>).PortBindings = {
        '8000/tcp': [{ HostIp: '0.0.0.0', HostPort: '8686' }]
      };
    });
    expect(denial(ports)).toMatch(/does not match/);

    const binds = createWith(body => ((body.HostConfig as Record<string, unknown>).Binds = ['/srv/scraper:/data', 'other:/other']));
    expect(denial(binds)).toMatch(/does not match/);
  });

  it('does not let a prototype-chain name pass as a known field', () => {
    // `key in expected` is true for toString and constructor, so a check
    // written that way would wave these through into the value comparison.
    for (const field of ['toString', 'constructor', 'hasOwnProperty']) {
      expect(denial(createWith(body => (body[field] = 'x')))).toMatch(/not allowed/);
    }
    // On the wire it arrives as JSON text, and JSON.parse turns __proto__ into
    // an ordinary own property rather than touching the prototype — so it has
    // to be rejected as the extra field it is.
    const { name, body } = legitimateCreate();
    const wire = JSON.parse(JSON.stringify(body).replace(/^\{/, '{"__proto__":{"Privileged":true},'));
    expect(denial(authorize('POST', `/containers/create?name=${name}`, wire, context()))).toMatch(/not allowed/);
  });

  it('strips control characters from the reason it echoes and logs', () => {
    // The denial text reaches a log file fail2ban parses; a percent-encoded
    // newline in a container name must not become a line of its own.
    const decision = authorize('POST', '/containers/mcp-sandbox-x%0AFORGED/start', undefined, context());
    expect(denial(decision)).not.toMatch(/\n/);
    expect(denial(decision)).toContain('?FORGED');
  });

  it('refuses unknown fields rather than ignoring them', () => {
    // Default-deny matters more than the specific field: whatever the daemon
    // grows next must not pass unexamined.
    expect(denial(createWith(body => (body.WorkingDir = '/')))).toMatch(/not allowed/);
    expect(denial(createWith(body => ((body.HostConfig as Record<string, unknown>).ShmSize = 1)))).toMatch(/not allowed/);
  });

  it('refuses a create for a server that is not in the config', () => {
    const { body } = legitimateCreate();
    expect(denial(authorize('POST', '/containers/create?name=mcp-sandbox-other', body, context()))).toMatch(/not a docker server/);
    expect(denial(authorize('POST', '/containers/create?name=whatever', body, context()))).toMatch(/outside the mcp-sandbox- namespace/);
    // A stdio server's name is not a sandbox name either.
    expect(denial(authorize('POST', '/containers/create?name=mcp-sandbox-paperless', body, context()))).toMatch(/not a docker server/);
  });

  it('refuses a create with no name or with smuggled query parameters', () => {
    const { body } = legitimateCreate();
    expect(denial(authorize('POST', '/containers/create', body, context()))).toMatch(/explicit \?name=/);
    expect(denial(authorize('POST', '/containers/create?name=mcp-sandbox-scraper&platform=linux/arm64', body, context()))).toMatch(/only \?name=/);
  });
});

describe('environment handling', () => {
  it('refuses an env key the config does not name', () => {
    const decision = createWith(body => ((body.Env as string[]).push('LD_PRELOAD=/tmp/evil.so')));
    expect(denial(decision)).toMatch(/Env keys do not match/);
  });

  it('refuses a duplicate env key', () => {
    const decision = createWith(body => (body.Env = ['HOME=/data', 'HOME=/root']));
    expect(denial(decision)).toMatch(/duplicate keys|do not match/);
  });

  it('refuses a malformed env entry', () => {
    expect(denial(createWith(body => (body.Env = ['HOME'])))).toMatch(/KEY=VALUE/);
    expect(denial(createWith(body => (body.Env = ['=/data'])))).toMatch(/KEY=VALUE/);
  });

  it('passes the value through untouched — only keys are policy', () => {
    // The hub holds the ${VAR} expansions; the proxy must not need them.
    const decision = createWith(body => (body.Env = ['HOME=/somewhere/else']));
    expect(decision.allow).toBe(true);
    expect(((decision as { body: Record<string, unknown> }).body.Env as string[])[0]).toBe('HOME=/somewhere/else');
  });
});

describe('routes', () => {
  const cases: [string, string, boolean][] = [
    ['GET', '/_ping', true],
    ['GET', '/version', true],
    ['GET', '/v1.44/version', true],
    ['POST', '/containers/mcp-sandbox-scraper/start', true],
    ['POST', '/containers/mcp-sandbox-scraper/attach?stream=1&stdin=1', true],
    ['POST', '/containers/mcp-sandbox-scraper/stop', true],
    ['DELETE', '/containers/mcp-sandbox-scraper?force=1', true],
    ['DELETE', '/containers/mcp-sandbox-gone?force=1', true], // reaping a removed server
    ['GET', '/containers/json?all=1', true],
    ['GET', '/images/scraper-mcp:1.4.2/json', true],
    ['POST', '/containers/mcp-hub/start', false],
    ['POST', '/containers/mcp-sandbox-other/start', false],
    ['POST', '/containers/mcp-sandbox-scraper/exec', false],
    ['GET', '/containers/mcp-sandbox-scraper/json', false],
    ['POST', '/build', false],
    ['POST', '/volumes/create', false],
    ['POST', '/networks/create', false],
    ['GET', '/images/alpine/json', false],
    ['GET', '/info', false],
    ['GET', '/secrets', false],
    ['POST', '/containers/mcp-sandbox-scraper/update', false],
    ['DELETE', '/containers/mcp-hub', false],
    ['GET', '/../info', false]
  ];

  it.each(cases)('%s %s', (method, url, allowed) => {
    expect(authorize(method, url, undefined, context()).allow).toBe(allowed);
  });

  it('rebuilds the attach query instead of trusting it', () => {
    // logs=1 would replay the whole container log into the protocol stream.
    const decision = authorize('POST', '/containers/mcp-sandbox-scraper/attach?logs=1&stream=1', undefined, context());
    expect(decision.allow).toBe(true);
    expect((decision as { path: string }).path).toBe('/containers/mcp-sandbox-scraper/attach?stream=1&stdin=1&stdout=1&stderr=1');
    expect((authorize('POST', '/v1.44/containers/mcp-sandbox-scraper/attach', undefined, context()) as { path: string }).path).toMatch(
      /^\/v1\.44\/containers/
    );
    expect((decision as { upgrade?: boolean }).upgrade).toBe(true);
  });

  it('forces its own label filter when listing containers', () => {
    const decision = authorize('GET', '/containers/json?all=1&filters=%7B%7D', undefined, context());
    expect((decision as { path: string }).path).toContain(encodeURIComponent('io.mcp-hub.owner=mcp-hub'));
  });

  it('allows pulling only what a "pull": "missing" entry names', () => {
    expect(authorize('POST', '/images/create?fromImage=ghcr.io/example/thing&tag=1.2.3', undefined, context()).allow).toBe(true);
    // scraper is pull: never, so even its own image may not be fetched.
    expect(denial(authorize('POST', '/images/create?fromImage=scraper-mcp&tag=local', undefined, context()))).toMatch(/not allowed/);
    expect(denial(authorize('POST', '/images/create?fromImage=alpine&tag=latest', undefined, context()))).toMatch(/not allowed/);
    expect(denial(authorize('POST', '/images/create?fromImage=ghcr.io/example/thing&tag=latest', undefined, context()))).toMatch(/not allowed/);
  });

  it('does not accept a wrong method on an allowed path', () => {
    expect(authorize('GET', '/containers/mcp-sandbox-scraper/start', undefined, context()).allow).toBe(false);
    expect(authorize('POST', '/containers/json', undefined, context()).allow).toBe(false);
  });
});

describe('diffCreateBody', () => {
  it('names the first difference, deeply', () => {
    expect(diffCreateBody({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toMatch(/\.a\.b\[1\]/);
    expect(diffCreateBody({ a: 1 }, { a: 1, b: 2 })).toMatch(/\.b: not allowed/);
    expect(diffCreateBody({ a: [1] }, { a: [1, 2] })).toMatch(/expected 1 entries/);
    expect(diffCreateBody({ a: 1 }, {})).toMatch(/\.a/);
    expect(diffCreateBody({ a: 1 }, { a: 1 })).toBeUndefined();
  });

  it('does not mistake an array for an object', () => {
    expect(diffCreateBody({ a: {} }, { a: [] })).toMatch(/expected an object/);
    expect(diffCreateBody({ a: [] }, { a: {} })).toMatch(/expected an array/);
  });
});

describe('hardDenials', () => {
  it('insists that Privileged is present and false', () => {
    // Belt and braces: the structural comparison catches this too, but a
    // missing field must never read as "not privileged, then".
    expect(hardDenials({ HostConfig: {} })).toMatch(/must be present and false/);
    expect(hardDenials({ HostConfig: { Privileged: false } })).toBeUndefined();
  });
});

describe('secrets', () => {
  it('parses env files the way an operator writes them', () => {
    expect(parseEnvFile('# c\n\nA=1\nexport B="two"\nC=\'three\'\nD=with=equals\n')).toEqual({
      A: '1',
      B: 'two',
      C: 'three',
      D: 'with=equals'
    });
  });

  it('rejects nonsense instead of guessing', () => {
    expect(() => parseEnvFile('JUST_A_WORD\n')).toThrow(SecretError);
    expect(() => parseEnvFile('1BAD=x\n')).toThrow(/invalid variable name/);
  });

  it('refuses to leave its directory', () => {
    expect(() => secrets.load('../../etc/passwd')).toThrow(/invalid secret set name/);
    expect(() => secrets.load('missing')).toThrow(/does not exist/);
  });

  it('refuses a world-readable secret file', () => {
    const open = path.join(dir, 'open.env');
    fs.writeFileSync(open, 'X=1\n', { mode: 0o644 });
    expect(() => secrets.load('open')).toThrow(/world-readable/);
  });

  it('reports a collision between a secret and a config env key', () => {
    fs.writeFileSync(path.join(dir, 'clash.env'), 'HOME=/elsewhere\n', { mode: 0o600 });
    const clashing = parseConfig(
      JSON.stringify({ mcpServers: { scraper: { type: 'docker', image: 'x:1', env: { HOME: '/data' }, secretsFrom: 'clash' } } }),
      {} as NodeJS.ProcessEnv,
      { expand: false }
    );
    const entry = clashing.get('scraper') as DockerServerConfig;
    const { name, body } = buildCreateRequest('scraper', entry);

    const decision = authorize('POST', `/containers/create?name=${name}`, body, { config: clashing, secrets });

    // Silently letting one win would make it unclear which value the container
    // actually got — for a credential, that is the worst outcome.
    expect(denial(decision)).toMatch(/collides/);
  });
});
