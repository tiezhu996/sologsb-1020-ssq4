import type { ArchiveRecord, CatalogEntry, CatalogField, CatalogSnapshot, CatalogTrackField, OutboxItem } from '../types';

/**
 * 模拟馆藏目录服务。
 *
 * 核对台是纯前端应用，这里用独立的 localStorage 命名空间扮演“远端目录”：
 * 目录管编号、权利和记录存活，本机核对台管匹配结论、字段选择和审计轨迹。
 * 服务侧维护已应用变更登记表，保证同一批变更重试时不会重复写入。
 */

const CATALOG_KEY = 'sologsb-1020-catalog-service-v1';

export interface CatalogServiceState {
  version: number;
  entries: CatalogEntry[];
  /** 离线修订过、尚未与核对台对齐的字段，提交写入这些字段时会被暂扣。 */
  revised: Record<string, CatalogTrackField[]>;
  /** 幂等登记：变更 ID → 回执。 */
  applied: Record<string, string>;
  /** 服务侧写入日志，用于核对是否发生重复写入。 */
  writeLog: string[];
}

export class SyncInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncInterruptedError';
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const load = (): CatalogServiceState | null => {
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    return raw ? (JSON.parse(raw) as CatalogServiceState) : null;
  } catch {
    return null;
  }
};

const save = (state: CatalogServiceState) => {
  localStorage.setItem(CATALOG_KEY, JSON.stringify(state));
};

const entryFromRecord = (record: ArchiveRecord): CatalogEntry => ({
  recordId: record.id,
  identifier: record.identifier,
  rights: record.rights,
  alive: true,
  updatedAt: record.updatedAt
});

/** 首次使用时按当前记录建立目录；之后目录独立演化（离线修订）。 */
export const ensureCatalog = (records: ArchiveRecord[]): CatalogServiceState => {
  const existing = load();
  if (existing) return existing;
  const state: CatalogServiceState = {
    version: 1,
    entries: records.map(entryFromRecord),
    revised: {},
    applied: {},
    writeLog: [`v1 · 目录初始化，收录 ${records.length} 条记录`]
  };
  save(state);
  return state;
};

export const catalogStatus = (): { version: number; entryCount: number } => {
  const state = load();
  return { version: state?.version ?? 0, entryCount: state?.entries.length ?? 0 };
};

export const fetchSnapshot = (): CatalogSnapshot => {
  const state = load();
  if (!state) return { version: 0, takenAt: new Date().toISOString(), entries: [] };
  return {
    version: state.version,
    takenAt: new Date().toISOString(),
    entries: clone(state.entries)
  };
};

interface PushPayload {
  kind: OutboxItem['kind'];
  recordId?: string;
  field?: CatalogTrackField;
  value?: string;
  values?: Partial<Record<CatalogField, string>>;
  absorbId?: string;
}

export interface PushResult {
  receipt: string;
  duplicate: boolean;
  held: string[];
}

/**
 * 提交一条本机变更。按变更 ID 幂等：已登记的变更直接返回原回执，
 * 不再执行写入，因此网络重试、整批重发都不会在目录侧重复落库。
 *
 * 若 `interruptAfterWrite` 为 true，则模拟“写入完成但回执未送达”的
 * 发送中断：变更已落库，客户端却拿不到回执，只能靠重试时的幂等去重
 * 恢复一致。
 */
