#!/usr/bin/env bun
/**
 * backfill-pi-craft-metadata.ts
 *
 * 给 ~/.pi/agent/sessions/ 下的 Pi 原生会话补全 craft 元数据。
 *
 * Pi 原生会话的 header 只有 {type, version, id, timestamp, cwd}，没有 craft 子对象。
 * Craft 读取时会回退用 header.cwd 作为 workspaceRootPath，但 UI 列表需要的
 * messageCount / preview / lastMessageRole 等字段无法从 header 直接获取。
 *
 * 本脚本扫描所有 Pi 会话文件，对缺少 craft.workspaceRootPath 的文件，
 * 调用 readTreeSessionAsStoredSession + writeTreeSessionCraftMetadata 补全。
 *
 * 用法：
 *   bun run scripts/backfill-pi-craft-metadata.ts              # dry-run，只统计
 *   bun run scripts/backfill-pi-craft-metadata.ts --apply      # 真正写入
 *   bun run scripts/backfill-pi-craft-metadata.ts --bucket xxx # 只处理指定 bucket
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 直接从源码 import（脚本位于仓库内，bun 支持直跑 .ts）
import {
  readTreeSessionHeader,
  readTreeSessionAsStoredSession,
  writeTreeSessionCraftMetadata,
  type TreeSessionHeader,
} from '../packages/shared/src/sessions/tree-jsonl.ts';
import { PI_SESSIONS_DIR } from '../packages/shared/src/config/paths.ts';

interface Stats {
  scanned: number;
  needsBackfill: number;
  backfilled: number;
  skippedHasCraft: number;
  failed: number;
  byBucket: Map<string, { scanned: number; backfilled: number }>;
}

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const bucketFilter = (() => {
  const idx = process.argv.indexOf('--bucket');
  return idx >= 0 ? process.argv[idx + 1] : undefined;
})();

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function needsBackfill(header: TreeSessionHeader | null): boolean {
  if (!header) return false;
  // 只处理 Pi tree JSONL v3 会话
  if (header.type !== 'session') return false;
  // 已有 craft.workspaceRootPath 就跳过
  const craft = header.craft;
  if (isRecord(craft) && typeof craft.workspaceRootPath === 'string' && craft.workspaceRootPath.length > 0) {
    return false;
  }
  return true;
}

function main(): void {
  if (!existsSync(PI_SESSIONS_DIR)) {
    console.error(`Pi sessions dir not found: ${PI_SESSIONS_DIR}`);
    process.exit(1);
  }

  const stats: Stats = {
    scanned: 0,
    needsBackfill: 0,
    backfilled: 0,
    skippedHasCraft: 0,
    failed: 0,
    byBucket: new Map(),
  };

  const buckets = readdirSync(PI_SESSIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const bucket of buckets) {
    if (bucketFilter && bucket !== bucketFilter) continue;

    const bucketDir = join(PI_SESSIONS_DIR, bucket);
    let files: string[] = [];
    try {
      files = readdirSync(bucketDir)
        .filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    let bucketScanned = 0;
    let bucketBackfilled = 0;

    for (const file of files) {
      stats.scanned++;
      bucketScanned++;
      const fullPath = join(bucketDir, file);

      // Step 1: 快速读 header（8KB）
      let header: TreeSessionHeader | null;
      try {
        header = readTreeSessionHeader(fullPath);
      } catch (err) {
        console.warn(`  [FAIL] read header: ${file} — ${(err as Error).message}`);
        stats.failed++;
        continue;
      }

      if (!header) {
        console.warn(`  [SKIP] not a tree session: ${file}`);
        stats.failed++;
        continue;
      }

      if (!needsBackfill(header)) {
        stats.skippedHasCraft++;
        continue;
      }

      stats.needsBackfill++;
      const relPath = `${bucket}/${file}`;
      console.log(`  [BACKFILL] ${relPath}`);
      console.log(`    pi id: ${header.id}`);
      console.log(`    cwd:   ${header.cwd}`);
      console.log(`    ts:    ${header.timestamp}`);

      if (!apply) {
        console.log(`    (dry-run, not writing)`);
        continue;
      }

      // Step 2: 完整读取会话（计算 messages / preview 等）
      let session;
      try {
        session = readTreeSessionAsStoredSession(fullPath, {
          workspaceRootPath: header.cwd,
        });
      } catch (err) {
        console.warn(`    [FAIL] readTreeSessionAsStoredSession: ${(err as Error).message}`);
        stats.failed++;
        continue;
      }

      if (!session) {
        console.warn(`    [FAIL] could not parse session`);
        stats.failed++;
        continue;
      }

      // Step 3: 写回 craft metadata（含 workspaceRootPath + messageCount + preview 等）
      try {
        const ok = writeTreeSessionCraftMetadata(fullPath, session);
        if (ok) {
          stats.backfilled++;
          bucketBackfilled++;
          console.log(`    [OK] craft.workspaceRootPath = ${session.workspaceRootPath}`);
          console.log(`         craft.id = ${session.craftId}`);
          console.log(`         messageCount = ${session.messageCount}`);
        } else {
          stats.failed++;
          console.warn(`    [FAIL] writeTreeSessionCraftMetadata returned false`);
        }
      } catch (err) {
        stats.failed++;
        console.warn(`    [FAIL] write: ${(err as Error).message}`);
      }
    }

    stats.byBucket.set(bucket, { scanned: bucketScanned, backfilled: bucketBackfilled });
  }

  // 汇总报告
  console.log('\n========================================');
  console.log('Backfill Pi Craft Metadata — Summary');
  console.log('========================================');
  console.log(`Mode:            ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Buckets scanned: ${stats.byBucket.size}`);
  console.log(`Files scanned:   ${stats.scanned}`);
  console.log(`Already has craft: ${stats.skippedHasCraft}`);
  console.log(`Needs backfill:  ${stats.needsBackfill}`);
  console.log(`Backfilled:      ${stats.backfilled}`);
  console.log(`Failed:          ${stats.failed}`);
  console.log('\nBy bucket:');
  for (const [bucket, s] of stats.byBucket) {
    const flag = s.backfilled > 0 ? ' *' : '';
    console.log(`  ${bucket}: scanned=${s.scanned}, backfilled=${s.backfilled}${flag}`);
  }

  if (!apply && stats.needsBackfill > 0) {
    console.log('\n=> Dry-run only. Run with --apply to write.');
  } else if (apply && stats.backfilled > 0) {
    console.log('\n=> Done. Craft UI can now list these sessions with metadata.');
  } else if (stats.needsBackfill === 0) {
    console.log('\n=> Nothing to backfill. All sessions already have craft metadata.');
  }

  process.exit(stats.failed > 0 ? 1 : 0);
}

main();
