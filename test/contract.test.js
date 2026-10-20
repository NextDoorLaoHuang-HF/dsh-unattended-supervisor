// Contract tests for the four load-blocking defects found against the live Host:
// an illegal domain name, illegal per-record keys, a Config default that skipped
// every field default, and a subagent event with no parent field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, DOMAIN_NAME } from '../src/index.js';
import { SupervisorController, safeKey } from '../src/controller.js';

// Live constraints, quoted from the installed runtime:
//   @deepseek-ai/dsh-storage        UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/
//   @deepseek-ai/dsh-storage-json   SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/;

const DEFAULTS = {
  idleDelayMs: 15000, sweepMs: 5000, maxNudges: 12, maxStalls: 3, childGraceMs: 120000,
  mailGraceMs: 15000, mailTimeoutMs: 30000,
  mailCli: '/opt/homebrew/bin/agently-cli', mailRecipient: '',
};

function fixture() {
  const stores = new Map([['tasks', new Map()], ['outbox', new Map()]]);
  const writes = [];
  const domain = {
    table(name) {
      return {
        entries: () => stores.get(name).entries(),
        async put(key, value) { writes.push([name, key]); stores.get(name).set(key, structuredClone(value)); },
      };
    },
    async close() {},
  };
  const agent = {
    id: 'session-334ea02f-f5a4-4edb-9e72-2eb7ed3c245d', status: 'idle',
    inbox: { nextStep: [], nextTurn: [] },
    followup() {}, inject() {},
  };
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined, roots: () => [agent], list: () => [agent], isOwnedBy: () => false },
    get: name => name === 'jobs' ? { list: () => [] } : undefined,
    logger: { warn() {} },
  };
  let mailCount = 0;
  const mailer = {
    async send(details) { mailCount += 1; return { status: 'queued', decisionId: details.decisionId }; },
  };
  const controller = new SupervisorController(ctx, { maxNudges: 12, maxStalls: 3, idleDelayMs: 1000, mailGraceMs: 0 },
    { now: () => 1, mailer });
  return { controller, ctx, agent, domain, stores, writes, mailCount: () => mailCount };
}

test('the durable domain name satisfies the live UNIT_NAME_RE', () => {
  assert.match(DOMAIN_NAME, UNIT_NAME_RE, `domain name ${DOMAIN_NAME} would be rejected by storage-domain`);
});

test('Config is a native Schemastery schema so Settings can render it', () => {
  // DSH marks a non-native Config `unsupported` and renders no settings form; a zod
  // Config would therefore silently lose its settings surface.
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true, 'Config must be native Schemastery');
  assert.equal(typeof Config.type, 'string');
});

test('Config supplies every default when the row omits config entirely', () => {
  // The Loader validates through the Standard Schema interface, so that path matters.
  const viaStandard = Config['~standard'].validate(undefined);
  assert.equal(viaStandard.issues, undefined, 'omitted config must validate');
  assert.deepEqual(viaStandard.value, DEFAULTS);
  assert.deepEqual(Config(), DEFAULTS, 'calling the schema fills every default');
});

test('a supplied config still overrides defaults and rejects bad values', () => {
  const parsed = Config({ sweepMs: 9000, maxNudges: 4 });
  assert.equal(parsed.sweepMs, 9000);
  assert.equal(parsed.maxNudges, 4);
  assert.equal(parsed.idleDelayMs, DEFAULTS.idleDelayMs, 'unspecified fields keep their default');
  assert.deepEqual(Config().mailRecipient, DEFAULTS.mailRecipient);
  assert.throws(() => Config({ sweepMs: 10 }), 'below min is rejected');
  assert.throws(() => Config({ mailGraceMs: 999999 }), 'above max is rejected');
});

test('safeKey folds every key onto the live SAFE_KEY_RE alphabet', () => {
  const hostile = [
    'session-334ea02f-f5a4-4edb-9e72-2eb7ed3c245d',
    'a:b:c',
    '../../etc/passwd',
    'with space',
    'dotted.name',
    'emoji 🚀',
    '',
  ];
  for (const value of hostile) assert.match(safeKey(value), SAFE_KEY_RE, `safeKey(${JSON.stringify(value)}) is not path-safe`);
});