export const pushChange = (item: OutboxItem, interruptAfterWrite = false): PushResult => {
  const state = load();
  if (!state) throw new SyncInterruptedError('目录服务不可用');
  const known = state.applied[item.id];
  if (known) return { receipt: known, duplicate: true, held: [] };

  const payload = JSON.parse(item.payload) as PushPayload;
  const held: string[] = [];
  const touch = (recordId: string, field: CatalogField, value: string) => {
    const entry = state.entries.find((candidate) => candidate.recordId === recordId);
    if (!entry || !entry.alive) return;
    // 目录离线修订过的字段被暂扣，等待对账裁决，不被提交直接冲掉。
    if (state.revised[recordId]?.includes(field)) {
      held.push(`${recordId}:${field}`);
      return;
    }
    entry[field] = value;
    entry.updatedAt = new Date().toISOString();
  };

  if (payload.kind === 'merge' && payload.recordId) {
    Object.entries(payload.values ?? {}).forEach(([field, value]) => {
      if (typeof value === 'string') touch(payload.recordId!, field as CatalogField, value);
    });
    if (payload.absorbId) {
      const absorbed = state.entries.find((entry) => entry.recordId === payload.absorbId);
      if (absorbed && absorbed.alive) {
        if (state.revised[absorbed.recordId]?.includes('alive')) {
          held.push(`${absorbed.recordId}:alive`);
        } else {
          absorbed.alive = false;
          absorbed.removedBy = 'submission';
          absorbed.updatedAt = new Date().toISOString();
        }
      }
    }
  }
  if (payload.kind === 'assert' && payload.recordId && payload.field) {
    // 裁决结论具有最高优先级，直接落库并解除暂扣。
    const entry = state.entries.find((candidate) => candidate.recordId === payload.recordId);
    const field = payload.field;
    if (entry && field) {
      if (field === 'alive') {
        entry.alive = true;
        delete entry.removedBy;
      } else {
        entry[field as CatalogField] = payload.value ?? '';
      }
      entry.updatedAt = new Date().toISOString();
      state.revised[payload.recordId] = (state.revised[payload.recordId] ?? []).filter((candidate) => candidate !== field);
    }
  }

  state.version += 1;
  const receipt = `RCPT-${String(state.version).padStart(4, '0')}-${item.id.slice(0, 8).toUpperCase()}`;
  state.applied[item.id] = receipt;
  state.writeLog.unshift(`v${state.version} · 应用变更 ${item.id.slice(0, 8)}（${item.kind}）${held.length ? ` · 暂扣 ${held.length} 项` : ''}`);
  state.writeLog = state.writeLog.slice(0, 120);
  save(state);

  if (interruptAfterWrite) throw new SyncInterruptedError('发送中断：写入已到达目录，但回执未送达');
  return { receipt, duplicate: false, held };
};

/**
 * 模拟核对台离线期间目录侧的修订：重编编号、调整权利、移除记录。
 * 返回人类可读的修订说明，用于界面展示。
 */
export const simulateOfflineRevision = (
  localRecords: ArchiveRecord[],
  mergedRecordIds: string[]
): string[] => {
  const state = load();
  if (!state) return [];
  const notes: string[] = [];
  const now = new Date().toISOString();
  const mark = (recordId: string, field: CatalogTrackField) => {
    state.revised[recordId] = Array.from(new Set([...(state.revised[recordId] ?? []), field]));
  };
  const aliveEntries = state.entries.filter((entry) => entry.alive);
  const candidates = aliveEntries.filter((entry) => localRecords.some((record) => record.id === entry.recordId));

  candidates.slice(0, 2).forEach((entry, index) => {
    const next = `CAT-2026-${String(state.version * 100 + index + 1).padStart(4, '0')}`;
    notes.push(`编号修订：${entry.identifier} → ${next}`);
    entry.identifier = next;
    entry.updatedAt = now;
    mark(entry.recordId, 'identifier');
  });
  candidates.slice(2, 4).forEach((entry) => {
    const next = entry.rights.includes('（目录复核）') ? entry.rights : `${entry.rights || '未标注'}（目录复核）`;
    notes.push(`权利修订：${entry.recordId} → ${next}`);
    entry.rights = next;
    entry.updatedAt = now;
    mark(entry.recordId, 'rights');
  });
  const mergedTarget = mergedRecordIds
    .map((id) => state.entries.find((entry) => entry.recordId === id && entry.alive))
    .find(Boolean);
  if (mergedTarget) {
    mergedTarget.alive = false;
    mergedTarget.removedBy = 'catalog';
    mergedTarget.updatedAt = now;
    mark(mergedTarget.recordId, 'alive');
    notes.push(`记录移除：${mergedTarget.recordId}（本机已合并，待对账处理）`);
  }

  if (notes.length) {
    state.version += 1;
    state.writeLog.unshift(`v${state.version} · 离线修订 ${notes.length} 项（编号 / 权利 / 存活）`);
    save(state);
  }
  return notes;
};

/** 对账采纳目录值后调用：解除该字段的暂扣标记。 */
export const ackFields = (recordId: string, fields: CatalogTrackField[]) => {
  const state = load();
  if (!state || !state.revised[recordId]) return;
  state.revised[recordId] = state.revised[recordId].filter((field) => !fields.includes(field));
  save(state);
};

export const serviceLog = (): string[] => load()?.writeLog ?? [];
