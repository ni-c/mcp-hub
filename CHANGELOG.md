# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- #region changelog -->

## [Unreleased]

### Added

- `allowTools` and `denyTools` on any server in `mcp.json` decide which of its
  tools the hub exposes. Each entry is an exact tool name or a prefix with a
  single trailing `*`; the allow list decides what is in and the deny list is
  subtracted from it. They apply to every kind of server — stdio, remote, docker
  and socket — because an upstream you do not control is the strongest case for
  filtering one. Nothing changes for a server that sets neither.

  **It is a boundary, not a tidy-up.** A filtered tool is absent from
  `tools/list` on the server's own path and from `list_tools` on `/hub`, and a
  client that calls it anyway is refused on both routes — before the server is
  woken, so a forbidden name cannot cost a container start. The refusal is the
  same "unknown tool" a server gives for a name it never had: `/hub` tokens go
  to third-party connectors, and enumerating what was hidden would be a
  disclosure in itself.

  Unlike ni-c's own MCP servers, an entry that matches no tool is not a config
  error — the hub only learns an upstream's tools once it has connected. The
  supervisor logs it at the moment it filters, and `/health` carries `exposed`,
  `hidden` and `unmatched` per filtered server.

  Filters tools only: resources, resource templates and prompts on a per-server
  path are untouched.

## [0.10.0] - 2026-08-25

### Added

