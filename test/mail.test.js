'use strict';

/**
 * Tests for src/mail.js — DecisionMailer.
 *
 * Safety envelope for this suite:
 * - `run` is injected everywhere, so no external CLI command is ever executed.
 * - cliPath always points at a NONEXISTENT absolute path, so even a lost
 *   injection could only fail with ENOENT — no real mail can ever be sent.
 * - The defaultRun unit tests only spawn `process.execPath` itself (node) with
 *   harmless inline scripts: no mail, no credentials, no network services.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DecisionMailer, defaultRun } from '../src/mail.js';

const FAKE_CLI = '/nonexistent/dsh-test/agently-cli';
const RECIPIENT = 'decisions@example.test';
const BANNED_FLAGS = ['--cc', '--bcc', '--attachment', '--confirmation-token'];

async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mail-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const basePayload = (over = {}) => ({
  sessionId: 'sess-1', decisionId: 'dec-1', question: 'Proceed?',
  options: ['Yes', 'No'], recommendation: 'Yes', attempted: [], impact: '', revision: 0, ...over,
});

/**
 * A recording fake `run`. Default: +send resolves queued:true (holding until
 * released when holdSends is set), +list resolves an empty list. Handlers may
 * return custom CLI results; `calls` records {file, args, opts, body} where
 * `body` is the on-disk body file captured at invocation time.
 */
function recorderRun({ onSend, onList, holdSends = false } = {}) {
  const calls = [];
  const pending = [];
  const run = async (file, args, opts) => {
    const call = { file, args, opts };
    calls.push(call);
    if (args[1] === '+send') {
      if (holdSends) await new Promise(resolve => pending.push(resolve));
      const bodyArg = args[args.indexOf('--body-file') + 1];
      if (bodyArg) call.body = await fs.readFile(path.join(opts.cwd, bodyArg), 'utf8');
      return onSend ? onSend(call) : { code: 0, stdout: '{"queued":true}', stderr: '' };
    }
    if (args[1] === '+list') return onList ? onList(call) : { code: 0, stdout: '{"messages":[]}', stderr: '' };
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  return { run, calls, releaseSends: () => { while (pending.length) pending.shift()(); } };
}

const sendCallsOf = calls => calls.filter(call => call.args[1] === '+send');
const argOf = (call, flag) => call.args[call.args.indexOf(flag) + 1];

/* ------------------------------------------------------- constructor / types */

test('constructor validates configuration strictly', () => {
  assert.throws(() => new DecisionMailer({ cliPath: 'agently-cli', directory: '/tmp/x' }), TypeError);
  assert.throws(() => new DecisionMailer({ recipient: 'not-an-email', directory: '/tmp/x' }), TypeError);
  assert.throws(() => new DecisionMailer({ recipient: 'a@b\nBcc: x@c', directory: '/tmp/x' }), TypeError);
  assert.throws(() => new DecisionMailer({ directory: '/tmp/x' }), TypeError); // recipient is required — there is no default
  assert.throws(() => new DecisionMailer({}), TypeError); // recipient and directory are both required
  assert.throws(() => new DecisionMailer({ recipient: 'a@b.co', directory: '/' }), TypeError); // never a filesystem root
  assert.throws(() => new DecisionMailer({ recipient: 'a@b.co', directory: '/tmp/x', timeoutMs: -1 }), TypeError);
  assert.throws(() => new DecisionMailer({ recipient: 'a@b.co', directory: '/tmp/x', timeoutMs: '30s' }), TypeError);
  assert.throws(() => new DecisionMailer({ recipient: 'a@b.co', directory: '/tmp/x', run: 'nope' }), TypeError);
  assert.throws(() => new DecisionMailer({ recipient: 'a@b.co', directory: '/tmp/x', now: 42 }), TypeError);
});

test('send validates payload types before touching the CLI', async (t) => {
  const dir = await makeTempDir(t);
  let calls = 0;
  const run = async () => { calls += 1; return { code: 0, stdout: '{"queued":true}', stderr: '' }; };
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run });
  await assert.rejects(() => mailer.send({ ...basePayload(), sessionId: '' }), TypeError);
  await assert.rejects(() => mailer.send({ ...basePayload(), question: 42 }), TypeError);
  await assert.rejects(() => mailer.send({ ...basePayload(), options: 'yes' }), TypeError);
  await assert.rejects(() => mailer.send({ ...basePayload(), options: [1] }), TypeError);
  await assert.rejects(() => mailer.send({ ...basePayload(), attempted: {} }), TypeError);
  await assert.rejects(() => mailer.send({ ...basePayload(), revision: -1 }), TypeError);
  await assert.rejects(() => mailer.send({ ...basePayload(), revision: '../x' }), TypeError);
  await assert.rejects(() => mailer.send(null), TypeError);
  await assert.rejects(() => mailer.send(basePayload(), { isCurrent: 'nope' }), TypeError);
  await assert.rejects(() => mailer.send(basePayload(), { signal: { addEventListener: 'x' } }), TypeError);
  assert.equal(calls, 0);
});

