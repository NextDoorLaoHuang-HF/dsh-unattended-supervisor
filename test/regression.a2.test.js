// Regression tests for the 2026-10-19 fix spec, acceptance criterion A2.
//
// Same mount pattern as test/e2e.host.test.js: the real apply() over a real
// Cordis Context and the real storage stack, with only the Host boundary and the
// mailer stubbed (a counting stub — no real email). Timers use a small
// mailGraceMs plus real short waits.
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
      return { Context: cordis.Context, storage, json, domain };
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

const real = await loadReal();
const skip = real === undefined
  ? 'no DSH runtime package tree found; set DSH_MODULES to run host-level regression'
  : false;

const rowOf = module => {
  if (typeof module.apply === 'function') return { name: module.name, inject: module.inject, Config: module.Config, apply: module.apply };
  if (typeof module.default === 'function') return module.default;
  throw new Error(`package exports neither an apply function nor a default class: ${Object.keys(module).join(', ')}`);
};

const ROOT = 'session-root-0000aaaa-1111bbbb-2222cccc-3333dddd';
const CHILD = 'session-child-4444dddd-5555eeee-6666ffff-77770000';
const GRACE = 50;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Mount the plugin with one root session and one delegated child session,
 * a counting mailer stub, and a small mailGraceMs. `mailer` optionally replaces
 * the stub entirely (for failing / deferred sends).
 */
async function mount({ mailer } = {}) {
  const { Context, storage, json, domain } = real;
  const plugin = await import('../src/index.js');
  const home = mkdtempSync(join(tmpdir(), 'dsh-us-a2-'));

  const calls = { mail: [], followup: [], inject: [] };
  const makeAgent = id => ({
    id, status: 'idle', ctx: {
      systemPrompt: { context: () => () => {} },
      on: () => () => {},
    },
    inbox: { nextStep: [], nextTurn: [] },
    followup: m => calls.followup.push(m),
    inject: m => calls.inject.push(m),
    cancel() { throw new Error('MUST NOT CANCEL a task'); },
  });
  const agent = makeAgent(ROOT);
  const child = makeAgent(CHILD);
  const agents = new Map([[ROOT, agent], [CHILD, child]]);

  const ctx = new Context();
  ctx.logger = { info() {}, warn() {}, error() {} };
  ctx.provide('logger', ctx.logger);
  ctx.provide('agents', {
    get: id => agents.get(id),
    list: () => [...agents.values()],
    roots: () => [agent],
    isOwnedBy: () => false,
  });
  ctx.provide('commands', { register() { return () => {}; } });
  ctx.provide('tools', { register() { return () => {}; } });
  ctx.provide('systemPrompt', { context: () => () => {}, section: () => () => {} });
  ctx.provide('timer', {});
  ctx.interval = () => () => {};

  await ctx.plugin(rowOf(storage), {});
  await ctx.plugin(rowOf(json), { root: home });
  await ctx.plugin(rowOf(domain), { backend: 'json' });

  const fiber = await ctx.plugin(rowOf(plugin), { mailGraceMs: GRACE });

  const controller = ctx.get('unattendedSupervisor');
  assert.ok(controller, 'the plugin must provide its controller service');
  controller.mailer = mailer ?? {
    async send(details) { calls.mail.push({ ...details }); return { status: 'queued', decisionId: details.decisionId }; },
    async close() {},
  };

  // The command handler is a thin wrapper over setEnabled; drive the controller
  // path directly (the full handler is covered by e2e.host.test.js).
  const run = async line => {
    const [action, rev] = line.trim().split(/\s+/);
    const state = await controller.setEnabled(agent, action === 'on', rev === undefined ? undefined : Number(rev));
    return { kind: 'success', text: JSON.stringify(state) };
  };
  /** Emit a session log event exactly the way the runtime broadcasts it. */
  const emit = (sessionId, event) => ctx.emit('session/event', { id: sessionId }, event);
  const asked = (id, uuid, toolName = 'bash', reason) =>
    emit(id, { type: 'approval/asked', data: { id: uuid, toolName, ...(reason ? { reason } : {}) } });
  const decided = (id, uuid) => emit(id, { type: 'approval/decided', data: { id: uuid, outcome: 'approved' } });
  const dispose = async () => {
    await fiber.dispose();
    rmSync(home, { recursive: true, force: true });
  };
  return { ctx, agent, child, controller, calls, run, emit, asked, decided, dispose };
}