// 2026-10-19 spec (F2): the outbox key is revision-free — a checkpoint during a
// pending wait bumps the revision, and a revision-suffixed key let the same
// decision mail a second time afterwards. The revision stays inside the entry
// for audit only, so the second request below lands after the first has settled —
// exactly the shape a checkpoint during a pending wait used to duplicate.
test('outbox keys are revision-free and deduplicate one mail per decisionId', async () => {
  const f = fixture();
  await f.controller.initialize(f.domain);
  await f.controller.setEnabled(f.agent, true);
  const details = { decisionId: 'route: choose/one', question: 'Which route?' };
  await f.controller.requestUser(f.agent, details);
  await f.controller.requestUser(f.agent, details);

  const outboxWrites = f.writes.filter(([table]) => table === 'outbox');
  assert.ok(outboxWrites.length > 0, 'the outbox was written');
  for (const [, key] of outboxWrites) {
    assert.match(key, SAFE_KEY_RE, `outbox key ${key} is not path-safe`);
    assert.doesNotMatch(key, /__r\d+/, `outbox key ${key} must not carry a revision suffix`);
  }
  assert.equal(f.mailCount(), 1, 'the same decisionId is sent once across checkpoints');
});

test('an unconfigured mailRecipient loads with mail disabled and fails sends explicitly', async () => {
  // Publishing guard: the recipient is personal configuration data, so the
  // shipped default is empty. That must not become a fifth load-blocking
  // defect — the controller falls back to an unconfigured mailer whose sends
  // settle as an explicit, retriable configuration failure.
  const f = fixture();
  const controller = new SupervisorController(f.ctx, Config(), { now: () => 1 });
  await controller.initialize(f.domain);
  await controller.setEnabled(f.agent, true);
  const details = { decisionId: 'no-recipient', question: 'Which route?' };
  const result = await controller.requestUser(f.agent, details);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /mailRecipient is not configured/);
  const persisted = [...f.stores.get('outbox').values()][0];
  assert.equal(persisted.status, 'failed', 'the failure is durable');
  // A failed attempt never blackholes the decision: once a recipient is
  // configured, the same decisionId gets a fresh attempt.
  controller.mailer = { async send(d) { return { status: 'queued', decisionId: d.decisionId }; } };
  const retry = await controller.requestUser(f.agent, details);
  assert.equal(retry.status, 'queued');
});

test('task persistence keeps the session id inside the record, not only in the key', async () => {
  const f = fixture();
  await f.controller.initialize(f.domain);
  await f.controller.setEnabled(f.agent, true);
  const saved = [...f.stores.get('tasks').values()][0];
  assert.equal(saved.sessionId, f.agent.id);
  assert.equal(saved.enabled, false, 'continuation authority is never persisted as ON');

  // A fresh controller recovers the contract under the real session id.
  const other = new SupervisorController(
    { agents: { get: () => undefined, roots: () => [], list: () => [], isOwnedBy: () => false }, get: () => undefined, logger: { warn() {} } },
    { maxNudges: 12, maxStalls: 3, idleDelayMs: 1000 },
    { mailer: { async send() { return { status: 'queued' }; } } },
  );
  await other.initialize(f.domain);
  assert.equal(other.engine.get(f.agent.id).enabled, false, 'recovery is always OFF');
});

test('subagent lifecycle reaches the controller with the delegating parent', () => {
  const f = fixture();
  const child = { id: 'session-child-1' };
  f.controller.childStarted(f.agent.id, child);
  assert.equal(f.controller.hasDependencies(f.agent), true, 'a live child blocks auxiliary progress');
  f.controller.childEnded(f.agent.id, child);
  assert.equal(f.controller.hasDependencies(f.agent), false, 'a settled child no longer blocks');
});

test('a subagent event without a parent argument cannot invent an owner', () => {
  const f = fixture();
  // The live SubagentRunInfo has no parent field; dropping the explicit parent must
  // be a no-op rather than registering the child under an unknown owner.
  f.controller.childStarted(undefined, { id: 'session-child-2', provider: 'x', local: true });
  assert.equal(f.controller.hasDependencies(f.agent), false);
  assert.equal(f.controller.childOwners.size, 0);
});

/* ------------------------------------------------- review follow-up guards */

test('a throwing mailer settles the decision instead of blackholing its key', async () => {
  // Review finding M1: a claim left in 'sending' after a mailer throw would make every
  // later attempt return a fake in-flight snapshot and never resend.
  const f = fixture();
  await f.controller.initialize(f.domain);
  await f.controller.setEnabled(f.agent, true);
  f.controller.mailer = { async send() { throw new TypeError('payload rejected'); } };
  const details = { decisionId: 'boom', question: 'q' };
  await assert.rejects(f.controller.requestUser(f.agent, details), /payload rejected/);
  const entry = f.controller.view(f.agent.id).mail[0];
  assert.equal(entry.status, 'failed', 'the intent must not stay in flight');
  assert.match(entry.error ?? '', /payload rejected/);
  assert.equal(f.stores.get('outbox').size, 1, 'the settled state is persisted');
  const persisted = [...f.stores.get('outbox').values()][0];
  assert.equal(persisted.status, 'failed', 'the durable copy is not left as sending');
});

