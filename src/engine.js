// dsh-unattended-supervisor · 独立纯 JS 监督状态引擎（standalone state engine）。
//
// 设计边界（对应 07.misc/dsh-unattended-plugin-plan_20261016.md 第一节）：
// - 零依赖、零 I/O、零定时器：本文件不引入任何模块，不触碰 DSH API，不发邮件，
//   不取消/暂停任何任务，不调用 Goal。它只维护插件自己的会话级状态。
// - enabled 只是“无人值守插件额外行为”的门禁：OFF、markStopped、complete 自动 OFF
//   都只停用插件侧的额外推进与待发动作，绝不代表取消或终止任务本身；
//   契约/账本字段（objective/acceptance/nextAction 等）在这些转换中原样保留。
// - revision 是模式与契约的控制版本（乐观并发围栏）：setEnabled、checkpoint、
//   restore、markStopped 都使其递增；旧回调凭旧 revision 调 reserveNudge /
//   isCurrent 一律得到负结果，满足“关闭后旧回调不得新增插件自主动作”。
// - 进展指纹（progress fingerprint）是契约/账本内容的确定性摘要（不含时间戳）：
//   仅当内容出现真实变化才把 stalls 清零；重复提交同样文本不得清零 stall。
// - reserveNudge 在同一次同步调用内原子完成：nudges +1，并对“距上次派发无新进展”
//   累积 stalls（首次派发有宽限，不计 stall）。
// - 所有对外返回的状态都是深拷贝；所有输入（patch/snapshot）在写入时校验并拷贝，
//   调用方随后突变其入参或返回值都不影响引擎内部状态。
// - restore 只认白名单字段并强制 OFF：snapshot 中的 enabled/revision/未知字段
//   一律不信任，防 snapshot 输入污染（含 __proto__ 之类键——本引擎按白名单重建
//   状态对象，不从 snapshot 批量合并）。

const PHASES = [
  'clarifying',
  'running',
  'waiting_dependency',
  'waiting_human',
  'verifying',
  'complete',
];

const NUDGEABLE_PHASES = ['running', 'verifying'];

const MAX_ARRAY_ITEMS = 20; // acceptance/decisions/evidence 条数上限
const MAX_ITEM_LENGTH = 2000; // 数组每条字符串上限
const MAX_TEXT_LENGTH = 4000; // 文本字段上限（objective/nextAction/summary/reason）

/** 引擎错误：code 供调用方精确分支，message 面向日志。 */
export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EngineError(code, message);
}

function assertSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_ARGUMENT', 'sessionId 必须是非空字符串');
  }
  return value;
}

function assertText(value, name, limit = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') {
    fail('INVALID_ARGUMENT', `${name} 必须是字符串`);
  }
  if (value.length > limit) {
    fail('LIMIT_EXCEEDED', `${name} 最多 ${limit} 字符`);
  }
  return value;
}

function assertStringArray(value, name) {
  if (!Array.isArray(value)) {
    fail('INVALID_ARGUMENT', `${name} 必须是字符串数组`);
  }
  if (value.length > MAX_ARRAY_ITEMS) {
    fail('LIMIT_EXCEEDED', `${name} 最多 ${MAX_ARRAY_ITEMS} 条`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      fail('INVALID_ARGUMENT', `${name} 的每一项都必须是字符串`);
    }
    if (item.length > MAX_ITEM_LENGTH) {
      fail('LIMIT_EXCEEDED', `${name} 每条最多 ${MAX_ITEM_LENGTH} 字符`);
    }
  }
  return value.slice(); // 拷贝，隔离调用方突变
}

function assertPhase(value) {
  if (typeof value !== 'string' || !PHASES.includes(value)) {
    fail('INVALID_PHASE', `phase 必须是 ${PHASES.join('/')} 之一`);
  }
  return value;
}

function assertCounter(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_ARGUMENT', `${name} 必须是非负安全整数`);
  }
  return value;
}

function hasMeaningfulEntry(list) {
  return list.some((item) => item.trim() !== '');
}

