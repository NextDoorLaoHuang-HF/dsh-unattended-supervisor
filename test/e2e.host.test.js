// Host-level end-to-end acceptance tests.
//
// The unit suites test the pure engine and the mailer in isolation. These tests
// mount the plugin's real `apply()` on a real Cordis Context over the real storage
// stack and drive it through the same entry points DSH uses: the `/unattended`
// command handler and the controller methods the model tools call. Only the Host
// service boundary (agents, commands, tools, systemPrompt) and the mailer's child
// process are stubbed.
//
// When the DSH runtime tree is unavailable every test skips instead of failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function loadReal() {
  const candidates = [
    process.env.DSH_MODULES,
    '/tmp/dsh-inspect/extracted/dsh/node_modules',
    join(process.cwd(), 'node_modules'),
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      const cordis = await import(join(base, '@deepseek-ai/cordis/lib/index.js'));
      const storage = await import(join(base, '@deepseek-ai/dsh-storage/lib/index.js'));
      const json = await import(join(base, '@deepseek-ai/dsh-storage-json/lib/index.js'));
      const domain = await import(join(base, '@deepseek-ai/dsh-storage-domain/lib/index.js'));
      return { base, Context: cordis.Context, storage, json, domain };
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

const real = await loadReal();
const skip = real === undefined
  ? 'no DSH runtime package tree found; set DSH_MODULES to run host-level acceptance'
  : false;

// Some packages ship a default class, others named apply/inject exports; normalise
// both the way the Loader's module form does.
const rowOf = module => {
  if (typeof module.apply === 'function') return { name: module.name, inject: module.inject, Config: module.Config, apply: module.apply };
  if (typeof module.default === 'function') return module.default;
  throw new Error(`package exports neither an apply function nor a default class: ${Object.keys(module).join(', ')}`);
};

const SESSION = 'session-1111aaaa-2222bbbb-3333cccc-4444dddd';

/**
 * Mount the real plugin over a real storage stack and return handles for driving it.
 * `mailCount` counts mailer sends; the child process is never spawned.
 */
async function mount({ pluginConfig = {}, mailResult = { status: 'queued' }, withConnection = false } = {}) {
  const { Context, storage, json, domain } = real;
  const plugin = await import('../src/index.js');
  const home = mkdtempSync(join(tmpdir(), 'dsh-us-e2e-'));

  const calls = { followup: [], inject: [], cancel: 0, tools: [], commands: [], mail: 0 };
  // `attach()` registers a scoped prompt context and the subagent lifecycle on the
  // agent's own scoped context, exactly as the runtime provides it.
  const scoped = { disposers: [], handlers: new Map() };
  const agentCtx = {
    systemPrompt: { context: () => { const dispose = () => {}; scoped.disposers.push(dispose); return dispose; } },
    on: (event, handler) => {
      scoped.handlers.set(event, handler);
      const dispose = () => scoped.handlers.delete(event);
      scoped.disposers.push(dispose);
      return dispose;
    },
  };
  const agent = {
    id: SESSION,
    status: 'idle',
    ctx: agentCtx,
    inbox: { nextStep: [], nextTurn: [] },
    followup(message) { calls.followup.push(message); },
    inject(message) { calls.inject.push(message); },
    cancel() { calls.cancel += 1; throw new Error('MUST NOT CANCEL a task'); },
  };

  const ctx = new Context();
  ctx.logger = { info() {}, warn() {}, error() {} };
  ctx.provide('logger', ctx.logger);
  ctx.provide('agents', {
    get: id => (id === agent.id ? agent : undefined),
    list: () => [agent],
    roots: () => [agent],
    isOwnedBy: () => false,
  });
  ctx.provide('commands', {
    register(definition) { calls.commands.push(definition); return () => {}; },
  });
  ctx.provide('tools', {
    register(definition) { calls.tools.push(definition); return () => {}; },
  });
  ctx.provide('systemPrompt', { context: () => () => {}, section: () => () => {} });
  ctx.provide('timer', {});
  ctx.interval = () => () => {};

  // Exact Fetch routes are optional by design: a profile without a Web connection
  // still loads the plugin, it just has no read-only UI transport.
  const fetchRoutes = [];
  if (withConnection) {
    ctx.provide('connection', {
      fetch: { register(route) { fetchRoutes.push(route); return () => {}; } },
    });
  }

  await ctx.plugin(rowOf(storage), {});
  await ctx.plugin(rowOf(json), { root: home });
  await ctx.plugin(rowOf(domain), { backend: 'json' });

  const fiber = await ctx.plugin(rowOf(plugin), pluginConfig);

  const controller = ctx.get('unattendedSupervisor');
  assert.ok(controller, 'the plugin must provide its controller service');
  // Replace the mailer with a counting stub: no real CLI, no real email.
  controller.mailer = {
    async send(details) { calls.mail += 1; return { ...mailResult, decisionId: details.decisionId }; },
    async close() {},
  };

  const run = async (line) => {
    const definition = calls.commands.find(entry => entry.name === 'unattended');
    assert.ok(definition, '/unattended command was not registered');
    const result = await definition.handler({
      agent, rawInput: line, attachments: [],
      signal: new AbortController().signal,
    });
    return result;
  };
  const status = async () => JSON.parse((await run('status')).text);
  const dispose = async () => {
    // `fiber.dispose()` is the unload path that actually runs the effect disposers;
    // `registry.delete()` resolves a plugin callback, not a fiber, so passing a fiber
    // silently does nothing.
    await fiber.dispose();
    rmSync(home, { recursive: true, force: true });
  };
  return { ctx, agent, controller, calls, run, status, dispose, home, fetchRoutes };
}

/* ------------------------------------------------------------ default state */

test('defaults to off with no authorization of any kind', { skip }, async () => {
  const m = await mount();
  try {
    const state = await m.status();
    assert.equal(state.enabled, false, 'a fresh session must be OFF');
    assert.equal(state.phase, 'clarifying');
    assert.equal(state.revision, 0);
    assert.deepEqual(state.acceptance, []);
    assert.equal(m.calls.followup.length, 0, 'mounting must not wake the task');
    assert.equal(m.calls.inject.length, 0);
  } finally { await m.dispose(); }
});

/* --------------------------------------------------------------- the switch */

test('turning it on injects guidance under a non-human source', { skip }, async () => {
  const m = await mount();
  try {
    const state = JSON.parse((await m.run('on')).text);
    assert.equal(state.enabled, true);
    const delivered = [...m.calls.inject, ...m.calls.followup];
    assert.equal(delivered.length, 1, 'exactly one guidance message is delivered');
    assert.equal(delivered[0].source.kind, 'unattended-supervisor');
    assert.notEqual(delivered[0].source.kind, 'user', 'never impersonate a human');
    assert.match(delivered[0].content[0].text, /glm-5\.3-flash/, 'the guidance names the Flash route');
  } finally { await m.dispose(); }
});

test('turning it off stops only the plugin, never the task', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    const inbox = m.agent.inbox;
    const before = m.calls.followup.length;
    const state = JSON.parse((await m.run('off')).text);
    assert.equal(state.enabled, false);
    assert.equal(m.calls.cancel, 0, 'OFF must never cancel the task');
    assert.equal(m.agent.inbox, inbox, 'OFF must not clear or replace the inbox');
    assert.equal(m.agent.status, 'idle', 'OFF must not change task status');
    assert.equal(m.calls.followup.length, before, 'OFF adds no follow-up');

    // A sweep after OFF must stay silent.
    await m.controller.sweep();
    assert.equal(m.calls.followup.length, before);
  } finally { await m.dispose(); }
});

