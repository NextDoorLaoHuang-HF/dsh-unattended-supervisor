// SupervisorEngine 单元测试（node:test，仅 Node 内置模块）。
// 覆盖：初始状态形状、深拷贝、ON/OFF/ON 旧 revision、乐观并发、checkpoint 校验与
// complete 自动 OFF、进展指纹与 stall 累积、needsNudge 门控、reserveNudge 围栏与
// 原子计数、markStopped 不取消任务、restore 强制 OFF 与 snapshot 污染、无限循环
// 上限、调用方突变隔离、纯 JS 静态约束。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SupervisorEngine } from '../src/engine.js';

// 统一受控时钟：每个用例自增，避免相互干扰。
let t = 1000;
const clock = () => t;
const fresh = (opts = {}) => new SupervisorEngine({ now: clock, ...opts });

const errCode = (code) => (err) => {
  assert.ok(err instanceof Error);
  assert.equal(err.code, code, `期望错误码 ${code}，实际 ${err.code}: ${err.message}`);
  return true;
};

const readyPatch = (over = {}) => ({
  objective: '目标O',
  acceptance: ['验收A'],
  phase: 'running',
  nextAction: '下一步N',
  ...over,
});

test('初始状态：惰性落地、默认 OFF、精确 14 个字段', () => {
  const e = fresh();
  const s = e.get('sess-1');
  assert.deepStrictEqual(
    { ...s, sessionId: 'sess-1', updatedAt: 1000 },
    {
      sessionId: 'sess-1',
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
      updatedAt: 1000,
    },
  );
  assert.equal(Object.keys(s).length, 14);
});

test('get 返回深拷贝：返回值突变不影响引擎，两次获取互不同引用', () => {
  const e = fresh();
  e.setEnabled('a', true);
  e.checkpoint('a', readyPatch({ acceptance: ['A1', 'A2'] }));
  const x = e.get('a');
  const y = e.get('a');
  assert.notStrictEqual(x, y);
  assert.notStrictEqual(x.acceptance, y.acceptance);
  x.enabled = true;
  x.revision = 999;
  x.nudges = 999;
  x.acceptance.push('EVIL');
  const z = e.get('a');
  assert.equal(z.enabled, true);
  assert.notEqual(z.revision, 999);
  assert.equal(z.nudges, 0);
  assert.deepEqual(z.acceptance, ['A1', 'A2']);
});

test('setEnabled：默认 OFF 起步、revision 单调递增、布尔校验、CAS 与旧 revision', () => {
  const e = fresh();
  const s1 = e.setEnabled('a', true);
  assert.equal(s1.enabled, true);
  assert.equal(s1.revision, 1);
  assert.equal(s1.updatedAt, 1000);

  // 同值再开也是一次新的控制版本提交（旧回调必须失效）
  const s2 = e.setEnabled('a', true);
  assert.equal(s2.revision, 2);

  // CAS 命中
  const s3 = e.setEnabled('a', false, 2);
  assert.equal(s3.enabled, false);
  assert.equal(s3.revision, 3);

  // CAS 过期：抛 STALE_REVISION 并记录 lastError，状态不变
  const before = e.get('a');
  assert.throws(() => e.setEnabled('a', true, 1), errCode('STALE_REVISION'));
  const after = e.get('a');
  assert.equal(after.revision, before.revision);
  assert.equal(after.enabled, before.enabled);
  assert.ok(after.lastError.includes('STALE_REVISION'));

  // 全新会话可以带 CAS=0 开启（revision 从 0 → 1）
  const s4 = e.setEnabled('fresh', true, 0);
  assert.equal(s4.revision, 1);

  // 非法入参
  assert.throws(() => e.setEnabled('a', 'yes'), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.setEnabled('a', true, 'x'), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.setEnabled('a', true, null), errCode('INVALID_ARGUMENT'));

  // ON→OFF→ON：旧 revision 全部失效
  e.setEnabled('b', true); // rev 1
  const oldRev = e.get('b').revision;
  e.setEnabled('b', false); // rev 2
  e.setEnabled('b', true); // rev 3
  assert.equal(e.isCurrent('b', oldRev), false);
  assert.equal(e.reserveNudge('b', oldRev), undefined);
  assert.equal(e.isCurrent('b', 3), true);
});