/* ------------------------------------------------ approval via session/event */

test('approval/asked mails exactly once after the grace expires', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    m.asked(ROOT, 'approval-uuid-1', 'bash', 'runs the deploy script');
    await sleep(GRACE / 2);
    assert.equal(m.calls.mail.length, 0, 'no mail before the grace expires');
    await sleep(GRACE);
    assert.equal(m.calls.mail.length, 1, 'exactly one notice after the grace');
    assert.equal(m.calls.mail[0].sessionId, ROOT, 'the notice names the root session');
    assert.match(m.calls.mail[0].question, /bash/, 'the question names the tool');
    assert.match(m.calls.mail[0].question, /deploy script/, 'the question carries the reason');
    // The wait stays registered until the user actually decides (approval/decided),
    // so an unresolved approval keeps blocking `phase=complete` even after the mail.
    assert.deepEqual(m.controller.view(ROOT).waits.map(w => w.decisionId), ['approval-approval-uuid-1']);
    await sleep(GRACE * 2);
    assert.equal(m.calls.mail.length, 1, 'no repeat after the grace');
  } finally { await m.dispose(); }
});

test('approval/decided during the grace sends zero mail', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    m.asked(ROOT, 'approval-uuid-2');
    m.decided(ROOT, 'approval-uuid-2');
    await sleep(GRACE * 3);
    assert.equal(m.calls.mail.length, 0, 'a settled wait never mails');
    assert.deepEqual(m.controller.view(ROOT).waits, []);
  } finally { await m.dispose(); }
});

test('approval for a session that never opted in is ignored', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    // Neither enabled itself nor mapped to an enabled parent: the hot-mounted
    // pre-existing child case from the README known limitations.
    m.asked('session-stranger-9999', 'approval-uuid-3');
    await sleep(GRACE * 3);
    assert.equal(m.calls.mail.length, 0, 'unknown sessions are never notified');
  } finally { await m.dispose(); }
});

/* ----------------------------------------------------- F2a: revision decoupling */

test('a checkpoint during the wait no longer invalidates the mail (F2a)', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    m.asked(ROOT, 'approval-uuid-4');
    await sleep(GRACE / 2);
    // Any checkpoint bumps the revision; the old revision-fenced timer silently
    // dropped the mail because of exactly this.
    await m.controller.checkpoint(m.agent, {
      objective: 'Keep going', acceptance: ['done'], phase: 'running', nextAction: 'next step', evidence: ['log'],
    });
    await sleep(GRACE * 2);
    assert.equal(m.calls.mail.length, 1, 'the notice must still go out after the checkpoint');
  } finally { await m.dispose(); }
});

/* ------------------------------------------------- F2b: revision-free dedup key */

test('the same decisionId across checkpoints mails once (F2b)', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    const details = { decisionId: 'route-choice', question: 'Which route?' };
    await m.controller.requestUser(m.agent, details);
    await m.controller.checkpoint(m.agent, {
      objective: 'X', acceptance: ['a'], phase: 'running', nextAction: 'n', evidence: ['e'],
    });
    const second = await m.controller.requestUser(m.agent, details);
    assert.equal(m.calls.mail.length, 1, 'a checkpoint must not buy a second mail');
    assert.equal(second.status, 'queued', 'the duplicate returns the first entry');
    assert.equal(second.decisionId, details.decisionId);
  } finally { await m.dispose(); }
});

/* ------------------------------------------------ failed decisions stay usable */

