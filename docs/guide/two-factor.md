# Two-factor login

By default the hub's login asks for one thing, the operator password. With
`TWO_FACTOR=totp` it asks for a second one as well: the six-digit code an
authenticator app shows for the hub (TOTP, [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)).
Every connector you add, in any client, sends you through that login, so a
password that leaked — typed into the wrong window, pasted into a chat, read
off a screen — no longer approves a client on its own.

Two-factor login is off unless you turn it on. Nothing changes for a hub that
does not set the variable.

## Turning it on

**1. Make a secret and put it into your authenticator app.** Run the admin CLI
interactively inside the container:

```sh
docker exec -it mcp-hub node /app/dist/admin.js totp init
```

It prints a QR code into the terminal, the same secret as a setup key in groups
of four, an `otpauth://` link and an `apple-otpauth://` link. Scan the code or
type the key into any authenticator app. On an iPhone the Passwords app takes
the key under *Set Up Verification Code*, and the second link opens it there
directly. Then type the code the app shows. The command prints the two lines for
the hub's environment only once that code matched, so a mistyped key or a phone
whose clock is off is caught here and not at your next login.

```txt
TWO_FACTOR=totp
TOTP_SECRET=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
```

`--light` draws the QR code for a light terminal background, `--label <name>`
changes the name the app lists the hub under (the host of `EXTERNAL_URL` by
default), and `--no-confirm` skips the check for scripts.

::: warning The output contains the secret
Anything that records terminal output keeps it: shell history tools that capture
output, `script`, CI logs. Clear it there, and keep the secret out of the
password manager that holds the hub password. Whoever opens a vault holding both
has both factors.
:::

**2. Hand the two lines to the hub.** In Compose, with the secret in `.env`:

```yaml
environment:
  TWO_FACTOR: "totp"
  TOTP_SECRET: "${TOTP_SECRET}"
```

**3. Restart.** The log says `two-factor login is on`, and, the first time,
`two-factor login was switched on since the last start`.

## What your connectors notice

**They sign in once more.** While two-factor login is on, the hub refuses what a
sign-in without a code had issued:

- **Refresh tokens and authorization codes** from such a sign-in are refused with
  `invalid_grant`, and the client sends you to the login page again. A refreshed
  token inherits what its first sign-in proved, so a connector that signed in
  with a code keeps refreshing.
- **A browser session** from such a sign-in no longer skips the login page.
- **The hub's session cookie**, which the consent page and the
  [upstream OAuth callback](/guide/configuration#upstreams-that-speak-oauth)
  check, is signed together with the mode. Switching the mode in either
  direction ends it.
- **Access tokens** that are already out keep working until they expire, which
  is fifteen minutes at most.

**Admin API tokens are not affected.** Tokens from
[`mcp-hub-admin tokens create`](/reference/admin-cli#tokens) never pass through
the login page, so there is no code to ask for. They are bearer credentials for
machines. Keep them short-lived, bound to one resource, and revoke the ones you
no longer use.

Switching two-factor login off again is the same edit in reverse. The password
alone signs in, and tokens that were issued with a code keep working.

## The login page

The code field sits under the password field and carries
`autocomplete="one-time-code"` and `inputmode="numeric"`. A phone therefore
offers the current code from its password manager or Passwords app, and opens
the number keyboard otherwise. Spaces are ignored, so `123 456` works.

A wrong password and a wrong code get the same answer, *Wrong password or code*.
The page does not tell anyone who is guessing which half was right.

## Codes, mistakes and pauses

**A code works once.** The hub accepts the code for the current 30-second step
and one step either side, to allow for clocks that drift and fingers that are
slow. Once a step was used, it and every earlier one are refused: *This code was
already used. Wait for the next one.* The last used step is stored in
`state.json`, so the hub and the admin CLI agree on it.

**Wrong passwords** count against the per-address login limit, ten per fifteen
minutes, and log `authentication failure from <ip>`. That is the line the
documented [fail2ban filter](/guide/deployment#fail2ban) bans on.

**Wrong codes after a correct password** pause sign-in, from the fifth one on:
thirty seconds, then doubling with every further wrong code, up to an hour. The
page answers `429` with a `Retry-After`, and a correct code resets the count.
These attempts log `second-factor failure from <ip>`, which the filter does
**not** match, so a typo on your own phone does not ban your own address. Only
someone who knows the password can start the pause. While it lasts, a wrong
password gets the same `429` as a right one, so the pause does not confirm a
guess either.

## When the secret is missing or broken

With `TWO_FACTOR=totp` and a `TOTP_SECRET` that is unset, not Base32 or shorter
than 160 bits, nobody can sign in. The hub still starts and serves its discovery
documents, the first log line says what is wrong, and the login page answers
`503` with the reason. It never falls back to the password alone. An unknown
`TWO_FACTOR` value stops the hub at startup.

## A lost phone

Recovery happens on the host, by whoever can change the hub's environment.
Either set `TWO_FACTOR=off`, sign in with the password and set up a new
authenticator, or run `totp init` again and replace `TOTP_SECRET`. There are no
recovery codes: anyone who can do either already controls the hub, and nobody
else should be able to.

## What it does not protect against

- **Phishing.** A code typed into a convincing copy of the login page can be
  replayed by whoever runs the copy, within the code's 30 seconds. Look at the
  address before you type.
- **A compromised stdio server.** Per the [trust model](/guide/security#trust-model)
  a child process runs as the hub's user and can read the hub's environment,
  `TOTP_SECRET` included. The second factor guards the login, not the container.

## Reference

- [`TWO_FACTOR` and `TOTP_SECRET`](/reference/environment#two-factor-login)
- [`mcp-hub-admin totp init`](/reference/admin-cli#totp)
- [Security](/guide/security) — rate limits and the trust model
