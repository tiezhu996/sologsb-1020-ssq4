import type { CatalogRecordSnapshot, CatalogSnapshot, SyncDecision, SyncReceipt } from '../types';

/**
 * 馆藏目录服务的本地模拟。真实部署时这里换成 HTTPS 客户端即可：
 * 接口形态保持「拉快照 / 幂等批次提交 / 发布修订」不变。
 */

const SERVER_KEY = 'sologsb-1020-catalog-server-v1';
const LATENCY_MS = 520;

export interface StoredBatch {
  batchId: string;
  decisions: SyncDecision[];
  receivedAt: string;
}

interface ServerState {
  snapshot: CatalogSnapshot;
  batches: StoredBatch[];
}

const delay = (ms = LATENCY_MS) => new Promise((resolve) => setTimeout(resolve, ms));

export class SimulatedSendError extends Error {
  constructor(public afterWrite: boolean) {
    super(afterWrite ? '目录已写入但回执丢失' : '发送在目录处理前中断');
    this.name = 'SimulatedSendError';
  }
}

function read(): ServerState | null {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    return raw ? (JSON.parse(raw) as ServerState) : null;
  } catch {
    return null;
  }
}

function write(state: ServerState) {
  localStorage.setItem(SERVER_KEY, JSON.stringify(state));
}

export function serverExists(): boolean {
  return read() !== null;
}

export function seedServer(records: CatalogRecordSnapshot[]): CatalogSnapshot {
  const snapshot: CatalogSnapshot = { version: 1, takenAt: new Date().toISOString(), records };
  write({ snapshot, batches: [] });
  return snapshot;
}

export function serverVersion(): number | null {
  return read()?.snapshot.version ?? null;
}

export async function fetchSnapshot(signal?: { aborted: boolean }): Promise<CatalogSnapshot> {
  await delay(620);
  if (signal?.aborted) throw new SimulatedSendError(false);
  const state = read();
  if (!state) throw new Error('馆藏目录尚未建立');
  return structuredClone(state.snapshot);
}

/**
 * 幂等批次提交：同一 batchId 重放时目录端不再写入决策，直接返回已有成功回执。
 * flaky=true 时模拟弱网：目录可能已经落库但本机没收到回执（afterWrite），
 * 此时重试同一批可验证“不重复写入 + 补回回执”。
 */
export async function pushBatch(
  batchId: string,
  decisions: SyncDecision[],
  options: { flaky: boolean; signal?: { aborted: boolean } }
): Promise<SyncReceipt> {
  await delay(680);
  const state = read();
  if (!state) throw new Error('馆藏目录尚未建立');

  const existing = state.batches.find((batch) => batch.batchId === batchId);
  if (existing) {
    // 重放同一批：幂等命中，不重复写入任何决策
    if (options.signal?.aborted || (options.flaky && Math.random() < 0.25)) {
      throw new SimulatedSendError(true);
    }
    return { batchId, decisionKeys: existing.decisions.map((decision) => decision.key), receivedAt: existing.receivedAt };
  }

  // 目录在此时落库
  const receivedAt = new Date().toISOString();
  state.batches.push({ batchId, decisions: structuredClone(decisions), receivedAt });
  write(state);

  if (options.signal?.aborted || (options.flaky && Math.random() < 0.5)) {
    throw new SimulatedSendError(true);
  }
  return { batchId, decisionKeys: decisions.map((decision) => decision.key), receivedAt };
}

export function publishRevision(mutate: (records: CatalogRecordSnapshot[]) => CatalogRecordSnapshot[]): CatalogSnapshot {
  const state = read();
  if (!state) throw new Error('馆藏目录尚未建立');
  const snapshot: CatalogSnapshot = {
    version: state.snapshot.version + 1,
    takenAt: new Date().toISOString(),
    records: mutate(structuredClone(state.snapshot.records))
  };
  state.snapshot = snapshot;
  write(state);
  return structuredClone(snapshot);
}

export function listServerRecords(): CatalogRecordSnapshot[] {
  const state = read();
  return state ? structuredClone(state.snapshot.records) : [];
}
