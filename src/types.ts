export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  /** 馆藏目录稳定记录锚点；目录修订编号时不变，无目录来源的本机记录为空 */
  catalogId?: string;
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
  catalogHold?: boolean;
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
  mergedRecordId?: string;
  leftCatalogId?: string;
  rightCatalogId?: string;
  leftIdentifier?: string;
  rightIdentifier?: string;
  mergedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
  sync: SyncState;
}

// ── 目录快照与同步对账 ─────────────────────────────────────────────

/** 馆藏目录管辖字段：编号、权利、记录存活 */
export type CatalogOwnedField = 'identifier' | 'rights';
export const CATALOG_OWNED_FIELDS: CatalogOwnedField[] = ['identifier', 'rights'];

export interface CatalogRecordSnapshot {
  catalogId: string;
  identifier: string;
  rights: string;
  alive: boolean;
  updatedAt: string;
}

export interface CatalogSnapshot {
  version: number;
  takenAt: string;
  records: CatalogRecordSnapshot[];
}

export type SyncDecisionType = 'match-review' | 'merge';

export interface SyncDecision {
  key: string;
  type: SyncDecisionType;
  matchId: string;
  recordIds: string[];
  at: string;
  payload: unknown;
}

export interface SyncReceipt {
  batchId: string;
  decisionKeys: string[];
  receivedAt: string;
}

export type SyncPhase =
  | 'idle'
  | 'pushing'      // 正在提交本机变更
  | 'interrupted' // 发送中断，保留进度与已成功回执
  | 'pulling'
  | 'review';     // 已取新快照，等待对账裁决与应用

export type AutoChangeType =
  | 'catalog-field'     // 仅目录修改的管辖字段，自动应用
  | 'catalog-deletion'  // 目录移除且本机未合并，自动应用
  | 'catalog-addition'; // 目录新增

export interface AutoChange {
  id: string;
  type: AutoChangeType;
  catalogId: string;
  recordId?: string;
  field?: CatalogOwnedField;
  before?: string;
  after?: string;
  note: string;
}

export type ArbitrationKind = 'field' | 'survival';
export type FieldResolution = 'local' | 'catalog' | 'combine';
export type SurvivalResolution = 'keep' | 'remove';
export type PendingResolution = FieldResolution | SurvivalResolution;

export interface PendingArbitration {
  id: string;
  kind: 'field';
  catalogId: string;
  recordId?: string;
  field: CatalogOwnedField;
  localValue: string;
  catalogValue: string;
  baselineValue: string;
  reason: string;
}

export interface PendingSurvival {
  id: string;
  kind: 'survival';
  catalogId: string;
  recordId?: string;
  recordTitle: string;
  reason: string;
}

export type PendingItem = PendingArbitration | PendingSurvival;

export interface CatalogAddition {
  id: string;
  catalogId: string;
  identifier: string;
  rights: string;
}

export interface ReconciliationReport {
  generatedAt: string;
  baselineVersion: number;
  incomingVersion: number;
  autoChanges: AutoChange[];
  pending: PendingItem[];
  additions: CatalogAddition[];
  resolutions: Record<string, PendingResolution>;
  appliedAt?: string;
}

export interface PushedBatch {
  batchId: string;
  decisions: SyncDecision[];
}

export interface SyncState {
  baseline: CatalogSnapshot | null;
  phase: SyncPhase;
  /** 本轮发送计划：中断后原样保留，重试时批次 id 与载荷都不变 */
  pushPlan: PushedBatch[];
  ackedBatches: SyncReceipt[];
  pushStartedAt: string | null;
  incoming: CatalogSnapshot | null;
  report: ReconciliationReport | null;
  lastSyncAt: string | null;
  flaky: boolean;
}

export const initialSyncState = (): SyncState => ({
  baseline: null,
  phase: 'idle',
  pushPlan: [],
  ackedBatches: [],
  pushStartedAt: null,
  incoming: null,
  report: null,
  lastSyncAt: null,
  flaky: false
});
