# Changelog

Rendered from
[`CHANGELOG.md`](https://github.com/ni-c/mcp-hub/blob/main/CHANGELOG.md) in the
repository, which is also the source for the
[GitHub releases](https://github.com/ni-c/mcp-hub/releases).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--@include: ../../CHANGELOG.md{8,}-->

## Known gaps

Not a roadmap with dates — an honest list of what is missing and why.

**Server-initiated messages are not delivered.** `listChanged`, resource
subscriptions and sampling stop at the hub. Forwarding them needs per-client
session state, which is exactly what the
[stateless transport](/guide/architecture#stateless-transport) avoids so that
clients reconnecting without closing their sessions cannot leak resources.
Changing this means solving that leak first.

One consequence is visible on the wire: the hub still announces `listChanged`
for tools, prompts and resources, because a proxied server passes its child's
capabilities on and `/hub` gets the flag from the SDK as soon as a tool is
registered. A client that acts on it simply waits for a notification that never
arrives. Resource subscriptions used to be announced the same way, which was
worse — there is no handler, so the call failed — and since 0.6.3 they are no
longer advertised.

**One password, no users.** There are no accounts, roles or audit trails, and
none are planned — that is a different product. See
[Comparison](/guide/comparison#hosted-or-commercial-mcp-gateways).

**No isolation between stdio servers.** They share the hub's user by design.
Servers with differing trust levels belong in separate containers, connected as
[remote upstreams](/guide/configuration#remote-servers).