test('a stale revision is rejected instead of clobbering a newer state', { skip }, async () => {
  const m = await mount();
  try {
    const first = JSON.parse((await m.run('on')).text);
    // Revision 0 is stale now that the toggle advanced it.
    const stale = await m.run('off 0');
    assert.equal(stale.kind, 'error', 'a stale expected-revision must be refused');
    assert.equal((await m.status()).enabled, true, 'the newer state survives');
    // The current revision is accepted.
    const ok = await m.run(`off ${first.revision}`);
    assert.equal(ok.kind, 'success');
    assert.equal((await m.status()).enabled, false);
  } finally { await m.dispose(); }
});

/* -------------------------------------------------------------- checkpoints */

test('a checkpoint persists OFF and recovery never restores authorization', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    const state = await m.controller.checkpoint(m.agent, {
      objective: 'Ship the feature', acceptance: ['tests pass'], phase: 'running', nextAction: 'run tests',
    });
    assert.equal(state.objective, 'Ship the feature');

    // The durable record must never carry continuation authority.
    const saved = [...m.controller.domain.table('tasks').entries()][0];
    assert.ok(saved, 'a task record was written');
    const [, record] = saved;
    assert.equal(record.enabled, false, 'enabled must never be persisted as true');
    assert.equal(record.sessionId, SESSION, 'the record self-identifies its session');

    // A fresh controller over the same domain recovers the contract but stays OFF.
    const replay = await mount();
    try {
      await replay.controller.initialize(m.controller.domain);
      const recovered = replay.controller.engine.get(SESSION);
      assert.equal(recovered.enabled, false, 'recovery is always OFF');
      assert.equal(recovered.objective, 'Ship the feature', 'the contract survives');
    } finally { await replay.dispose(); }
  } finally { await m.dispose(); }
});

