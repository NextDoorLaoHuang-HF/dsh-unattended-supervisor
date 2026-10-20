import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { SupervisorEngine } from './engine.js';
import { DecisionMailer } from './mail.js';

export const SOURCE = 'unattended-supervisor';
// Flash routes that are actually billable on this deployment. The former
// `commandcode` route is retired (subscription cancelled on 2026-10-17); DeepSeek
// now runs through `amr-link`, so guiding the model to the old provider would send
// delegation at a route with no quota left.
export const FLASH_ROUTES = [
  { provider: 'zai-coding-cn', model: 'glm-5.3-flash' },
  { provider: 'amr-link', model: 'deepseek-v4.1-flash' },
];

const clone = value => JSON.parse(JSON.stringify(value));
const message = text => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: SOURCE } });
const asError = error => error instanceof Error ? error.message : String(error);

// Durable per-record keys must be path-safe. The json storage backend asserts
// SAFE_KEY_RE (/^[a-zA-Z0-9_-]+$/) before writing, so session ids, decision ids
// and separators are all folded onto that alphabet.
export const safeKey = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160) || '_';
// Outbox keys are deliberately revision-free: a checkpoint during a pending wait
// bumps the revision, and a revision-suffixed key would let the same decision mail
// a second time after it (duplicate side effect). The revision stays inside the
// entry for audit only.
const outboxKeyOf = (sessionId, decisionId) => `${safeKey(sessionId)}__${safeKey(decisionId)}`;
// Entry statuses that mean "an attempt exists or is in flight": a duplicate
// request must not start a second side effect for the same decision.
const ACTIVE_MAIL_STATUSES = ['sending', 'queued', 'sent_copy_verified', 'delivery_unknown'];
// A recipient that could plausibly be an address (the mailer itself remains the
// authority: it re-validates and throws on anything malformed).
const PLAIN_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// No recipient configured: the plugin must still load. Every send settles as an
// explicit, retriable configuration failure instead of spawning a CLI.
class UnconfiguredMailer {
  #reason;
  constructor(value) {
    this.#reason = `mailRecipient is not configured (${JSON.stringify(value ?? '')}); set it in the plugin config to enable decision mail`;
  }
  async send() { return { status: 'failed', error: this.#reason }; }
  async close() {}
}

export class SupervisorController {
  constructor(ctx, config, { engine, mailer, now = Date.now } = {}) {
    this.ctx = ctx;
    this.config = config;
    this.now = now;
    this.engine = engine ?? new SupervisorEngine(config);
    this.mailer = mailer ?? (PLAIN_ADDRESS_RE.test(config.mailRecipient ?? '')
      ? new DecisionMailer({
          cliPath: config.mailCli,
          recipient: config.mailRecipient,
          directory: resolve(homedir(), '.dsh', 'unattended-mail'),
          timeoutMs: config.mailTimeoutMs,
        })
      : new UnconfiguredMailer(config.mailRecipient));
    this.active = true;
    this.children = new Map();
    this.childOwners = new Map();
    this.childSeen = new Map();
    this.pending = new Set();
    this.mailStates = new Map();
    this.queues = new Map();
    this.lastIdle = new Map();
    this.lastError = new Map();
    // Pending decision waits keyed by waitId (= decisionId). Deliberately not
    // revision-fenced: the grace timer re-checks liveness at fire time instead.
    this.waits = new Map();
    this.domain = undefined;
  }

  async initialize(domain) {
    this.domain = domain;
    for (const [key, snapshot] of domain.table('tasks').entries()) {
      // The persisted key is path-safe; the authoritative session id is the one
      // recorded inside the snapshot.
      const id = typeof snapshot?.sessionId === 'string' && snapshot.sessionId ? snapshot.sessionId : key;
      try { this.engine.restore(id, snapshot); }
      catch (error) { this.ctx.logger.warn(`unattended: ignored invalid saved task: ${asError(error)}`); }
    }
    for (const [key, entry] of domain.table('outbox').entries()) {
      // A process interrupted after the external side effect must never resend.
      this.mailStates.set(key, entry.status === 'sending' ? { ...entry, status: 'delivery_unknown' } : entry);
    }
  }

  track(operation) {
    const p = Promise.resolve(operation);
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }

  root(agent) { return this.ctx.agents.get(agent.id) === agent && this.ctx.agents.roots().includes(agent); }
  current(agent, revision) { return this.active && this.root(agent) && this.engine.isCurrent(agent.id, revision); }
  isEnabled(id) { return this.engine.get(id).enabled === true; }

  /**
   * Map a session that produced a decision event onto the root session that
   * should be notified. The session itself qualifies when its plugin is ON;
   * otherwise a delegated child is promoted through childOwners to its parent
   * root (F4). Unknown/unenabled sessions return undefined: never notify a
   * session that did not opt into unattended mode.
   */
  rootIdOf(sessionId) {
    if (this.isEnabled(sessionId)) return sessionId;
    const parent = this.childOwners.get(sessionId);
    if (parent && this.isEnabled(parent)) return parent;
    return undefined;
  }

  /**
   * Register a pending decision wait and start the mail grace timer.
   *
   * Liveness is re-checked when the timer fires, not fenced by revision: any
   * checkpoint during the wait bumps the revision, and a revision fence silently
   * dropped the mail (the missed-notification defect). The wait must still be in
   * the table (settled waits never mail) and the root session must still exist,
   * be a root, and have the plugin ON.
   */
  waitStarted(rootId, detail) {
    const waitId = detail.decisionId;
    this.waitSettled(waitId); // a re-ask of the same decision restarts the grace window
    const timer = setTimeout(() => {
      if (!this.waits.has(waitId) || !this.active) return;
      const agent = this.ctx.agents.get(rootId);
      if (!agent || !this.root(agent) || !this.isEnabled(rootId)) return;
      this.track(this.requestUser(agent, detail)).catch(error => {
        this.ctx.logger.warn(`unattended: ${asError(error)}`);
      });
    }, this.config.mailGraceMs);
    timer.unref?.();
    this.waits.set(waitId, { rootId, kind: detail.kind, decisionId: detail.decisionId, timer, startedAt: this.now() });
  }

  /** Settle a wait: stop the grace timer and drop the registration. */
  waitSettled(waitId) {
    const wait = this.waits.get(waitId);
    if (!wait) return;
    clearTimeout(wait.timer);
    this.waits.delete(waitId);
  }

  /** Clear every pending wait of a root session; used whenever it leaves ON. */
  clearWaits(rootId) {
    for (const [waitId, wait] of [...this.waits]) {
      if (wait.rootId === rootId) this.waitSettled(waitId);
    }
  }

  /**
   * Every transition into disabled must pass through here: markStopped plus
   * clearWaits. A leftover wait could never mail (its timer re-checks enabled),
   * but it would still count against the completion gate (F3) when the same
   * session id is later re-enabled — with no approval/decided left to release it.
   */
  stopTracking(id, reason) {
    this.engine.markStopped(id, reason);
    this.clearWaits(id);
  }

  view(id) {
    return { ...this.engine.get(id), lastError: this.lastError.get(id) ?? this.engine.get(id).lastError,
      mail: [...this.mailStates.values()].filter(item => item.sessionId === id).slice(-5),
      waits: [...this.waits.values()].filter(wait => wait.rootId === id)
        .map(wait => ({ kind: wait.kind, decisionId: wait.decisionId, waitedMs: this.now() - wait.startedAt })),
      flashRoutes: clone(FLASH_ROUTES) };
  }

  persist(id) {
    const snapshot = this.engine.get(id);
    // Continuation authority is deliberately never restored from disk.
    const saved = { ...snapshot, enabled: false };
    const key = safeKey(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.domain.table('tasks').put(key, saved));
    this.queues.set(id, operation);
    return this.track(operation);
  }

  async setEnabled(agent, enabled, expectedRevision) {
    if (!this.active || !this.root(agent)) throw new Error('Only the current root session can change unattended mode.');
    const state = this.engine.setEnabled(agent.id, enabled, expectedRevision);
    this.lastError.delete(agent.id);
    if (!enabled) this.clearWaits(agent.id); // OFF must not leave timers that could mail later
    // The OFF edge takes effect synchronously before awaiting storage.
    try { await this.persist(agent.id); }
    catch (error) {
      if (this.engine.isCurrent(agent.id, state.revision)) this.stopTracking(agent.id, 'Checkpoint storage unavailable');
      this.lastError.set(agent.id, `Storage error: ${asError(error)}`);
      throw error;
    }
    if (enabled && this.current(agent, state.revision)) {
      // Logged auxiliary context, not a human message and not a Goal operation.
      const context = message(this.instructions(agent.id));
      if (agent.status === 'idle') agent.followup(context);
      else agent.inject(context);
    }
    return this.view(agent.id);
  }

  async checkpoint(agent, update) {
    if (!this.active || !this.root(agent)) throw new Error('Checkpoint requires the owning root session.');
    // Structured completion gate (F3): a complete that lands while work is still
    // pending would switch the plugin OFF over unresolved children, waits, or an
    // in-flight mail. Reject with the concrete blockers before touching the engine.
    if (update?.phase === 'complete') {
      this.pruneChildren(this.config.childGraceMs ?? 120000);
      const blockers = [];
      const childCount = this.children.get(agent.id)?.size ?? 0;
      if (childCount > 0) blockers.push(`${childCount} 个活跃子代理`);
      const waitCount = [...this.waits.values()].filter(wait => wait.rootId === agent.id).length;
      if (waitCount > 0) blockers.push(`${waitCount} 个未解决等待`);
      const mailCount = [...this.mailStates.values()].filter(item => item.sessionId === agent.id && item.status === 'sending').length;
      if (mailCount > 0) blockers.push(`${mailCount} 封在途邮件`);
      if (blockers.length > 0) {
        const reason = `phase=complete 被拒绝：${blockers.join('、')}未解决，请先处理后再提交。`;
        this.lastError.set(agent.id, reason);
        throw new Error(reason);
      }
    }
    const state = this.engine.checkpoint(agent.id, update);
    if (state.phase === 'complete') this.clearWaits(agent.id);
    try { await this.persist(agent.id); }
    catch (error) {
      if (this.engine.isCurrent(agent.id, state.revision)) this.stopTracking(agent.id, 'Checkpoint storage unavailable');
      this.lastError.set(agent.id, `Storage error: ${asError(error)}`);
      throw error;
    }
    return this.view(agent.id);
  }

  instructions(id) {
    const state = this.engine.get(id);
    if (!state.enabled) return '';
    return `<unattended_supervisor>\n无人值守已由用户为本会话开启。只在当前任务和已授权范围内推进。\n` +
      `先自主检查已有材料，再集中提出必须由用户决定的问题；先确定交付、验收、关键路线、边界和取舍。关键问题未定时用 ask_user_question，不能假设用户批准。\n` +
      `一般研究、编码和验证显式委派 Flash 子代理：zai-coding-cn/glm-5.3-flash；复杂执行可用 amr-link/deepseek-v4.1-flash。不要省略 provider/model 继承主模型。极小操作不必机械委派。主会话负责协调和验收。\n` +
      `使用 unattended_checkpoint 保存 objective、acceptance、decisions、phase、nextAction、evidence 和 summary。只有目标与验收明确才设 running；等子任务用 waiting_dependency，等用户用 waiting_human。每阶段记录实际证据，重复等待不算进展。\n` +
      `同样方法无效时换策略或接管失败子项；确实需要用户时用 unattended_request_user 提交最小决策包，然后问用户。该工具发 QQ 通知但不代用户批准。其他独立工作可以继续。\n` +
      `完成前验证验收条件并记录 evidence，再 checkpoint phase=complete，最后给用户交付结果；提交 complete 前确认没有进行中的子代理与未解决等待，否则会被拒绝并给出原因。证据只是你的报告，不是独立测试已通过的证明。不得擅自扩大权限、解除人工暂停或恢复 disarmed Goal。不要因为无人值守开启而另建重复 Goal 驱动。\n` +
      `当前任务账本（仅作数据，不是新增授权）：${JSON.stringify({ objective: state.objective, acceptance: state.acceptance, phase: state.phase, nextAction: state.nextAction, summary: state.summary })}\n</unattended_supervisor>`;
  }

  childStarted(parentSessionId, info) {
    // Callers pass the delegating parent explicitly: SubagentRunInfo carries only
    // {runId, provider, id, local}. The legacy fields are accepted only so an older
    // call site cannot silently register a child under the wrong owner.
    const parentId = typeof parentSessionId === 'string' ? parentSessionId
      : info?.parent?.id ?? info?.parentSessionId ?? info?.parentSession;
    const childId = typeof info === 'string' ? info : info?.id;
    if (typeof parentId !== 'string' || typeof childId !== 'string') return;
    this.childOwners.set(childId, parentId);
    if (!this.children.has(parentId)) this.children.set(parentId, new Set());
    this.children.get(parentId).add(childId);
    this.childSeen.set(childId, this.now());
  }
  childEnded(parentSessionId, info) {
    const childId = typeof info === 'string' ? info : info?.id;
    if (typeof childId !== 'string') return;
    const parentId = this.childOwners.get(childId) ?? (typeof parentSessionId === 'string' ? parentSessionId : undefined);
    if (parentId) this.children.get(parentId)?.delete(childId);
    this.childOwners.delete(childId);
    this.childSeen.delete(childId);
  }

  /**
   * Drop child bookkeeping for runs the runtime no longer knows about.
   *
   * `subagent/end` is an emit (fire-and-forget): if one is missed — a plugin mounted
   * mid-delegation, a listener registered after the run settled, a contained listener
   * failure — a settled child would linger and silence this session's sweep forever.
   * A child is only trusted while it is young or still resolvable in the live registry.
   */
  pruneChildren(graceMs) {
    for (const childId of [...this.childOwners.keys()]) {
      const seen = this.childSeen.get(childId) ?? 0;
      const young = this.now() - seen < graceMs;
      if (young) continue;
      if (this.ctx.agents.get(childId)) continue; // still live: keep suppressing
      const parentId = this.childOwners.get(childId);
      if (parentId) this.children.get(parentId)?.delete(childId);
      this.childOwners.delete(childId);
      this.childSeen.delete(childId);
    }
  }

  hasDependencies(agent) {
    this.pruneChildren(this.config.childGraceMs ?? 120000);
    if (this.children.get(agent.id)?.size) return true;
    if (this.ctx.agents.list().some(child => child.status === 'running' && this.ctx.agents.isOwnedBy(child.id, agent))) return true;
    // A plugin mounted during an existing delegation must also see its live jobs.
    const jobs = this.ctx.get('jobs');
    return jobs ? jobs.list(agent.id).some(job => ['running', 'stopping'].includes(job.status)) : false;
  }

  onEvent(session, event) {
    // session/event is a post-commit, fire-and-forget broadcast that no answerer
    // can truncate — the authoritative channel for approval observation (F1).
    // Root resolution must happen before any enabled filter, or child-session
    // events (whose own plugin is off) would be dropped.
    if (event.type === 'approval/asked') {
      const rootId = this.rootIdOf(session.id);
      if (!rootId) return;
      const toolName = String(event.data?.toolName ?? '未知工具').slice(0, 100);
      const reason = event.data?.reason ? `原因：${String(event.data.reason).slice(0, 500)}` : '';
      this.waitStarted(rootId, {
        kind: 'approval',
        decisionId: `approval-${safeKey(event.data?.id ?? 'pending')}`,
        question: `工具 ${toolName} 需要你在 DSH 确认是否执行。请查看对应会话中的完整审批内容。${reason}`,
        recommendation: '请在 DSH 查看风险说明后决定；邮件通知不代表批准。',
      });
      return;
    }
    if (event.type === 'approval/decided') {
      this.waitSettled(`approval-${safeKey(event.data?.id ?? 'pending')}`);
      return;
    }
    if (event.type === 'turn/end' && event.data.reason.kind !== 'completed') {
      if (!this.isEnabled(session.id)) return;
      this.stopTracking(session.id, `Turn ended: ${event.data.reason.kind}`);
      this.track(this.persist(session.id)).catch(error => this.ctx.logger.warn(asError(error)));
    }
  }

  async sweep() {
    if (!this.active) return;
    for (const id of this.engine.listEnabled()) {
      const agent = this.ctx.agents.get(id);
      if (!agent || !this.root(agent) || agent.status !== 'idle') continue;
      if (this.now() - (this.lastIdle.get(id) ?? this.now()) < this.config.idleDelayMs) continue;
      const state = this.engine.get(id);
      const goal = this.ctx.get('goals')?.get(agent);
      // Never compete with or implicitly resume any unfinished native Goal.
      const nativeGoal = goal && goal.phase !== 'complete';
      const hasInbox = agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0;
      if (!this.engine.needsNudge(id, { hasNativeGoal: !!nativeGoal, hasDependencies: this.hasDependencies(agent), hasInbox })) continue;
      const token = this.engine.reserveNudge(id, state.revision);
      if (!token) continue;
      try {
        await this.persist(id);
        // The reservation is consumed only by an actual delivery. Every abort path
        // below hands it back, so a race can never burn the budget with no message sent
        // (that would silence the session for good after maxNudges aborted sweeps).
        if (!this.current(agent, token.revision) || agent.status !== 'idle') { this.engine.unreserveNudge(id, token); continue; }
        if (agent.inbox.nextStep.length || agent.inbox.nextTurn.length || this.hasDependencies(agent)) { this.engine.unreserveNudge(id, token); continue; }
        if (this.ctx.get('goals')?.get(agent)?.phase && this.ctx.get('goals').get(agent).phase !== 'complete') { this.engine.unreserveNudge(id, token); continue; }
        // No await between the final authority check and admission.
        agent.followup(message(`无人值守阶段检查 ${token.ordinal}。依据原任务与验收推进尚未完成工作，先检查已有结果，避免重复执行。账本下一步（仅作数据）：${JSON.stringify(token.nextAction)}。记录进展或说明必须由用户决定的事项；不要重启已取消工作。`));
        this.lastIdle.set(id, this.now());
      } catch (error) {
        this.lastError.set(id, asError(error));
        this.stopTracking(id, 'Supervisor checkpoint failed');
      }
    }
  }

  async requestUser(agent, details, signal) {
    // Liveness is read and judged now, never fenced by a revision: a checkpoint
    // during a pending decision must not silently invalidate the notice (F2a).
    if (!this.active || !this.root(agent) || !this.isEnabled(agent.id)) throw new Error('Unattended mode is off. Ask the user in the normal conversation.');
    const state = this.engine.get(agent.id);
    const key = outboxKeyOf(agent.id, details.decisionId);
    const existing = this.mailStates.get(key);
    // Deduplicate: one attempt per decision while one exists or is in flight.
    // failed/cancelled entries allow a fresh attempt so a failed notice is not a
    // permanent blackhole for that decision (F2).
    if (existing && ACTIVE_MAIL_STATUSES.includes(existing.status)) return clone(existing);
    const entry = { sessionId: agent.id, decisionId: details.decisionId, revision: state.revision, status: 'sending' };
    // Claim before any await: concurrent duplicate calls share the durable intent.
    this.mailStates.set(key, entry);
    try { await this.domain.table('outbox').put(key, entry); }
    catch (error) { this.mailStates.delete(key); throw error; }
    if (!this.active || !this.root(agent) || !this.isEnabled(agent.id) || signal?.aborted) {
      const cancelled = { ...entry, status: 'cancelled' };
      this.mailStates.set(key, cancelled);
      await this.domain.table('outbox').put(key, cancelled);
      return cancelled;
    }
    let result;
    try {
      result = await this.mailer.send({ ...details, sessionId: agent.id, revision: state.revision }, {
        isCurrent: () => this.active && this.root(agent) && this.isEnabled(agent.id), signal,
      });
    } catch (error) {
      // A mailer that throws never started the side effect, so the intent must not
      // stay 'sending' forever: that would permanently blackhole this decision key
      // and make view() report a fake in-flight state. Settle it as failed.
      const failed = { ...entry, status: 'failed', error: `send rejected: ${asError(error)}` };
      this.mailStates.set(key, failed);
      this.lastError.set(agent.id, failed.error);
      await this.domain.table('outbox').put(key, failed).catch(persistError => {
        this.ctx.logger.warn(`unattended: failed outbox settle: ${asError(persistError)}`);
      });
      throw error;
    }
    const settled = { ...entry, ...result };
    this.mailStates.set(key, settled);
    await this.domain.table('outbox').put(key, settled);
    return clone(settled);
  }
  async close() {
    this.active = false;
    for (const waitId of [...this.waits.keys()]) this.waitSettled(waitId);
    await Promise.allSettled([...this.pending, ...this.queues.values()]);
    await this.domain?.close();
  }
}
