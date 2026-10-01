import { $, component$, useComputed$, useSignal, type QRL } from '@builder.io/qwik';
import { Modal } from '@qwik-ui/headless';
import type {
  ArchiveState, AutoChange, FieldResolution, PendingArbitration,
  PendingSurvival, SurvivalResolution
} from '../types';

export interface SyncModalProps {
  state: ArchiveState;
  running: { value: boolean };
  pushProgress: { value: string };
  onRunSync: QRL<() => void>;
  onAbort: QRL<() => void>;
  onAbandon: QRL<() => void>;
  onResolve: QRL<(itemId: string, resolution: FieldResolution | SurvivalResolution) => void>;
  onImport: QRL<(catalogId: string) => void>;
  onApply: QRL<() => void>;
  onCloseReport: QRL<() => void>;
  onExport: QRL<() => void>;
  onDemoRevision: QRL<() => void>;
  onManualRevision: QRL<(payload: { catalogId: string; identifier?: string; rights?: string; alive?: boolean }) => void>;
}

const phaseLabel: Record<ArchiveState['sync']['phase'], string> = {
  idle: '空闲',
  pushing: '提交本机变更',
  interrupted: '发送中断 · 保留进度',
  pulling: '拉取目录快照',
  review: '等待对账裁决'
};

const changeLabel = (change: AutoChange) => {
  if (change.type === 'catalog-deletion') return '目录移除 · 自动删除';
  if (change.field === 'identifier') return `编号修订：${change.before || '—'} → ${change.after}`;
  if (change.field === 'rights') return `权利修订：${change.before || '—'} → ${change.after}`;
  return change.note;
};