test('complete requires both acceptance and evidence, and then switches off', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    await assert.rejects(
      m.controller.checkpoint(m.agent, { phase: 'complete' }),
      /acceptance|evidence/i,
      'complete without criteria must be refused',
    );
    const done = await m.controller.checkpoint(m.agent, {
      phase: 'complete', acceptance: ['outputs exist'], evidence: ['npm test => 0'], summary: 'done',
    });
    assert.equal(done.phase, 'complete');
    assert.equal(done.enabled, false, 'completion switches off only this plugin');
    assert.equal(m.calls.cancel, 0, 'completion must not cancel the task');
  } finally { await m.dispose(); }
});

/* -------------------------------------------------------------------- mail */

test('decision mail is refused when off and sent once per decision', { skip }, async () => {
  const m = await mount();
  try {
    const details = { decisionId: 'route', question: 'Which route?', options: ['a', 'b'] };
    await assert.rejects(m.controller.requestUser(m.agent, details), /off/i);
    assert.equal(m.calls.mail, 0, 'no mail while off');

    await m.run('on');
    await m.controller.requestUser(m.agent, details);
    await m.controller.requestUser(m.agent, details);
    assert.equal(m.calls.mail, 1, 'the same decision revision is sent exactly once');
  } finally { await m.dispose(); }
});

/* ------------------------------------------------------------ progress gates */

test('live subagents and native goals suppress auxiliary progress', { skip }, async () => {
  const m = await mount({ pluginConfig: { idleDelayMs: 1000, sweepMs: 1000, maxNudges: 2 } });
  try {
    await m.run('on');
    await m.controller.checkpoint(m.agent, {
      objective: 'Finish', acceptance: ['done'], phase: 'running', nextAction: 'next unit',
    });
    const before = m.calls.followup.length;
    m.controller.lastIdle.set(SESSION, 1);
    m.controller.now = () => 10 ** 9;

    // A live child blocks the auxiliary wake-up.
    m.controller.childStarted(SESSION, { id: 'session-child-1' });
    await m.controller.sweep();
    assert.equal(m.calls.followup.length, before, 'a live child suppresses the nudge');
    m.controller.childEnded(SESSION, { id: 'session-child-1' });

    // So does an unfinished native Goal.
    m.controller.ctx.get = name => name === 'goals' ? { get: () => ({ phase: 'active' }) } : undefined;
    await m.controller.sweep();
    assert.equal(m.calls.followup.length, before, 'an unfinished native Goal suppresses the nudge');
  } finally { await m.dispose(); }
});

test('auxiliary progress is bounded by maxNudges', { skip }, async () => {
  const m = await mount({ pluginConfig: { idleDelayMs: 1000, sweepMs: 1000, maxNudges: 2, maxStalls: 9 } });
  try {
    await m.run('on');
    await m.controller.checkpoint(m.agent, {
      objective: 'Finish', acceptance: ['done'], phase: 'running', nextAction: 'next unit',
    });
    const before = m.calls.followup.length;
    const realGet = m.controller.ctx.get.bind(m.controller.ctx);
    m.controller.ctx.get = name => (name === 'goals' ? undefined : realGet(name));
    m.controller.now = () => 10 ** 9;
    for (let i = 0; i < 8; i += 1) {
      m.controller.lastIdle.set(SESSION, 1);
      await m.controller.sweep();
    }
    const added = m.calls.followup.length - before;
    assert.ok(added >= 1, 'the plugin does make auxiliary progress');
    assert.ok(added <= 2, `maxNudges caps follow-ups, got ${added}`);
  } finally { await m.dispose(); }
});