/* ------------------------------------------------ main happy path: argv/paths */

test('send: exact argv, relative body path, 0700/0600 perms, minimal body, sent-copy verified', async (t) => {
  const dir = await makeTempDir(t);
  const rec = recorderRun({
    onList: () => {
      const subject = argOf(sendCallsOf(rec.calls)[0], '--subject');
      return {
        code: 0,
        stdout: JSON.stringify({ data: { dir: 'sent', messages: [
          { message_id: 'msg_old', subject: 'DSH Action Required - unrelated', to: [{ email: 'other@example.com' }] },
          { message_id: 'msg_verified_1', subject, to: [{ email: RECIPIENT }] },
        ] } }),
        stderr: '',
      };
    },
  });
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, timeoutMs: 1234, run: rec.run, now: () => 1700000000000 });
  const res = await mailer.send({
    sessionId: 'sess-1', decisionId: 'dec-1', question: 'Approve restart?',
    options: ['Approve', 'Deny'], recommendation: 'Approve', attempted: ['graceful stop'],
    impact: 'brief downtime', revision: 2,
  });

  assert.deepEqual(res, { status: 'sent_copy_verified', decisionId: 'dec-1', messageId: 'msg_verified_1' });
  assert.equal(rec.calls.length, 2);

  const send = rec.calls[0];
  assert.equal(send.file, FAKE_CLI);
  assert.equal(send.opts.cwd, dir);
  assert.equal(send.opts.timeoutMs, 1234);
  assert.equal(send.opts.signal, undefined);
  const subject = argOf(send, '--subject');
  const bodyArg = argOf(send, '--body-file');
  assert.deepEqual(send.args, ['message', '+send', '--to', RECIPIENT, '--subject', subject,
    '--body-file', bodyArg, '--body-format', 'plain', '--confirmed']);
  for (const banned of BANNED_FLAGS) assert.ok(!send.args.includes(banned));
  assert.match(subject, /^DSH Action Required - [A-Za-z0-9_-]+$/);
  assert.ok(subject.includes('sess-1') && subject.includes('dec-1'));
  assert.match(bodyArg, /^\.\/[A-Za-z0-9_-]+\.txt$/); // relative, single segment, no traversal
  assert.equal(path.resolve(send.opts.cwd, bodyArg), path.join(dir, bodyArg.slice(2)));

  const list = rec.calls[1];
  assert.equal(list.file, FAKE_CLI);
  assert.deepEqual(list.args, ['message', '+list', '--dir', 'sent', '--limit', '20']);
  for (const call of rec.calls) for (const banned of ['auth', 'login', 'install', ...BANNED_FLAGS]) assert.ok(!call.args.includes(banned));

  // Minimal decision package, no auto signature, no local links.
  const body = send.body;
  assert.match(body, /^DSH unattended decision request\n/);
  assert.ok(body.includes('session: sess-1'));
  assert.ok(body.includes('decision: dec-1'));
  assert.ok(body.includes('revision: 2'));
  assert.ok(body.includes('time: 2023-11-14T22:13:20.000Z'));
  assert.ok(body.includes('question:\nApprove restart?'));
  assert.ok(body.includes('- [A] Approve') && body.includes('- [B] Deny'));
  assert.ok(body.includes('recommendation: Approve'));
  assert.ok(body.includes('attempted:\n- graceful stop'));
  assert.ok(body.includes('impact:\nbrief downtime'));
  assert.ok(!/regards|signature|--\s*$/im.test(body));

  // Private permissions and post-send cleanup.
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(dir), []); // body file removed after settle
});

/* -------------------------------------------------- queued vs sent verification */