test('a failed decision allows a fresh attempt (F2)', { skip }, async () => {
  let attempts = 0;
  let failFirst = true;
  const m = await mount({ mailer: {
    async send(details) {
      attempts += 1;
      if (failFirst) throw new Error('cli exploded');
      m.calls.mail.push({ ...details });
      return { status: 'queued', decisionId: details.decisionId };
    },
    async close() {},
  } });
  try {
    await m.run('on');
    const details = { decisionId: 'flaky', question: 'Proceed?' };
    await assert.rejects(m.controller.requestUser(m.agent, details), /cli exploded/);
    assert.equal(m.controller.view(ROOT).mail.at(-1).status, 'failed');
    failFirst = false;
    const retry = await m.controller.requestUser(m.agent, details);
    assert.equal(retry.status, 'queued', 'a failed notice is not a permanent blackhole');
    assert.equal(m.calls.mail.length, 1, 'the retry actually sends');
    assert.equal(attempts, 2);
  } finally { await m.dispose(); }
});

/* ------------------------------------------------- F4: child approval escalation */

test('a child session approval/asked notifies in the root session name (F4)', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    m.controller.childStarted(ROOT, { id: CHILD });
    m.asked(CHILD, 'approval-uuid-5', 'write', 'child wants to modify files');
    await sleep(GRACE * 2);
    assert.equal(m.calls.mail.length, 1, 'the child wait escalates to the root');
    assert.equal(m.calls.mail[0].sessionId, ROOT, 'the notice is issued in the root name');
    assert.deepEqual(m.controller.view(ROOT).waits.map(w => w.kind), ['approval']);
    m.decided(CHILD, 'approval-uuid-5');
    assert.deepEqual(m.controller.view(ROOT).waits, [], 'decided on the child settles the wait');
  } finally { await m.dispose(); }
});

/* ------------------------------------------------------- F3: the complete gate */

test('phase=complete is blocked by an active child and released after cleanup (F3)', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    m.controller.childStarted(ROOT, { id: CHILD });
    const done = { phase: 'complete', acceptance: ['a'], evidence: ['e'], summary: 's' };
    await assert.rejects(m.controller.checkpoint(m.agent, done), /1 个活跃子代理/);
    assert.match(m.controller.view(ROOT).lastError, /子代理/, 'the blocker is written to lastError');
    m.controller.childEnded(ROOT, { id: CHILD });
    const state = await m.controller.checkpoint(m.agent, done);
    assert.equal(state.enabled, false, 'cleanup releases the completion');
  } finally { await m.dispose(); }
});

test('phase=complete is blocked by an unresolved wait and released by decided (F3)', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    m.asked(ROOT, 'approval-uuid-6');
    await assert.rejects(
      m.controller.checkpoint(m.agent, { phase: 'complete', acceptance: ['a'], evidence: ['e'] }),
      /1 个未解决等待/,
    );
    m.decided(ROOT, 'approval-uuid-6');
    const state = await m.controller.checkpoint(m.agent, { phase: 'complete', acceptance: ['a'], evidence: ['e'] });
    assert.equal(state.phase, 'complete');
    assert.equal(m.calls.mail.length, 0, 'decided before the grace mails nothing');
  } finally { await m.dispose(); }
});

test('phase=complete is blocked by an in-flight mail and released once it settles (F3)', { skip }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const m = await mount({ mailer: {
    async send(details) {
      m.calls.mail.push({ ...details });
      await gate;
      return { status: 'queued', decisionId: details.decisionId };
    },
    async close() {},
  } });
  try {
    await m.run('on');
    const sending = m.controller.requestUser(m.agent, { decisionId: 'slow', question: 'q' });
    await sleep(10); // let the claim ('sending') land
    await assert.rejects(
      m.controller.checkpoint(m.agent, { phase: 'complete', acceptance: ['a'], evidence: ['e'] }),
      /1 封在途邮件/,
    );
    release();
    await sending;
    const state = await m.controller.checkpoint(m.agent, { phase: 'complete', acceptance: ['a'], evidence: ['e'] });
    assert.equal(state.enabled, false, 'a settled mail no longer blocks');
  } finally { await m.dispose(); }
});

