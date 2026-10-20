import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorController, safeKey } from '../src/controller.js';

function fixture({ pauseWrite = false } = {}) {
  let clock = 100000;
  const stores = new Map([['tasks', new Map()], ['outbox', new Map()]]);
  let release;
  let barrier = pauseWrite ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const domain = { table(name) { return { entries: () => stores.get(name).entries(),
    async put(key, value) { await barrier; stores.get(name).set(key, structuredClone(value)); } }; }, async close() {} };
  const calls = [];
  const agent = { id: 'session-test', status: 'running', inbox: { nextStep: [], nextTurn: [] },
    followup: message => calls.push(['followup', message]), inject: message => calls.push(['inject', message]),
    cancel() { throw new Error('MUST NOT CANCEL'); } };
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined, roots: () => [agent],
      list: () => [agent], isOwnedBy: () => false },
    get: name => name === 'goals' ? ctx.goalService : name === 'jobs' ? { list: () => [] } : undefined,
    logger: { warn() {} }, goalService: undefined };
  const config = { maxNudges: 12, maxStalls: 3, idleDelayMs: 1000 };
  let mailCount = 0;
  const mailer = { async send(details, { isCurrent }) { if (!isCurrent()) return { status: 'cancelled', decisionId: details.decisionId };
    mailCount += 1; return { status: 'queued', decisionId: details.decisionId }; } };
  const controller = new SupervisorController(ctx, config, { now: () => clock, mailer });
  return { controller, ctx, agent, calls, stores, domain, mailCount: () => mailCount,
    tick: () => { clock += 2000; }, release: () => { barrier = Promise.resolve(); release?.(); } };
}
const contract = { objective: 'Build result', acceptance: ['Tests pass'], phase: 'running', nextAction: 'Run tests', evidence: ['Wrote source'] };

test('OFF is only a mode flag: does not touch tasks, Goal, inbox or subagents', async () => {
  const f = fixture(); await f.controller.initialize(f.domain);
  await f.controller.setEnabled(f.agent, true);
  const inbox = { nextStep: [{ id: 'accepted-work' }], nextTurn: [{ id: 'next-work' }] };
  f.agent.inbox = inbox;
  f.ctx.goalService = { get: () => ({ phase: 'active', activation: 'armed' }), pause() { throw Error('MUST NOT PAUSE'); }, disarm() { throw Error('MUST NOT DISARM'); } };
  const count = f.calls.length;
  await f.controller.setEnabled(f.agent, false);
  await f.controller.sweep();
  assert.equal(f.controller.view(f.agent.id).enabled, false);
  assert.equal(f.agent.status, 'running'); assert.equal(f.agent.inbox, inbox);
  assert.equal(f.calls.length, count);
  assert.equal(f.stores.get('tasks').get(f.agent.id).enabled, false);
});

test('ON uses an explicit non-human source and restart never restores ON', async () => {
  const f = fixture(); await f.controller.initialize(f.domain);
  await f.controller.setEnabled(f.agent, true);
  assert.equal(f.calls[0][1].source.kind, 'unattended-supervisor');
  assert.match(f.calls[0][1].content[0].text, /glm-5.3-flash/);
  await f.controller.checkpoint(f.agent, contract);
  const second = fixture(); second.domain = f.domain;
  await second.controller.initialize(second.domain);
  assert.equal(second.controller.view(f.agent.id).enabled, false);
  assert.equal(second.controller.view(f.agent.id).objective, contract.objective);
});

test('sweep is bounded and skips every unfinished native Goal', async () => {
  const f = fixture(); await f.controller.initialize(f.domain);
  await f.controller.setEnabled(f.agent, true); await f.controller.checkpoint(f.agent, contract);
  f.agent.status = 'idle'; f.controller.lastIdle.set(f.agent.id, 1); f.tick();
  f.ctx.goalService = { get: () => ({ phase: 'paused', activation: 'disarmed' }) };
  await f.controller.sweep(); assert.equal(f.calls.length, 1);
  f.ctx.goalService = undefined;
  await f.controller.sweep(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1][0], 'followup'); assert.equal(f.calls[1][1].source.kind, 'unattended-supervisor');
});

test('user cancellation disables only auxiliary mode and cannot be rewoken by late sweep', async () => {
  const f = fixture(); await f.controller.initialize(f.domain);
  await f.controller.setEnabled(f.agent, true); await f.controller.checkpoint(f.agent, contract);
  f.controller.onEvent({ id: f.agent.id }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
  f.agent.status = 'idle'; f.controller.lastIdle.set(f.agent.id, 1); f.tick();
  await f.controller.sweep(); assert.equal(f.calls.length, 1);
});

test('decision outbox deduplicates concurrent notices; OFF cannot send', async () => {
  const f = fixture(); await f.controller.initialize(f.domain);
  await f.controller.setEnabled(f.agent, true);
  const details = { decisionId: 'route', question: 'Which route?' };
  await Promise.all([f.controller.requestUser(f.agent, details), f.controller.requestUser(f.agent, details)]);
  assert.equal(f.mailCount(), 1);
  await f.controller.setEnabled(f.agent, false);
  await assert.rejects(f.controller.requestUser(f.agent, { ...details, decisionId: 'route-two' }), /off/);
  assert.equal(f.mailCount(), 1);
});

test('restored sending intent is delivery_unknown and is never automatically resent', async () => {
  // Production keys are folded onto [A-Za-z0-9_-] by safeKey; using a colon here would
  // test a shape the real storage backend rejects.
  const f = fixture(); const key = `${safeKey(f.agent.id)}__route__r1`;
  f.stores.get('outbox').set(key, { sessionId: f.agent.id, decisionId: 'route', revision: 1, status: 'sending' });
  await f.controller.initialize(f.domain);
  assert.equal(f.controller.view(f.agent.id).mail[0].status, 'delivery_unknown');
  assert.equal(f.mailCount(), 0);
});

test('OFF during a pending auxiliary checkpoint fences the old continuation', async () => {
  const f = fixture(); await f.controller.initialize(f.domain);
  await f.controller.setEnabled(f.agent, true); await f.controller.checkpoint(f.agent, contract);
  let release;
  const original = f.controller.domain.table.bind(f.controller.domain);
  let shouldPause = true;
  f.controller.domain.table = name => {
    const table = original(name);
    return { ...table, async put(key, value) {
      if (shouldPause && name === 'tasks') { shouldPause = false; await new Promise(resolve => { release = resolve; }); }
      return table.put(key, value);
    } };
  };
  f.agent.status = 'idle'; f.controller.lastIdle.set(f.agent.id, 1); f.tick();
  const sweep = f.controller.sweep();
  await new Promise(resolve => setImmediate(resolve));
  const off = f.controller.setEnabled(f.agent, false);
  assert.equal(f.controller.engine.get(f.agent.id).enabled, false);
  release(); await Promise.all([sweep, off]);
  assert.equal(f.calls.length, 1);
});
