import * as assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CURRENT_EVENT_SCHEMA_VERSION, GameUIEvent } from '../game/GameEvents';
import { EventLog } from './EventLog';
import { projectEventForViewer } from './EventVisibility';

function writeLines(dir: string, gameId: string, lines: string[]): string {
  const file = path.join(dir, `${gameId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  return file;
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanguo-event-log-'));
  try {
    const legacy = { type: 'game_paused', data: { gameId: 'legacy' }, timestamp: 10 };
    const v1 = { type: 'game_resumed', data: { gameId: 'legacy' }, schemaVersion: 1, timestamp: 11 };
    const explicit = { type: 'phase_change', data: { gameId: 'legacy', phase: 'night', round: 1 }, schemaVersion: 1, sequence: 5, timestamp: 12 };
    const duplicate = { type: 'game_paused', data: { gameId: 'legacy' }, schemaVersion: 1, sequence: 5, timestamp: 13 };
    const backwards = { type: 'game_resumed', data: { gameId: 'legacy' }, schemaVersion: 1, sequence: 4, timestamp: 14 };
    const invalidSequences = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '6', null].map((sequence, index) => ({
      type: 'game_paused', data: { gameId: 'legacy' }, schemaVersion: 1, sequence, timestamp: 20 + index,
    }));
    const legacyAfterExplicit = { type: 'game_cancelled', data: { gameId: 'legacy' }, timestamp: 30 };
    const future = { type: 'game_cancelled', data: { gameId: 'legacy' }, schemaVersion: 99, sequence: 99, timestamp: 31 };
    const historyFile = writeLines(dir, 'legacy', [
      JSON.stringify(legacy),
      JSON.stringify(v1),
      JSON.stringify(explicit),
      JSON.stringify(duplicate),
      JSON.stringify(backwards),
      ...invalidSequences.map(event => JSON.stringify(event)),
      JSON.stringify(legacyAfterExplicit),
      JSON.stringify(future),
      '{broken',
    ]);
    const originalHistory = fs.readFileSync(historyFile, 'utf-8');

    const log = new EventLog(dir);
    const loaded = log.loadEvents('legacy');
    assert.equal(loaded.length, 4, '应接受 legacy/合法显式序号并跳过未来版本、非法/重复/倒序序号和损坏行');
    assert.ok(loaded.every(event => event.schemaVersion === CURRENT_EVENT_SCHEMA_VERSION));
    assert.deepEqual(loaded.map(event => event.sequence), [1, 2, 5, 6], 'legacy sequence 应基于已接受事件在内存中严格递增补齐');
    assert.equal(fs.readFileSync(historyFile, 'utf-8'), originalHistory, '兼容解码不得回写历史文件');

    // 新格式原样落盘并保留 sequence；写入端对非法/重复/倒序显式序号 fail-closed。
    const makeEvent = (sequence: number, type: 'game_paused' | 'game_resumed' = 'game_paused'): GameUIEvent => ({
      type,
      data: { gameId: 'new-format' },
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
      sequence,
      timestamp: 100 + sequence,
    } as GameUIEvent);
    log.record(makeEvent(1));
    log.record(makeEvent(1, 'game_resumed'));
    log.record(makeEvent(0));
    log.record(makeEvent(3, 'game_resumed'));
    log.record(makeEvent(2));
    assert.deepEqual(log.loadEvents('new-format').map(event => event.sequence), [1, 3]);
    await new Promise(resolve => setTimeout(resolve, 20));

    // legacy 文件可能含第一阶段以前落盘的私密事件；读取兼容，但回放必须经当前策略拒绝。
    const legacyPrivate = {
      type: 'seer_result_private',
      data: { gameId: 'legacy-private', seerId: 'seer', targetName: '狼', isWolf: true, round: 1 },
      timestamp: 20,
    };
    writeLines(dir, 'legacy-private', [JSON.stringify(legacyPrivate)]);
    const decodedPrivate = log.loadEvents('legacy-private')[0];
    assert.ok(decodedPrivate, 'EventLog 应继续兼容读取 legacy v1');
    assert.equal(
      projectEventForViewer(decodedPrivate, { kind: 'spectator', omniscient: false }),
      null,
      'legacy owner-private 不得直接进入公共回放',
    );

    console.log('EventLog 离线测试通过');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