/* ----------------------------------------------- question observer never jams */

test('a throwing question observer cannot deadlock the waterfall', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    const agent = { get id() { throw new Error('observer input is hostile'); } };
    const answer = await m.ctx.waterfall('user-questions/request',
      { agent, questions: [{ id: 'q1', question: 'Go on?' }] },
      () => 'answered-by-gui');
    assert.equal(answer, 'answered-by-gui', "the observer's throw must not veto the chain");
    assert.equal(m.calls.mail.length, 0);
  } finally { await m.dispose(); }
});

test('a normal question registers a wait and settles it when answered', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    const pending = m.ctx.waterfall('user-questions/request',
      { agent: m.agent, wait: { callId: 'call-9' }, questions: [{ id: 'q1', question: 'Go on?' }] },
      () => 'answered-by-gui');
    // The observer registers synchronously during dispatch; the finally-settle runs
    // once the answerer's promise resolves (the next microtask here).
    const waits = m.controller.view(ROOT).waits;
    assert.deepEqual(waits.map(w => w.kind), ['question']);
    assert.match(waits[0].decisionId, /^question-call-9$/);
    assert.ok(waits[0].waitedMs >= 0);
    assert.equal(await pending, 'answered-by-gui');
    assert.deepEqual(m.controller.view(ROOT).waits, [], 'the finally-settle drops the wait');
    await sleep(GRACE * 2);
    assert.equal(m.calls.mail.length, 0, 'an answered question never mails');
  } finally { await m.dispose(); }
});

/* ------------------------------------------- OFF paths must not leave timers */

test('a non-completed turn end clears pending approval timers without mailing', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    m.asked(ROOT, 'approval-uuid-7');
    m.emit(ROOT, { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
    await sleep(GRACE * 3);
    assert.equal(m.calls.mail.length, 0, 'OFF must not mail later');
    assert.equal(m.controller.view(ROOT).enabled, false);
    assert.deepEqual(m.controller.view(ROOT).waits, []);
  } finally { await m.dispose(); }
});

test('switching OFF clears pending approval timers without mailing', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    m.asked(ROOT, 'approval-uuid-8');
    await sleep(GRACE / 2);
    await m.run('off');
    await sleep(GRACE * 2);
    assert.equal(m.calls.mail.length, 0, 'OFF must not mail later');
  } finally { await m.dispose(); }
});

test('a storage-failure stop clears waits so a re-enabled session can complete', { skip }, async () => {
  const m = await mount();
  try {
    await m.run('on');
    m.asked(ROOT, 'approval-uuid-9');
    // Force the next tasks-table write to fail: the checkpoint path must stop
    // tracking (markStopped + clearWaits), not leave the pending wait behind.
    const realTable = m.controller.domain.table.bind(m.controller.domain);
    m.controller.domain.table = name => name === 'tasks'
      ? { put: () => Promise.reject(new Error('disk full')) }
      : realTable(name);
    await assert.rejects(
      m.controller.checkpoint(m.agent, { objective: 'X', acceptance: ['a'], phase: 'running', nextAction: 'n' }),
      /disk full/,
    );
    assert.equal(m.controller.engine.get(ROOT).enabled, false, 'the storage failure disables the session');
    assert.deepEqual(m.controller.view(ROOT).waits, [], 'the pending wait is cleared with the stop');
    // Re-enable on the same session id: the stale wait must not block completion.
    m.controller.domain.table = realTable;
    await m.run('on');
    const state = await m.controller.checkpoint(m.agent, { phase: 'complete', acceptance: ['a'], evidence: ['e'] });
    assert.equal(state.phase, 'complete');
    await sleep(GRACE * 2);
    assert.equal(m.calls.mail.length, 0, 'the cleared wait never mails');
  } finally { await m.dispose(); }
});
