# Recorded client transcripts

What real MCP clients actually put on the wire, replayed against a hub that has
never met them.

The suite that reads these is `e2e/suites/transcripts.e2e.ts`; how they are
replayed and why is in `e2e/harness/replay.ts`. This file is about getting one.

## Why these exist

Every suite in `e2e/` other than this one drives the hub through the reference
SDK. That proves the reference SDK works. It does not prove that ChatGPT's
`Accept` header is accepted, that claude.ai's reconnect — a GET stream, no
session DELETE, every five minutes — is served, that Codex omitting the RFC 8707
`resource` parameter lands on `DEFAULT_RESOURCE` rather than a 400, or that a
client which never sends `MCP-Protocol-Version` is treated as legacy.

Those are the four kinds of thing that break a connector without breaking a
test, and none of them is reachable from a client that shares the server's idea
of the protocol.

## Rules

**A transcript is never hand-edited.** Re-capture it, or re-derive it with
`curate`. A hand-patched golden quietly becomes "what the hub does today",
which is the opposite of what a golden is for.

**Every file carries a `meta` record**, and its `did` field says what the human
did and what wire behaviour the file pins. A meta-test fails on a missing or
boilerplate one. This is not paperwork: a snapshot with no stated purpose is a
snapshot nobody can decide to delete.

**Re-recording is deliberate.** Only `MCP_HUB_RERECORD=1` writes, and CI fails
if `git status --porcelain e2e/transcripts/` is dirty after a run — so a silent
re-record cannot land in a pull request that looks like something else.

**A transcript older than about two releases is a liability.** Delete it rather
than patch it. It was capturing a client version that no longer exists.

## Capturing one

```sh
# 1. a hub to record against
docker compose -f demo/compose.yml up -d

# 2. the recorder in front of it
npm run e2e:record -- --client chatgpt --upstream-port 7690 \
  --port 7691 --out e2e/transcripts/chatgpt/connector-add.jsonl

# 3. point the real client at http://127.0.0.1:7691, do the thing once, Ctrl-C
#    (the upstream is a port, not a URL: the recorder only ever proxies to
#     127.0.0.1, which is the rule anyway and is one fewer thing to get wrong)

# 4. fill in meta.did, then make it deterministic
npm run e2e:curate -- --file e2e/transcripts/chatgpt/connector-add.jsonl
```

`curate` replays the raw capture twice against a fresh hub and keeps only the
fields both runs agreed on. Everything else was nondeterministic by definition
and must not be asserted. This step is what makes a golden provably stable
rather than merely plausible on the day it was taken.

## The chicken-and-egg problem, stated plainly

A hosted client cannot reach `127.0.0.1`. ChatGPT and claude.ai fetch metadata
documents over the public internet, and `createHub` refuses `oauth mode "cimd"`
on a plain-http issuer at all — so those two have to be captured against a
*deployed* hub behind whatever tunnel or staging host you already use, and
replayed against a local one. That works, and it is why `${EXTERNAL_URL}`
substitution has to be airtight.

The practical consequence: the realistic starting set is two or three files, not
eight. Three real captures are worth more than eight invented ones, which would
only assert what somebody already believed.

## Wanted, in rough order of value

| File | Why it is worth having |
|---|---|
| `claude-web/reconnect-sse.jsonl` | The GET stream reopened every ~5 minutes with no session DELETE. This is the shape that decided the hub stays stateless. |
| `chatgpt/connector-add.jsonl` | Dynamic registration with the throwaway `client_secret` quirk — a public client that is sent a secret it never stores. |
| `codex/no-resource-param.jsonl` | A token request with no `resource`, which must land on `DEFAULT_RESOURCE` rather than `invalid_target`. |
| `vscode/dcr.jsonl` | A second, independent DCR implementation. |
| `mcp-inspector/full-sweep.jsonl` | Tools, resources, prompts and completions in one pass from a client nobody here wrote. |
