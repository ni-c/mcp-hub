# Elicitation

Some servers need a person, not a model. `smtp-mcp` asks before it sends a
message; `imap-mcp` asks before it expunges a mailbox. MCP calls that
**elicitation**: the server puts a question in front of whoever is sitting at
the client, and the model cannot answer on their behalf.

Behind a gateway that question used to have nowhere to go, and a server that
cannot ask does not stop working — it falls back to something weaker. Both of
those two fall back to a confirmation token returned inside a tool result,
which the model reads and can satisfy by calling twice in the same turn. That
still catches a mistake. It does not catch a model that has been talked into
something.

On the `2026-07-28` revision the hub carries the question through, in both
directions.

## How it works

The reason this fits a stateless hub is that the question is not a push. On
`2026-07-28` there is no server→client request channel at all: a server answers
`input_required` instead of a result, and the call **ends**.

```
client ──tools/call──► hub ──────► child
                                     │ "may I really delete these?"
client ◄──input_required── hub ◄─────┘

                        ( the person reads it and decides )

client ──tools/call + the answer──► hub ──────► child
client ◄──────── the result ─────── hub ◄───────┘
```

Nothing is held open while somebody thinks. No request occupies one of the
hub's [concurrency slots](/guide/security), no timer runs, and the five-minute
call deadline is never anywhere near being reached — the hub→child leg is two
short calls, not one long one. Statelessness is the reason this works rather
than an obstacle to it.

## What the hub adds

The question was written by a child server and is shown to a human as though
the hub were asking. That crosses a trust boundary, so four things happen to it
on the way through, and each is a refusal rather than a repair.

**It is attributed.** The message is prefixed with `Server "<name>" asks:`, and
the text is stripped of bidirectional overrides, zero-width and control
characters first — otherwise a child could visually reverse the very line that
names it.

**Only questions travel.** A child may embed other requests in an
`input_required`; the hub carries `elicitation/create` and drops the rest. An
embedded `sampling/createMessage` would spend the caller's model budget on a
child's prompt, and `roots/list` would hand a child the client's workspace
layout. Neither is something to relay on a child's say-so. What was dropped is
named in the hub log.

**The child's `_meta` is removed.** A progress token or a related-task id
belongs to the child's own id space; forwarded downstream it would collide with
the client's.

**The state is sealed.** `requestState` goes out to the client and comes back,
so the hub treats it as attacker-controlled: it is signed with the same secret
that signs the login cookie and bound to the server, the tool, the OAuth client
and the endpoint it was minted at. A state that does not open — expired, out of
rounds, forged, or minted for a different call — is refused as a whole, without
saying which part was wrong.

## When the hub asks nothing

The hub only announces to a child that a question is answerable when it
actually is. All four have to hold at once:

1. the operator has not switched pass-through off, globally or for this server;
2. the client declared `elicitation` **in this request** — which is a
   `2026-07-28` thing, so a 2025 client is ruled out here;
3. the child negotiated `2026-07-28`, so its answer can be a result;
4. the child actually asked something.

The capability is mirrored from what the client declared for that one call and
never widened. That is what keeps the announcement honest: it says only "the
caller of this one call can answer you".

A 2025 client over HTTP therefore never sees an elicitation, and the child is
told so rather than left to discover it — it takes its own fallback, which is
the correct behaviour for a client that genuinely cannot be asked. Over stdio
there is no such limit: `mcp-hub-stdio` is spawned per client session, so both
eras reach a person.

### Finding out why nothing was asked

A child's fallback is deliberately quiet, and that is the problem: a server that
took its two-call token instead of asking looks exactly like a server that had
nothing to ask. Two ways to tell them apart.

From the operator's side, the hub says it once per client, server and reason:

```
mcp-hub: [freshrss] elicitation not forwarded for client "…" — the caller
declared no elicitation capability for this request, so a question would have
nowhere to go
```

Once, not per call: a connector that cannot be asked calls all day and the
answer never changes.

From inside the client, switch
[`MCP_DIAGNOSTICS`](/reference/environment#diagnostics) on and ask
[`describe_connection`](/reference/hub-tools#describe-connection) — it reports
the era, the capability this request carried, and for a named server whether a
question would reach you.

## Switching it off

Per server, in `mcp.json`:

```json
{
  "mcpServers": {
    "imap": { "command": "npx", "args": ["-y", "@ni-c/imap-mcp"], "passthrough": "off" }
  }
}
```

`"off"` withdraws that upstream's right to put words in front of the user. It
is a phishing judgement, not an availability one: the server keeps working and
falls back on its own. `"auto"` is the default.

Globally, `MCP_ELICITATION=false` is the emergency brake. The rest of the
limits exist so that one child cannot turn a prompt into a denial of service:

| Variable | Default | What it bounds |
|---|---|---|
| `MCP_ELICITATION` | `true` | the whole feature |
| `MCP_ELICITATION_MAX_ROUNDS` | `8` | how often one call may come back for more input |
| `MCP_ELICITATION_STATE_TTL_MS` | `900000` | how long a half-finished call stays resumable |
| `MCP_ELICITATION_MAX_MESSAGE_BYTES` | `4096` | one prompt — anything longer is not a prompt |
| `MCP_ELICITATION_MAX_PAYLOAD_BYTES` | `131072` | the whole question, schemas included |

The round cap is enforced through the sealed state rather than a counter,
because the hub keeps nothing between requests.

## What is not logged

Never the question and never the answer. Both are text a person read or typed;
what the log gets is the server name, the tool and the fact that something was
dropped.

## What this is worth, next to an annotation

A child's [tool annotations](/reference/hub-tools#list-tools) travel through the
hub unchanged, and they are a **hint a client may ignore** — the specification
says so in as many words. Elicitation is not: the child raises the question, and
until an answer comes back it does nothing.

That is why passing it through matters more than it looks. A server whose
`delete_*` tool asks a person keeps asking behind the hub; one that is only
annotated `destructiveHint: true` is relying on a client to notice. The servers
in [this family](https://github.com/ni-c) do the former — see, for instance,
[imap-mcp's approval guide](https://imap-mcp.ni-c.de/guide/approval) — and each
of them can be switched onto its two-call token fallback with `ELICITATION=false`
if a dialog is the wrong shape for a deployment.

Note the two names are deliberately different. `MCP_ELICITATION` here switches
off the hub's **carrying** of the question; `ELICITATION` in a child switches off
that child's **asking** of it. Two layers, two switches — and neither of them
turns a guarded call into an unguarded one.

## Next

- [Hub meta-tools](/reference/hub-tools#list-tools) — what a child's annotations look like coming out of `list_tools`
- [Standards](/reference/standards#transport-and-protocol) — the full capability matrix, per revision
- [Architecture](/guide/architecture#stateless-transport) — why the stateless transport helps here and hurts elsewhere
- [Configuration](/guide/configuration) — where `passthrough` goes
