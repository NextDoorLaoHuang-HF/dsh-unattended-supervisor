'use strict';

/**
 * DecisionMailer — QQ decision mail adapter (agently-cli) for the
 * dsh-unattended-supervisor. Pure ESM, Node built-ins only.
 *
 * Mail transport safety rules:
 * - Recipient is fixed from constructor config; the CLI binary must be an
 *   absolute path. Only two commands are ever issued:
 *     `message +send --to <recipient> --subject <ascii> --body-file ./<id>.txt
 *      --body-format plain --confirmed`
 *     `message +list --dir sent --limit 20`   (sent-copy verification)
 *   Never cc/bcc, attachments, OAuth/auth commands, or installs.
 * - `"queued": true` in the +send stdout only proves acceptance. The result is
 *   upgraded to `sent_copy_verified` only when the sent folder lists an entry
 *   matching the unique subject + recipient + a message id; otherwise it stays
 *   `queued`.
 * - Any non-zero exit is not a success. Exit 3 (auth expired) is reported
 *   verbatim; this module never attempts an OAuth refresh.
 * - Timeout, a thrown `run` error, or a missing exit code mean the transport
 *   state is unknown -> `delivery_unknown`. The module never re-sends on its
 *   own; resend control belongs to the Host caller.
 * - Body files live in a private directory (0700) and are written 0600, then
 *   referenced relatively (`./<id>.txt`) with cwd set to that directory, and
 *   deleted once the operation settles.
 * - sessionId/decisionId are sanitized to [A-Za-z0-9_-] before reaching argv or
 *   the filesystem, so path traversal is impossible.
 * - Body is a minimal decision package: length-capped, no auto signature, and
 *   common secrets (Bearer/token/password/api key/...) plus local-machine links
 *   are redacted.
 */

import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CLI_PATH = '/opt/homebrew/bin/agently-cli';
// No default recipient: the address is deployment-specific personal data and
// must come from the plugin config (the controller refuses to build a mailer
// without one, so a missing recipient can never silently mail a stranger).
const DEFAULT_TIMEOUT_MS = 30000;
const SUBJECT_PREFIX = 'DSH Action Required - ';
const LIST_ARGS = ['message', '+list', '--dir', 'sent', '--limit', '20'];
const MAX_STREAM_BYTES = 128 * 1024;
const MAX_BODY_CHARS = 8000;
const CAPS = { sessionId: 512, decisionId: 512, question: 2000, recommendation: 500, impact: 500, item: 200, listItems: 10, token: 48, revision: 32 };
const DEFAULT_IS_CURRENT = () => true;

/* ---------------------------------------------------------------- helpers */

