/**
 * nameResolver 离线单测。
 * 与仓库其他测试保持同风格：node:assert/strict + ts-node 直跑，不引第三方框架。
 *
 * 覆盖重点：
 *   1) raw 已是合法 ID → 原样返回。
 *   2) raw 是精确中文名 → 解析成对应 ID。
 *   3) raw 是含名短语（"我投张飞"）→ 子串匹配解析。
 *   4) 命中玩家但不在 validIds 白名单 → 视为未解析（返回 undefined）。
 *   5) 空值 / 无匹配 → undefined。
 */

import { strict as assert } from 'node:assert';
import { resolvePlayerIdByName, NameIdPair } from './nameResolver';

const PLAYERS: NameIdPair[] = [
  { id: 'player_0', name: '张飞' },
  { id: 'player_1', name: '关羽' },
  { id: 'player_2', name: '刘备' },
  { id: 'player_3', name: '诸葛亮' },
];
const ALL_IDS = PLAYERS.map(p => p.id);

interface Case {
  name: string;
  run: () => void;
}
const cases: Case[] = [];
function test(name: string, run: () => void): void {
  cases.push({ name, run });
}

test('raw 已是合法 ID → 原样返回', () => {
  assert.equal(resolvePlayerIdByName(PLAYERS, 'player_2', ALL_IDS), 'player_2');
});

test('精确中文名"张飞"→ player_0', () => {
  assert.equal(resolvePlayerIdByName(PLAYERS, '张飞', ALL_IDS), 'player_0');
});

test('含名短语"我这票投张飞"→ player_0', () => {
  assert.equal(resolvePlayerIdByName(PLAYERS, '我这票投张飞', ALL_IDS), 'player_0');
});

test('含名短语"就砍诸葛亮"→ player_3', () => {
  assert.equal(resolvePlayerIdByName(PLAYERS, '就砍诸葛亮', ALL_IDS), 'player_3');
});

test('命中玩家但不在 validIds（已出局）→ undefined', () => {
  // 张飞已死，白名单里没有 player_0。
  const alive = ['player_1', 'player_2', 'player_3'];
  assert.equal(resolvePlayerIdByName(PLAYERS, '张飞', alive), undefined);
});

test('raw 是不在白名单的合法 ID → 不直接返回，尝试按名亦无果 → undefined', () => {
  const alive = ['player_1', 'player_2'];
  // player_0 是真实 ID 但不在白名单；raw 里也不含任何白名单玩家名 → undefined。
  assert.equal(resolvePlayerIdByName(PLAYERS, 'player_0', alive), undefined);
});

test('完全无匹配的乱码 → undefined', () => {
  assert.equal(resolvePlayerIdByName(PLAYERS, '不存在的人', ALL_IDS), undefined);
});

test('空串 → undefined', () => {
  assert.equal(resolvePlayerIdByName(PLAYERS, '', ALL_IDS), undefined);
});

test('undefined → undefined', () => {
  assert.equal(resolvePlayerIdByName(PLAYERS, undefined, ALL_IDS), undefined);
});

test('null → undefined', () => {
  assert.equal(resolvePlayerIdByName(PLAYERS, null, ALL_IDS), undefined);
});

// —— 执行 ——
let passed = 0;
let failed = 0;
const failures: string[] = [];
for (const c of cases) {
  try {
    c.run();
    passed++;
    process.stdout.write(`  ✓ ${c.name}\n`);
  } catch (e: any) {
    failed++;
    failures.push(c.name);
    process.stdout.write(`  ✗ ${c.name}\n`);
    process.stdout.write(`      ${String(e?.message || e).split('\n')[0]}\n`);
  }
}
process.stdout.write(`\n=== nameResolver: ${passed} 通过，${failed} 失败 ===\n`);
if (failures.length > 0) {
  process.stdout.write('失败用例：\n');
  for (const f of failures) process.stdout.write(`  · ${f}\n`);
  process.exit(1);
}