test('accepted but not verifiable: status stays queued', async (t) => {
  await t.test('sent entry with matching subject but wrong recipient stays queued', async (t) => {
    const dir = await makeTempDir(t);
    const rec = recorderRun({
      onSend: () => ({ code: 0, stdout: '{"queued":true,"message_id":"msg_send_1"}', stderr: '' }),
      onList: () => ({ code: 0, stdout: JSON.stringify({ messages: [
        { message_id: 'msg_x', subject: 'DSH Action Required - somebody_else', to: [{ email: 'else@example.com' }] },
      ] }), stderr: '' }),
    });
    const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
    const res = await mailer.send(basePayload());
    assert.deepEqual(res, { status: 'queued', decisionId: 'dec-1', messageId: 'msg_send_1' });
  });

  await t.test('matching subject+recipient but missing message_id stays queued', async (t) => {
    const dir = await makeTempDir(t);
    const rec = recorderRun({
      onList: () => {
        const subject = argOf(sendCallsOf(rec.calls)[0], '--subject');
        return { code: 0, stdout: JSON.stringify({ messages: [{ subject, to: RECIPIENT }] }), stderr: '' };
      },
    });
    const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
    const res = await mailer.send(basePayload());
    assert.equal(res.status, 'queued');
    assert.equal(res.messageId, undefined);
    assert.equal(res.error, undefined); // readable sent folder, no qualifying copy: clean queued
  });

  await t.test('+list failing or unparseable keeps queued with an explanation', async (t) => {
    for (const onList of [
      () => ({ code: 1, stdout: 'boom', stderr: 'list failed' }),
      () => ({ code: 0, stdout: 'not json at all', stderr: '' }),
      () => { throw new Error('list blew up'); },
    ]) {
      const dir = await makeTempDir(t);
      const rec = recorderRun({ onList });
      const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
      const res = await mailer.send(basePayload());
      assert.equal(res.status, 'queued');
      assert.equal(res.decisionId, 'dec-1');
      assert.match(res.error, /verification|unreadable/);
    }
  });

  await t.test('stdout "queued": true is honored even with surrounding output', async (t) => {
    const dir = await makeTempDir(t);
    const rec = recorderRun({ onSend: () => ({ code: 0, stdout: 'notice\n{"queued": true}\n', stderr: '' }) });
    const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
    const res = await mailer.send(basePayload());
    assert.equal(res.status, 'queued');
  });
});

/* --------------------------------------------------------------- failures */

test('non-zero exit is never a success and skips sent verification', async (t) => {
  const dir = await makeTempDir(t);
  const rec = recorderRun({ onSend: () => ({ code: 2, stdout: JSON.stringify({ error: { message: 'invalid parameters' } }), stderr: '' }) });
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
  const res = await mailer.send(basePayload());
  assert.equal(res.status, 'failed');
  assert.match(res.error, /exit 2/);
  assert.match(res.error, /invalid parameters/);
  assert.equal(rec.calls.length, 1); // no verification call after a failed send
  assert.equal(res.messageId, undefined);
});

test('exit 3 auth failure is reported but no refresh/credential path is ever invoked', async (t) => {
  const dir = await makeTempDir(t);
  const rec = recorderRun({ onSend: () => ({ code: 3, stdout: '{"error":{"message":"token expired"}}', stderr: '' }) });
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
  const res = await mailer.send(basePayload());
  assert.equal(res.status, 'failed');
  assert.match(res.error, /auth/i);
  assert.match(res.error, /not attempted/);
  assert.equal(rec.calls.length, 1);
  for (const call of rec.calls) {
    assert.ok(!call.args.includes('auth') && !call.args.includes('login') && !call.args.includes('install'));
  }
});

test('CLI exit 0 without queued:true is a failure', async (t) => {
  const dir = await makeTempDir(t);
  const rec = recorderRun({ onSend: () => ({ code: 0, stdout: '{"ok":true}', stderr: '' }) });
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
  const res = await mailer.send(basePayload());
  assert.equal(res.status, 'failed');
  assert.match(res.error, /queued/);
  assert.equal(sendCallsOf(rec.calls).length, 1);
});

test('spawn failure of a missing binary is a plain failure, nothing is executed', async (t) => {
  const dir = await makeTempDir(t);
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir }); // default run, missing binary
  const res = await mailer.send(basePayload());
  assert.equal(res.status, 'failed');
  assert.match(res.error, /failed to start CLI/);
});

/* ------------------------------------------------- timeout/unknown, no resend */

test('run timeout exception -> delivery_unknown exactly once, never re-sent', async (t) => {
  const dir = await makeTempDir(t);
  let calls = 0;
  const run = async () => {
    calls += 1;
    const error = new Error('spawn timed out after 30000ms');
    error.name = 'TimeoutError';
    throw error;
  };
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run });
  const res = await mailer.send(basePayload());
  assert.equal(res.status, 'delivery_unknown');
  assert.equal(res.decisionId, 'dec-1');
  assert.equal(res.messageId, undefined);
  assert.match(res.error, /timed out|unknown/i);
  assert.equal(calls, 1); // one send attempt, no resend, no verification
});

