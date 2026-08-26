# Changelog

Rendered from
[`CHANGELOG.md`](https://github.com/ni-c/mcp-hub/blob/main/CHANGELOG.md) in the
repository, which is also the source for the
[GitHub releases](https://github.com/ni-c/mcp-hub/releases).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- Included from CHANGELOG.md by name, not by line range: a range silently drops
     whatever moved out of it, so growing the file's header would quietly delete the
     newest release from this page while the build stays green. The markers live in
     CHANGELOG.md as `#region changelog` / `#endregion changelog`, and the Docs
     workflow asserts that the current version reaches the rendered page. -->
<!--@include: ../../CHANGELOG.md#changelog-->

## Known gaps

Not a roadmap with dates — an honest list of what is missing and why.

**An upstream login is per hub, not per user.** A credential the hub holds for
a remote server belongs to the deployment. The hub does not act on behalf of the
individual client that made the call, and there is no way to give two clients
two different upstream identities.

**An upstream that needs re-authorizing stays down until someone acts.** That is
deliberate — retrying cannot help — but it does mean an expired refresh token is
an outage until `mcp-hub-admin upstream login` is run. There is no notification;
watch for `unauthorized` in `/health`.

**Upstream tokens are stored in the clear.** They have to be presented, so they
cannot be hashed like the hub's own refresh tokens. `state.json` is mode 0600
and was already a secret, but with upstream OAuth in use it holds credentials to
a third party — treat the volume accordingly.

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
That is what [sandboxing](/guide/sandboxing) is for: a server you do not trust
belongs in its own container, reached over the Docker API or a socket rather
than as a child process. The stdio kind itself will not gain isolation — a
child process in the hub's container is what it is.

**A sandboxed server is recreated on every hub start.** There is no reattaching
to a container that is already running, so a server with a long startup pays it
again after a hub restart. Reuse would mean a second code path plus drift
detection, and a container whose stdio nobody holds is worse than a slow start.

**The docker proxy is a single point of failure for sandboxes.** If it is down,
`type: "docker"` servers cannot start; stdio, remote and socket servers are
unaffected. It is deliberately small for that reason.