export const SyncModal = component$<SyncModalProps>((props) => {
  const { state } = props;
  const sync = state.sync;
  const report = sync.report;

  const manualId = useSignal('');
  const manualIdentifier = useSignal('');
  const manualRights = useSignal('');
  const manualAlive = useSignal(true);
  const showManual = useSignal(false);

  const serverRecords = useComputed$(() => sync.incoming?.records ?? sync.baseline?.records ?? []);
  const pendingField = useComputed$(() => report?.pending.filter((item) => item.kind === 'field') as PendingArbitration[] ?? []);
  const pendingSurvival = useComputed$(() => report?.pending.filter((item) => item.kind === 'survival') as PendingSurvival[] ?? []);
  const importedIds = useSignal<Set<string>>(new Set());

  const allResolved = useComputed$(() =>
    !!report && report.pending.every((item) => report.resolutions[item.id])
  );

  const pickManual = $((id: string) => {
    manualId.value = id;
    const found = serverRecords.value.find((record) => record.catalogId === id);
    manualIdentifier.value = found?.identifier ?? '';
    manualRights.value = found?.rights ?? '';
    manualAlive.value = found?.alive ?? true;
  });

  const submitManual = $(() => {
    if (!manualId.value) return;
    const current = serverRecords.value.find((record) => record.catalogId === manualId.value);
    props.onManualRevision({
      catalogId: manualId.value,
      identifier: manualIdentifier.value.trim() !== (current?.identifier ?? '') ? manualIdentifier.value.trim() : undefined,
      rights: manualRights.value.trim() !== (current?.rights ?? '') ? manualRights.value.trim() : undefined,
      alive: manualAlive.value !== (current?.alive ?? true) ? manualAlive.value : undefined
    });
    showManual.value = false;
  });

  const isBusy = () => props.running.value;

  return (
    <Modal.Panel class="modal-panel sync-modal">
      <Modal.Header class="modal-header">
        <div>
          <span class="eyebrow">CATALOG SNAPSHOT SYNC</span>
          <Modal.Title>目录快照对账</Modal.Title>
        </div>
        <Modal.Close class="modal-close">×</Modal.Close>
      </Modal.Header>
      <Modal.Description class="modal-description">
        馆藏目录管辖编号、权利与记录存活；本机工作区管辖匹配结论、字段选择与审计轨迹。同步先提交本机变更，再取新快照做三方对账。
      </Modal.Description>

      <div class="sync-status-grid">
        <div><small>当前阶段</small><strong class={`sync-phase ${sync.phase}`}>{phaseLabel[sync.phase]}</strong></div>
        <div><small>基线版本</small><strong>v{sync.baseline?.version ?? '—'}</strong></div>
        <div><small>上次同步</small><strong>{sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString('zh-CN') : '尚未同步'}</strong></div>
        <div><small>已送达回执</small><strong>{sync.ackedBatches.length} 批</strong></div>
      </div>

      {/* 推送 / 拉取进度 */}
      {(sync.phase === 'pushing' || sync.phase === 'pulling' || sync.phase === 'interrupted') && (
        <div class="sync-progress">
          <div class={`progress-bar ${sync.phase}`}><span /></div>
          <p>{props.pushProgress.value || (sync.phase === 'pulling' ? '正在从馆藏目录拉取新快照…' : sync.phase === 'interrupted' ? '发送中断，进度与已成功回执已保留' : '正在提交本机变更批次…')}</p>
          {sync.phase === 'interrupted' && (
            <div class="interrupt-actions">
              <button class="button primary small" disabled={isBusy()} onClick$={props.onRunSync}>重试同一批（幂等，不重复写入）</button>
              <button class="button ghost small" disabled={isBusy()} onClick$={props.onAbandon}>放弃本轮发送（保留回执）</button>
            </div>
          )}
          {(sync.phase === 'pushing' || sync.phase === 'pulling') && (
            <button class="button danger small" disabled={isBusy() ? false : true} onClick$={props.onAbort}>模拟发送中断</button>
          )}
        </div>
      )}

      {/* 空闲：发起同步 + 模拟目录侧修订 */}
      {sync.phase === 'idle' && (
        <div class="sync-idle">
          <div class="sync-actions-row">
            <button class="button primary" disabled={isBusy()} onClick$={props.onRunSync}>开始同步（先提交本机变更，再取新快照）</button>
            {sync.report && <button class="button ghost" onClick$={props.onExport}>导出上次对账记录</button>}
            <label class="flaky-toggle">
              <input type="checkbox" checked={sync.flaky} onChange$={() => { state.sync.flaky = !state.sync.flaky; }} />
              <span>弱网模拟（目录可能已写入但回执丢失）</span>
            </label>
          </div>
          <div class="catalog-devbox">
            <div class="devbox-head">
              <strong>模拟馆藏目录离线期间修订（演示用）</strong>
              <button class="button small light" disabled={isBusy()} onClick$={props.onDemoRevision}>一键发布修订（覆盖全部对账分支）</button>
              <button class="button small ghost" onClick$={() => showManual.value = !showManual.value}>{showManual.value ? '收起手动修订' : '手动修订一条目录记录'}</button>
            </div>
            {showManual.value && (
              <div class="manual-revise">
                <select class="input" value={manualId.value} onChange$={(event) => pickManual((event.target as HTMLSelectElement).value)}>
                  <option value="">选择目录记录…</option>
                  {serverRecords.value.map((record) => <option value={record.catalogId} key={record.catalogId}>{`${record.identifier} · ${record.rights}${record.alive ? '' : ' · 已移除'}`}</option>)}
                </select>
                <input class="input" placeholder="新编号（留空不改）" value={manualIdentifier.value} onInput$={(event) => manualIdentifier.value = (event.target as HTMLInputElement).value} />
                <input class="input" placeholder="新权利（留空不改）" value={manualRights.value} onInput$={(event) => manualRights.value = (event.target as HTMLInputElement).value} />
                <label class="alive-check"><input type="checkbox" checked={manualAlive.value} onChange$={() => { manualAlive.value = !manualAlive.value; }} /><span>记录存活</span></label>
                <button class="button small primary" disabled={!manualId.value} onClick$={submitManual}>发布修订</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 对账报告 */}
      {sync.phase === 'review' && report && (
        <div class="recon-report">
          <div class="report-summary">
            <span class="pill auto">自动应用 {report.autoChanges.length}</span>
            <span class="pill warn">待裁字段 {pendingField.value.length}</span>
            <span class="pill danger">存活待处理 {pendingSurvival.value.length}</span>
            <span class="pill">目录新增 {report.additions.length}</span>
            <small>基线 v{report.baselineVersion} → 新快照 v{report.incomingVersion}</small>
          </div>

          <section class="report-section">
            <h4>自动应用项（目录管辖，不覆盖本机合并结论）</h4>
            <div class="report-list">
              {report.autoChanges.map((change) => (
                <div class="report-row auto" key={change.id}>
                  <span class="row-tag">{change.type === 'catalog-deletion' ? '删除' : '字段'}</span>
                  <code>{change.catalogId}</code>
                  <span>{changeLabel(change)}</span>
                </div>
              ))}
              {!report.autoChanges.length && <p class="report-empty">无自动应用项。</p>}
            </div>
          </section>

          <section class="report-section">
            <h4>待裁项：双方都改了同一字段</h4>
            <div class="report-list">
              {pendingField.value.map((item) => {
                const resolution = report.resolutions[item.id] as FieldResolution | undefined;
                return (
                  <div class="arb-card" key={item.id}>
                    <div class="arb-head">
                      <code>{item.catalogId}</code>
                      <strong>{item.field === 'identifier' ? '编号' : '权利'}</strong>
                      <small>共同祖先（基线）：{item.baselineValue || '—'}</small>
                    </div>
                    <p class="arb-reason">{item.reason}</p>
                    <div class="arb-values">
                      <div class="arb-value local"><small>本机合并值</small><span>{item.localValue || '—'}</span></div>
                      <div class="arb-value catalog"><small>目录新值</small><span>{item.catalogValue || '—'}</span></div>
                    </div>
                    <div class="arb-choices">
                      <button class={`choice ${resolution === 'local' ? 'selected local' : ''}`} onClick$={() => props.onResolve(item.id, 'local')}>保留本机</button>
                      <button class={`choice ${resolution === 'catalog' ? 'selected catalog' : ''}`} onClick$={() => props.onResolve(item.id, 'catalog')}>采用目录</button>
                      <button class={`choice ${resolution === 'combine' ? 'selected combine' : ''}`} onClick$={() => props.onResolve(item.id, 'combine')}>拼接双方</button>
                    </div>
                  </div>
                );
              })}
              {!pendingField.value.length && <p class="report-empty">没有双方同改的字段。</p>}
            </div>
          </section>

          <section class="report-section">
            <h4>存活待处理：目录已移除，本机已合并</h4>
            <div class="report-list">
              {pendingSurvival.value.map((item) => {
                const resolution = report.resolutions[item.id] as SurvivalResolution | undefined;
                return (
                  <div class="arb-card survival" key={item.id}>
                    <div class="arb-head"><code>{item.catalogId}</code><strong>{item.recordTitle}</strong></div>
                    <p class="arb-reason">{item.reason}</p>
                    <div class="arb-choices">
                      <button class={`choice ${resolution === 'keep' ? 'selected local' : ''}`} onClick$={() => props.onResolve(item.id, 'keep')}>本机保留（标记“目录已移除”）</button>
                      <button class={`choice ${resolution === 'remove' ? 'selected catalog' : ''}`} onClick$={() => props.onResolve(item.id, 'remove')}>按目录删除</button>
                    </div>
                  </div>
                );
              })}
              {!pendingSurvival.value.length && <p class="report-empty">没有需要存活裁决的记录。</p>}
            </div>
          </section>

          <section class="report-section">
            <h4>目录新增记录（可导入本机工作区）</h4>
            <div class="report-list">
              {report.additions.map((item) => {
                const imported = importedIds.value.has(item.catalogId);
                return (
                  <div class="report-row" key={item.id}>
                    <code>{item.catalogId}</code>
                    <span>{item.identifier} · {item.rights}</span>
                    <button
                      class="button small ghost"
                      disabled={imported}
                      onClick$={async () => { await props.onImport(item.catalogId); importedIds.value = new Set(importedIds.value).add(item.catalogId); }}
                    >{imported ? '已导入' : '导入本机'}</button>
                  </div>
                );
              })}
              {!report.additions.length && <p class="report-empty">目录没有新增记录。</p>}
            </div>
          </section>

          <div class="modal-footer report-footer">
            <button class="button ghost" onClick$={props.onExport}>导出对账记录</button>
            <button class="button ghost" onClick$={props.onCloseReport}>暂不处理（关闭，报告保留）</button>
            <button class="button primary" disabled={!allResolved.value} onClick$={props.onApply}>
              {allResolved.value ? '应用对账结果并推进基线' : `还有 ${report.pending.filter((item) => !report.resolutions[item.id]).length} 项待裁决`}
            </button>
          </div>
        </div>
      )}
    </Modal.Panel>
  );
});