test('run resolving without an exit code -> delivery_unknown', async (t) => {
  const dir = await makeTempDir(t);
  for (const result of [{ code: null, stdout: '', stderr: '' }, { code: null, stdout: '', stderr: '', timedOut: true }, { code: null, stdout: '', stderr: '', aborted: true }]) {
    const rec = recorderRun({ onSend: () => result });
    const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
    const res = await mailer.send(basePayload());
    assert.equal(res.status, 'delivery_unknown');
    assert.equal(sendCallsOf(rec.calls).length, 1);
  }
});

test('cancelled operations never reach the CLI', async (t) => {
  const dir = await makeTempDir(t);

  // closed mailer
  const recClosed = recorderRun();
  const closedMailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: recClosed.run });
  await closedMailer.close();
  const resClosed = await closedMailer.send(basePayload());
  assert.equal(resClosed.status, 'cancelled');
  assert.equal(recClosed.calls.length, 0);

  // isCurrent false from the start
  const recPre = recorderRun();
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: recPre.run });
  const resPre = await mailer.send(basePayload(), { isCurrent: () => false });
  assert.equal(resPre.status, 'cancelled');
  assert.equal(recPre.calls.length, 0);

  // already-aborted signal
  const ac = new AbortController();
  ac.abort();
  const resAbort = await mailer.send(basePayload(), { signal: ac.signal });
  assert.equal(resAbort.status, 'cancelled');
  assert.equal(recPre.calls.length, 0);
});

test('isCurrent re-checked after the async body write: cancelled, no CLI call, body removed', async (t) => {
  const dir = await makeTempDir(t);
  let checks = 0;
  const rec = recorderRun();
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
  const res = await mailer.send(basePayload(), { isCurrent: () => (checks += 1) <= 1 });
  assert.equal(res.status, 'cancelled');
  assert.equal(sendCallsOf(rec.calls).length, 0);
  assert.deepEqual(await fs.readdir(dir), []); // written body got cleaned up
});

test('close() waits for in-flight operation; afterwards sends are cancelled', async (t) => {
  const dir = await makeTempDir(t);
  const rec = recorderRun({ holdSends: true });
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
  const inflight = mailer.send(basePayload());
  let closeSettled = false;
  const closing = mailer.close().then(() => { closeSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closeSettled, false); // close waits for the in-flight send
  rec.releaseSends();
  const res = await inflight;
  assert.equal(res.status, 'queued');
  await closing;
  assert.equal(closeSettled, true);
  const res2 = await mailer.send(basePayload({ decisionId: 'dec-2' }));
  assert.equal(res2.status, 'cancelled');
  assert.equal(sendCallsOf(rec.calls).length, 1);
});

/* ------------------------------------------------------------- dedup */

test('concurrent identical operations coalesce into a single send', async (t) => {
  const dir = await makeTempDir(t);
  const rec = recorderRun({ holdSends: true });
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
  const p1 = mailer.send(basePayload());
  const p2 = mailer.send(basePayload());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sendCallsOf(rec.calls).length, 1); // one operation behind both calls
  rec.releaseSends();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, r2); // identical result object, single operation
  assert.equal(r1.status, 'queued');
});

test('sequential retries and different revisions are separate operations', async (t) => {
  const dir = await makeTempDir(t);
  let sends = 0;
  const run = async (file, args) => (args[1] === '+send'
    ? (sends += 1, { code: 0, stdout: '{"queued":true}', stderr: '' })
    : { code: 0, stdout: '{"messages":[]}', stderr: '' });
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run });
  await mailer.send(basePayload());
  await mailer.send(basePayload()); // sequential: dedup is the Host's job
  await Promise.all([
    mailer.send(basePayload({ revision: 1 })),
    mailer.send(basePayload({ revision: 2 })),
  ]);
  assert.equal(sends, 4);
});

/* ------------------------------------------------------- injection & privacy */

