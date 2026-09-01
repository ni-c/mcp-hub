# Subscriptions

A server's tool list changes. A watched file is rewritten. Behind a gateway
those events used to stop dead: the hub knew, and the client never found out.

On `2026-07-28` a client opens a notification stream with `subscriptions/listen`
and names what it wants to hear about. The hub carries it — **on both sides**,
and that is the part worth stating plainly:

| | What the hub does |
|---|---|
| Towards **clients** | Serves `subscriptions/listen` on `/hub`, `/<name>/mcp` and `--stdio`: acknowledgment first, per-stream filtering, one stream per client. |
| Towards a **`2026-07-28` child** | Opens its own `subscriptions/listen` upstream, carrying the merged filter of everyone watching that route. |
| Towards a **`2025-11-25` child** | Asks the only way that child understands — `resources/subscribe`, one URI at a time — and receives its unsolicited notifications. |

So a child that has never heard of `subscriptions/listen` still reaches a client
that speaks nothing else. The era gap is the hub's problem, not either end's —
the same bargain as [OAuth in both directions](/reference/standards) and
[elicitation](/guide/elicitation).

## Why a stateless gateway can do this at all

A long-lived stream sounds like exactly what the
[stateless transport](/guide/architecture#stateless-transport) rules out. It is
not, and the reason is worth understanding before you rely on it.

`subscriptions/listen` is one POST whose response stays open. The state is that
open response — not a session table, not a session id, nothing the hub has to
remember and later garbage-collect. When the socket goes, so does the
subscription. A client that reconnects without closing anything (which is what
real clients do, constantly) leaks nothing, because there was never a record of
it to leak.

That is the same property that made elicitation forwardable: it travels as a
*result*, so nothing is held open between the two legs. Both features exist
because the specification found a shape that does not require the gateway to
remember who you are.

## What a client can watch

```json
{
  "method": "subscriptions/listen",
  "params": {
    "notifications": {
      "toolsListChanged": true,
      "promptsListChanged": true,
      "resourcesListChanged": true,
      "resourceSubscriptions": ["file:///project/config.json"]
    }
  }
}
```

The acknowledgment names the subset the hub will honour. A type the child never
advertised is left out of it rather than silently ignored — if a server has no
prompts, `promptsListChanged` does not come back.

On the `/hub` aggregate only `toolsListChanged` is offered, and it fires when
**any** child's tool list moves. That is the only signal that means anything
there: `/hub` aggregates tools and nothing else, so a resource notification from
one child would describe something no `/hub` client can read.

## A `2025-11-25` client is offered none of it

Not "asked and dropped" — not offered. That revision delivers changes
unsolicited on a channel the stateless transport does not keep, and
`resources/subscribe` would require the hub to remember who asked for what.

The hub advertised `listChanged` to those clients for a long time and never
delivered a single notification. That was a lie, it is fixed, and the
[capability table](/reference/standards#what-is-carried-per-revision) now says
what actually happens. `logging` went the same way: `logging/setLevel` never had
a handler, so it is no longer advertised on either era.

## Sleeping servers, and what a nap costs

An [on-demand server](/guide/on-demand) holds no connection while it sleeps, so
nothing is watched. This is a deliberate trade and you should know its shape:

- **Subscribing does not wake anything.** The acknowledgment is built from the
  cached capabilities, which survive the nap. Waking on subscribe would undo
  on-demand for every server anyone ever watched.
- **The subscription survives as intent.** It is re-established upstream the
  moment something wakes the child — a tool call, a resource read,
  `wake_server`.
- **On waking, the hub tells you to re-read.** The `listChanged` types you asked
  for, plus one `resources/updated` for every URI you were watching. That does
  not claim those resources changed; it says *look again*, which is all the
  notification ever meant.

What you cannot learn is *what* changed during the nap. If that matters for a
particular server, give it `keepAlive: true`.

The same replay happens after a crash and restart, for the same reason.

## Switching it off

Per server, beside `passthrough`:

```json
{
  "mcpServers": {
    "chatty": { "command": "npx", "args": ["-y", "some-server"], "subscriptions": "off" }
  }
}
```

`"off"` withdraws that server's right to push. It is a separate judgement from
`passthrough`: that one is about words shown to a person and the risk is
phishing; this one is about volume on a stream nobody reads synchronously and
the risk is noise. A server can easily warrant one answer and not the other.

A switched-off server is treated exactly like a 2025 connection — the capability
is withheld too, so nothing is announced that will not arrive.

`MCP_SUBSCRIPTIONS=false` turns the whole thing off for the deployment.

## Limits

| Variable | Default | What it bounds |
|---|---|---|
| `MCP_SUBSCRIPTIONS` | `true` | The feature, hub-wide. |
| `MCP_MAX_SUBSCRIPTIONS` | `1024` | Open listen streams per route. |
| `MCP_SUBSCRIPTION_MAX_URIS` | `64` | URIs one filter may name; more is refused with `-32602`. |
| `MCP_SUBSCRIPTION_KEEPALIVE_MS` | `15000` | SSE keepalive; `0` disables it. |
| `MCP_SUBSCRIPTION_DEBOUNCE_MS` | `250` | Coalescing window; `0` delivers every event as it arrives. |
| `MCP_SUBSCRIPTION_MAX_MS` | `1800000` | How long one stream may stay open; `0` means as long as the socket. |

A listen stream is counted against `MCP_MAX_CONCURRENT_STREAMS`, not
`MCP_MAX_CONCURRENT_REQUESTS` — it is the standing channel by another name, and
charging it to the in-flight budget would let a handful of subscribed clients
lock every tool call on the hub out.

Within the coalescing window, repeats of the same event collapse to one. Fifty
`tools/list_changed` in a second are still one instruction: read the list again.

## Two things it does not do

**A stream that hits `MCP_SUBSCRIPTION_MAX_MS` is closed, not closed
gracefully.** The specification describes ending a subscription by answering the
original request with a completion result first; the SDK owns the stream and
offers no hook for that. So the stream simply ends, which the client sees as the
same unexpected disconnect an HTTP timeout produces — one of the ways the
specification says a subscription ends — and re-listens.

**A resync reaches every stream on the route, not just the one it was for.** One
event bus serves a whole path, so when a child wakes and its watchers are told
to re-read, anyone else listening on that path is told too. Harmless — they
re-read a list they already had — and damped by the coalescing window, but it is
real and you may see it.

## Next

- [Standards](/reference/standards#what-is-carried-per-revision) — the row-by-row table, with a test behind each row
- [On-demand servers](/guide/on-demand) — what sleeps, and when
- [Elicitation](/guide/elicitation) — the other direction, and the other half of what the 2026 revision unlocked
