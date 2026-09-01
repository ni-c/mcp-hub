# The end-to-end suite

Runs the hub the way it ships, and drives it the way a client does.

```sh
npm run build                                   # the spawned tiers execute dist/
MCPHUB_E2E_TIERS=inproc,process npm run test:e2e
```

For the container tier, build the image first:

```sh
docker build -t mcp-hub:e2e .
MCPHUB_E2E_TIERS=docker MCPHUB_EXPECT_DOCKER=1 npm run test:e2e
```

`npm test` is untouched by all of this. That one is the pull-request gate and
stays fast; this one runs nightly and before a release.

## Why it exists

`test/` covers the hub thoroughly and covers it in one process. That leaves a
shape of question it cannot ask:

- **Env parsing, signals, the listener.** `src/index.ts`'s `isMain` block is
  entered only when the file is the program. `vitest.config.ts` names it as the
  largest gap in the numbers.
- **Two processes over one state file.** `mcp-hub-admin` is a separate program
  sharing `/data` with a running hub. A test that called the same `AuthStore`
  instance proves the hub can read its own memory — and that mistake shipped: a
  revocation reported success, did nothing, and was undone by the hub's next
  write.
- **The artefact.** uid 1000, a read-only root filesystem, the `HEALTHCHECK`,
  tini, `docker compose exec`. None of it can be wrong in a bare process.
- **Containment.** An `uncaughtException` in-process takes the test runner down,
  not the hub. Out of process, a child that writes half a JSON-RPC frame is
  something the hub either survives or does not.
- **The wire.** An SDK smooths over precisely what a gateway must get right.

## The three tiers

| Tier | What it runs | What only it can answer |
|---|---|---|
| `inproc` | `createHub()` here | Fast; the only tier that can reach the supervisor. Mostly a debugging switch — reproduce a `process` failure without the spawn. |
| `process` | `node dist/index.js` | The bootstrap, signals, orphaned children, a second process on the same state file. **The default.** |
| `docker` | the image, via `demo/compose.yml` | The user, the filesystem, the healthcheck, the init — and the public demo. |

`MCPHUB_E2E_TIERS` is a positive list. **In CI it has no default**: a workflow
that lost its `env:` block would otherwise keep reporting green while running a
third of what it claims to.

## What is in here

```
harness/     startGateway() and everything a suite needs to reach a hub
fixtures/    small MCP servers, each with one property no other one has
suites/      the tests
transcripts/ what real clients put on the wire (see its own README)
tools/       record and curate a transcript
```

The fixture fleet is written to misbehave in specific ways — a server that hangs,
one that dies mid-call, one that answers with more than the hub will carry, one
that writes garbage onto the protocol, one that asks for things a stateless
gateway cannot serve. Each file's header says what it is for and why nothing
off the shelf would do.

`demo/servers/*` are used by the `docker` tier and by nothing else. Wiring them
into the general fixtures would mean a change to the demo breaks unrelated
tests, and a change to the tests quietly constrains the demo.

## The agent loop

`harness/agent.ts` is a consumer that behaves like a model without being one. It
discovers (`list_servers` → `list_tools` → `get_tool_schema`) and then builds
its arguments **from the schema the hub published**, rather than from a list
somebody wrote down. That is the whole trick: a schema the hub damaged in
transit — truncated, budget-clipped, missing the properties it declares
required — stops working here, and nowhere else.

It also asserts things that scale with the fleet instead of with the test file:
result shape on every call, `structuredContent` against the declared
`outputSchema`, byte-identical transcripts across two runs of the same scenario
(which catches unordered iteration, the thing that makes real clients flap), and
that no result mentions another server's tools.

A real model was considered and rejected. A model given a broken schema
improvises around it, and improvisation is not an assertion.

## Rules that keep it from rotting

- **Nothing sleeps.** Every wait is `waitFor(predicate, deadline)` with a short
  poll. Time-dependent behaviour is *configured* short through `src/timings.ts`,
  never elapsed — the five-minute backoff ceiling is asserted from the log.
- **`retry: 0`.** A retry hides a flake instead of fixing it, and a flaky
  nightly is muted within a month.
- **Every failure carries the hub's output.** `gateway.explain()` turns
  "Connection closed" into a diagnosis.
- **Loud, never silent.** A missing daemon fails when one was promised; a stale
  `dist/` fails before it can waste an hour; a tier that silently substituted
  another fails; a run that reported zero tests fails.
- **A skip needs a reason a person wrote.** `expectEveryToolExercised` checks
  three directions: never called, reason now false, reason naming a tool that no
  longer exists.

## Two findings this suite produced on its first run

Recorded here because they are the argument for the tier that found them.

- **A hub with no `PASSWORD` and no `PASSWORD_HASH` starts, says nothing, and
  accepts an empty password.** `EXTERNAL_URL` is checked at boot; the password
  is not, and the comparison then reduces to two empty buffers.
  `suites/no-password.e2e.ts`.
- **Malformed JSON is answered `500` / `-32603` "Internal error"** rather than
  the `-32700` the specification reserves for a parse error — telling a client
  the server broke, when what broke was the request. Pinned in
  `suites/conformance.e2e.ts` so that fixing it is a visible change.
