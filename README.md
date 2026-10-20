# dsh-unattended-supervisor

A session-scoped **unattended assistance** switch for DeepSeek Harness. It helps a
long task keep moving after the user steps away — and, when a decision truly needs
a human, sends one QQ decision email instead of silently stalling.

**The switch controls the plugin's assistance, not the task.** Turning it off
restores normal DSH behaviour; it never pauses, cancels, or stops anything.

## What it is not

- It does not approve tool calls, plan reviews, or permission changes.
- It does not resume a disarmed Goal, re-arm a paused Goal, or fabricate human input.
- It does not restart tasks after an app restart, and it does not silently resume
  work the user stopped.
- It does not listen to email replies; a reply is not an approval.
- It is not a model-quota watchdog: quota, auth, and rate-limit errors are handled
  as ordinary failures.

## The switch

Per session, default **off**, persistable across restarts only as *off*.

| State | Behaviour |
|---|---|
| **On** | The plugin may add its extra progress checkpoints, guidance context, and decision mail for *this* session. |
| **Off** | Every plugin-added behaviour is disabled immediately. The current turn, tools, subagents, and native Goal continuation keep running exactly as before. |

Turning it off is not stopping the task: use DSH's own **Stop** for that. Reopening
it reuses the recorded contract and progress instead of replaying work.

Toggle it two ways — both are the same Host operation:

- the **switch in the composer tool row**, or
- the human command `/unattended [on|off|status] [expected-revision]`.

The `expected-revision` argument is an optimistic-concurrency fence: a stale value
is rejected instead of clobbering a newer state from another tab.

### Reading state without writing the transcript

The switch has to read the current state to render itself, and it does that over
`GET /api/unattended.status?sessionId=…` — an exact Fetch route on the
authenticated `connection.fetch` channel, admitted only to the owner principal.

This distinction matters because DSH logs **every executed command** as a
`command/run`/`command/done` pair that the transcript renders as a row. The first
version read state by executing `/unattended status` through the Commands remote,
so each focus refresh and each re-mount appended a JSON blob to the tail of the
conversation — visible noise that looked like someone had typed the command.

