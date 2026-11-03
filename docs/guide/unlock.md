# Locked servers

Some servers are too powerful to be at every model's disposal at every moment.
A shell, a mailbox that can send, the DNS of your domains. Any client that
holds a token for the hub can call them, and so can a token that leaked or a
model that a web page or an e-mail talked into it.

`unlock` keeps such a server locked until a person unlocks it. A model that
calls one of its tools gets a link instead of a result. You open the link,
prove that you are there with the operator password (and the
[second factor](/guide/two-factor), if it is on), and pick how long: only this
call, or 15 minutes up to four hours. Only the connection that asked is
unlocked, and only for that long.

## Configuration

```jsonc
{
  "mcpServers": {
    // every tool, resource and prompt locked, unlocks up to 4 hours
    "ssh": { "type": "docker", "image": "…", "unlock": true },
    // only these tools locked, unlocks up to 2 hours
    "smtp": { "command": "smtp-mcp", "unlock": { "tools": ["send_mail", "reply_mail", "forward_mail"], "maxMinutes": 120 } }
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `tools` | `["*"]` | The tools that stay locked, in the [`allowTools` syntax](/guide/configuration#filtering-tools): exact names or a trailing `*`. `"*"` locks the whole server: tools, resources, prompts, completions and subscriptions. A list locks just those tools and leaves everything else of the server free. |
| `maxMinutes` | `240` | The longest unlock the page offers, from `0` (single calls only) to `240`. |

`"unlock": true` is short for `{ "tools": ["*"] }`. The fields are checked
strictly, and an unknown field stops the config from loading. A misspelt key next to
`unlock` (`"unlok"`) is [warned about](/guide/configuration#validation-errors)
rather than ignored in silence. Entries in `tools` that match none of the
server's tools are warned about when its tool list arrives: such a typo would
leave a tool unlocked.

Changing `tools` or `maxMinutes` takes effect at once without restarting the
server. Adding or removing `unlock` restarts it.

::: warning A hub older than 0.12 ignores `unlock`
Upgrade the hub first, then add the key. An older hub, or a rollback to one,
runs a server with `unlock` as if it were not locked. The boot log names every
locked server (`locked until unlocked: …`), so check for that line.
:::

## What a model sees

The locked server's tools stay listed, so a model knows they exist.
`list_servers` marks them, with `locked`, the `lockedTools` when it is not all
of them, and `unlockedUntil` when the caller holds an unlock.

A call to a locked tool does not reach the server. The answer depends on the
client:

- **Clients that can open pages themselves** (URL-mode elicitation: Claude Code,
  VS Code, the MCP Inspector) are asked through the client. It shows the hub's
  address, the server, the tool and the matching code, opens the page with your
  consent, and retries the call once you are done.
- **Every other client** (claude.ai, ChatGPT, …) gets an error result with the link
  and the matching code, and the instruction to ask you and then call again.

On a hub that locks something, two more meta-tools appear on `/hub`:

- `request_unlock` hands out the link before the first call.
- `lock_server` ends the caller's own unlocks once it is done. It can never
  unlock anything.

## The page

The link opens a page on the hub. It shows what the hub itself recorded:

- the server, and what is locked on it;
- the client and the time;
- the matching code, the same one the model was given;
- for a locked call, the tool and its exact arguments, marked as written by the
  model.

Compare the code with the one in your chat. If it differs, or you did not start
this, press **Deny**: the model is told, and the same ask is held off for two
minutes.

To unlock, choose a duration, enter the password and, with two-factor login on,
the code from your authenticator, and press **Unlock**. *Only this call* unlocks
exactly that call with exactly those arguments, once. The page offers it when
the arguments are short enough to show in full. The durations stop at the
server's `maxMinutes`, and an unlock ends at a fixed time: using the server does
not extend it. To keep going, unlock again.

The link works for ten minutes and once. It unlocks nothing by itself. Every
unlock needs the factors, and wrong ones count exactly as on the login page:
toward the per-address limit and the pause after wrong codes, with the same log
lines.

**`/unlock` is worth a bookmark.** Sign in there and it shows:

- the open requests with their codes, to unlock or deny;
- what is unlocked right now, with a *Lock now* button for each;
- a form to unlock a server ahead of a call for an approved client.

With the bookmark you never need a link a model gave you.

## Who is unlocked

**The authorization that asked, and only that.** One authorization is one
connector you added in one client: the `/ssh/mcp` connector in claude.ai, or one
Claude Code installation. Another client stays locked, and so does another
installation of the same client.

Within one authorization, an unlock covers everything that authorization does.
All your claude.ai conversations use the same connector, so a 30-minute unlock
started from one conversation also covers the others.

Admin API tokens are unlocked per token. An unlock made from the overview page or
the admin CLI covers every authorization of the client you pick.

## When an unlock ends

It expires, you press *Lock now*, the model calls `lock_server`, or
`mcp-hub-admin unlock revoke` ends it. From then on the server's locked tools are
refused again, and calls already running are allowed to finish.

When the last unlock of a server that locks everything has ended, the hub waits
for those calls (up to five minutes) and then ends what the server holds. An
[on-demand](/guide/on-demand) server goes to sleep, an always-on one restarts. A
shell session or a connection that was opened while the server was unlocked
does not outlive the unlock. A server that locks only some tools keeps running,
because its other tools are free.

## From the host

```sh
mcp-hub-admin unlock list
mcp-hub-admin unlock grant <server> <minutes> --client <client-id>
mcp-hub-admin unlock revoke <server> [--client <client-id>]
```

This is the way in without a phone, or for a hub without a usable sign-in. See
the [admin CLI](/reference/admin-cli#unlock).

## Limits

- **An unlock is a window, and whatever runs in it runs.** A model that is being
  manipulated while the server is unlocked can use it like any other call.
  Prefer short windows, or *only this call*, and lock again when you are done.
- **A server that administers the hub's own host can switch the lock off.** A
  shell that runs `docker` on the machine the hub runs on can reach the hub's
  container, its environment and its config while it is unlocked. Keep such a
  server's own permissions narrow. The lock is not a sandbox.
- **A link from a model can be a fake.** The page lives on your hub's address
  and nowhere else, so check the address before you type the password. The
  `/unlock` bookmark avoids the question altogether.
- **Over stdio nothing can be unlocked.** There is no page to unlock on, so
  locked tools stay shut in `--stdio` mode.
