export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
  /** 目录侧已移除（目录管记录存活），本机仅作标记，不删本地数据。 */
  catalogRemoved?: boolean;
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  /** 产生该条审计时的本机版本号，用于同步时圈定“上次版本后的变更”。 */
  revision: number;
  /** sync 表示对账过程产生的系统条目，不再作为本机变更回传目录。 */
  channel?: 'local' | 'sync';
  before?: string;
  after?: string;
}

/** 目录侧拥有所有权的字段：编号、权利；记录存活单独处理。 */
export type CatalogField = 'identifier' | 'rights';

/** 目录离线修订跟踪的字段，在所有权字段之外加上存活状态。 */
export type CatalogTrackField = CatalogField | 'alive';

export interface CatalogEntry {
  recordId: string;
  identifier: string;
  rights: string;
  alive: boolean;
  /** submission = 因本机提交的合并结论而移除；catalog = 目录离线修订移除。 */
  removedBy?: 'catalog' | 'submission';
  updatedAt: string;
}

export interface CatalogSnapshot {
  version: number;
  takenAt: string;
  entries: CatalogEntry[];
}

export type OutboxStatus = 'pending' | 'acked';

export interface OutboxItem {
  /** 幂等键：取审计条目 ID，重试同一批时目录侧按它去重。 */
  id: string;
  revision: number;
  kind: 'match' | 'batch-review' | 'merge' | 'assert';
  summary: string;
  payload: string;
  status: OutboxStatus;
  attempts: number;
  /** 目录返回的成功回执；中断后保留，重试时跳过已确认条目。 */
  receipt?: string;
  /** 回执为目录侧去重后返回时为 true（写入未重复发生）。 */
  deduped?: boolean;
  ackedAt?: string;
}

/** 待裁项：本机与目录在上次同步后改了同一字段。 */
export interface PendingConflict {
  id: string;
  recordId: string;
  recordTitle: string;
  field: CatalogField;
  baseValue: string;
  localValue: string;
  catalogValue: string;
  status: 'pending' | 'resolved';
  resolution?: 'local' | 'catalog';
  resolvedAt?: string;
}

/** 留待处理：目录移除了本机已合并的记录。 */
export interface RemovedMergedItem {
  id: string;
  recordId: string;
  recordTitle: string;
  mergeId: string;
  note: string;
  status: 'pending' | 'kept' | 'dropped';
  resolvedAt?: string;
}

export interface ReconcileReport {
  id: string;
  at: string;
  fromVersion: number;
  toVersion: number;
  pushed: number;
  applied: number;
  conflicts: number;
  removedMerged: number;
  detail: string[];
}

export interface CatalogSyncState {
  /** 上次对账完成的目录版本。 */
  lastVersion: number;
  /** 上次提交时覆盖到的本机 revision。 */
  lastSyncedRevision: number;
  /** 上次同步拿到的快照，作为三方对账基准。 */
  baseEntries: CatalogEntry[];
  outbox: OutboxItem[];
  conflicts: PendingConflict[];
  removedMerged: RemovedMergedItem[];
  reports: ReconcileReport[];
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  catalog: CatalogSyncState;
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}