test('an unloaded plugin stops acting', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    await m.controller.checkpoint(m.agent, {
      objective: 'Finish', acceptance: ['done'], phase: 'running', nextAction: 'next unit',
    });
    const before = m.calls.followup.length;
    await m.dispose();
    m.controller.now = () => 10 ** 9;
    m.controller.lastIdle.set(SESSION, 1);
    await m.controller.sweep();
    assert.equal(m.calls.followup.length, before, 'a disposed plugin must not wake anything');
  } finally { /* already disposed */ }
});

test('a non-completed turn end disables the plugin but preserves the contract', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    await m.controller.checkpoint(m.agent, {
      objective: 'Finish', acceptance: ['done'], phase: 'running', nextAction: 'next unit',
    });
    // A user abort is reported as a non-completed turn end.
    m.controller.onEvent({ id: SESSION }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
    await m.controller.close().catch(() => {});
    const state = await m.status();
    assert.equal(state.enabled, false, 'an aborted turn disables the plugin');
    assert.equal(state.objective, 'Finish', 'the contract survives the abort');
    assert.equal(m.calls.cancel, 0, 'the plugin never cancels the task');
  } finally { /* already closed above */ }
});

/* ------------------------------------------------- read-only status transport */

// The composer switch used to read state by executing `/unattended status`. The
// Commands executor logs each resolved command as a `command/run`/`command/done`
// pair, which the transcript renders as a row, so every focus refresh appended a
// JSON blob to the conversation. The read-only route below answers the same view
// without entering the command lifecycle; state CHANGES stay commands on purpose.

test('the status route is mounted only when a Web connection is composed', { skip }, async () => {
  const without = await mount();
  try {
    assert.equal(without.fetchRoutes.length, 0, 'no connection row means no Fetch route');
    assert.ok(without.controller, 'the plugin still loads without a Web connection');
  } finally { await without.dispose(); }

  const withRoute = await mount({ withConnection: true });
  try {
    assert.equal(withRoute.fetchRoutes.length, 1);
    const [route] = withRoute.fetchRoutes;
    assert.equal(route.path, '/api/unattended.status', 'the path must be a plain /api endpoint');
    assert.deepEqual([...route.methods], ['GET'], 'reading state is read-only');
    assert.equal(route.requestBody, 'buffered');
  } finally { await withRoute.dispose(); }
});

test('the status route answers with the same view the model tool returns', { skip }, async () => {
  const m = await mount({ withConnection: true });
  try {
    await m.run('on');
    const route = m.fetchRoutes[0];
    const response = await route.fetch(new Request(`http://127.0.0.1/api/unattended.status?sessionId=${SESSION}`, { method: 'GET' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.state, m.controller.view(SESSION));
    assert.equal(payload.state.enabled, true);

    // The read is observation only: it must not move the revision.
    const before = payload.state.revision;
    const again = await route.fetch(new Request(`http://127.0.0.1/api/unattended.status?sessionId=${SESSION}`, { method: 'GET' }));
    assert.equal((await again.json()).state.revision, before, 'a status read never advances state');
  } finally { await m.dispose(); }
});

test('the status route refuses unknown and non-root sessions instead of leaking state', { skip }, async () => {
  const m = await mount({ withConnection: true });
  try {
    const route = m.fetchRoutes[0];
    for (const url of [
      'http://127.0.0.1/api/unattended.status',
      'http://127.0.0.1/api/unattended.status?sessionId=session-unknown',
    ]) {
      const response = await route.fetch(new Request(url, { method: 'GET' }));
      assert.equal(response.status, 404, `${url} must be refused`);
      assert.equal((await response.json()).ok, false);
    }
  } finally { await m.dispose(); }
});

test('the read-only route never writes a command lifecycle entry', { skip }, async () => {
  const m = await mount({ withConnection: true });
  try {
    await m.run('on');
    const commandsBefore = m.calls.commands.length;
    const route = m.fetchRoutes[0];
    for (let i = 0; i < 5; i += 1) {
      await route.fetch(new Request(`http://127.0.0.1/api/unattended.status?sessionId=${SESSION}`, { method: 'GET' }));
    }
    assert.equal(m.calls.commands.length, commandsBefore, 'no command registration or execution on a read');
  } finally { await m.dispose(); }
});