- **Reading state** (the switch's initial load, the ↻ button, window refocus) never
  enters the command executor, so it never writes a log row.
- **Changing state** still goes through `/unattended on|off <expected-revision>`:
  the recorded lifecycle is the audit trail for who flipped it and when.

The route is mounted through an optional `ctx.inject(['connection'], …)` child, so
a profile without a Web connection still loads the plugin; it just has no read-only
transport. A Host process started before this version mounted the route answers a
bare 404 for it; the switch probes once, then falls back to the legacy command read
(which logs, as before) so it keeps working until the app is restarted.

`src/client.js` also owns the `conversation.chat.commandview` cell for the
`unattended` command name: a real toggle renders as one compact line, and a status
row renders as nothing at all. That is what clears the JSON rows already recorded
in older sessions.

## The four pieces

| Concern | Where it lives | What it does |
|---|---|---|
| Mode + contract state machine | `src/engine.js` | Pure, dependency-free state: phase, objective, acceptance, decisions, evidence, progress fingerprint, nudge/stall budgets. Never touches tasks, Goals, or jobs. |
| Host wiring | `src/index.js` | Opens the durable domain, registers the command, the three model tools, the read-only status route, and the passive approval/question observers. |
| Coordination | `src/controller.js` | Bounds and fences every plugin-initiated action; owns the durable outbox and the per-session write queue. |
| Decision mail | `src/mail.js` | One bounded `agently-cli` send plus sent-copy verification. No retries of an unknown outcome, no OAuth, no secrets in the body. |

## Model tools

The tools are read/record only; none of them can start, stop, or authorize work.

| Tool | Purpose |
|---|---|
| `unattended_status` | Read this session's mode and ledger (including the current waits). Cannot change the mode. |
| `unattended_checkpoint` | Record the contract, progress, and verification evidence. `phase=complete` requires accepted criteria *and* evidence, refuses to land over active subagents / unresolved waits / an in-flight mail (see the completion gate below), and switches off only this plugin. |
| `unattended_request_user` | Send one deduplicated QQ decision email when the user genuinely must decide. Does not approve anything. |

Mode changes deliberately have **no model tool**: only a human command or the UI
switch can enable or disable the mode.

## Waiting decisions and the notification channels

A pending decision is first **registered as a wait** (`controller.waitStarted`),
which starts a grace timer (`mailGraceMs`, default 15 s) so a user who is present
wins. When the decision settles, `waitSettled` stops the timer and drops the
registration — a settled wait never mails. Every path that takes a session out of
ON (the switch, a non-completed turn end, an unloaded session, completion) clears
that session's waits without mailing.

Which channel observes which decision:

- **Approvals go through the authoritative `session/event` broadcast.** The
  `approval/request` waterfall can be answered (truncated) by the GUI or any
  earlier listener before the plugin's observer ever runs, so it silently missed
  waits. The runtime instead commits `approval/asked` /
  `approval/decided` records to the session log, and `session/event` is a
  post-commit, fire-and-forget broadcast that **no answerer can truncate**. The
  plugin listens on the root context, so it sees every session's events,
  including subagent sessions.
- **Subagent approvals are escalated to the root session.** `Agent.id` equals the
  session id, so an `approval/asked` whose own session has the plugin off is
  mapped through `childOwners` to its delegating root; the notice is issued in
  the root's name. A session that is neither enabled nor mapped to an enabled
  root is never notified.
- **Questions keep the `user-questions/request` waterfall** (it has no session
  audit event), but the observer is registered with `prepend: true` — always
  ahead of the GUI answerer — and fully try/catch-guarded: an observer that
  throws, or a registration that fails, logs a warning and still calls
  `next()`. The observer can never veto or deadlock the user's answer chain.

The current waits are visible in `controller.view(id)` (`kind`, `decisionId`,
`waitedMs`), which `unattended_status` and the status route surface.

## Decision mail

The recipient is a config value with **no default**: decision mail stays
disabled — every notice settles as an explicit, retriable configuration error —
until you set `mailRecipient` to your own address (the CLI defaults to
`/opt/homebrew/bin/agently-cli`). A send is attempted only when all of these hold:

1. the session is On and currently a live root (re-checked when the grace timer
   fires and again at send time — **never** fenced by the revision, which any
   checkpoint during the wait would otherwise bump and silently drop the mail),
2. the same `decisionId` has not already produced an attempt (`sending`,
   `queued`, `sent_copy_verified`, or `delivery_unknown` — one mail per decision,
   regardless of how many checkpoints happen in between),
3. the process can still write its private body file (0700 dir, 0600 file).

A `failed` or `cancelled` entry **allows a fresh attempt** for the same
`decisionId`: a failed notice must not permanently blackhole the decision.

## The completion gate

`unattended_checkpoint` with `phase=complete` passes three structured gates
before it may switch the plugin off; any failure is refused with the concrete
blockers (and the reason lands in `lastError`, visible via
`unattended_status`):

1. **Active subagents** — any child still registered to the session.
2. **Unresolved waits** — any pending approval/question wait of the session.
3. **In-flight mail** — any `sending` notice; an already settled mail never
   blocks (`delivery_unknown` does not block either, but stays visible in
   `view()`).

The engine's own text gates (acceptance and evidence must be non-empty) are
unchanged and run first.

`"queued": true` from the CLI is **acceptance, not delivery**, so the result stays
`queued` until the sent folder lists a matching copy (`sent_copy_verified`).
Timeout or a thrown run leaves the outcome unknown (`delivery_unknown`) and the
mail is never blindly resent. Nothing about a sent email grants approval — the
user must answer back in DSH.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `idleDelayMs` | `15000` | Quiet time before an auxiliary checkpoint may follow up. |
| `sweepMs` | `5000` | Sweep interval for enabled, idle sessions. |
| `maxNudges` | `12` | Hard cap on plugin-initiated follow-ups per session. |
| `maxStalls` | `3` | Consecutive no-progress follow-ups before the plugin backs off. |
| `childGraceMs` | `120000` | How long a delegated child may stay unknown to the runtime before its bookkeeping is dropped. |
| `mailGraceMs` | `15000` | Delay before mailing a pending approval/question, so a present user wins. |
| `mailTimeoutMs` | `30000` | Hard limit for one CLI invocation. |
| `mailCli` | `/opt/homebrew/bin/agently-cli` | Absolute path to the mail CLI. |
| `mailRecipient` | *(empty)* | Decision-mail recipient. Empty disables decision mail (notices fail with an explicit configuration error); set your own address to enable it. |

An omitted config still yields every default (see `test/contract.test.js`).

## Durability

State lives in the `unattended_supervisor` storage domain (per-record layout). The
recorded contract and ledger survive a restart; **continuation authority never
does** — a restored session is always `off` and must be switched on again by a human.
Writes are serialized per session, and a write failure fails closed (`Storage error`)
rather than continuing with unsaved authority.

## Develop

```bash
node scripts/check.mjs          # packaging preflight: manifest, patch, locales, syntax
node scripts/harness-smoke.mjs  # mounts apply() on a real Cordis Context + real storage stack
node --test test/*.test.js      # unit + host-level end-to-end tests
npm run verify                  # all three
```

### Test layers

| Layer | File | What it proves |
|---|---|---|
| Pure state machine | `test/engine.test.js` | Revision fences, progress fingerprint, nudge/stall bounds, restore-always-OFF |
| Mail transport | `test/mail.test.js` | argv/path safety, redaction, acceptance vs delivery, no blind resend |
| Contract guards | `test/contract.test.js` | The four load-blocking defects below cannot regress |
| **Host end-to-end** | `test/e2e.host.test.js` | The real `apply()` mounted over the real storage stack: default OFF, ON injects non-human guidance, OFF never touches the task, stale revision refused, checkpoint persisted OFF, `complete` gate, mail dedup, subagent/goal suppression, `maxNudges` cap, unload silence, aborted turn; plus the read-only status route: mounted only with a connection, answers the same view, refuses unknown sessions, never advances state |
| **Fix-spec regression** | `test/regression.a2.test.js` | The 2026-10-19 acceptance set: approval `asked`→grace→exactly one mail, `decided`→zero mail, checkpoint during a wait no longer drops the mail, one mail per `decisionId` across checkpoints, `failed` decisions retriable, child-session approval escalated to the root, `complete` blocked by child/wait/in-flight mail and released after cleanup, a throwing question observer cannot deadlock the waterfall, OFF/turn-end clears pending timers |
| **Client half** | `test/client.test.js` | The bundle evaluated against a recording Host: a status read is one authenticated GET and never a command execution, a Host refusal is not mistaken for a missing route, the legacy fallback probes once, a toggle stays an auditable command, and the command-row cell hides status rows |

The end-to-end layer drives the plugin through the same entry points DSH uses (the
`/unattended` command handler and the controller methods behind the model tools),
stubbing only the Host service boundary and the mailer's child process. The client
layer stubs the module loader, `fetch`, and React, and calls the same functions the
two slot components call.

`harness-smoke.mjs` resolves the DSH runtime from this installation (override with
`DSH_MODULES=/path/to/node_modules`). It exists because three of the load-blocking
defects below only appear against the real storage stack, not against stubs:

| Defect | Symptom if unfixed |
|---|---|
| Domain name `unattended-supervisor` | `invalid unit name` — the plugin never loads |
| Outbox key `session:decision:revision` | `per-record key ... is not path-safe` |
| `Config = z.object({}).strict().default({})` | every field default skipped, so `ctx.interval(fn, undefined)` |
| Reading a parent from `subagent/start` info | the run info has no parent field, so live children go unnoticed |

### Unloading

`fiber.dispose()` is the unload path that runs effect disposers.
`ctx.registry.delete(fiber)` resolves a plugin *callback*, so passing a fiber there
silently skips cleanup — a mistake this repo made once in its own harness script and
now asserts against.

## Install

Install as a bundle through the DSH plugin manager (`install_bundle` with this
directory). The patch inserts one Host row named `dsh-unattended-supervisor`; it
does not override or disable any shipped row. Changes affect every session in the
profile after the profile recomposes.

## Boundaries

- Scope: one session's *assistance*; not a supervisor of the whole process.
- Subagent, job, and native-Goal activity always outranks an auxiliary follow-up:
  while any of them is live, the plugin stays quiet.
- A user stop, a non-completed turn end, an unloaded session, or a storage failure
  disables the plugin's authority for that session immediately.
- No new permissions, no sandbox or approval-policy changes, no credential access.

## Known limitations

These are deliberate, documented trade-offs rather than defects:

- **Decision mail needs a live OAuth grant.** Measured against the real `agently-cli`:
  an expired grant exits **0** with `{"ok":false,"error":{"type":"auth",...}}`. That is
  reported as `failed` with an explicit "authorization required" message — never as
  accepted — and this plugin never triggers an interactive re-authorization.
- **A settle write can lose a known outcome.** If `mailer.send` already returned
  `queued` and the following outbox write fails, memory holds the truth while disk
  keeps the earlier intent; after a restart that decision reads `delivery_unknown`.
  The direction is safe (it never resends a possibly-delivered mail) but the audit
  ledger can under-report a known result.
- **Progress can be redefined by the model.** The fingerprint treats *content change*
  as progress, so a checkpoint that only appends filler evidence resets the stall
  counter; only `maxNudges` then bounds the session. This matches the documented
  guarantee ("identical text does not reset stalls") and is not a security boundary.
- **A turn ending in `error` or `max-tokens` switches the plugin off** for that
  session until a human re-enables it. That is intentionally conservative: an
  unattended plugin should not keep driving after the runtime reported a failure.
- **Approvals of subagents that already existed before the plugin hot-mounted are
  not escalated.** The child→root mapping (`childOwners`) is learned from
  `subagent/start`, which a freshly mounted plugin never saw for pre-existing
  runs; their approvals only go through the normal GUI channel, with no mail.
  Delegations started after the mount escalate normally.
- **The UI switch is unverified in a browser.** The command path and the toggle share
  one Host operation, both are exercised by tests, but no rendered click has been
  observed.