test('a child whose end event never arrives is eventually reclaimed', () => {
  // Review finding m3: subagent/end is fire-and-forget; a lost one would silence the
  // session's sweep forever. A young child must still suppress, a stale ghost must not.
  let clock = 1000;
  const agent = { id: 'p', status: 'idle', inbox: { nextStep: [], nextTurn: [] }, followup() {}, inject() {} };
  const ctx = {
    agents: { get: id => (id === agent.id ? agent : undefined), roots: () => [agent], list: () => [agent], isOwnedBy: () => false },
    get: () => undefined, logger: { warn() {} },
  };
  const c = new SupervisorController(ctx, { maxNudges: 5, maxStalls: 3, idleDelayMs: 1, childGraceMs: 5000 },
    { now: () => clock, mailer: { async send() {} } });
  c.childStarted('p', { id: 'ghost' });
  assert.equal(c.hasDependencies(agent), true, 'a fresh child suppresses');
  clock += 1000;
  assert.equal(c.hasDependencies(agent), true, 'within the grace period it still suppresses');
  clock += 6000;
  assert.equal(c.hasDependencies(agent), false, 'a stale, unresolvable child is reclaimed');
});

test('a live child keeps suppressing past the grace period', () => {
  let clock = 1000;
  const agent = { id: 'p', status: 'idle', inbox: { nextStep: [], nextTurn: [] }, followup() {}, inject() {} };
  const live = { id: 'live-child', status: 'running' };
  const ctx = {
    agents: { get: id => (id === agent.id ? agent : id === live.id ? live : undefined), roots: () => [agent], list: () => [agent], isOwnedBy: () => false },
    get: () => undefined, logger: { warn() {} },
  };
  const c = new SupervisorController(ctx, { maxNudges: 5, maxStalls: 3, idleDelayMs: 1, childGraceMs: 5000 },
    { now: () => clock, mailer: { async send() {} } });
  c.childStarted('p', { id: live.id });
  clock += 60000;
  assert.equal(c.hasDependencies(agent), true, 'the registry still resolves it, so it keeps suppressing');
});