// 稳定进展指纹：对契约/账本内容做 FNV-1a 确定性摘要。
// 刻意排除 nextAction 与 phase——“说下一步要做什么/换阶段话术”不算进展，
// 只有目标、验收、决定、证据、摘要的实际内容变化才算（对应“重复读取/相同
// 报错/等待话术不计进展”）。
function fingerprintOf(state) {
  const basis = JSON.stringify([
    state.objective,
    state.acceptance,
    state.decisions,
    state.evidence,
    state.summary,
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class SupervisorEngine {
  #sessions = new Map();
  #maxNudges;
  #maxStalls;
  #now;

  constructor({ maxNudges = 12, maxStalls = 3, now = Date.now } = {}) {
    if (!Number.isSafeInteger(maxNudges) || maxNudges < 1) {
      fail('INVALID_ARGUMENT', 'maxNudges 必须是正整数');
    }
    if (!Number.isSafeInteger(maxStalls) || maxStalls < 1) {
      fail('INVALID_ARGUMENT', 'maxStalls 必须是正整数');
    }
    if (typeof now !== 'function') {
      fail('INVALID_ARGUMENT', 'now 必须是函数');
    }
    this.#maxNudges = maxNudges;
    this.#maxStalls = maxStalls;
    this.#now = now;
  }

  // ---- 内部 ---------------------------------------------------------------

  // 惰性创建：任何会话首次被触及时都以文档规定的初始状态（默认 OFF）落地。
  #record(sessionId) {
    let rec = this.#sessions.get(sessionId);
    if (!rec) {
      const state = {
        sessionId,
        enabled: false,
        revision: 0,
        phase: 'clarifying',
        objective: '',
        acceptance: [],
        decisions: [],
        nextAction: '',
        evidence: [],
        summary: '',
        nudges: 0,
        stalls: 0,
        lastError: '',
        updatedAt: this.#now(),
      };
      rec = {
        state,
        meta: {
          progressFingerprint: fingerprintOf(state),
          lastNudgeFingerprint: null,
          stoppedReason: '',
        },
      };
      this.#sessions.set(sessionId, rec);
    }
    return rec;
  }

  #recordError(rec, code, message) {
    rec.state.lastError = `${code}: ${message}`.slice(0, MAX_TEXT_LENGTH);
    rec.state.updatedAt = this.#now();
  }

  #nudgeGateBlocks(rec) {
    const s = rec.state;
    return (
      !s.enabled ||
      !NUDGEABLE_PHASES.includes(s.phase) ||
      s.nextAction.trim() === '' ||
      s.objective.trim() === '' ||
      !hasMeaningfulEntry(s.acceptance) ||
      s.nudges >= this.#maxNudges ||
      s.stalls >= this.#maxStalls
    );
  }

  // ---- 查询 ---------------------------------------------------------------

  /** 返回会话状态的深拷贝（未知会话按初始状态惰性落地，默认 OFF）。 */
  get(sessionId) {
    assertSessionId(sessionId);
    const rec = this.#record(sessionId);
    return structuredClone(rec.state);
  }

  /**
   * 无人值守开关（会话级）。只改插件侧门禁并递增 revision，不触及任何外部任务。
   * expectedRevision 提供时做乐观并发校验，过期则抛 STALE_REVISION（记录 lastError）。
   */
  setEnabled(sessionId, enabled, expectedRevision) {
    assertSessionId(sessionId);
    if (typeof enabled !== 'boolean') {
      fail('INVALID_ARGUMENT', 'enabled 必须是布尔值');
    }
    const rec = this.#record(sessionId);
    if (expectedRevision !== undefined) {
      if (!Number.isSafeInteger(expectedRevision)) {
        fail('INVALID_ARGUMENT', 'expectedRevision 必须是安全整数');
      }
      if (rec.state.revision !== expectedRevision) {
        const message = `revision 已前进：期望 ${expectedRevision}，当前 ${rec.state.revision}`;
        this.#recordError(rec, 'STALE_REVISION', message);
        fail('STALE_REVISION', message);
      }
    }
    rec.state.enabled = enabled;
    rec.state.revision += 1;
    rec.state.updatedAt = this.#now();
    // A successful mode change clears the previous failure: a stale error must not
    // outlive the state it described (it would otherwise sit in the composer forever).
    rec.state.lastError = '';
    if (enabled) {
      rec.meta.stoppedReason = ''; // 重新开启即开始新的监督区间
    }
    return structuredClone(rec.state);
  }

  /**
   * 从快照恢复契约/账本，但强制 OFF（重新开启需显式 setEnabled）。
   * 只认白名单字段；enabled、lastError、updatedAt、sessionId 与一切未知字段
   * 一律忽略；revision 取 max(引擎当前, 快照) + 1，让旧回调全部失效。
   * 校验失败整条拒绝（all-or-nothing），不半套用脏数据。
   */
  restore(sessionId, snapshot) {
    assertSessionId(sessionId);
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      fail('INVALID_ARGUMENT', 'snapshot 必须是普通对象');
    }
    const prev = this.#sessions.get(sessionId);
    const prevRevision = prev ? prev.state.revision : 0;
    let snapRevision = 0;
    if (snapshot.revision !== undefined) {
      snapRevision = assertCounter(snapshot.revision, 'snapshot.revision');
    }

    let phase = 'clarifying';
    if (snapshot.phase !== undefined) phase = assertPhase(snapshot.phase);
    let objective = '';
    if (snapshot.objective !== undefined) objective = assertText(snapshot.objective, 'snapshot.objective');
    let nextAction = '';
    if (snapshot.nextAction !== undefined) nextAction = assertText(snapshot.nextAction, 'snapshot.nextAction');
    let summary = '';
    if (snapshot.summary !== undefined) summary = assertText(snapshot.summary, 'snapshot.summary');
    let acceptance = [];
    if (snapshot.acceptance !== undefined) acceptance = assertStringArray(snapshot.acceptance, 'snapshot.acceptance');
    let decisions = [];
    if (snapshot.decisions !== undefined) decisions = assertStringArray(snapshot.decisions, 'snapshot.decisions');
    let evidence = [];
    if (snapshot.evidence !== undefined) evidence = assertStringArray(snapshot.evidence, 'snapshot.evidence');
    let nudges = 0;
    if (snapshot.nudges !== undefined) nudges = assertCounter(snapshot.nudges, 'snapshot.nudges');
    let stalls = 0;
    if (snapshot.stalls !== undefined) stalls = assertCounter(snapshot.stalls, 'snapshot.stalls');

    const state = {
      sessionId, // 以调用键为准，不信任 snapshot.sessionId
      enabled: false, // 恢复后强制 OFF
      revision: Math.max(prevRevision, snapRevision) + 1,
      phase,
      objective,
      acceptance,
      decisions,
      nextAction,
      evidence,
      summary,
      nudges,
      stalls,
      lastError: '',
      updatedAt: this.#now(),
    };
    this.#sessions.set(sessionId, {
      state,
      meta: {
        progressFingerprint: fingerprintOf(state),
        lastNudgeFingerprint: null,
        stoppedReason: '',
      },
    });
    return structuredClone(state);
  }

  /**
   * 检查点：仅 ON 会话可用。patch 字段全部可选、按合并语义覆盖（数组整体替换）。
   * phase=complete 要求合并后 acceptance 与 evidence 都有实际内容，并保留 summary；
   * 提交后自动 enabled=false——这是插件侧收尾，不是取消任务。
   * 成功提交递增 revision；仅当进展指纹变化（真实新进展）时才把 stalls 清零。
   */
  checkpoint(sessionId, patch = {}) {
    assertSessionId(sessionId);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      fail('INVALID_ARGUMENT', 'checkpoint patch 必须是普通对象');
    }
    const rec = this.#record(sessionId);
    if (!rec.state.enabled) {
      const message = 'checkpoint 需要该会话处于 ON（enabled=true）';
      this.#recordError(rec, 'NOT_ENABLED', message);
      fail('NOT_ENABLED', message);
    }
    try {
      return this.#applyCheckpoint(rec, patch);
    } catch (err) {
      if (err instanceof EngineError) {
        this.#recordError(rec, err.code, err.message);
      }
      throw err;
    }
  }

  #applyCheckpoint(rec, patch) {
    const s = rec.state;
    const next = {
      phase: s.phase,
      objective: s.objective,
      acceptance: s.acceptance,
      decisions: s.decisions,
      nextAction: s.nextAction,
      evidence: s.evidence,
      summary: s.summary,
    };
    if (patch.phase !== undefined) next.phase = assertPhase(patch.phase);
    if (patch.objective !== undefined) next.objective = assertText(patch.objective, 'objective');
    if (patch.nextAction !== undefined) next.nextAction = assertText(patch.nextAction, 'nextAction');
    if (patch.summary !== undefined) next.summary = assertText(patch.summary, 'summary');
    if (patch.acceptance !== undefined) next.acceptance = assertStringArray(patch.acceptance, 'acceptance');
    if (patch.decisions !== undefined) next.decisions = assertStringArray(patch.decisions, 'decisions');
    if (patch.evidence !== undefined) next.evidence = assertStringArray(patch.evidence, 'evidence');
    // 白名单之外的字段（含 enabled/sessionId）一律忽略，防止借 checkpoint 越权改模式。

    if (next.phase === 'complete') {
      if (!hasMeaningfulEntry(next.acceptance)) {
        fail('COMPLETE_INCOMPLETE', 'phase=complete 要求 acceptance 至少有一条实际内容');
      }
      if (!hasMeaningfulEntry(next.evidence)) {
        fail('COMPLETE_INCOMPLETE', 'phase=complete 要求 evidence 至少有一条实际内容');
      }
    }

    // 全部校验通过后才提交（all-or-nothing）。
    s.phase = next.phase;
    s.objective = next.objective;
    s.acceptance = next.acceptance;
    s.decisions = next.decisions;
    s.nextAction = next.nextAction;
    s.evidence = next.evidence;
    s.summary = next.summary; // complete 同样保留 summary
    s.revision += 1;
    s.updatedAt = this.#now();
    s.lastError = ''; // a committed checkpoint supersedes the previous failure
    if (next.phase === 'complete') {
      // 验收通过自动关闭插件侧监督：只是本插件的收尾门禁，不是取消任务，
      // 契约与账本（含 summary）原样保留，供交付对账与人工复核。
      s.enabled = false;
    }

    const fp = fingerprintOf(s);
    if (fp !== rec.meta.progressFingerprint) {
      rec.meta.progressFingerprint = fp;
      s.stalls = 0; // 出现真实新进展才允许清零；同样文本不清零
    }
    return structuredClone(s);
  }

  /**
   * 是否需要插件补发一次推进（纯读，无副作用）。
   * 仅当：ON + phase ∈ {running, verifying} + nextAction 非空 + 目标/验收明确
   * + nudges 未达 maxNudges + stalls 未达 maxStalls。
   * hasNativeGoal/hasDependencies/hasInbox 任一为真即返回 false：
   * 原生 Goal 续跑、活跃依赖、已有 inbox 待办时不追加，避免双投/重复唤醒。
   */
  needsNudge(sessionId, flags = {}) {
    assertSessionId(sessionId);
    if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) {
      fail('INVALID_ARGUMENT', 'flags 必须是普通对象');
    }
    const hasNativeGoal = flags.hasNativeGoal ?? false;
    const hasDependencies = flags.hasDependencies ?? false;
    const hasInbox = flags.hasInbox ?? false;
    if (
      typeof hasNativeGoal !== 'boolean' ||
      typeof hasDependencies !== 'boolean' ||
      typeof hasInbox !== 'boolean'
    ) {
      fail('INVALID_ARGUMENT', 'flags.hasNativeGoal/hasDependencies/hasInbox 必须是布尔值');
    }
    const rec = this.#sessions.get(sessionId);
    if (!rec) return false;
    if (hasNativeGoal || hasDependencies || hasInbox) return false;
    return !this.#nudgeGateBlocks(rec);
  }

  /**
   * 预约一次推进：返回 { revision, ordinal, nextAction }，拒绝时返回 undefined。
   * 同一次同步调用内原子完成：nudges +1；若距上次预约没有任何新进展
   * （进展指纹未变）则 stalls +1。expectedRevision 不匹配（含 OFF 后重新 ON 的旧
   * revision）一律 undefined，保证旧回调不得重复派活。
   */
  reserveNudge(sessionId, expectedRevision) {
    assertSessionId(sessionId);
    if (!Number.isSafeInteger(expectedRevision)) {
      fail('INVALID_ARGUMENT', 'expectedRevision 必须是安全整数');
    }
    const rec = this.#sessions.get(sessionId);
    if (!rec) return undefined;
    if (rec.state.revision !== expectedRevision) return undefined;
    if (this.#nudgeGateBlocks(rec)) return undefined;

    const s = rec.state;
    const meta = rec.meta;
    s.nudges += 1;
    const ordinal = s.nudges;
    if (meta.lastNudgeFingerprint === meta.progressFingerprint) {
      s.stalls += 1; // 无新进展：累积 stall
    }
    meta.lastNudgeFingerprint = meta.progressFingerprint;
    s.updatedAt = this.#now();
    return { revision: s.revision, ordinal, nextAction: s.nextAction };
  }

  /**
   * 撤销一次未被实际使用的预约（reserveNudge 之后、真正投递之前放弃了）。
   *
   * 场景：预约成功、await 落盘期间用户开始输入或提交了 checkpoint，调用方在投递前
   * 复查发现应放弃——但预算已被计入。若不回滚，反复竞态会在一条消息都没发出的
   * 情况下耗尽 maxNudges，把会话永久静音。
   *
   * 仅在 revision 未变（期间无其他状态转换）且该 ordinal 仍是最后一次预约时回滚，
   * 保证不会误撤销别人的合法预约。stalls 一并回滚。返回是否真的撤销。
   */
  unreserveNudge(sessionId, token) {
    assertSessionId(sessionId);
    if (token === null || typeof token !== 'object') {
      fail('INVALID_ARGUMENT', 'token 必须是 reserveNudge 的返回值');
    }
    const rec = this.#sessions.get(sessionId);
    if (!rec) return false;
    const s = rec.state;
    if (s.revision !== token.revision) return false; // 期间有别的状态转换：不冒撤销风险
    if (s.nudges !== token.ordinal) return false; // 不是最后一次预约：另有派发在进行
    s.nudges = Math.max(0, s.nudges - 1);
    if (s.stalls > 0 && rec.meta.lastNudgeFingerprint === rec.meta.progressFingerprint) {
      // 该次预约是在“无新进展”前提下累加过 stall 的；把计数与指针一并还原。
      s.stalls -= 1;
    }
    s.updatedAt = this.#now();
    return true;
  }

  /** 精确围栏：仅当会话当前 ON 且 revision 与调用方持有的完全一致才为 true。 */
  isCurrent(sessionId, revision) {
    assertSessionId(sessionId);
    const rec = this.#sessions.get(sessionId);
    if (!rec) return false;
    return rec.state.enabled === true && rec.state.revision === revision;
  }

  /**
   * 标记任务已停止：只把插件侧 enabled 置为 OFF 并记录停止原因（插件自己的
   * 标识，不对外冒充任务状态）；契约、账本、phase 一概不动，不取消任务。
   * 停止任务本身应使用 DSH 现有“停止”，与本开关生命周期分离。
   */
  markStopped(sessionId, reason) {
    assertSessionId(sessionId);
    assertText(reason, 'reason');
    const rec = this.#sessions.get(sessionId);
    if (!rec) {
      fail('NOT_FOUND', `未知会话：${sessionId}`);
    }
    rec.state.enabled = false;
    rec.state.revision += 1;
    rec.state.updatedAt = this.#now();
    rec.meta.stoppedReason = reason;
    return structuredClone(rec.state);
  }

  /** 当前 ON 的会话 id 列表（惰性落地但从未开启的会话不会出现）。 */
  listEnabled() {
    const ids = [];
    for (const rec of this.#sessions.values()) {
      if (rec.state.enabled) ids.push(rec.state.sessionId);
    }
    return ids;
  }
}
