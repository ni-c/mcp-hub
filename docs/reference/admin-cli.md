# Admin CLI

`mcp-hub-admin` is the offline half of the hub: it reads and writes the same
state the running process uses, so nothing here needs a restart.

## Running it

Inside the container, which is where `CONFIG_PATH` and `DATA_PATH` are already
set:

```sh
docker exec mcp-hub node /app/dist/admin.js clients list
```

Installed from npm, the same commands are `mcp-hub-admin …` with `DATA_PATH`
pointing at the hub's state directory.

Both sides re-read `state.json` before they touch it and serialize their writes
with a cross-process lock, so a change made here is visible to the hub on its
next request — and a change the hub makes is not overwritten by this one.

| Variable | Needed by |
|---|---|
| `DATA_PATH` | everything |
| `CONFIG_PATH` | every `upstream` command — they have to read the server definition |
| `EXTERNAL_URL` | `tokens create`; and `upstream login` unless the hub has run at least once, which records it |

Output is split so it can be piped: machine-readable JSON goes to **stdout**,
prose and secrets-with-context go to **stderr**. Exit codes are `0` for success,
`1` for an operational failure (unknown client, unreachable upstream) and `2`
for a usage error.

## `clients`

The MCP clients that connect **to** this hub.

```sh
mcp-hub-admin clients list
mcp-hub-admin clients add --name <text> --redirect-uri <uri> [--public]
mcp-hub-admin clients revoke <client-id>
mcp-hub-admin clients delete <client-id>
mcp-hub-admin clients prune [--dry-run]
```

**`list`** prints every client, including ones approved without ever being
registered. `via` says how each arrived: `cimd` for a metadata document,
`dcr` for dynamic registration, `static` for one you created yourself.

**`add`** issues a `client_id` and secret for a client that can do neither
dynamic registration nor a metadata document. The secret is printed once and
never again. The redirect URI must be `https`, a loopback address or a
private-use scheme, and `--public` creates a client without a secret.

Two things make it different from a self-registered client: it counts as
approved for the redirect URI you named, so nobody has to click through a
browser to confirm what you just typed, and it is exempt from every
[lifecycle rule](/guide/client-registration#registrations-do-not-accumulate) —
neither the ceiling nor the inactivity window can remove it.

**`revoke`** withdraws access: the approval and every refresh token go, and
already-issued access tokens are rejected immediately. The registration stays,
so the client can be approved again.

**`delete`** removes the registration as well. The client would have to start
from scratch.

**`prune`** applies the lifecycle rules on demand instead of waiting for the
next sweep. `--dry-run` shows what would go without removing anything.

## `tokens`

Long-lived bearer tokens for clients that cannot do OAuth at all — the OpenAI
Responses API, the xAI API, Gemini's `mcp_server` tool, anything that only sends
a header.

```sh
mcp-hub-admin tokens create --resource <name|hub> [--days <n>] [--label <text>]
mcp-hub-admin tokens list
mcp-hub-admin tokens revoke <token-id>
```

The token itself is printed once, on stdout and alone, so it can be piped. Only
a record of it is stored, which is what `list` shows and `revoke` deletes —
verification refuses a token whose record is gone. Each token is bound to one
resource, exactly like an OAuth access token: `--resource hub` reaches the
aggregate and `/health`, a server name reaches that server only.

## `upstream`

The remote MCP servers this hub connects **to**, for those with an
[`oauth` block](/guide/configuration#upstreams-that-speak-oauth).

```sh
mcp-hub-admin upstream list
mcp-hub-admin upstream status <server>
mcp-hub-admin upstream login <server> [--no-wait]
mcp-hub-admin upstream register <server>
mcp-hub-admin upstream refresh <server>
mcp-hub-admin upstream logout <server>
```

**`list`** and **`status`** report each upstream's mode, grant, scopes and
state: `authorized`, `expired`, `login_required`, or `stale` — the last meaning
a stored credential belongs to a configuration that has since changed, so a
fresh login is needed.

**`login`** starts the browser flow for the `authorization_code` grant. It
prints an authorization URL on stdout and then waits. Open that URL in a browser
**that is signed in to this hub**: the callback requires a signed, single-use
`state` *and* a valid hub session, so intercepting the redirect is not enough to
finish somebody else's login. When the upstream redirects back, the hub stores
the tokens and brings the server up; the command reports that and exits.
`--no-wait` prints the URL and returns immediately.

An upstream using `client_credentials` needs none of this — say `refresh`
instead.

**`register`** obtains a `client_id` without logging in, for the `dcr` and
`cimd` modes. Useful to check that registration works before involving a
browser.

**`refresh`** renews the token now rather than waiting for the next `401`.

**`logout`** forgets the credentials here **and** asks the upstream to revoke
the token and delete a dynamic registration, where it supports those. The local
side goes away regardless; a failure at the upstream is reported and sets a
non-zero exit code.

## Next

- [Client registration](/guide/client-registration) — how clients get a `client_id`
- [Upstreams that speak OAuth](/guide/configuration#upstreams-that-speak-oauth)
- [Standards](/reference/standards) — what is implemented in each direction
