import type {
  ArchiveRecord, AutoChange, CatalogAddition, CatalogOwnedField, CatalogRecordSnapshot,
  CatalogSnapshot, FieldResolution, MatchCandidate, MergeResult, PendingArbitration,
  PendingItem, PendingSurvival, ReconciliationReport, SurvivalResolution, SyncDecision
} from '../types';
import { CATALOG_OWNED_FIELDS } from '../types';

export const BATCH_SIZE = 3;

export const decisionKey = {
  match: (matchId: string) => `match:${matchId}`,
  merge: (mergeId: string) => `merge:${mergeId}`
};

/** 从本机工作区提取尚未送达目录的结论（匹配结论、合并的字段选择）。 */
export function buildDecisions(
  matches: MatchCandidate[],
  merges: MergeResult[],
  ackedKeys: ReadonlySet<string>
): SyncDecision[] {
  const decisions: SyncDecision[] = [];
  matches
    .filter((match) => match.status !== 'suggested' && !!match.reviewedAt)
    .forEach((match) => {
      const key = decisionKey.match(match.id);
      if (ackedKeys.has(key)) return;
      decisions.push({
        key,
        type: 'match-review',
        matchId: match.id,
        recordIds: [match.leftId, match.rightId],
        at: match.reviewedAt ?? '',
        payload: { status: match.status, score: match.score }
      });
    });
  merges.forEach((merge) => {
    const key = decisionKey.merge(merge.id);
    if (ackedKeys.has(key)) return;
    decisions.push({
      key,
      type: 'merge',
      matchId: merge.matchId,
      recordIds: [merge.leftId, merge.rightId, ...(merge.mergedRecordId ? [merge.mergedRecordId] : [])],
      at: merge.mergedAt,
      payload: {
        leftCatalogId: merge.leftCatalogId,
        rightCatalogId: merge.rightCatalogId,
        leftIdentifier: merge.leftIdentifier,
        rightIdentifier: merge.rightIdentifier,
        chosen: merge.chosen,
        values: merge.values
      }
    });
  });
  return decisions.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

/**
 * 用稳定的批次 id 切分结论；重试同一批 id 不变，目录端据此去重，绝不重复写入。
 */
export function buildBatches(decisions: SyncDecision[]): Array<{ batchId: string; decisions: SyncDecision[] }> {
  const batches: Array<{ batchId: string; decisions: SyncDecision[] }> = [];
  for (let start = 0; start < decisions.length; start += BATCH_SIZE) {
    const slice = decisions.slice(start, start + BATCH_SIZE);
    const batchId = `batch-${slice[0].key}--${slice[slice.length - 1].key}`;
    batches.push({ batchId, decisions: slice });
  }
  return batches;
}

const fieldLabel: Record<CatalogOwnedField, string> = { identifier: '编号', rights: '权利' };

export const combineValues = (local: string, catalog: string) => {
  const left = local.trim();
  const right = catalog.trim();
  if (!left) return right;
  if (!right) return left;
  if (left === right || left.includes(right)) return left;
  if (right.includes(left)) return right;
  return `${left}；${right}`;
};

interface MergeBinding {
  merge: MergeResult;
  record: ArchiveRecord;
}

export interface ReconcileInput {
  baseline: CatalogSnapshot;
  incoming: CatalogSnapshot;
  records: ArchiveRecord[];
  merges: MergeResult[];
}

/**
 * 目录快照对账（纯函数）。
 *
 * 以基线快照为共同祖先做三方比对：
 * - 目录单方面修订管辖字段 → 自动应用项（含合并记录上本机未单独改写的情况）；
 * - 目录与本机合并都改了同一字段且取值不同 → 待裁项；
 * - 目录移除记录：本机已合并（含被合并的任一来源编号）→ 存活待处理项；未合并 → 自动删除项；
 * - 目录新增、本机没有的编号 → 待导入项。
 */
export function reconcileSnapshots(input: ReconcileInput): Omit<ReconciliationReport, 'generatedAt'> {
  const { baseline, incoming, records, merges } = input;
  const baselineById = new Map(baseline.records.map((record) => [record.catalogId, record]));
  const incomingById = new Map(incoming.records.map((record) => [record.catalogId, record]));

  const mergedRecords = records.filter((record) => record.status === 'merged');
  const mergedByChosenId = new Map<string, MergeBinding>();
  const provenance = new Map<string, MergeBinding>();
  merges.forEach((merge) => {
    const record = mergedRecords.find((item) => item.id === merge.mergedRecordId);
    if (!record) return;
    const binding: MergeBinding = { merge, record };
    if (record.catalogId) mergedByChosenId.set(record.catalogId, binding);
    [merge.leftCatalogId, merge.rightCatalogId].forEach((catalogId) => {
      if (catalogId) provenance.set(catalogId, binding);
    });
  });

  const findUnmerged = (catalogId: string) =>
    records.find((record) => record.status !== 'merged' && record.catalogId === catalogId);

  const autoChanges: AutoChange[] = [];
  const pending: PendingItem[] = [];
  const additions: CatalogAddition[] = [];

  incoming.records.forEach((next) => {
    const base = baselineById.get(next.catalogId);
    if (!base) {
      if (!records.some((record) => record.catalogId === next.catalogId)) {
        additions.push({ id: `add-${next.catalogId}`, catalogId: next.catalogId, identifier: next.identifier, rights: next.rights });
      }
      return;
    }

    const binding = mergedByChosenId.get(next.catalogId);
    const unmerged = binding ? undefined : findUnmerged(next.catalogId);

    CATALOG_OWNED_FIELDS.forEach((field) => {
      if (base[field] === next[field]) return;
      const baseValue = base[field];
      const catalogValue = next[field];

      if (binding) {
        const localValue = binding.record[field] ?? binding.merge.values[field] ?? '';
        const localChanged = localValue !== baseValue;
        if (localChanged && localValue !== catalogValue) {
          pending.push(arbItem(next.catalogId, binding, field, localValue, catalogValue, baseValue));
        } else {
          autoChanges.push({
            id: `auto-${next.catalogId}-${field}`,
            type: 'catalog-field',
            catalogId: next.catalogId,
            recordId: binding.record.id,
            field,
            before: localValue,
            after: catalogValue,
            note: localChanged
              ? `目录修订${fieldLabel[field]}，与本机合并取值一致`
              : `目录修订${fieldLabel[field]}，本机合并未单独改写`
          });
        }
        return;
      }

      // 未合并记录：编号与权利归目录管辖，目录单方面修订直接吸收，绝不覆盖本机合并结论。
      autoChanges.push({
        id: `auto-${next.catalogId}-${field}`,
        type: 'catalog-field',
        catalogId: next.catalogId,
        recordId: unmerged?.id,
        field,
        before: unmerged?.[field] ?? baseValue,
        after: catalogValue,
        note: `目录修订${fieldLabel[field]}`
      });
    });
  });

  // 目录移除（alive=false 或新版本中缺失）
  baseline.records.forEach((base) => {
    const next = incomingById.get(base.catalogId);
    if (next && next.alive) return;
    const binding = mergedByChosenId.get(base.catalogId) ?? provenance.get(base.catalogId);
    if (binding) {
      pending.push(holdItem(base.catalogId, binding, next === undefined));
      return;
    }
    const unmerged = findUnmerged(base.catalogId);
    if (unmerged) {
      autoChanges.push({
        id: `del-${base.catalogId}`,
        type: 'catalog-deletion',
        catalogId: base.catalogId,
        recordId: unmerged.id,
        note: next === undefined ? '目录新版本已移除该记录' : '目录已将该记录标记为不复存在'
      });
    }
  });

  return {
    baselineVersion: baseline.version,
    incomingVersion: incoming.version,
    autoChanges: autoChanges.sort((a, b) => a.id.localeCompare(b.id)),
    pending,
    additions,
    resolutions: {}
  };
}

function arbItem(
  catalogId: string,
  binding: MergeBinding,
  field: CatalogOwnedField,
  localValue: string,
  catalogValue: string,
  baselineValue: string
): PendingArbitration {
  return {
    id: `arb-${catalogId}-${field}`,
    kind: 'field',
    catalogId,
    recordId: binding.record.id,
    field,
    localValue,
    catalogValue,
    baselineValue,
    reason: `目录离线期间也修订了${fieldLabel[field]}，本机合并另选了不同取值`
  };
}

function holdItem(catalogId: string, binding: MergeBinding, missing: boolean): PendingSurvival {
  return {
    id: `hold-${catalogId}`,
    kind: 'survival',
    catalogId,
    recordId: binding.record.id,
    recordTitle: binding.record.title,
    reason: missing
      ? '目录新版本已移除该编号，但本机已完成合并，需人工决定存活'
      : '目录将该编号标记为不复存在，但本机已完成合并，需人工决定存活'
  };
}

export interface ApplyInput {
  report: ReconciliationReport;
  records: ArchiveRecord[];
}

export interface ApplyResult {
  records: ArchiveRecord[];
  autoApplied: AutoChange[];
  fieldArbitrations: Array<{ item: PendingArbitration; resolution: FieldResolution }>;
  survivalResolutions: Array<{ item: PendingSurvival; resolution: SurvivalResolution }>;
}

/** 把对账结果落到本机工作区：自动项直接应用，待裁项按用户选择应用。 */
export function applyReport(input: ApplyInput): ApplyResult {
  const { report, records } = input;
  let next = [...records];
  const autoApplied: AutoChange[] = [];

  report.autoChanges.forEach((change) => {
    if (change.type === 'catalog-field' && change.field) {
      const field: CatalogOwnedField = change.field;
      const after = change.after;
      next = next.map((record) =>
        record.id === change.recordId ? { ...record, [field]: after } : record
      );
      autoApplied.push(change);
    } else if (change.type === 'catalog-deletion') {
      next = next.filter((record) => record.id !== change.recordId);
      autoApplied.push(change);
    }
  });

  const fieldArbitrations: ApplyResult['fieldArbitrations'] = [];
  const survivalResolutions: ApplyResult['survivalResolutions'] = [];

  report.pending.forEach((item) => {
    const resolution = report.resolutions[item.id];
    if (!resolution) return;
    if (item.kind === 'field') {
      const chosen = resolution as FieldResolution;
      const field = item.field;
      fieldArbitrations.push({ item, resolution: chosen });
      if (chosen === 'catalog') {
        next = next.map((record) =>
          record.id === item.recordId ? { ...record, [field]: item.catalogValue, catalogHold: false } : record
        );
      } else if (chosen === 'combine') {
        next = next.map((record) =>
          record.id === item.recordId
            ? { ...record, [field]: combineValues(record[field], item.catalogValue) }
            : record
        );
      }
    } else {
      const chosen = resolution as SurvivalResolution;
      survivalResolutions.push({ item, resolution: chosen });
      if (chosen === 'remove') {
        next = next.filter((record) => record.id !== item.recordId);
      } else {
        next = next.map((record) =>
          record.id === item.recordId ? { ...record, catalogHold: true } : record
        );
      }
    }
  });

  return { records: next, autoApplied, fieldArbitrations, survivalResolutions };
}