test('path traversal in session/decision ids cannot escape the body directory', async (t) => {
  const dir = await makeTempDir(t);
  let send = null;
  const run = async (file, args, opts) => {
    if (args[1] === '+send') { send = { args, opts }; return { code: 0, stdout: '{"queued":true}', stderr: '' }; }
    return { code: 0, stdout: '{"messages":[]}', stderr: '' };
  };
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run });
  const res = await mailer.send(basePayload({
    sessionId: '../../etc/passwd',
    decisionId: '..\\..\\..\\Windows\\system32',
    question: 'q',
  }));
  assert.equal(res.status, 'queued');
  const subject = argOf(send, '--subject');
  const bodyArg = argOf(send, '--body-file');
  assert.match(subject, /^DSH Action Required - [A-Za-z0-9_-]+$/); // no separators, no dots
  assert.match(bodyArg, /^\.\/[A-Za-z0-9_-]+\.txt$/);
  assert.ok(!subject.includes('..') && !subject.includes('/') && !subject.includes('\\'));
  assert.equal(path.resolve(send.opts.cwd, bodyArg).startsWith(dir + path.sep), true);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('privacy trimming: bearer/token/password/api-key secrets and local links are removed', async (t) => {
  const dir = await makeTempDir(t);
  const rec = recorderRun();
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
  await mailer.send(basePayload({
    question: [
      'Please approve rollout.',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig123456',
      'api_key: sk-abcdefghij1234567890abcd',
      'password=hunter2secret',
      'token=abc123def456ghi',
      'see http://127.0.0.1:9999/debug?token=zzz123456 or ghp_abcdefghijklmnopqrstuvwx and AKIAIOSFODNN7EXAMPLE',
    ].join('\n'),
  }));
  const body = sendCallsOf(rec.calls)[0].body;
  for (const secret of ['eyJhbGciOi', 'sk-abcdefghij', 'hunter2secret', 'abc123def456',
    'ghp_abcdefghij', 'AKIAIOSFODNN7', '127.0.0.1', 'zzz123456']) {
    assert.ok(!body.includes(secret), `body leaked: ${secret}`);
  }
  assert.ok(body.includes('Please approve rollout.'));
  assert.ok(body.includes('[REDACTED]'));
  assert.ok(body.includes('[LOCAL-LINK-REMOVED]'));
  assert.ok(!/localhost|127\.0\.0\.1/.test(body)); // no local token links survive
});

test('body length limits and option count are enforced', async (t) => {
  const dir = await makeTempDir(t);
  const rec = recorderRun();
  const mailer = new DecisionMailer({ recipient: RECIPIENT, cliPath: FAKE_CLI, directory: dir, run: rec.run });
  await mailer.send(basePayload({
    question: 'q'.repeat(5000),
    options: Array.from({ length: 15 }, (_, index) => `opt${index}`),
    recommendation: 'r'.repeat(3000),
    impact: 'i'.repeat(3000),
  }));
  const body = sendCallsOf(rec.calls)[0].body;
  assert.ok(body.length <= 8100, `body too long: ${body.length}`);
  assert.ok(body.includes('...[truncated]'));
  assert.ok(body.includes('q'.repeat(2000)));
  assert.ok(body.includes('opt9') && !body.includes('opt10')); // options capped at 10
});

/* ----------------------------------------------------- defaultRun unit tests */

test('defaultRun: captures output, passes args literally (no shell), reports exit code', async (t) => {
  const dir = await makeTempDir(t);
  const injected = 'a;b|c&d $(touch should-not-run) `x`';
  const r = await defaultRun(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv))', injected], { cwd: dir, timeoutMs: 15000 });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes(injected)); // literal argv, no shell interpretation
  assert.equal(existsSync(path.join(dir, 'should-not-run')), false);
});

test('defaultRun: timeout kills the process and is marked timedOut', async (t) => {
  const dir = await makeTempDir(t);
  const started = Date.now();
  const r = await defaultRun(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, timeoutMs: 250 });
  assert.equal(r.code, null);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5000);
});

test('defaultRun: external abort is marked aborted', async (t) => {
  const dir = await makeTempDir(t);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 120);
  const r = await defaultRun(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, timeoutMs: 30000, signal: ac.signal });
  assert.equal(r.code, null);
  assert.equal(r.aborted, true);
});

test('defaultRun: stdout/stderr are hard-capped at 128KB per stream', async (t) => {
  const dir = await makeTempDir(t);
  const r = await defaultRun(process.execPath,
    ['-e', 'process.stdout.write("o".repeat(200000));process.stderr.write("e".repeat(200000));'],
    { cwd: dir, timeoutMs: 20000 });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.length <= 128 * 1024 && r.stdout.length >= 130000 - 2000);
  assert.ok(r.stderr.length <= 128 * 1024 && r.stderr.length >= 130000 - 2000);
});

test('defaultRun: spawn error resolves with code null and an error marker', async (t) => {
  const dir = await makeTempDir(t);
  const r = await defaultRun(FAKE_CLI, ['anything'], { cwd: dir, timeoutMs: 5000 });
  assert.equal(r.code, null);
  assert.ok(r.error);
});