function requireStr(value, name, { max = 20000, nonEmpty = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  if (nonEmpty && value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  if (value.length > max) throw new TypeError(`${name} exceeds maximum length ${max}`);
  return value;
}

function sanitizeText(value) {
  // Normalize CRLF, drop control characters except \n and \t.
  return String(value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function clip(value, max) {
  return value.length <= max ? value : value.slice(0, max) + '...[truncated]';
}

const SECRET_PATTERNS = [
  // Whole authorization header lines.
  { re: /\b(authorization|auth)\s*[:=]\s*[^\r\n]+/gi, to: '$1=[REDACTED]' },
  // PEM private key blocks, including the base64 body. Runs before the generic
  // key=value rule so the whole armored block is removed, not just its header.
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, to: '[PRIVATE-KEY-REMOVED]' },
  // key=value / key: value secrets (incl. token query params in URLs).
  { re: /\b(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|password|passwd|pwd|secret|credential|cookie)\s*[:=]\s*[^\s,;"'\]]+/gi, to: '$1=[REDACTED]' },
  // Bearer tokens.
  { re: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, to: '$1 [REDACTED]' },
  // Well-known token shapes (OpenAI sk-, GitHub ghp_/ghpousr_, AWS AKIA, Slack xox, JWT).
  { re: /\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, to: '[REDACTED]' },
  // Local machine links (never leak localhost token links) and local file URLs,
  // which expose a username and private paths.
  { re: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[^\s<>"']*/gi, to: '[LOCAL-LINK-REMOVED]' },
  { re: /\bfile:\/\/[^\s<>"']*/gi, to: '[LOCAL-FILE-REMOVED]' },
  // RFC 1918 / link-local hosts: an internal panel URL is not the recipient's business.
  { re: /\bhttps?:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})[^\s<>"']*/gi, to: '[PRIVATE-NET-LINK-REMOVED]' },
];

function redactSecrets(text) {
  let out = String(text);
  for (const { re, to } of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

function safeToken(value, max = CAPS.token) {
  // Everything outside [A-Za-z0-9_-] (dots and separators included) becomes '_',
  // so traversal sequences like ".." or "/" can never survive.
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, max);
}

function describeError(error) {
  if (error && typeof error === 'object') return error.code ? `${error.code} ${error.message ?? String(error)}` : String(error.message ?? error);
  return String(error);
}

function firstLine(value) {
  const text = String(value ?? '').trim();
  return text ? text.split('\n')[0].slice(0, 300) : undefined;
}

function parseEnvelope(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  try { return JSON.parse(text.slice(start)); } catch { return undefined; }
}

function findQueuedTrue(node, depth = 0) {
  if (depth > 5 || node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(item => findQueuedTrue(item, depth + 1));
  if (node.queued === true) return true;
  return Object.values(node).some(value => value !== null && typeof value === 'object' && findQueuedTrue(value, depth + 1));
}

function pickErrorMessage(envelope) {
  if (!envelope || typeof envelope !== 'object') return undefined;
  const error = envelope.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return typeof envelope.message === 'string' ? envelope.message : undefined;
}

function extractMessageId(node, depth = 0) {
  if (depth > 5 || node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) { const found = extractMessageId(item, depth + 1); if (found) return found; }
    return undefined;
  }
  const direct = node.message_id ?? node.messageId;
  if (typeof direct === 'string' && direct) return direct;
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === 'object') { const found = extractMessageId(value, depth + 1); if (found) return found; }
  }
  return undefined;
}

function extractMessageList(envelope) {
  const found = [];
  const visit = (node, depth) => {
    if (depth > 5 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.length && node.every(item => item && typeof item === 'object' && !Array.isArray(item))) found.push(node);
      node.forEach(item => visit(item, depth + 1));
      return;
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(envelope, 0);
  const withSubjects = found.filter(list => list.some(entry => typeof entry.subject === 'string'));
  return (withSubjects.length ? withSubjects : found)[0] ?? [];
}

/**
 * Match a sent-folder entry by unique subject + recipient + required message id.
 * Returns the messageId, or null when no entry qualifies.
 */
function findSentCopy(envelope, subject, recipient) {
  for (const entry of extractMessageList(envelope)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const entrySubject = typeof entry.subject === 'string' ? entry.subject.trim() : '';
    if (entrySubject !== subject) continue;
    let blob;
    try { blob = JSON.stringify(entry); } catch { continue; }
    if (!blob || !blob.includes(recipient)) continue;
    const id = typeof entry.message_id === 'string' && entry.message_id ? entry.message_id
      : typeof entry.messageId === 'string' && entry.messageId ? entry.messageId : undefined;
    if (!id) continue;
    return id;
  }
  return null;
}

/**
 * Classify one CLI invocation result. `expectQueued` applies to +send.
 * Never throws.
 */
function interpretRun(result, { expectQueued = false } = {}) {
  if (result === null || typeof result !== 'object') {
    return { status: 'delivery_unknown', error: 'run returned no result object; delivery state unknown' };
  }
  const { code } = result;
  if (code === 0) {
    const envelope = parseEnvelope(result.stdout);
    if (!expectQueued) return { status: 'ok', envelope };
    if ((envelope && findQueuedTrue(envelope)) || /"queued"\s*:\s*true/.test(String(result.stdout ?? ''))) {
      return { status: 'ok', envelope };
    }
    // The real CLI reports failures with exit code 0 and `{"ok": false, "error": {...}}`
    // — an expired OAuth grant is the common case (measured against agently-cli:
    // `{"ok":false,"error":{"type":"auth","message":"authorization required"}}`, exit 0).
    // Surface that cause instead of collapsing it into "no queued flag".
    if (envelope && envelope.ok === false) {
      const type = typeof envelope.error?.type === 'string' ? envelope.error.type : 'unreported';
      const message = pickErrorMessage(envelope) ?? 'no error message';
      if (type === 'auth') {
        return { status: 'failed', error: `mail authorization required (CLI ok:false type=auth; OAuth refresh intentionally not attempted): ${message}` };
      }
      return { status: 'failed', error: `CLI reported ok:false (type=${type}): ${message}` };
    }
    return { status: 'failed', error: 'CLI exited 0 but did not report "queued": true; message not accepted' };
  }
  if (typeof code === 'number') {
    const detail = pickErrorMessage(parseEnvelope(result.stdout)) ?? pickErrorMessage(parseEnvelope(result.stderr))
      ?? firstLine(result.stderr) ?? `exit code ${code}`;
    if (code === 3) return { status: 'failed', error: `auth failed (exit 3; OAuth refresh intentionally not attempted): ${detail}` };
    return { status: 'failed', error: `CLI exit ${code}: ${detail}` };
  }
  // No exit code: the process was killed (timeout/abort) or never started.
  if (result.timedOut) return { status: 'delivery_unknown', error: 'send command timed out; delivery state unknown' };
  if (result.aborted) return { status: 'delivery_unknown', error: 'send command aborted; delivery state unknown' };
  if (result.error) return { status: 'failed', error: `failed to start CLI: ${describeError(result.error)}` };
  return { status: 'delivery_unknown', error: 'CLI produced no exit code; delivery state unknown' };
}

function buildBody(payload, isoTime) {
  const parts = ['DSH unattended decision request', '',
    `session: ${sanitizeText(String(payload.sessionId))}`,
    `decision: ${sanitizeText(String(payload.decisionId))}`,
    `revision: ${payload.revision}`,
    `time: ${isoTime}`, '',
    'question:',
    clip(redactSecrets(sanitizeText(payload.question)), CAPS.question)];
  const options = payload.options.slice(0, CAPS.listItems)
    .map((option, index) => `- [${String.fromCharCode(65 + index)}] ${clip(redactSecrets(sanitizeText(option)), CAPS.item)}`);
  if (options.length) parts.push('', 'options:', options.join('\n'));
  if (payload.recommendation) parts.push('', `recommendation: ${clip(redactSecrets(sanitizeText(payload.recommendation)), CAPS.recommendation)}`);
  const attempted = payload.attempted.slice(0, CAPS.listItems)
    .map(item => `- ${clip(redactSecrets(sanitizeText(item)), CAPS.item)}`);
  if (attempted.length) parts.push('', 'attempted:', attempted.join('\n'));
  if (payload.impact) parts.push('', 'impact:', clip(redactSecrets(sanitizeText(payload.impact)), CAPS.impact));
  let body = parts.join('\n') + '\n';
  if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '\n...[truncated]\n';
  return body;
}

function validatePayload(payload) {
  if (payload === null || typeof payload !== 'object') throw new TypeError('send payload must be an object');
  const { sessionId, decisionId, question, options = [], recommendation = '', attempted = [], impact = '', revision = 0 } = payload;
  requireStr(sessionId, 'sessionId', { max: CAPS.sessionId, nonEmpty: true });
  requireStr(decisionId, 'decisionId', { max: CAPS.decisionId, nonEmpty: true });
  requireStr(question, 'question', { max: 100000 });
  requireStr(recommendation, 'recommendation', { max: 100000 });
  requireStr(impact, 'impact', { max: 100000 });
  if (!Array.isArray(options)) throw new TypeError('options must be an array of strings');
  options.forEach((option, index) => requireStr(option, `options[${index}]`, { max: 100000 }));
  if (!Array.isArray(attempted)) throw new TypeError('attempted must be an array of strings');
  attempted.forEach((item, index) => requireStr(item, `attempted[${index}]`, { max: 100000 }));
  const revisionOk = (Number.isSafeInteger(revision) && revision >= 0)
    || (typeof revision === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(revision));
  if (!revisionOk) throw new TypeError('revision must be a non-negative safe integer or a short [A-Za-z0-9_-] string');
  return { sessionId, decisionId, question, options, recommendation, attempted, impact, revision };
}

/* ------------------------------------------------------------- default run */

function capCollector() {
  const chunks = [];
  let total = 0;
  return {
    attach(stream) {
      stream.on('data', chunk => {
        if (total >= MAX_STREAM_BYTES) return; // hard 128KB cap per stream
        const room = MAX_STREAM_BYTES - total;
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        chunks.push(Buffer.from(piece));
        total += piece.length;
      });
    },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

/**
 * Default injected-dependency implementation of `run`:
 * spawn(file, args) without a shell, output capped at 128KB per stream,
 * killed with SIGKILL after `timeoutMs`. Resolves { code, stdout, stderr }
 * plus optional { timedOut, aborted, error } markers; never rejects.
 */
export function defaultRun(file, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise(resolve => {
    const out = capCollector();
    const err = capCollector();
    let child;
    try {
      child = spawn(file, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error });
      return;
    }
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawned = false;
    let spawnError;
    const onAbort = () => { aborted = true; try { child.kill('SIGKILL'); } catch { /* already dead */ } };
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* already dead */ } }, Math.max(1, timeoutMs));
    if (signal) {
      if (signal.aborted) onAbort();
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    }
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      const result = { code, stdout: out.text(), stderr: err.text() };
      if (timedOut) result.timedOut = true;
      if (aborted) result.aborted = true;
      if (spawnError) result.error = spawnError;
      resolve(result);
    };
    out.attach(child.stdout);
    err.attach(child.stderr);
    child.on('spawn', () => { spawned = true; });
    child.on('error', error => {
      spawnError = error;
      if (!spawned) queueMicrotask(() => finish(null)); // spawn never succeeded
    });
    child.on('close', code => finish(code));
  });
}

/* ------------------------------------------------------------------ module */

export class DecisionMailer {
  #cliPath;
  #recipient;
  #directory;
  #timeoutMs;
  #run;
  #now;
  #closed = false;
  #seq = 0;
  #inflight = new Map();

  constructor({
    cliPath = DEFAULT_CLI_PATH,
    recipient,
    directory,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    run,
    now = Date.now,
  } = {}) {
    requireStr(cliPath, 'cliPath', { nonEmpty: true });
    if (!path.isAbsolute(cliPath)) throw new TypeError(`cliPath must be an absolute path, got: ${cliPath}`);
    if (typeof recipient !== 'string' || !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(recipient) || /[\s\u0000-\u001F\u007F]/.test(recipient)) {
      throw new TypeError(`recipient must be a plain email address string, got: ${JSON.stringify(recipient)}`);
    }
    requireStr(directory, 'directory', { nonEmpty: true });
    this.#directory = path.resolve(directory);
    if (this.#directory === path.parse(this.#directory).root) throw new TypeError('directory must not be a filesystem root');
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive finite number');
    if (run !== undefined && typeof run !== 'function') throw new TypeError('run must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#cliPath = cliPath;
    this.#recipient = recipient;
    this.#timeoutMs = timeoutMs;
    this.#run = run ?? defaultRun;
    this.#now = now;
  }

  get closed() { return this.#closed; }

  /**
   * send({sessionId, decisionId, question, options?, recommendation?,
   *       attempted?, impact?, revision?}, {isCurrent?, signal?}?)
   *   -> { status: 'queued'|'sent_copy_verified'|'delivery_unknown'|'failed'
   *              |'cancelled', decisionId, messageId?, error? }
   *
   * Concurrent calls with the same sessionId+decisionId+revision coalesce into
   * a single operation and share one result. Persistent dedup remains the
   * Host's responsibility.
   */
  async send(payload, { isCurrent = DEFAULT_IS_CURRENT, signal } = {}) {
    const details = validatePayload(payload);
    if (typeof isCurrent !== 'function') throw new TypeError('isCurrent must be a function');
    if (signal !== undefined && (signal === null || typeof signal !== 'object' || typeof signal.addEventListener !== 'function')) {
      throw new TypeError('signal must be an AbortSignal');
    }
    const key = `${details.sessionId}\u0000${details.decisionId}\u0000${details.revision}`;
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const operation = this.#performSend(details, { isCurrent, signal });
    this.#inflight.set(key, operation);
    const drop = () => { if (this.#inflight.get(key) === operation) this.#inflight.delete(key); };
    operation.then(drop, drop);
    return operation;
  }

  /** Stop accepting sends and wait for in-flight operations to settle. */
  async close() {
    this.#closed = true;
    await Promise.allSettled([...this.#inflight.values()]);
    this.#inflight.clear();
    return { closed: true };
  }

  async #performSend(details, { isCurrent, signal }) {
    const { decisionId } = details;
    const cancelled = reason => ({ status: 'cancelled', decisionId, error: reason });
    if (this.#closed) return cancelled('DecisionMailer is closed');
    if (signal?.aborted) return cancelled('aborted before send');
    if (!this.#checkCurrent(isCurrent)) return cancelled('session no longer current');

    const clock = Number(this.#now());
    const nowMs = Number.isFinite(clock) ? Math.trunc(clock) : 0;
    const stamp = `${nowMs.toString(36)}${(++this.#seq).toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
    const taskKey = `${safeToken(details.sessionId)}__${safeToken(details.decisionId)}__r${safeToken(String(details.revision), 16)}__${stamp}`;
    const subject = SUBJECT_PREFIX + taskKey;
    const bodyPath = path.join(this.#directory, `${taskKey}.txt`);
    const sendArgs = ['message', '+send', '--to', this.#recipient, '--subject', subject,
      '--body-file', `./${taskKey}.txt`, '--body-format', 'plain', '--confirmed'];
    const runOptions = { cwd: this.#directory, timeoutMs: this.#timeoutMs, signal };

    let body;
    try {
      body = buildBody(details, new Date(nowMs).toISOString());
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await chmod(this.#directory, 0o700); // enforce private dir even if it pre-existed
      await writeFile(bodyPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      return { status: 'failed', decisionId, error: `body file write failed: ${describeError(error)}` };
    }

    try {
      // isCurrent must be re-checked after the async body write, before sending.
      if (signal?.aborted) return cancelled('aborted after body write');
      if (!this.#checkCurrent(isCurrent)) return cancelled('session no longer current after body write');

      let result;
      try {
        result = await this.#run(this.#cliPath, sendArgs, runOptions);
      } catch (error) {
        // A thrown run (incl. timeout exceptions) leaves the transport state
        // unknown: report once, never re-send.
        return { status: 'delivery_unknown', decisionId, error: `send command threw (${error?.name ?? 'Error'}): ${describeError(error)}` };
      }
      const outcome = interpretRun(result, { expectQueued: true });
      if (outcome.status === 'delivery_unknown') return { status: 'delivery_unknown', decisionId, error: outcome.error };
      if (outcome.status === 'failed') return { status: 'failed', decisionId, error: outcome.error };

      // Accepted ("queued": true) — acceptance only. Verify the sent copy.
      const verified = { status: 'queued', decisionId };
      const acceptedId = extractMessageId(outcome.envelope);
      if (acceptedId) verified.messageId = acceptedId;
      if (signal?.aborted) return verified;
      try {
        const listResult = await this.#run(this.#cliPath, LIST_ARGS, runOptions);
        const listOutcome = interpretRun(listResult);
        if (listOutcome.status === 'ok') {
          const copyId = findSentCopy(listOutcome.envelope, subject, this.#recipient);
          // A readable sent folder without a matching copy is a normal
          // terminal "queued" state, not an error. Unreadable output is.
          if (copyId) { verified.status = 'sent_copy_verified'; verified.messageId = copyId; }
          else if (listOutcome.envelope === undefined) verified.error = 'sent folder response unreadable (no JSON); status stays queued';
        } else {
          verified.error = `sent copy verification unavailable: ${listOutcome.error}`;
        }
      } catch (error) {
        verified.error = `sent copy verification threw: ${describeError(error)}`;
      }
      return verified;
    } finally {
      await rm(bodyPath, { force: true }).catch(() => {});
    }
  }

  #checkCurrent(isCurrent) {
    try { return Boolean(isCurrent()); } catch { return false; }
  }
}
