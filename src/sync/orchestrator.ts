import type {
  ArchiveState, CatalogRecordSnapshot, CatalogSnapshot, ReconciliationReport, SyncReceipt
} from '../types';
import { SimulatedSendError, fetchSnapshot, pushBatch, seedServer } from './catalogServer';
import { applyReport, buildBatches, buildDecisions, reconcileSnapshots } from './reconcile';

const ackedKeySet = (receipts: SyncReceipt[]) => {
  const keys = new Set<string>();
  receipts.forEach((receipt) => receipt.decisionKeys.forEach((key) => keys.add(key)));
  return keys;
};

export const ensureBaseline = (state: ArchiveState, seedRecords: CatalogRecordSnapshot[]): CatalogSnapshot => {
  if (state.sync.baseline) return state.sync.baseline;
  const snapshot = seedServer(seedRecords);
  state.sync.baseline = snapshot;
  return snapshot;
};

export interface ProgressEvents {
  onPushProgress: (acked: number, total: number, currentBatchId: string) => void;
  onPhase: (phase: ArchiveState['sync']['phase']) => void;
}

// ── 中断控制（模拟传输断开；一轮同步共用一个控制器，重试时换新的） ──────
export interface SyncController { signal: { aborted: boolean }; abort: () => void }
export const makeController = (): SyncController => {
  const signal = { aborted: false };
  return { signal, abort: () => { signal.aborted = true; } };
};

let controller: SyncController = makeController();

export function simulateAbort() {
  controller.abort();
}

/**
 * 同步第一步：提交自上次同步以来的本机变更。
 * 发送计划在开始时固化（批次 id 由决策 key 决定，稳定不变）；
 * 中断后保留计划与已成功回执，重试同一批在目录端幂等去重，绝不重复写入。
 */
export async function runPush(state: ArchiveState, events: ProgressEvents): Promise<'complete' | 'interrupted'> {
  const sync = state.sync;
  controller = makeController();
  if (!sync.pushPlan.length) {
    const decisions = buildDecisions(state.matches, state.merges, ackedKeySet(sync.ackedBatches));
    sync.pushPlan = buildBatches(decisions);
    sync.pushStartedAt = new Date().toISOString();
  }

  const total = sync.pushPlan.length;
  if (total === 0) {
    events.onPhase('pulling');
    return runPull(state, events, controller);
  }

  events.onPhase('pushing');
  for (const batch of sync.pushPlan) {
    const already = sync.ackedBatches.find((receipt) => receipt.batchId === batch.batchId);
    if (already) {
      events.onPushProgress(sync.ackedBatches.length, total, batch.batchId);
      continue;
    }
    try {
      const receipt = await pushBatch(batch.batchId, batch.decisions, { flaky: sync.flaky, signal: controller.signal });
      sync.ackedBatches = [...sync.ackedBatches.filter((item) => item.batchId !== receipt.batchId), receipt];
      events.onPushProgress(sync.ackedBatches.length, total, batch.batchId);
    } catch (error) {
      if (error instanceof SimulatedSendError) {
        events.onPhase('interrupted');
        return 'interrupted';
      }
      throw error;
    }
  }
  sync.pushPlan = [];
  sync.pushStartedAt = null;
  events.onPhase('pulling');
  return runPull(state, events, controller);
}

/** 同步第二步：取目录新快照并生成对账报告（纯函数，不改动工作区记录）。 */
export async function runPull(
  state: ArchiveState,
  _events: ProgressEvents,
  control: SyncController = makeController()
): Promise<'complete' | 'interrupted'> {
  try {
    const incoming = await fetchSnapshot(control.signal);
    state.sync.incoming = incoming;
    const report = reconcileSnapshots({
      baseline: state.sync.baseline!,
      incoming,
      records: state.records,
      merges: state.merges
    });
    state.sync.report = { ...report, generatedAt: new Date().toISOString() };
    state.sync.phase = 'review';
    return 'complete';
  } catch (error) {
    if (error instanceof SimulatedSendError) {
      state.sync.phase = 'interrupted';
      return 'interrupted';
    }
    throw error;
  }
}

/** 放弃中断的发送：保留已成功回执，清空本轮计划；下次同步只发剩余结论。 */
export function abandonPush(state: ArchiveState) {
  state.sync.pushPlan = [];
  state.sync.pushStartedAt = null;
  state.sync.phase = 'idle';
}

export function setResolution(
  state: ArchiveState,
  itemId: string,
  resolution: NonNullable<ReconciliationReport['resolutions'][string]>
) {
  if (!state.sync.report) return;
  state.sync.report.resolutions = { ...state.sync.report.resolutions, [itemId]: resolution };
}

/** 把目录新增记录导入本机（匹配队列按导入后的记录重算，已有的匹配结论不丢）。 */
export function importAddition(state: ArchiveState, catalogId: string): ArchiveState['records'][number] | undefined {
  const addition = state.sync.report?.additions.find((item) => item.catalogId === catalogId)
    ?? state.sync.incoming?.records.find((item) => item.catalogId === catalogId);
  if (!addition) return undefined;
  const record: ArchiveState['records'][number] = {
    id: crypto.randomUUID(),
    group: 'B',
    catalogId: addition.catalogId,
    title: `目录新增记录 ${addition.identifier}`,
    date: '',
    people: [],
    places: [],
    identifier: addition.identifier,
    medium: '',
    extent: '',
    rights: addition.rights,
    notes: '目录同步时新增，待补全元数据',
    updatedAt: new Date().toISOString(),
    status: 'unreviewed'
  };
  state.records = [...state.records, record];
  return record;
}

export interface ApplySummary {
  appliedAuto: number;
  appliedDeletions: number;
  fieldCount: number;
  survivalCount: number;
  imported: number;
}

/** 应用对账报告：自动项落库、待裁项按选择落库、基线推进到新快照。 */
export function applyCurrentReport(state: ArchiveState, importedCatalogIds: Set<string>): ApplySummary {
  const report = state.sync.report;
  const incoming = state.sync.incoming;
  if (!report || !incoming) throw new Error('没有可应用的对账报告');

  const result = applyReport({ report, records: state.records });
  state.records = result.records;

  const summary: ApplySummary = {
    appliedAuto: result.autoApplied.filter((change) => change.type === 'catalog-field').length,
    appliedDeletions: result.autoApplied.filter((change) => change.type === 'catalog-deletion').length,
    fieldCount: result.fieldArbitrations.length,
    survivalCount: result.survivalResolutions.length,
    imported: importedCatalogIds.size
  };

  state.sync.report = { ...report, appliedAt: new Date().toISOString() };
  state.sync.baseline = incoming;
  state.sync.incoming = null;
  state.sync.phase = 'idle';
  state.sync.lastSyncAt = new Date().toISOString();
  return summary;
}

export function dismissReport(state: ArchiveState) {
  state.sync.report = null;
  state.sync.incoming = null;
  state.sync.phase = 'idle';
}

export function exportableReconciliation(state: ArchiveState) {
  const report = state.sync.report;
  return {
    exportedAt: new Date().toISOString(),
    baseline: state.sync.baseline,
    incoming: state.sync.incoming,
    report,
    records: state.records,
    merges: state.merges,
    decisionsAcked: state.sync.ackedBatches
  };
}