- **Client ID Metadata Documents (CIMD), the registration mechanism the MCP
  specification now prefers.** A client may use an HTTPS URL as its `client_id`
  and host its own metadata there; the hub fetches that document, checks that it
  vouches for itself and takes the client's name and redirect URIs from it.
  Nothing is registered and nothing is stored, so a client that reinstalls or
  moves to another machine is still recognised as the same client, and the
  approval you gave it still holds. Dynamic registration remains available and
  advertised beside it, so nothing that works today stops working: a
  spec-compliant client picks CIMD on its own, everything else falls back.
  Closes [#18](https://github.com/ni-c/mcp-hub/issues/18).

- **`private_key_jwt` client authentication.** A CIMD client cannot hold a
  shared secret, so a confidential one proves itself with a JWT signed by a key
  it publishes in its own document (`jwks` or `jwks_uri`). This is the path
  ChatGPT's connectors take; without it they were refused with `invalid_client`.
  The assertion must name the client as both `iss` and `sub`, target the token
  endpoint or the issuer, carry a `jti` that is accepted exactly once, and
  expire within five minutes.

- **`CLIENT_REGISTRATION`** names the mechanisms a client may use to obtain a
  `client_id` — `cimd`, `dcr`, or both, which is the default. Dropping `dcr`
  removes `registration_endpoint` from the discovery document and makes
  `/register` answer `404`, which is how you retire dynamic registration once
  every client you use supports CIMD. `CIMD_ALLOWED_ORIGINS` restricts which
  origins may serve a metadata document (only origins can be pinned — ChatGPT's
  per-connector document path is random), and `CIMD_ALLOW_PRIVATE_ADDRESSES`
  relaxes the SSRF guard for local development only.

- **The authorization page names what cannot be forged.** For a
  metadata-document client it shows the document URL under *Identified by*: the
  name in that document is self-declared, the origin serving it is not. When
  every redirect URI is a loopback address the page says so outright, because a
  code sent to `http://127.0.0.1:…` could be collected by any program on that
  machine.

- **The hub can authenticate itself to upstream MCP servers with OAuth.** A
  remote server may carry an `oauth` block instead of a static `Authorization`
  header, and the hub then obtains and refreshes the token itself — no
  `mcp-remote` bridge, no token cache to babysit. It identifies itself with
  credentials the upstream issued (`mode: "static"`, with an optional
  `clientSecret` from `${VAR}`), by registering dynamically (`"dcr"`, RFC 7591)
  or with its own client metadata document (`"cimd"`), and uses either the
  `client_credentials` grant, which needs no attention at all, or
  `authorization_code`, which needs one browser visit started with
  `mcp-hub-admin upstream login <server>`. The CLI prints a URL, the upstream
  redirects back to the hub, and the server connects. `upstream list`, `status`,
  `register`, `refresh` and `logout` cover the rest; `logout` also revokes the
  token (RFC 7009) and deletes a dynamic registration (RFC 7592) at the upstream.
  Replaces the `mcp-remote` workaround the configuration guide used to recommend.

- **`mcp-hub-admin clients add`** issues a `client_id` and secret by hand, for a
  client that supports neither dynamic registration nor a metadata document —
  the one case that previously had no answer but an API token. Creating it
  counts as approving it for the redirect URI you named, and it is exempt from
  the lifecycle rules: nothing removes it but `clients delete`.

- **Outbound `private_key_jwt`.** An upstream can be told
  `"clientAuth": "private_key_jwt"` and the hub signs an RFC 7523 assertion
  instead of presenting a shared secret. The signing key lives at
  `<DATA_PATH>/upstream-key.pem` and is deliberately not the key that signs the
  hub's own access tokens; its public half travels with the client metadata
  document or the registration request, which is how the upstream verifies it.

- **A client metadata document per upstream.** The hub previously published one
  document built from the first server using `mode: "cimd"`, so a second such
  server was registered with the first one's scopes. Each now has its own at
  `/.well-known/mcp-hub-client/<id>.json`, where the identifier is derived from
  the server name rather than being it — the URL is public, the names are not.

- **A remote server whose authorization is missing or refused enters a new
  `unauthorized` state** instead of restarting every five minutes for ever. It
  is reported in `/health` and `list_servers`, and the log names the command to
  run. A completed login brings it up again without a restart of the hub.

- **A registration lifecycle for dynamic clients.** Anyone may register, so
  registrations no longer stay forever: one that is never approved is dropped
  after `DCR_PENDING_TTL_HOURS` (24), an approved one nobody has used after
  `DCR_INACTIVE_DAYS` (90) along with its approval and refresh tokens, and the
  store holds at most `DCR_MAX_CLIENTS` (500). Reaching the ceiling evicts the
  oldest never-approved registrations; when every one of them has been approved
  the newcomer is refused instead, so registering repeatedly cannot push a
  working connector out. Opening the authorization page counts as use, so a slow
  login is not cut short. The sweep runs at startup and every fifteen minutes,
  and an existing state file is given a fresh clock rather than being read as
  idle since the day each client registered. Client ID Metadata Document clients
  are unaffected — they are never stored.

- **Clients can manage their own registration (RFC 7592).** The registration
  response now carries `registration_access_token` and
  `registration_client_uri`, and `GET`, `PUT` and `DELETE` on
  `/register/<client_id>` let a client read, change or remove what it
  registered. Only a hash of the token is stored, so it is shown exactly once.
  `DELETE` takes the approval and every refresh token with it. Changing the
  redirect URIs through `PUT` withdraws the approval — consent was given for a
  destination and does not transfer to a new one — while changing a name or a
  logo leaves it in place. A wrong token and an unknown `client_id` get the same
  answer, so the endpoint cannot be used to enumerate registrations. None of
  this comes from the SDK, whose registration router accepts `POST` and nothing
  else.

- `mcp-hub-admin clients delete <client-id>` removes a registration outright,
  where `clients revoke` withdraws access but keeps it, and
  `mcp-hub-admin clients prune [--dry-run]` applies the lifecycle rules on
  demand instead of waiting for the next sweep.

- `mcp-hub-admin clients list` now also lists clients that were approved
  without ever being registered, and says which mechanism each one came in
  through. A metadata-document client leaves no registration behind, so its
  approval is the whole record; `clients revoke` works on it either way.

- **A `demo/` directory you can run without owning anything.**
  `docker compose up -d` brings up a hub with three fake MCP servers —
  weather, tickets and a small index of these docs — and
  [the page that goes with it](https://mcp-hub.ni-c.de/guide/demo) shows how to
  point the MCP Inspector or MCPJam at it. The servers answer from tables
  compiled into them: no network, no filesystem, no stored state, so the same
  call gives the same answer and nothing a visitor does outlasts the request.
  `demo/token.sh` mints the API tokens. It exists because the first question
  about a gateway is what it looks like from the client side, and until now the
  only way to find out was to deploy one.

### Changed

- The authorization-server metadata advertises
  `client_id_metadata_document_supported`, and `private_key_jwt` alongside
  `client_secret_post` and `none` in `token_endpoint_auth_methods_supported`.
  The enriched document is served at the root path, the RFC 8414 path-inserted
  form and the OpenID Connect discovery alias alike.

### Security

- Metadata documents are fetched from a URL an unauthenticated caller chose, so
  the request is treated as hostile: `https` only, redirects never followed,
  private, loopback, link-local and CGNAT addresses refused after DNS
  resolution, a 5 kB cap enforced while reading, a 5-second timeout and a JSON
  content type required. Documents carrying a `client_secret` or declaring a
  symmetric authentication method are refused outright. Concurrent lookups of
  one URL collapse into a single request, rejections are remembered for 30
  seconds and the cache is bounded, so a `client_id` cannot be used to point the
  hub at a third party. Every rejection answers a bare `invalid_client`; the
  reason goes to the log only, so the admission policy cannot be mapped by
  probing.

- **A client declaring `private_key_jwt` must present an assertion.** Client
  authentication is driven by the stored record, and a metadata-document client
  never has a `client_secret` — so a token request that simply omitted
  `client_assertion` was treated as a public client and accepted on its
  `client_id` alone. A leaked refresh token or authorization code was therefore
  redeemable without the private key that exists to prevent exactly that. The
  assertion is now required whenever the document declares it.

- **The connection is pinned to the address that was checked.** The SSRF guard
  resolved the hostname and then handed the name to `fetch`, which resolved it
  again; a zone answering differently the second time could move the request
  onto an internal address or a cloud metadata endpoint. The vetted address is
  now what the socket connects to, with the certificate still validated against
  the hostname. The IPv6 forms that carry an IPv4 address (NAT64 `64:ff9b::/96`,
  6to4 `2002::/16`) and several reserved IPv4 ranges are refused as well.

- **The `jwks_uri` fetch is capped at 64 kB.** It inherited the redirect,
  timeout and address guards but not the size limit, and the JWKS is parsed
  whole — an unauthenticated token request naming a document with a hostile
  `jwks_uri` could push an unbounded body into the heap and take the hub, and
  every MCP server it supervises, down with it. The cache of remote key sets is
  now bounded too; entries were created before the signature was checked.

- **Untrusted values can no longer forge a log record.** A `client_id` may
  contain newlines — the URL parser strips them, so the value passed every
  structural check while the raw string reached the log, where each line is
  given a valid timestamp. A forged `mcp-hub: authentication failure from …`
  line matches the fail2ban filter this project ships, which made it possible
  to have any address banned by sending unauthenticated requests. Client-chosen
  values are escaped and capped at the point they enter a log line.

- **Redirect URIs are held to one rule for both registration mechanisms.**
  Dynamic registration accepted anything outside the SDK's three-scheme
  denylist, including a plaintext `http://` callback on a remote host, which
  delivers the authorization code in the clear. Registration now requires
  `https`, a loopback address, or an application-specific scheme for native
  clients, and answers `400 invalid_client_metadata` otherwise.

- Self-declared client names are reduced to a single short line before they are
  stored or shown. They were escaped but unbounded, so a name of several hundred
  characters could push the redirect target and the loopback warning off the
  consent page.

- `/health` is authenticated and bound to the `hub` resource; only `/livez` is
  public. A stale comment claimed the opposite, which would have justified
  exposing the deployment topology.

- Revocation markers are dropped once they are older than the longest-lived
  refresh token they could reject. They were the one part of the state file
  that only ever grew.

## [0.9.2] - 2026-08-24

### Fixed

- **A client locked itself out of the hub after four connected sessions.**
  Streamable HTTP uses a `GET` to open the server-to-client SSE channel, and
  that stream stays open for the whole session. The per-client gate counted it
  as an in-flight request, so every connected session permanently held one of
  the `MCP_MAX_CONCURRENT_REQUESTS` slots (default 4) — the fifth session got
  `429 Too many concurrent MCP requests` on `initialize` while the hub was
  otherwise idle, and stayed locked out until the older sessions ended. Since
  sessions of the same editor or CLI share one OAuth client, running a handful
  of them was enough. Listening streams now have their own budget.

### Added

- `MCP_MAX_CONCURRENT_STREAMS` (default 32) bounds the SSE listening streams
  one OAuth client may hold open, so the stream budget stays limited without
  competing with actual request work.

### Security

- The image overwrites npm's vendored `tar` with 7.5.22, alongside the
  `brace-expansion` and `ip-address` replacements it already carried. npm 12.0.2
  still pins 7.5.19, which CVE-2026-73566 (denial of service via a crafted long
  path) applies to.

## [0.9.1] - 2026-08-20

### Fixed

- **`npx @ni-c/mcp-hub` did nothing.** npm links a `bin` entry as
  `node_modules/.bin/<name>` — a symlink whose basename is the command, not the
  file — and the entry point recognised itself by comparing that basename with
  its own file name. Started through the symlink it therefore never ran: the
  process exited 0 without a listener, a child or a single log line, in HTTP as
  well as in stdio mode. Only `node dist/index.js` (what the container does)
  ever worked. Entry-point detection now compares real paths, and a test starts
  the hub through a `.bin`-style symlink.

## [0.9.0] - 2026-08-20

### Added

- **On-demand servers.** Stdio and docker servers now start when they are used
  and go to sleep after `IDLE_TIMEOUT_MINUTES` (default 60) without a forwarded
  request — on a small host, a dozen configured servers cost only the memory of
  the ones actually in use. While a server sleeps, `initialize` and
  `tools/list` are answered from a persistent snapshot
  (`TOOL_CACHE_PATH`, default `/data/tool-cache.json`), so a client
  enumerating its connectors wakes nothing; the first real tool call wakes the
  server and blocks until it is up (120 s budget). `/hub`'s `list_tools` and
  `get_tool_schema` answer from the snapshot and pre-warm the server in the
  background. Per-server control: `"keepAlive": true` keeps a server always
  running (the previous behaviour), `"idleMinutes"` overrides the global
  timeout; `IDLE_TIMEOUT_MINUTES=0` disables the feature entirely. New `/hub`
  meta-tools `wake_server` and `sleep_server` steer the lifecycle manually. An
  on-demand server that crashes five restarts in a row without being used is
  parked as `sleeping` (error kept visible) instead of restarting forever.
  `/health` treats `sleeping` as healthy. The docker-proxy and its policy are
  unchanged — `DOCKER_POLICY_VERSION` stays at 1.
- **`hub: false` servers are lifecycle-managed through `/hub`.** `list_servers`
  now includes them with a `hidden` marker and `wake_server`/`sleep_server`
  accept them — hiding a server's tools no longer means its lifecycle can only
  be reached by the idle sweep. Tool access (`list_tools`, `get_tool_schema`,
  `call_tool`) still refuses hidden servers, now pointing at the server's own
  endpoint instead of pretending it does not exist.
- **Single-file config mounts log a startup warning.** A
  `-v ./mcp.json:/config/mcp.json` bind mount silently loses every editor save
  that goes through a rename (new inode), killing hot reload. The hub and the
  docker-proxy now detect that setup via `/proc/self/mountinfo` and say so at
  startup.
- **stdio mode.** `mcp-hub --stdio` (or the `mcp-hub-stdio` binary) serves the
  `/hub` aggregate — the same six meta-tools, the same `mcp.json`, the same
  supervision, on-demand lifecycle and hot reload — on stdin/stdout, for
  clients that can only spawn a local process. No listener, no OAuth, no
  `EXTERNAL_URL`; the trust boundary is the local user account. `CONFIG_PATH`
  defaults to `mcp.json` in the working directory, the tool cache to
  `.mcp-hub/tool-cache.json` beside it, and a missing config starts an empty
  hub instead of failing, because a client-spawned process has nowhere to show
  a startup error. `console.log`/`console.info` are moved to stderr for the
  life of the process: stdout carries the protocol. The MCP Registry entry
  follows: the npm package is now listed as a **stdio** package
  (`npx @ni-c/mcp-hub --stdio`), so the hub can be installed straight from the
  registry. The OCI package stays `streamable-http` — that is the container
  deployment.

### Changed

- **Examples and docs mount the config directory, not the file.** The
  recommended layout is `./config/mcp.json` mounted as `./config:/config:ro` in
  both the hub and the docker-proxy — rename-style editor saves then hot-reload
  correctly. `CONFIG_PATH` and its default `/config/mcp.json` are unchanged, so
  existing single-file deployments keep working (with the warning above).

### Fixed

- The release workflow now has a concurrency group and skips an npm publish,
  MCP Registry publish or GitHub release that already exists. A tag push
  delivered twice used to start two releases, and the loser died on npm's 403
  for an already-published version — a permanently red check on a commit that
  is also main's HEAD. Every publishing step is now idempotent, so a re-run can
  finish the half that is missing; the manual `mcp-registry` workflow carries
  the same guard.

## [0.8.0] - 2026-08-18

### Added

- **Secrets hot-reload.** The docker-proxy now watches the sandbox secrets
  directory: when the content of a referenced `<set>.env` changes, it stops the
  affected sandbox container (after the same daemon-side ownership check as
  every other container action), and the hub's supervisor recreates it — the
  replacement create reads the file fresh. Rotating a token is now an edit, not
  a hub restart. Content is compared by parsed entries, so a `touch` or a
  comment-only edit triggers nothing; a broken edit (permissions, symlink,
  parse error, a key colliding with the entry's `env`) is logged and ignored so
  it cannot crash-loop a running server. Opt out with
  `SANDBOX_SECRETS_WATCH=false`. The hub is unchanged and
  `DOCKER_POLICY_VERSION` stays at 1 — 0.7.0 hubs interoperate.

## [0.7.0] - 2026-08-18

### Added

- **Sandboxed servers.** An MCP server that only speaks stdio can now run in its
  own container without an HTTP listener, a bearer token or a bridge process in
  its image. Two new kinds carry the protocol on a plain byte stream, using the
  stdio framing the specification asks custom transports to reuse:
  - `type: "docker"` — the hub creates the container over the Docker API,
    attaches to its stdin/stdout and speaks MCP across the container boundary.
    The sandbox is described in `mcp.json`: image, mounts, ports, network,
    memory, pids, tmpfs, user. Capabilities are always dropped,
    `no-new-privileges` is always set, there is never a restart policy, and the
    default network is `none`.
  - `type: "unix"` / `type: "tcp"` — the hub connects to a socket a container
    you started is listening on. Costs the hub no privileges at all, and a Unix
    socket in a shared volume reaches a sandbox running with `network_mode: none`
    — which no HTTP upstream can do, because HTTP needs an interface.

  Supervision is unchanged for both: ping, backoff restart, hot reload, `/hub`,
  `/health`. A sandbox's stderr is prefixed and passed through exactly like a
  stdio child's.

- **`mcp-hub-docker-proxy`** (`ghcr.io/ni-c/mcp-hub-docker-proxy`, published
  from the same pipeline under the same tags). The hub is exposed to the
  internet and the Docker API is root-equivalent, so the hub never gets the
  daemon socket: this second, much smaller image holds it and enforces a policy
  read from the same `mcp.json`. It allows only containers named
  `mcp-sandbox-<server>` for a configured `type: "docker"` entry, compares the
  whole create request against one rebuilt by the same function the hub used to
  build it — so the policy cannot drift from the code that sends the request —
  and refuses `Privileged`, `CapAdd`, `Devices`, `Mounts`, host namespaces and
  binds under `/`, `/proc`, `/sys`, `/dev`, `/etc`, `/boot`, `/root`, `/run`,
  `/var/run` and `/var/lib/docker` regardless of what the config says. Nothing
  is forwarded verbatim: every allowed request is rebuilt from the decision, so
  a duplicate query parameter or an extra JSON key has nothing to ride on.

- **`secretsFrom`** keeps a sandbox's credentials out of the hub entirely. The
  config names an env file the *proxy* holds; the proxy appends those variables
  after it has validated the create request. They never enter the process whose
  stdio children can read `/proc/1/environ`.

- `/health` now reports each server's `kind`, and for a sandbox the `image` and
  `container` it runs as.

- Sandbox containers are taken out of any Compose project their image carried.
  An image built with `docker compose build` is stamped with that project, a
  container inherits its image's labels, and `docker compose down` in the
  directory the image was built in would then collect a container the hub owns
  and is holding the stdio of.

- **`cpus`** for `type: "docker"` entries. Fractional values are accepted and
  become Docker's `NanoCpus`.

- `MCP_CALL_TIMEOUT_MS` and `MCP_RESET_TIMEOUT_ON_PROGRESS` for deployments
  whose tools genuinely run longer than the new absolute deadline below. An
  unusable value logs and keeps the default instead of ending the process:
  unlike the other limits these are read by the request path, not at startup.

### Changed

- **Node 22 or newer is required** (`engines` was `>=20`); CI runs 22 and 24 and
  the images are built on Node 24. Node 20 left maintenance in April 2026.
- **`DOCKER_HOST` is required for `type: "docker"` entries and must point at the
  policy proxy.** It has no default any more, and a value resolving to
  `/var/run/docker.sock` is refused outright: the hub faces the internet and the
  daemon API is root-equivalent, so falling back to it was the one mistake the
  documentation could not prevent. Hub and proxy also complete a versioned
  handshake before the first container operation, which fails closed against an
  unreachable daemon, a foreign socket or a proxy speaking a different policy.
- **Sandboxes now have resource limits by default**: `memory` `512m`, `pidsLimit`
  `256`, `cpus` `1`. Previously an entry without those fields ran unbounded. An
  existing sandbox that needs more must say so in `mcp.json`.
- **Tool calls have an absolute five-minute deadline.** Progress notifications no
  longer extend it, because a child emitting one every few seconds could hold a
  request — and one of the client's concurrency slots — open indefinitely. Raise
  `MCP_CALL_TIMEOUT_MS`, or set `MCP_RESET_TIMEOUT_ON_PROGRESS=true` to restore
  the old behaviour, and raise `HTTP_REQUEST_TIMEOUT_MS` and the reverse proxy
  with it.
- For `type: "docker"` entries only `env` values may use `${VAR}`. The image,
  mounts, ports, network, user and command must be literal: the proxy validates
  those fields against the config and deliberately holds none of the hub's
  secrets, so a variable there would be a field it could not check.
- A `type: "docker"` image given as a mutable tag logs a warning at startup and
  on every config reload. Digests are strongly recommended; tags stay supported.
- Base images are pinned to `node:24-bookworm-slim` by digest.

### Fixed

- The login and consent pages name the client's redirect origin in their
  `form-action`, so signing in actually completes. Browsers apply the directive
  to every hop of a form submission, and the last hop is the redirect that
  carries the authorization code back to the client — with a bare `'self'`
  Chrome and Firefox blocked it silently, leaving the window sitting on the
  password prompt with nothing happening on click or Enter. The origin comes
  from the redirect_uri the SDK has already matched against the client's
  registration, so the widening is per-request and never wider than the flow.

### Security

- The proxy verifies container ownership with the daemon before every start,
  stop, wait, attach and remove: both the `io.mcp-hub.owner` and the
  `io.mcp-hub.server` label must match exactly. The name pattern alone said
  nothing about who created a container that happened to be called
  `mcp-sandbox-<server>`.
- Secret files are validated when the proxy starts and on every config reload,
  not first when a container is created — an operator finds out about a
  world-readable credential immediately instead of at the next restart. They
  must be regular non-symlink files of at most 64 KiB, mode 640 or stricter,
  with at most 100 unique variables and no NUL bytes or duplicate keys. A reload
  that references an invalid set keeps the previous policy.
- Responses from a child server are bounded: 8 MiB per forwarded result, and
  tool discovery stops at 100 pages, 10,000 tools, 16 MiB of metadata or a
  repeated pagination cursor. A server that answers `tools/list` forever can no
  longer exhaust the hub's memory.
- A Docker attach frame with an impossible length ends the stream instead of
  being skipped, so a desynchronised sandbox is restarted through the normal
  supervisor backoff rather than left attached and mute.
- `state.json` mutations are serialized with a cross-process lock (0.6.2 reduced
  the window; it did not close it). The lock is broken only when its owner is
  demonstrably gone — a dead pid, or, when the owner cannot be identified at
  all, an age of more than 30 seconds. A state file deleted underneath a running
  hub is rewritten rather than turned into a permanent failure to mutate.
- Release tags must match `package.json` and point at a commit reachable from
  `main` before anything is published; the MCP registry publisher is pinned by
  version and SHA-256 instead of being taken from `latest`; a Trivy secret scan
  gates every push; the docs deploy runs in a separate job so only it holds
  write permission; and Dependabot auto-merge is limited to patch updates of
  direct development dependencies.

## [0.6.4] - 2026-08-18

### Fixed

- The architecture diagram no longer depends on the reader's operating system.
  It carried a `prefers-color-scheme` block, which resolves against the OS rather
  than the theme toggle of GitHub or npm — so dark-mode readers on a light OS got
  the light artwork on a dark page. The README now uses `<picture>`, which is
  resolved against the page, and the `<img>` that npm falls back to brings its own
  card instead of a media query.

### Changed

- The diagram is generated from a single source, `docs/assets/architecture.source.svg`,
  by `npm run assets`. The four rendered copies had already drifted apart; CI now
  fails if one of them is edited by hand.
- `docs/public/og.png` is generated at exactly 1280x640, GitHub's recommended size
  for a social preview, instead of being drawn by hand.

## [0.6.3] - 2026-08-17

### Fixed

- The per-server proxy no longer advertises resource subscriptions it cannot
  serve. It passed the child's capabilities through unchanged, so a server that
  supports `resources/subscribe` made the hub claim it too — while the proxy
  registers no handler for it, and the call failed with `-32601`. Only the
  `subscribe` flag is dropped: listing, templates and reading are unaffected.

### Changed

- Known gaps: the entry claiming `RESOURCE_BOUND_TOKENS` still defaults to
  `false` is gone. Resource binding has been the default since 0.5.0, and every
  other document already said so — this was the one place still describing the
  old behaviour and promising a flip that had already happened.
- Known gaps now state that `listChanged` is announced but never sent. Passing
  it on is deliberate: delivering server-initiated messages needs the per-client
  session state the stateless transport exists to avoid, and a client waiting
  for a notification that never comes is no worse off than one that was never
  told.

## [0.6.2] - 2026-08-17

### Fixed

- Admin CLI changes now reach a running hub. `state.json` has always had a
  second writer — every `mcp-hub-admin` invocation is its own process on the
  same volume — but each `AuthStore` trusted the copy it read at startup and
  `persist()` rewrote the whole file. A token minted by the CLI was therefore
  refused by the hub as "Access token has been revoked" until the container was
  restarted; worse, a token or client the CLI revoked stayed valid, and the
  hub's next write put its stale snapshot back and resurrected it. Since
  `persist()` runs on every refresh-token rotation, that happened within
  minutes. Reads now re-read the file when it changed underneath them (inode,
  mtime and size), and every mutation is a read-modify-write.
- `checkAlive()` no longer leaks an unhandled rejection when a ping fails
  because the connection went away. `onExit()` had already cleared the client
  by the time the catch block read `this.client.close()`, which throws
  synchronously and so slipped past the attached `.catch()`. Nothing was
  actually broken — the restart was already scheduled — but the resulting
  TypeError landed in `LOG_FILE` with a misleading stack and buried real
  failures.

### Security

- Revocation is now effective against a running hub, which is what the README
  and the security guide already promised. Both documents had described
  `tokens revoke` as taking effect immediately while it silently did nothing
  unless the container was stopped first.
- `state.json` is written through a per-writer temporary file instead of a
  fixed `state.json.tmp`, so two processes can no longer write into the same
  temporary. With an atomic rename a reader can never observe a partial file;
  the residual risk of concurrent writers is a lost update, not corruption.
  Documented in SECURITY.md.
- A reload that cannot be parsed keeps the state already in memory instead of
  quarantining the file and starting fresh the way the constructor does.
  Rotating `cookieSecret` under a running hub would log out every session.

### Changed

- Coverage gate: `@vitest/coverage-v8` pinned to the exact vitest version,
  thresholds set just below the current measurement, and CI keeps the report as
  an artifact. The repository had no coverage tooling before.
- The admin-CLI recipes in the README and the deployment guide no longer tell
  you to stop the container first.
- `jose` 6.2.8 -> 6.2.9.

## [0.6.1] - 2026-08-14

### Fixed

- `/health` runs through the same per-client request gate as the MCP routes.
  It had bearer auth and the resource check but no rate limit, so a token
  holder could hammer it without bound (CodeQL `js/missing-rate-limiting`).

### Changed

- README, package descriptions and documentation no longer present Claude Web
  as the only client: the hub serves ChatGPT connectors, Claude, Mistral
  Le Chat, Cursor, LibreChat and any other Streamable-HTTP MCP client, plus
  API-token access for the OpenAI, xAI and Gemini APIs. Wording only.
- README and documentation state the lightweight goal explicitly — one Node
  process, no database, stateless transport, multi-arch images, comfortable on
  a single-board computer like a Raspberry Pi — and the README's ASCII
  architecture sketch is replaced by the reworked SVG diagram (served from the
  docs site, following the OS colour scheme).

## [0.6.0] - 2026-08-14

### Added

- **API tokens** for clients that cannot do OAuth — the OpenAI Responses API,
  the xAI API, Gemini's `mcp_server` tool and plain-header clients.
  `mcp-hub-admin tokens create --resource <name|hub> --days <n>` mints a
  long-lived, resource-bound token (printed once, never stored); `tokens list`
  and `tokens revoke` manage the records, and revocation refuses the token
  immediately even though its signature is still valid.
- `DEFAULT_RESOURCE`: optionally bind tokens to one chosen resource when an
  OAuth client sends no RFC 8707 `resource` parameter at all (older Codex
  logins, Google ADK, Gemini Enterprise) instead of refusing with
  `invalid_target`. Tokens stay bound either way — never global.
- OIDC discovery alias: `/.well-known/openid-configuration` (plus the
  path-inserted form) serves the RFC 8414 document for clients that probe the
  OIDC path, as the MCP spec expects both to work.
- Documentation: a [client compatibility](https://mcp-hub.ni-c.de/guide/client-compatibility)
  page covering OAuth clients, API clients and their per-client quirks.

### Changed

- Registration plays along with ChatGPT's connector behaviour: public clients
  (`token_endpoint_auth_method: none`) receive a `client_secret` in the
  registration response — ChatGPT refuses its own registration without one —
  but the secret is not stored, so correct public clients are unaffected; and
  client secrets no longer expire (ChatGPT registers once per connector and
  never re-registers, so the SDK's 30-day default would brick the connector).

## [0.5.1] - 2026-08-14

### Added

- Listed in the official [MCP Registry](https://registry.modelcontextprotocol.io)
  as `io.github.ni-c/mcp-hub`, with both install paths — the npm package and the
  GHCR image — described as what they are: a Streamable-HTTP server on `/hub`,
  not a stdio process. The ownership proofs (`mcpName` in `package.json`, the
  `io.modelcontextprotocol.server.name` image label) ship with this release,
  and the release workflow now publishes registry updates automatically.

## [0.5.0] - 2026-08-14

### Changed

- **Breaking: access tokens are bound to one resource by default.**
  `RESOURCE_BOUND_TOKENS` no longer has to be switched on; RFC 8707 binding is
  what you get without asking, and the setting only exists to turn it *off*.
  A token issued for `/paperless/mcp` reaches neither another server nor `/hub`,
  and an authorization request that names no resource is refused with
  `invalid_target`.

  **Upgrading:** tokens issued before this release carry no resource and stop
  working, so every connector authorizes once more. To postpone that, set
  `RESOURCE_BOUND_TOKENS=false` — it restores the old behaviour and logs a
  warning on every start. The default also applies to `createHub()` for
  programmatic use.

- **Breaking: `/health` requires a token for `/hub`.** It reports the same
  fleet-wide view as the aggregate — every server's name, state and tool count —
  so a token bound to a single server no longer reads it. Unauthenticated
  liveness monitoring belongs on `/livez`, unchanged.
- The `uv` layer is pinned to a version tag (`0.12.3`) instead of `latest`. The
  digest is unchanged, so the image content is identical; upgrades now arrive as
  readable version bumps rather than opaque digest churn.
- The documentation site builds with VitePress 2. VitePress 1 pins Vite 5,
  which is end-of-life and carries unfixable dev-server advisories; Vite 8 clears
  them. Documentation tooling is not part of the published package or image.

### Added

- Documentation site at [mcp-hub.ni-c.de](https://mcp-hub.ni-c.de) — guides for
  configuration, deployment, clients and security, an architecture walkthrough,
  a troubleshooting FAQ and a full endpoint/meta-tool reference. Built with
  VitePress from `docs/`, which carries its own manifest so the runtime image
  and the test matrix are unaffected, and published to `gh-pages` by
  `.github/workflows/docs.yml`.

## [0.4.0] - 2026-08-13

### Added

- Published on npm as [`@ni-c/mcp-hub`](https://www.npmjs.com/package/@ni-c/mcp-hub)
  (the unscoped name belongs to an unrelated project). `npx @ni-c/mcp-hub`
  starts the hub, `mcp-hub-admin` ships as a second binary; Docker remains the
  recommended deployment. Releases are published via npm Trusted Publishing
  (OIDC, with provenance) from the new `release.yml`, which also creates the
  GitHub release from this changelog.

### Changed

- The version reported by the `/hub` server and the child MCP clients is now
  read from `package.json` instead of being hardcoded in two source files.
- zod updated to v4, the runtime image moved to `node:26-bookworm-slim`, and
  all GitHub Actions moved to their current majors (checkout v7, setup-node v7,
  CodeQL v4, docker/* v4/v6/v7, trivy-action 0.36).

### Fixed

- The `mcp-hub` binary was missing its shebang line, so the npm-installed
  command would not execute on Unix.

## [0.3.0] - 2026-08-13

Security-hardening release; deployment guidance moved to SECURITY.md.

### Security

- Resource-bound access tokens (RFC 8707), opt-in enforcement via
  `RESOURCE_BOUND_TOKENS=true`; access-token TTL down from 24 h to 15 min.
- Offline revocation via `mcp-hub-admin clients list|revoke`
  (`revokedBefore` marker); stricter EdDSA-pinned JWT verification.
- Per-IP rate limits on all auth endpoints before body parsing, a per-client
  request/concurrency gate for MCP traffic, 1 MB body limit after bearer auth,
  server header/request timeouts and browser hardening (CSP, frame denial) on
  the interactive pages.
- `/health` moved behind bearer auth; new unauthenticated `/livez` liveness
  probe (also used by the image `HEALTHCHECK`).

### Supply chain

- Digest-/SHA-pinned base images and Actions, CodeQL + Trivy gates before
  publishing, SBOM and `mode=max` provenance on images, Dependabot for npm,
  Docker and Actions; bundled npm replaced with npm 12 and its two remaining
  vendored CVEs patched in place; `tini` as PID 1, `curl` removed,
  read-only-rootfs compose example.

## [0.2.0] - 2026-08-11

### Added

- `LOG_FILE` mirrors every hub log line into a file with an ISO-8601 UTC
  prefix while leaving the console untouched — a stable path for fail2ban and
  friends (the Docker `json-file` path changes on every recreate and the
  `journald` driver maps all stderr to priority `err`).

## [0.1.0] - 2026-08-11

First public release: serve many stdio MCP servers from one container over
Streamable HTTP — Claude-Code-style `mcpServers` config (1:1 copy), path-based
routing (`/<name>`, `/<name>/mcp`), the `/hub` aggregate with four meta-tools,
a built-in OAuth 2.1 authorization server (DCR, PKCE, per-client approval,
rotating refresh tokens), child supervision with backoff restarts, config hot
reload, native remote `http`/`sse` upstreams and multi-arch images on GHCR.

<!-- #endregion changelog -->
