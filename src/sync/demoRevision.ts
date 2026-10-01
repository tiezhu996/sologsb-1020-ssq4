import type { ArchiveRecord, MergeResult } from '../types';
import { publishRevision } from './catalogServer';

const now = () => new Date().toISOString();

/**
 * 演示用：让离线期间的馆藏目录产生一组覆盖全部对账分支的修订——
 * 单方面权利修订（自动吸收）、单方面编号修订（自动吸收）、
 * 与本机合并冲突的修订（待裁）、移除已合并记录的来源编号（存活待处理）、
 * 移除未合并记录（自动删除）、以及一条新增记录（待导入）。
 * 没有合并记录时自动退化为只产生可自动应用的修订。
 */
export function publishDemoRevision(records: ArchiveRecord[], merges: MergeResult[]) {
  const merged = records.find((record) => record.status === 'merged');
  const unmerged = records.filter((record) => record.status !== 'merged');

  // 被合并记录吸收的来源目录锚点（含合并后沿用的锚点）
  const mergeSourceIds = new Set<string>();
  merges.forEach((merge) => {
    if (merge.leftCatalogId) mergeSourceIds.add(merge.leftCatalogId);
    if (merge.rightCatalogId) mergeSourceIds.add(merge.rightCatalogId);
  });

  return publishRevision((snapshots) => {
    const next = snapshots.map((record) => ({ ...record }));
    const byId = new Map(next.map((record) => [record.catalogId, record]));
    const hasServer = (catalogId?: string) => !!catalogId && byId.has(catalogId);

    // 1. 未合并记录：单方面改权利 → 自动吸收
    const rightsTarget = unmerged.find((record) => hasServer(record.catalogId));
    const rightsRecord = rightsTarget ? byId.get(rightsTarget.catalogId!) : undefined;
    if (rightsRecord) rightsRecord.rights = `${rightsRecord.rights}（目录离线期间复核更新）`;

    // 2. 未合并记录：单方面改编号 → 自动吸收（catalogId 锚点不变）
    const idTarget = unmerged.find((record) => record.catalogId !== rightsTarget?.catalogId && hasServer(record.catalogId));
    const idRecord = idTarget ? byId.get(idTarget.catalogId!) : undefined;
    if (idRecord) idRecord.identifier = `${idRecord.identifier}-R${Date.now() % 1000}`;

    if (merged?.catalogId) {
      const mergedSnap = byId.get(merged.catalogId);
      if (mergedSnap) {
        // 3. 与本机合并不同的权利取值 → 待裁
        mergedSnap.rights = `目录权利裁定 ${new Date().getFullYear()}`;
        // 4. 编号也改为目录新号 → 待裁（本机合并沿用的是旧号，catalogId 锚点不变）
        mergedSnap.identifier = `${mergedSnap.identifier}-CAT-NEW`;
        mergedSnap.updatedAt = now();
      }
      // 5. 移除一条被本机合并吸收、但不是合并后沿用锚点的来源 → 存活待处理
      const removedSource = [...mergeSourceIds]
        .filter((catalogId) => catalogId !== merged.catalogId && byId.has(catalogId))[0];
      if (removedSource) byId.get(removedSource)!.alive = false;
    }

    // 6. 移除一条未合并、且未参与合并的记录 → 自动删除
    const deleteTarget = unmerged.find(
      (record) =>
        hasServer(record.catalogId) &&
        !mergeSourceIds.has(record.catalogId!) &&
        record.catalogId !== rightsTarget?.catalogId &&
        record.catalogId !== idTarget?.catalogId
    );
    if (deleteTarget?.catalogId) {
      byId.delete(deleteTarget.catalogId);
      const index = next.findIndex((record) => record.catalogId === deleteTarget.catalogId);
      if (index >= 0) next.splice(index, 1);
    }

    // 7. 新增一条目录记录 → 待导入
    next.push({
      catalogId: `CAT-NEW-${Date.now() % 100000}`,
      identifier: `OH-CAT-${String(next.length + 1).padStart(3, '0')}`,
      rights: '目录新增 · 待本机导入',
      alive: true,
      updatedAt: now()
    });

    return next;
  });
}

export interface ManualRevision {
  catalogId: string;
  identifier?: string;
  rights?: string;
  alive?: boolean;
}

export function publishManualRevision(revisions: ManualRevision[]) {
  return publishRevision((records) =>
    records.map((record) => {
      const revision = revisions.find((item) => item.catalogId === record.catalogId);
      if (!revision) return record;
      return {
        ...record,
        identifier: revision.identifier ?? record.identifier,
        rights: revision.rights ?? record.rights,
        alive: revision.alive ?? record.alive,
        updatedAt: now()
      };
    })
  );
}
