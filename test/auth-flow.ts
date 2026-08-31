import crypto from 'node:crypto';

import request from 'supertest';

/**
 * The browser half of an authorization, written so that it does not know which
 * authorization server is mounted.
 *
 * The two differ in shape but not in substance. The hand-written one answers
 * `GET /authorize` with the login page inline; oidc-provider redirects to an
 * interaction URL and serves the same page from there. A test that hardcodes
 * either shape is testing the implementation rather than the behaviour, and
 * cannot be pointed at the other one.
 *
 * So: follow redirects, and whenever a page comes back, fill in whichever form
 * it is showing and post it to its own `action`. That is what a browser does,
 * and it is the only part of this that both servers genuinely agree on.
 */

export interface AuthorizeResult {
  code: string;
  verifier: string;
  agent: ReturnType<typeof request.agent>;
  /** Every page rendered on the way, for assertions about what the user saw. */
  pages: string[];
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** supertest speaks paths; redirects may be absolute or relative. */
function toPath(url: string): string {
  if (!url.startsWith('http')) return url;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/** Resolves a form's `action` against the page it was served from. */
function formAction(html: string, pagePath: string): string {
  const action = /<form[^>]*action="([^"]*)"/.exec(html)?.[1] ?? '';
  return toPath(new URL(action, `http://placeholder.invalid${pagePath}`).href.replace('http://placeholder.invalid', ''));
}

function field(html: string, name: string): string | undefined {
  return new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
}

export interface AuthorizeOptions {
  password: string;
  redirectUri: string;
  resource?: string;
  /** Reuse a signed-in agent, to reach the consent page rather than login. */
  agent?: ReturnType<typeof request.agent>;
  /** What to do when the consent page appears. Defaults to approving. */
  consent?: 'approve' | 'deny';
  /** Expect the flow to end at the client's redirect_uri with an error. */
  allowError?: boolean;
}

/**
 * Walks the whole journey and returns the authorization code.
 *
 * Throws with the last page or status when it does not settle, because a
 * silent stall here is the single most confusing failure mode in this suite.
 */
export async function authorizeInBrowser(
  app: Express.Application,
  clientId: string,
  options: AuthorizeOptions
): Promise<AuthorizeResult> {
  const agent = options.agent ?? request.agent(app);
  const { verifier, challenge } = pkcePair();
  const pages: string[] = [];

  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...(options.resource ? { resource: options.resource } : {})
  });

  let location = `/authorize?${query.toString()}`;
  for (let hop = 0; hop < 12; hop += 1) {
    if (location.startsWith(options.redirectUri)) {
      const parsed = new URL(location);
      const code = parsed.searchParams.get('code');
      if (!code) {
        if (options.allowError) return { code: '', verifier, agent, pages };
        throw new Error(`authorization refused: ${parsed.search}`);
      }
      return { code, verifier, agent, pages };
    }

    const res = await agent.get(location).redirects(0);
    if (res.status === 200 && typeof res.text === 'string' && /name="request"/.test(res.text)) {
      pages.push(res.text);
      const action = formAction(res.text, location.split('?')[0]);
      const body: Record<string, string> = { request: field(res.text, 'request')! };
      if (/name="password"/.test(res.text)) body.password = options.password;
      else {
        body.csrf = field(res.text, 'csrf')!;
        body.action = options.consent ?? 'approve';
      }
      const submitted = await agent.post(action).type('form').send(body).redirects(0);
      const next = submitted.headers.location as string | undefined;
      if (!next) throw new Error(`form post to ${action} did not redirect: ${submitted.status}`);
      location = next.startsWith(options.redirectUri) ? next : toPath(next);
      continue;
    }

    const next = res.headers.location as string | undefined;
    if (!next) throw new Error(`stalled at hop ${hop} on ${location}: ${res.status} ${String(res.text).slice(0, 200)}`);
    location = next.startsWith(options.redirectUri) ? next : toPath(next);
  }
  throw new Error('authorization did not settle');
}

/** Registers a public client the way an MCP client would. */
export async function registerPublicClient(
  app: Express.Application,
  redirectUri: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const res = await request(app)
    .post('/register')
    .send({
      client_name: 'vitest',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      response_types: ['code'],
      ...overrides
    })
    .expect(201);
  return res.body.client_id as string;
}
