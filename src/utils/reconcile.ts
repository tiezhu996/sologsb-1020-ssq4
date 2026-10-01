import type {
  ArchiveState,
  CatalogField,
  CatalogSnapshot,
  CatalogSyncState,
  OutboxItem,
  ReconcileReport
} from '../types';
import { ackFields, fetchSnapshot } from './catalogService';

/**
 * 目录快照对账。
 *
 * 所有权划分：目录管编号、权利和记录存活；本机管匹配结论、字段选择和审计轨迹。
 * 同步顺序固定为“先提交上次版本后的本机变更，再取新快照对账”，
 * 对账以“上次同步快照 / 本机当前值 / 目录新快照”三方比较：
 * 双方改了同一字段 → 待裁项；目录移除而本机已合并 → 留待处理。
 */

export const emptyCatalogState = (): CatalogSyncState => ({
  lastVersion: 0,
  lastSyncedRevision: 0,
  baseEntries: [],
  outbox: [],
  conflicts: [],
  removedMerged: [],
  reports: []
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * 核对台开工时把目录当前快照登记为对账基准（三方对账的“上次同步版本”）。
 * 没有基准时，目录侧任何修订都会被误判成双方同时修改。
 */
export const ensureBaseSnapshot = (state: ArchiveState) => {
  if (state.catalog.baseEntries.length) return;
  const snapshot = fetchSnapshot();
  state.catalog.baseEntries = clone(snapshot.entries);
  state.catalog.lastVersion = snapshot.version;
};

/** 需要提交给目录的本机动作（对账系统条目不在其列）。 */
const OUTBOX_ACTIONS = new Set(['确认匹配', '忽略可疑匹配', '批量复核', '合并两条记录', '对账裁决']);

const toOutboxItem = (state: ArchiveState, entryId: string): OutboxItem | null => {
  const entry = state.audit.find((item) => item.id === entryId);
  if (!entry) return null;
  const base = { id: entry.id, revision: entry.revision, summary: entry.detail, status: 'pending' as const, attempts: 0 };

  if (entry.action === '确认匹配' || entry.action === '忽略可疑匹配') {
    const match = state.matches.find((item) => item.leftId === entry.recordIds[0] && item.rightId === entry.recordIds[1]);
    return {
      ...base,
      kind: 'match',
      payload: JSON.stringify({
        kind: 'match',
        matchId: match?.id ?? '',
        leftId: entry.recordIds[0],
        rightId: entry.recordIds[1],
        status: entry.action === '确认匹配' ? 'confirmed' : 'rejected',
        reviewedAt: entry.at
      })
    };
  }
  if (entry.action === '批量复核') {
    return { ...base, kind: 'batch-review', payload: JSON.stringify({ kind: 'batch-review', recordIds: entry.recordIds, detail: entry.detail }) };
  }
  if (entry.action === '合并两条记录') {
    const [leftId, rightId, mergedId] = entry.recordIds;
    const merge = state.merges.find((item) => item.leftId === leftId && item.rightId === rightId);
    return {
      ...base,
      kind: 'merge',
      payload: JSON.stringify({
        kind: 'merge',
        recordId: mergedId ?? leftId,
        absorbId: (mergedId ?? leftId) === leftId ? rightId : leftId,
        values: { identifier: merge?.values.identifier ?? '', rights: merge?.values.rights ?? '' },
        mergeId: merge?.id ?? ''
      })
    };
  }
  if (entry.action === '对账裁决' && entry.after) {
    // 裁决条目在 after 中携带机读指令（assert），提交时原样转发。
    return { ...base, kind: 'assert', payload: entry.after };
  }
  return null;
};

/** 圈定上次提交后的本机变更，追加进发件箱（已入箱的跳过，可安全重复调用）。 */
export const buildOutbox = (state: ArchiveState): number => {
  const known = new Set(state.catalog.outbox.map((item) => item.id));
  const pending = state.audit
    .filter((entry) => entry.revision > state.catalog.lastSyncedRevision && entry.channel !== 'sync' && OUTBOX_ACTIONS.has(entry.action))
    .sort((a, b) => a.revision - b.revision || a.at.localeCompare(b.at));
  let added = 0;
  pending.forEach((entry) => {
    if (known.has(entry.id)) return;
    const item = toOutboxItem(state, entry.id);
    if (item) {
      state.catalog.outbox.push(item);
      known.add(item.id);
      added += 1;
    }
  });
  return added;
};

const fieldLabels: Record<CatalogField, string> = { identifier: '编号', rights: '权利' };

/** 用目录新快照对账，就地更新本机状态并返回对账报告。 */
export const reconcileSnapshot = (state: ArchiveState, snapshot: CatalogSnapshot): ReconcileReport => {
  const report: ReconcileReport = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    fromVersion: state.catalog.lastVersion,
    toVersion: snapshot.version,
    pushed: 0,
    applied: 0,
    conflicts: 0,
    removedMerged: 0,
    detail: []
  };
  const baseById = new Map(state.catalog.baseEntries.map((entry) => [entry.recordId, entry]));

  snapshot.entries.forEach((entry) => {
    const base = baseById.get(entry.recordId);
    const local = state.records.find((record) => record.id === entry.recordId);
    const merge = state.merges.find((item) => item.leftId === entry.recordId || item.rightId === entry.recordId);

    if (!entry.alive) {
      if (entry.removedBy === 'submission') {
        report.detail.push(`记录 ${entry.recordId} 因本机提交的合并结论在目录侧下架，属预期变更`);
        ackFields(entry.recordId, ['alive']);
      } else if (merge) {
        // 同一记录只留待一次：已裁决（保留/接受移除）的不再重复提请。
        const exists = state.catalog.removedMerged.some((item) => item.recordId === entry.recordId);
        if (!exists) {
          state.catalog.removedMerged.unshift({
            id: crypto.randomUUID(),
            recordId: entry.recordId,
            recordTitle: local?.title ?? base?.identifier ?? entry.recordId,
            mergeId: merge.id,
            note: '目录已移除该记录，但本机存在涉及它的合并结论，留待人工处理',
            status: 'pending'
          });
          report.removedMerged += 1;
          report.detail.push(`记录 ${local?.title ?? entry.recordId} 已被目录移除，本机合并结论留待处理`);
        }
      } else if (local && !local.catalogRemoved) {
        local.catalogRemoved = true;
        report.applied += 1;
        report.detail.push(`记录「${local.title}」在目录侧已移除，本机标记为目录已移除`);
        ackFields(entry.recordId, ['alive']);
      }
      return;
    }

    if (!local) {
      report.detail.push(`目录记录 ${entry.identifier || entry.recordId} 本机不存在，未自动导入`);
      return;
    }

    (['identifier', 'rights'] as CatalogField[]).forEach((field) => {
      const baseValue = base?.[field] ?? '';
      const catalogValue = entry[field];
      const localValue = local[field];
      const remoteChanged = catalogValue !== baseValue;
      const localChanged = localValue !== baseValue;
      if (remoteChanged && localChanged && catalogValue !== localValue) {
        const exists = state.catalog.conflicts.some((item) => item.recordId === entry.recordId && item.field === field && item.status === 'pending');
        if (!exists) {
          state.catalog.conflicts.unshift({
            id: crypto.randomUUID(),
            recordId: entry.recordId,
            recordTitle: local.title,
            field,
            baseValue,
            localValue,
            catalogValue,
            status: 'pending'
          });
          report.conflicts += 1;
          report.detail.push(`「${local.title}」的${fieldLabels[field]}双方均有修改，列入待裁项`);
        }
      } else if (remoteChanged && !localChanged) {
        local[field] = catalogValue;
        local.updatedAt = new Date().toISOString();
        report.applied += 1;
        report.detail.push(`「${local.title}」的${fieldLabels[field]}按目录更新为：${catalogValue || '（空）'}`);
        ackFields(entry.recordId, [field]);
      }
      // 仅本机修改的字段已通过发件箱提交，保持本机值不变。
    });
  });

  state.catalog.baseEntries = clone(snapshot.entries);
  state.catalog.lastVersion = snapshot.version;
  return report;
};

/** 对账完成后结算：同步版本水位；已确认条目连同回执保留在箱内作为凭证，仅做容量裁剪。 */
export const settleOutbox = (state: ArchiveState) => {
  state.catalog.lastSyncedRevision = state.revision;
  if (state.catalog.outbox.length > 300) {
    const pending = state.catalog.outbox.filter((item) => item.status !== 'acked');
    const acked = state.catalog.outbox.filter((item) => item.status === 'acked');
    state.catalog.outbox = [...acked.slice(-(300 - pending.length)), ...pending];
  }
};

export const pendingOutboxCount = (state: ArchiveState) => state.catalog.outbox.filter((item) => item.status !== 'acked').length;

/** 待提交变更 = 发件箱待发送 + 尚未入箱的本机变更（已入箱的按发件箱状态计，不重复）。 */
export const pendingLocalChanges = (state: ArchiveState) => {
  const boxed = new Set(state.catalog.outbox.map((item) => item.id));
  const unboxed = state.audit.filter(
    (entry) => entry.revision > state.catalog.lastSyncedRevision && entry.channel !== 'sync' && OUTBOX_ACTIONS.has(entry.action) && !boxed.has(entry.id)
  ).length;
  return unboxed + pendingOutboxCount(state);
};

export const pendingDecisionCount = (state: ArchiveState) =>
  state.catalog.conflicts.filter((item) => item.status === 'pending').length +
  state.catalog.removedMerged.filter((item) => item.status === 'pending').length;

/** 导出对账记录：报告、待裁与裁决、留待处理、回执与目录侧写入日志。 */
export const exportReconciliation = (state: ArchiveState, serviceLog: string[]) => ({
  exportedAt: new Date().toISOString(),
  catalogVersion: state.catalog.lastVersion,
  lastSyncedRevision: state.catalog.lastSyncedRevision,
  reports: state.catalog.reports,
  conflicts: state.catalog.conflicts,
  removedMerged: state.catalog.removedMerged,
  receipts: state.catalog.outbox.filter((item) => item.receipt).map((item) => ({
    changeId: item.id,
    kind: item.kind,
    summary: item.summary,
    receipt: item.receipt,
    deduped: item.deduped ?? false,
    ackedAt: item.ackedAt
  })),
  pendingOutbox: state.catalog.outbox.filter((item) => item.status !== 'acked'),
  catalogWriteLog: serviceLog
});
