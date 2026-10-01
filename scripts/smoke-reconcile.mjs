// 对账引擎冒烟测试：用内存 localStorage 跑通
// 提交 → 中断 → 重试去重 → 快照对账 → 待裁 / 留待处理 的完整链路。
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

const service = await import('../src/utils/catalogService.ts');
const reconcile = await import('../src/utils/reconcile.ts');
const { seedState } = await import('../src/data/seed.ts');

const state = seedState();
// 构造一次本机合并：a-001 + b-001 → 合并记录保留 a-001，编号取 A，权利取 B
const left = state.records.find((r) => r.id === 'a-001');
const right = state.records.find((r) => r.id === 'b-001');
const commit = (action, detail, recordIds = [], channel = 'local', after) => {
  state.revision += 1;
  state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds, revision: state.revision, channel, after });
};
state.records = state.records.filter((r) => r.id !== 'b-001');
left.rights = right.rights;
left.status = 'merged';
state.merges.unshift({
  id: 'm-1', matchId: 'x', leftId: 'a-001', rightId: 'b-001',
  chosen: { rights: 'B' }, values: { identifier: left.identifier, rights: right.rights }, mergedAt: new Date().toISOString()
});
commit('合并两条记录', '测试合并', ['a-001', 'b-001', 'a-001']);
commit('确认匹配', '测试确认', ['a-002', 'b-002']);

service.ensureCatalog(state.records);
reconcile.ensureBaseSnapshot(state); // 开工时登记目录基准快照

// 本机也改了 a-002 的编号（例如合并时选择了另一来源），与目录离线修订撞车
state.records.find((r) => r.id === 'a-002').identifier = 'MS-WDH-2017-LOCAL';

// ① 目录离线修订：重编号、改权利、移除一条已合并记录
const notes = service.simulateOfflineRevision(state.records, ['a-001', 'b-001']);
assert.ok(notes.length >= 3, `离线修订应产生 ≥3 条说明，实际 ${notes.length}`);
console.log('离线修订:', notes.join(' | '));

// ② 同步：圈定本机变更
const added = reconcile.buildOutbox(state);
assert.equal(added, 2, `应入箱 2 条变更，实际 ${added}`);
let queue = state.catalog.outbox.filter((i) => i.status !== 'acked');
assert.equal(queue.length, 2);

// ③ 发送中断：第一条在“写入落库、回执未送达”处断开
const first = queue[0];
assert.throws(() => service.pushChange(first, true), service.SyncInterruptedError);
assert.equal(first.status, 'pending', '中断后条目仍为待发送');
// 重试同一批：目录侧幂等去重，返回同一回执，不重复写入
const retry = service.pushChange(first, false);
assert.equal(retry.duplicate, true, '重试应被目录侧去重');
const logAfterRetry = service.serviceLog().filter((l) => l.includes(first.id.slice(0, 8)));
assert.equal(logAfterRetry.length, 1, `同一变更只应写入一次，实际日志 ${logAfterRetry.length} 条`);
first.status = 'acked'; first.receipt = retry.receipt; first.deduped = true;
// 第二条正常发送
const second = queue[1];
const ok = service.pushChange(second, false);
assert.equal(ok.duplicate, false);
second.status = 'acked'; second.receipt = ok.receipt;
console.log('回执:', first.receipt, '(去重) /', second.receipt);

// ④ 取快照对账
const snapshot = service.fetchSnapshot();
const report = reconcile.reconcileSnapshot(state, snapshot);
reconcile.settleOutbox(state); // 同步结束，水位对齐（与 runSync 内顺序一致）
console.log('对账报告:', JSON.stringify({ applied: report.applied, conflicts: report.conflicts, removedMerged: report.removedMerged }));
assert.ok(report.applied >= 2, `仅目录侧修改的字段应自动应用（≥2），实际 ${report.applied}`);
assert.ok(report.conflicts >= 1, '双方改同一字段应产生待裁项');
assert.ok(report.removedMerged >= 1, '目录移除已合并记录应留待处理');
const conflict = state.catalog.conflicts.find((c) => c.status === 'pending');
assert.ok(conflict && conflict.baseValue !== conflict.catalogValue, '待裁项应带基准值与目录值');
assert.equal(conflict.recordId, 'a-002', '待裁项应来自双方均修改编号的 a-002');
const removed = state.catalog.removedMerged.find((i) => i.status === 'pending');
assert.ok(removed, '应有留待处理项');

// ⑤ 裁决：保留本机 → 生成断言变更；采用目录 → 直接更新
const before = state.revision;
commit('对账裁决', '保留本机编号', [conflict.recordId], 'local', JSON.stringify({ kind: 'assert', recordId: conflict.recordId, field: conflict.field, value: conflict.localValue }));
conflict.status = 'resolved'; conflict.resolution = 'local';
const added2 = reconcile.buildOutbox(state);
assert.equal(added2, 1, `裁决后应新入箱 1 条断言，实际 ${added2}`);
const assertItem = state.catalog.outbox.find((i) => i.kind === 'assert' && i.status !== 'acked');
const assertResult = service.pushChange(assertItem, false);
assert.equal(assertResult.duplicate, false);
assertItem.status = 'acked'; assertItem.receipt = assertResult.receipt;
assert.ok(state.revision > before);

// 留待处理：保留合并结果（存活断言）
commit('对账裁决', '保留合并结果', [removed.recordId], 'local', JSON.stringify({ kind: 'assert', recordId: removed.recordId, field: 'alive', value: 'true' }));
removed.status = 'kept';
reconcile.buildOutbox(state);
const aliveItem = state.catalog.outbox.find((i) => i.kind === 'assert' && i.status !== 'acked');
const aliveResult = service.pushChange(aliveItem, false);
aliveItem.status = 'acked'; aliveItem.receipt = aliveResult.receipt;
const snap2 = service.fetchSnapshot();
const revived = snap2.entries.find((e) => e.recordId === removed.recordId);
assert.equal(revived.alive, true, '保留合并结果后目录应恢复存活');

// ⑥ 再次对账应收敛：无新待裁、无新留待
const report2 = reconcile.reconcileSnapshot(state, service.fetchSnapshot());
assert.equal(report2.conflicts, 0, `二次对账不应再有待裁，实际 ${report2.conflicts}`);
assert.equal(report2.removedMerged, 0, `二次对账不应再有留待，实际 ${report2.removedMerged}`);

// ⑦ 导出
const exported = reconcile.exportReconciliation(state, service.serviceLog());
assert.ok(exported.receipts.length >= 2, '导出应包含成功回执');
assert.ok(exported.catalogWriteLog.length > 0, '导出应包含目录写入日志');

console.log('✓ 全部冒烟断言通过');