test('redaction removes private keys, local file URLs and private-network links', async () => {
  // Review finding m5: these three shapes leaked into the outgoing body.
  const { mkdtempSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DecisionMailer } = await import('../src/mail.js');
  const dir = mkdtempSync(join(tmpdir(), 'us-redact-'));
  let body = '';
  const mailer = new DecisionMailer({
    cliPath: '/bin/echo', recipient: 'a@b.co', directory: dir,
    run: async (_file, args, opts) => {
      body = await readFile(join(opts.cwd, args[args.indexOf('--body-file') + 1].replace('./', '')), 'utf8');
      return { code: 0, stdout: '{"queued":true}' };
    },
  });
  await mailer.send({
    sessionId: 's', decisionId: 'redact', revision: 1,
    question: [
      '-----BEGIN RSA PRIVATE KEY-----', 'MIIEow', '-----END RSA PRIVATE KEY-----',
      'file:///Users/someone/.ssh/id_rsa',
      'http://192.168.1.10/admin?token=x',
      'http://10.0.0.5/panel',
      'http://172.16.9.9/panel',
      'https://example.com/keep-me',
    ].join('\n'),
  });
  assert.doesNotMatch(body, /BEGIN RSA PRIVATE KEY|MIIEow/, 'a private key block must not ship');
  assert.doesNotMatch(body, /file:\/\//, 'local file URLs must not ship');
  assert.doesNotMatch(body, /192\.168|10\.0\.0|172\.16/, 'private-network links must not ship');
  assert.match(body, /example\.com\/keep-me/, 'an ordinary link is preserved');
});

test('an exit-0 auth failure is reported as authorization, not as a missing flag', async () => {
  // Measured against the real agently-cli: an expired grant exits 0 with
  // {"ok":false,"error":{"type":"auth","message":"authorization required"}}.
  const { DecisionMailer } = await import('../src/mail.js');
  const mailer = new DecisionMailer({
    cliPath: '/bin/echo', recipient: 'a@b.co', directory: '/tmp/us-auth-probe',
    run: async () => ({ code: 0, stdout: JSON.stringify({ ok: false, error: { type: 'auth', message: 'authorization required' } }), stderr: '' }),
  });
  const result = await mailer.send({ sessionId: 's', decisionId: 'auth', question: 'Which route?', revision: 1 });
  assert.equal(result.status, 'failed', 'a failure must never read as accepted');
  assert.match(result.error ?? '', /authorization required/i);
  assert.match(result.error ?? '', /OAuth refresh intentionally not attempted/i);
});

test('an aborted sweep returns its reservation instead of burning the budget', async () => {
  // Review finding m1: a race after reserveNudge used to consume nudges with no message
  // sent, so repeated races could silence the session for good.
  const agent = { id: 's1', status: 'idle', inbox: { nextStep: [], nextTurn: [] }, followup() {}, inject() {} };
  const ctx = {
    agents: { get: () => agent, roots: () => [agent], list: () => [agent], isOwnedBy: () => false },
    get: () => undefined, logger: { warn() {} },
  };
  const c = new SupervisorController(ctx, { maxNudges: 3, maxStalls: 9, idleDelayMs: 1 },
    { now: () => 10 ** 9, mailer: { async send() {} } });
  let sent = 0;
  agent.followup = () => { sent += 1; };
  c.engine.setEnabled('s1', true);
  c.engine.checkpoint('s1', { objective: 'o', acceptance: ['a'], phase: 'running', nextAction: 'n' });
  // Persist takes a moment while the user starts typing: every sweep aborts.
  c.domain = { table: () => ({ put: async () => { agent.inbox.nextStep.push({ id: 'typed' }); }, entries: () => [] }) };
  for (let i = 0; i < 6; i += 1) {
    agent.inbox.nextStep.length = 0;
    c.lastIdle.set('s1', 1);
    await c.sweep();
  }
  assert.equal(sent, 0, 'nothing was delivered while the race kept aborting');
  assert.equal(c.engine.get('s1').nudges, 0, 'no budget was consumed by aborted sweeps');
  assert.equal(c.engine.needsNudge('s1', {}), true, 'the session is still allowed to progress');
});

test('the guidance only names routes that are billable on this deployment', async () => {
  // Command Code was retired on 2026-10-17 (subscription cancelled): a guidance string
  // that still names it would send delegation at a route with no quota.
  const { FLASH_ROUTES, SupervisorController } = await import('../src/controller.js');
  const providers = FLASH_ROUTES.map(route => route.provider);
  assert.deepEqual(providers, ['zai-coding-cn', 'amr-link']);
  assert.ok(FLASH_ROUTES.every(route => route.model && !route.model.includes('/')),
    'a model id is bare, not prefixed with a retired provider path');

  const agent = { id: 's1', status: 'idle', inbox: { nextStep: [], nextTurn: [] }, followup() {}, inject() {} };
  const ctx = {
    agents: { get: () => agent, roots: () => [agent], list: () => [agent], isOwnedBy: () => false },
    get: () => undefined, logger: { warn() {} },
  };
  const c = new SupervisorController(ctx, { maxNudges: 5, maxStalls: 3, idleDelayMs: 1 }, { mailer: { async send() {} } });
  c.engine.setEnabled('s1', true);
  const text = c.instructions('s1');
  assert.match(text, /amr-link\/deepseek-v4\.1-flash/);
  assert.doesNotMatch(text, /commandcode/, 'the retired provider must not be suggested');
});

test('a recorded failure is cleared by the next successful operation', async () => {
  // The composer renders state.lastError; a failure that outlives its cause leaves a
  // permanent error line in the toolbar (observed: NOT_ENABLED stayed visible after ON).
  const { SupervisorEngine } = await import('../src/engine.js');
  const e = new SupervisorEngine({});
  e.setEnabled('s', true);
  e.setEnabled('s', false);
  assert.throws(() => e.checkpoint('s', { phase: 'running' }), /NOT_ENABLED|ON/);
  assert.match(e.get('s').lastError, /NOT_ENABLED/, 'the failure is recorded for diagnostics');

  e.setEnabled('s', true);
  assert.equal(e.get('s').lastError, '', 're-enabling clears the stale error');

  assert.throws(() => e.checkpoint('s', { phase: 'not-a-phase' }));
  assert.match(e.get('s').lastError, /INVALID_PHASE/);
  e.checkpoint('s', { phase: 'running', objective: 'o', acceptance: ['a'] });
  assert.equal(e.get('s').lastError, '', 'a committed checkpoint clears the stale error');
});

test('the composer chip never renders a long failure inline', async () => {
  // Regression for the misaligned toolbar: the failure text must collapse into a
  // fixed-width marker so the composer row keeps its size.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /state\?\.lastError\s*\?\s*h\('small'/, 'the raw error must not be laid out as text');
  assert.match(source, /title: failure/, 'the failure text is reachable through a tooltip');
  assert.match(source, /flexWrap: 'nowrap'/, 'the composer row must not wrap');
});