test('checkpoint：须 ON、合并语义、白名单外字段忽略、全量校验 all-or-nothing', () => {
  const e = fresh();
  // OFF 直接拒绝
  assert.throws(() => e.checkpoint('c', { objective: 'x' }), errCode('NOT_ENABLED'));
  assert.ok(e.get('c').lastError.includes('NOT_ENABLED'));

  e.setEnabled('c', true); // rev 1
  t += 1;
  const s1 = e.checkpoint('c', readyPatch({ decisions: ['D1'], evidence: ['E1'], summary: 'S1' }));
  assert.equal(s1.revision, 2); // checkpoint 也递增 revision（契约版本）
  assert.equal(s1.phase, 'running');
  assert.equal(s1.objective, '目标O');

  // 省略字段保持不变（合并语义，非整体替换）
  const s2 = e.checkpoint('c', { nextAction: 'N2' });
  assert.equal(s2.objective, '目标O');
  assert.equal(s2.nextAction, 'N2');
  assert.deepEqual(s2.acceptance, ['验收A']);
  assert.equal(s2.revision, 3);

  // 白名单外字段被忽略（含 enabled / sessionId 不能借道修改）
  const s3 = e.checkpoint('c', { enabled: false, sessionId: 'other', isAdmin: true });
  assert.equal(s3.enabled, true);
  assert.equal(s3.sessionId, 'c');
  assert.ok(!('isAdmin' in s3));

  // 校验失败：状态内容不变（lastError 除外）
  const before = e.get('c');
  assert.throws(() => e.checkpoint('c', { objective: '已改', evidence: '不是数组' }), errCode('INVALID_ARGUMENT'));
  const after = e.get('c');
  assert.equal(after.objective, before.objective);
  assert.deepEqual(after.evidence, before.evidence);
  assert.ok(after.lastError.length > 0);

  // 枚举与类型
  assert.throws(() => e.checkpoint('c', { phase: 'bogus' }), errCode('INVALID_PHASE'));
  assert.throws(() => e.checkpoint('c', { phase: 3 }), errCode('INVALID_PHASE'));
  assert.throws(() => e.checkpoint('c', { acceptance: 'A' }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.checkpoint('c', { acceptance: [1] }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.checkpoint('c', { decisions: [null] }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.checkpoint('c', { objective: 42 }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.checkpoint('c', null), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.checkpoint('c', [1]), errCode('INVALID_ARGUMENT'));

  // 上限：>20 条、单条 >2000、文本 >4000 全部拒绝
  assert.throws(
    () => e.checkpoint('c', { acceptance: Array.from({ length: 21 }, () => 'x') }),
    errCode('LIMIT_EXCEEDED'),
  );
  assert.throws(() => e.checkpoint('c', { evidence: ['x'.repeat(2001)] }), errCode('LIMIT_EXCEEDED'));
  assert.throws(() => e.checkpoint('c', { summary: 'x'.repeat(4001) }), errCode('LIMIT_EXCEEDED'));

  // 恰好达限可通过
  const ok = e.checkpoint('c', {
    acceptance: Array.from({ length: 20 }, () => 'y'.repeat(2000)),
    objective: 'z'.repeat(4000),
  });
  assert.equal(ok.acceptance.length, 20);

  // 空 patch 允许（仅作为一次契约版本提交）
  const empty = e.checkpoint('c', {});
  assert.equal(empty.revision, e.get('c').revision);
});

test('complete：必须 acceptance 与 evidence 非空、保留 summary、自动 OFF、不是取消任务', () => {
  const e = fresh();
  e.setEnabled('k', true);

  // 无 acceptance / 无 evidence 都不能 complete
  assert.throws(
    () => e.checkpoint('k', { objective: 'O', phase: 'complete', evidence: ['E'] }),
    errCode('COMPLETE_INCOMPLETE'),
  );
  e.checkpoint('k', { objective: 'O', acceptance: ['A'] });
  assert.throws(() => e.checkpoint('k', { phase: 'complete' }), errCode('COMPLETE_INCOMPLETE'));

  // 全空白条目视同空
  e.checkpoint('k', { acceptance: ['   '], evidence: ['E'] });
  assert.throws(() => e.checkpoint('k', { phase: 'complete' }), errCode('COMPLETE_INCOMPLETE'));

  // 正常完成：合并保留 acceptance/evidence/summary，自动 enabled=false
  e.checkpoint('k', { acceptance: ['A'], evidence: ['E1'], summary: '最终摘要', nextAction: '收尾', phase: 'running' });
  const done = e.checkpoint('k', { phase: 'complete' });
  assert.equal(done.enabled, false);
  assert.equal(done.phase, 'complete');
  assert.equal(done.summary, '最终摘要'); // 保留 summary
  assert.deepEqual(done.acceptance, ['A']);
  assert.deepEqual(done.evidence, ['E1']);
  assert.equal(done.objective, 'O');
  assert.equal(done.nextAction, '收尾');

  // complete 后插件侧不再接受 checkpoint（须重新 ON），但契约未被清除——不是取消任务
  assert.throws(() => e.checkpoint('k', { objective: 'x' }), errCode('NOT_ENABLED'));
  const still = e.get('k');
  assert.equal(still.objective, 'O');
  assert.deepEqual(still.evidence, ['E1']);
});

test('进展指纹：同样文本不得清零 stall，真实新内容才清零', () => {
  const e = fresh();
  e.setEnabled('w', true);
  const base = readyPatch({ nextAction: '读规范' });
  e.checkpoint('w', base);

  const rev = () => e.get('w').revision;
  let r = e.reserveNudge('w', rev()); // 首次预约有宽限
  assert.deepEqual(r, { revision: rev(), ordinal: 1, nextAction: '读规范' });
  assert.equal(e.get('w').stalls, 0);

  e.reserveNudge('w', rev());
  assert.equal(e.get('w').stalls, 1); // 无新进展 → 累积

  e.checkpoint('w', { ...base }); // 同样文本：不得清零
  assert.equal(e.get('w').stalls, 1);
  e.reserveNudge('w', rev());
  assert.equal(e.get('w').stalls, 2);

  e.checkpoint('w', { ...base }); // 依旧同样文本
  assert.equal(e.get('w').stalls, 2);

  // 换 nextAction 话术不算进展（指纹不含 nextAction）
  e.checkpoint('w', { ...base, nextAction: '继续读规范（换个说法）' });
  assert.equal(e.get('w').stalls, 2);

  // 真实新证据 → 清零
  t += 1;
  e.checkpoint('w', { ...base, evidence: ['真实新进展'] });
  assert.equal(e.get('w').stalls, 0);
  assert.equal(e.needsNudge('w'), true);
});

test('stalls 达到 maxStalls 后关闭 nudge，新进展可复活', () => {
  const e = fresh({ maxNudges: 99, maxStalls: 3 });
  e.setEnabled('b', true);
  e.checkpoint('b', readyPatch());

  let guard = 0;
  while (e.needsNudge('b') && guard < 10) {
    assert.ok(e.reserveNudge('b', e.get('b').revision));
    guard += 1;
  }
  assert.equal(guard, 4); // 1 次宽限 + 3 次 stall
  assert.equal(e.get('b').stalls, 3);
  assert.equal(e.get('b').nudges, 4);
  assert.equal(e.needsNudge('b'), false);
  assert.equal(e.reserveNudge('b', e.get('b').revision), undefined);

  // 换策略出新证据 → stalls 清零，恢复可推进
  e.checkpoint('b', { evidence: ['换策略后的成果'] });
  assert.equal(e.get('b').stalls, 0);
  assert.equal(e.needsNudge('b'), true);
});

test('needsNudge 真值表：ON + running/verifying + nextAction + 目标/验收明确 + 阈值', () => {
  const e = fresh();
  assert.equal(e.needsNudge('n'), false); // 未知会话

  e.setEnabled('n', true);
  assert.equal(e.needsNudge('n'), false); // 目标/验收缺失

  e.checkpoint('n', readyPatch());
  assert.equal(e.needsNudge('n'), true);

  // 运行环境标志：任一为真即抑制（不双投、不重复唤醒）
  assert.equal(e.needsNudge('n', { hasNativeGoal: true }), false);
  assert.equal(e.needsNudge('n', { hasDependencies: true }), false);
  assert.equal(e.needsNudge('n', { hasInbox: true }), false);
  assert.equal(e.needsNudge('n', {}), true);
  assert.equal(e.needsNudge('n'), true);

  // 非可推进阶段
  for (const ph of ['clarifying', 'waiting_dependency', 'waiting_human']) {
    e.checkpoint('n', { phase: ph });
    assert.equal(e.needsNudge('n'), false, `phase=${ph} 不应需要 nudge`);
  }
  e.checkpoint('n', { phase: 'verifying' });
  assert.equal(e.needsNudge('n'), true);

  // nextAction 空白
  e.checkpoint('n', { nextAction: '' });
  assert.equal(e.needsNudge('n'), false);

  // 验收全空白视同缺失
  e.checkpoint('n', { acceptance: [' '], phase: 'running', nextAction: 'N' });
  assert.equal(e.needsNudge('n'), false);

  // OFF
  e.checkpoint('n', { acceptance: ['A'] });
  e.setEnabled('n', false);
  assert.equal(e.needsNudge('n'), false);

  // flags 类型校验
  e.setEnabled('n', true);
  assert.throws(() => e.needsNudge('n', { hasNativeGoal: 'yes' }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.needsNudge('n', null), errCode('INVALID_ARGUMENT'));
});

test('reserveNudge：围栏、undefined 拒绝路径、ordinal 递增、同 tick 计数', () => {
  const e = fresh({ maxNudges: 3, maxStalls: 5 });
  assert.equal(e.reserveNudge('ghost', 0), undefined); // 未知会话

  e.setEnabled('r', true);
  e.checkpoint('r', readyPatch());
  const rev = e.get('r').revision;

  // 旧 revision / 篡改 revision 一律 undefined
  assert.equal(e.reserveNudge('r', rev + 1), undefined);
  assert.equal(e.reserveNudge('r', rev - 1), undefined);

  const r1 = e.reserveNudge('r', rev);
  assert.deepEqual(r1, { revision: rev, ordinal: 1, nextAction: '下一步N' });
  // 同 tick：立即读取即见 nudges 已加
  assert.equal(e.get('r').nudges, 1);

  const r2 = e.reserveNudge('r', rev);
  assert.equal(r2.ordinal, 2);
  const r3 = e.reserveNudge('r', rev);
  assert.equal(r3.ordinal, 3);

  // 达到 maxNudges=3：needsNudge 关闭、reserve 拒绝
  assert.equal(e.needsNudge('r'), false);
  assert.equal(e.reserveNudge('r', rev), undefined);
  assert.equal(e.get('r').nudges, 3); // 拒绝路径不再计数

  // 非法入参抛错
  assert.throws(() => e.reserveNudge('r'), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.reserveNudge('r', 'x'), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.reserveNudge('r', 1.5), errCode('INVALID_ARGUMENT'));
});

test('isCurrent：精确 ON 且 revision 相同', () => {
  const e = fresh();
  assert.equal(e.isCurrent('i', 0), false); // 未知会话
  e.setEnabled('i', true); // rev 1
  assert.equal(e.isCurrent('i', 1), true);
  assert.equal(e.isCurrent('i', 0), false);
  assert.equal(e.isCurrent('i', 2), false);
  assert.equal(e.isCurrent('i', '1'), false); // 类型不同的同值也拒绝
  e.setEnabled('i', false); // rev 2 → OFF
  assert.equal(e.isCurrent('i', 2), false); // OFF 不算 current
  e.setEnabled('i', true); // rev 3
  assert.equal(e.isCurrent('i', 1), false); // 旧 revision
  assert.equal(e.isCurrent('i', 3), true);
  assert.throws(() => e.isCurrent('', 1), errCode('INVALID_ARGUMENT'));
});

test('markStopped：仅插件侧 enabled=false + 停止标识，不取消任务，旧回调失效，可重新开启', () => {
  const e = fresh();
  assert.throws(() => e.markStopped('ghost', 'x'), errCode('NOT_FOUND')); // 未知会话
  assert.throws(() => e.markStopped('m'), errCode('INVALID_ARGUMENT')); // reason 必填
  assert.throws(() => e.markStopped('m', 'x'.repeat(4001)), errCode('LIMIT_EXCEEDED'));

  e.setEnabled('m', true);
  e.checkpoint('m', readyPatch({ evidence: ['E'] }));
  const revBefore = e.get('m').revision;

  const stopped = e.markStopped('m', '用户在 DSH 里停止了任务');
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.revision, revBefore + 1);
  // 不取消任务：契约与账本原样保留
  assert.equal(stopped.phase, 'running');
  assert.equal(stopped.objective, '目标O');
  assert.deepEqual(stopped.acceptance, ['验收A']);
  assert.equal(stopped.nextAction, '下一步N');
  assert.deepEqual(stopped.evidence, ['E']);

  // 旧回调全部失效
  assert.equal(e.isCurrent('m', revBefore), false);
  assert.equal(e.needsNudge('m'), false);
  assert.equal(e.reserveNudge('m', revBefore), undefined);

  // 再次开启：复用现状，不重跑不重建
  const again = e.setEnabled('m', true);
  assert.equal(again.enabled, true);
  assert.equal(again.revision, revBefore + 2);
  assert.equal(e.needsNudge('m'), true);
});

test('listEnabled：只含当前 ON 的会话，惰性会话与已停用会话不出现', () => {
  const e = fresh();
  assert.deepEqual(e.listEnabled(), []);
  e.setEnabled('a', true);
  e.setEnabled('b', true);
  e.setEnabled('c', true);
  e.setEnabled('b', false);
  assert.deepEqual([...e.listEnabled()].sort(), ['a', 'c']);
  e.get('zzz'); // 只读不开启
  e.markStopped('c', 'done');
  assert.deepEqual(e.listEnabled(), ['a']);
});

test('restore：恢复契约/账本但强制 OFF，白名单重建，revision 围栏 max+1', () => {
  const e = fresh();
  e.setEnabled('s', true);
  e.checkpoint('s', readyPatch({ decisions: ['D1'], evidence: ['E1'], summary: 'S' }));
  const live = e.get('s');

  // 构造污染快照：试图借恢复通道越权开启、注入未知字段、伪造 revision
  const snapshot = JSON.parse(JSON.stringify(live));
  snapshot.enabled = true;
  snapshot.revision = 99;
  snapshot.lastError = '伪造错误';
  snapshot.updatedAt = 42;
  snapshot.sessionId = 'other';
  snapshot.isAdmin = true;

  const restored = e.restore('s', snapshot);
  assert.equal(restored.enabled, false); // 强制 OFF
  assert.equal(restored.revision, Math.max(live.revision, 99) + 1); // 围栏前进
  assert.equal(restored.sessionId, 's'); // 以调用键为准
  assert.equal(restored.objective, '目标O');
  assert.deepEqual(restored.acceptance, ['验收A']);
  assert.equal(restored.phase, 'running');
  assert.equal(restored.nudges, 0);
  assert.equal(restored.lastError, '');
  assert.equal(Object.keys(restored).length, 14); // 精确形状，未知字段不进入
  assert.ok(!('isAdmin' in restored));

  // 旧回调全部失效；恢复态必须先重新开启
  assert.equal(e.isCurrent('s', live.revision), false);
  assert.equal(e.needsNudge('s'), false);
  assert.equal(e.reserveNudge('s', 99), undefined);
  assert.throws(() => e.checkpoint('s', { objective: 'x' }), errCode('NOT_ENABLED'));
  e.setEnabled('s', true, restored.revision);
  assert.equal(e.get('s').enabled, true);

  // 全新会话按快照 revision 前进；缺省字段回落默认
  const r2 = e.restore('new-s', { objective: 'OO', revision: 7, phase: 'verifying', nudges: 2, stalls: 1 });
  assert.equal(r2.revision, 8);
  assert.equal(r2.enabled, false);
  assert.equal(r2.phase, 'verifying');
  assert.equal(r2.nudges, 2);
  assert.equal(r2.stalls, 1);
  assert.deepEqual(r2.acceptance, []);

  // 非法快照整条拒绝
  assert.throws(() => e.restore('bad', null), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.restore('bad', 42), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.restore('bad', [1, 2]), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.restore('bad', { phase: 'nope' }), errCode('INVALID_PHASE'));
  assert.throws(() => e.restore('bad', { acceptance: [123] }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.restore('bad', { nudges: -1 }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.restore('bad', { stalls: 1.5 }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => e.restore('bad', { revision: '9' }), errCode('INVALID_ARGUMENT'));

  // 失败的恢复不影响既有状态
  const before = e.get('s');
  assert.throws(() => e.restore('s', { acceptance: [{}] }), errCode('INVALID_ARGUMENT'));
  assert.deepEqual(e.get('s'), before);

  // 原型污染防护：__proto__ 键不会被合并进任何对象
  const evil = JSON.parse('{"objective":"污染尝试","__proto__":{"polluted":1}}');
  const r3 = e.restore('evil', evil);
  assert.equal(r3.objective, '污染尝试');
  assert.equal(r3.enabled, false);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(r3), Object.prototype);
});

test('无限循环防护：无进展 4 次内断路；有进展也被 maxNudges 硬上限封顶', () => {
  const e = fresh({ maxNudges: 12, maxStalls: 3 });

  // 场景一：同一文本反复空转
  e.setEnabled('loop', true);
  e.checkpoint('loop', readyPatch());
  let submits = 0;
  for (let i = 0; i < 1000; i += 1) {
    if (!e.needsNudge('loop')) break;
    const r = e.reserveNudge('loop', e.get('loop').revision);
    if (!r) break;
    submits += 1;
    e.checkpoint('loop', { nextAction: '说下一句但无实际进展' }); // 只有话术，无新证据
  }
  assert.ok(submits <= 4, `无进展空转应在 4 次内断路，实际 ${submits}`);
  assert.equal(e.get('loop').stalls, 3);
  assert.equal(e.needsNudge('loop'), false);

  // 场景二：每轮都伪造“新证据”，也逃不出 maxNudges 总上限
  e.setEnabled('cap', true);
  e.checkpoint('cap', readyPatch());
  let count = 0;
  for (let i = 0; i < 100; i += 1) {
    if (!e.needsNudge('cap')) break;
    const r = e.reserveNudge('cap', e.get('cap').revision);
    if (!r) break;
    count += 1;
    e.checkpoint('cap', { evidence: [`p${i}`] });
  }
  assert.equal(count, 12);
  assert.equal(e.get('cap').nudges, 12);
  assert.equal(e.get('cap').stalls, 0);
  assert.equal(e.needsNudge('cap'), false);
  assert.equal(e.reserveNudge('cap', e.get('cap').revision), undefined);
});

test('调用方突变隔离：patch / snapshot / 返回值都不泄漏进引擎', () => {
  const e = fresh();
  e.setEnabled('mu', true);
  const patch = { objective: 'O', acceptance: ['A'], evidence: ['E'], decisions: ['D'] };
  e.checkpoint('mu', patch);
  patch.acceptance.push('EVIL');
  patch.evidence[0] = 'EVIL';
  patch.decisions.push('EVIL');
  patch.objective = 'EVIL';
  const s = e.get('mu');
  assert.deepEqual(s.acceptance, ['A']);
  assert.deepEqual(s.evidence, ['E']);
  assert.deepEqual(s.decisions, ['D']);
  assert.equal(s.objective, 'O');

  s.enabled = false;
  s.revision = 999;
  s.nudges = 999;
  s.phase = 'complete';
  s.acceptance.push('X');
  assert.equal(e.get('mu').enabled, true); // 引擎内部仍保持开启时的真实状态
  assert.equal(e.get('mu').revision, 2);
  assert.equal(e.get('mu').phase, 'clarifying'); // 本用例 patch 未带 phase，保持默认
  assert.equal(e.get('mu').nudges, 0);
  assert.deepEqual(e.get('mu').acceptance, ['A']);

  const snap = { objective: 'S', acceptance: ['A'] };
  e.restore('mu2', snap);
  snap.acceptance.push('EVIL');
  snap.objective = 'EVIL';
  assert.deepEqual(e.get('mu2').acceptance, ['A']);
  assert.equal(e.get('mu2').objective, 'S');
});

test('只读操作零副作用：get/needsNudge/isCurrent 不推进 revision/updatedAt', () => {
  const e = fresh();
  e.setEnabled('x', true);
  e.checkpoint('x', readyPatch());
  const before = e.get('x');
  assert.equal(e.isCurrent('x', before.revision), true);
  assert.equal(e.needsNudge('x'), true);
  e.get('x');
  e.get('x');
  assert.deepEqual(e.get('x'), before);
});

test('时钟注入与 JSON 纯净性', () => {
  let local = 10;
  const e = new SupervisorEngine({ now: () => local });
  assert.equal(e.get('k').updatedAt, 10);
  local = 20;
  e.setEnabled('k', true);
  assert.equal(e.get('k').updatedAt, 20);
  local = 30;
  e.checkpoint('k', { objective: 'O' });
  assert.equal(e.get('k').updatedAt, 30);
  const s = e.get('k');
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s); // 状态可无损 JSON 序列化
});

test('构造参数校验与多实例隔离', () => {
  assert.throws(() => new SupervisorEngine({ maxNudges: 0 }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => new SupervisorEngine({ maxNudges: 1.5 }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => new SupervisorEngine({ maxStalls: -1 }), errCode('INVALID_ARGUMENT'));
  assert.throws(() => new SupervisorEngine({ now: 'x' }), errCode('INVALID_ARGUMENT'));
  const a = new SupervisorEngine();
  const b = new SupervisorEngine();
  a.setEnabled('only-a', true);
  assert.deepEqual(a.listEnabled(), ['only-a']);
  assert.deepEqual(b.listEnabled(), []);
  assert.equal(b.needsNudge('only-a'), false);
});

test('静态约束：engine.js 零模块引用、零 I/O、零定时器、纯数据引擎', () => {
  const raw = readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
  // 去掉注释后检查代码本体（注释里讨论 DSH 边界不算引用）
  const src = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/(^|\n)\s*(import|export\s+default)[\s(]/.test(src), 'engine.js 不得有模块引用语句');
  assert.ok(!/\brequire\s*\(/.test(src), 'engine.js 不得有模块引用调用');
  assert.ok(!/\b(fetch|setTimeout|setInterval|setImmediate)\s*\(/.test(src), 'engine.js 不得有 I/O 或定时器');
  assert.ok(!/\bprocess\./.test(src), 'engine.js 不得触碰进程环境');
  assert.ok(!/@deepseek-ai/.test(src), 'engine.js 不得依赖 DSH 包');
  assert.ok(
    !/\bgoals?\s*\.\s*(resume|pause|update|create|arm|disarm)/.test(src),
    'engine.js 不得调用 Goal 服务',
  );
  assert.ok(!/\b(mail|agently|smtp)\b/i.test(src), 'engine.js 不得涉及邮件通道');
});
