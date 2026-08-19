import * as assert from 'node:assert/strict';
import { Faction, RoleType } from './types';
import { analyzeSimJsonl } from './simReportCore';
import {
  makeDegradeBuckets,
  makeFallbackBuckets,
  makeLLMRequestMetrics,
} from './simMetrics';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error: any) {
    failed++;
    failures.push(name);
    process.stdout.write(`  ✗ ${name}\n      ${String(error?.message || error).split('\n')[0]}\n`);
  }
}

function line(value: unknown): string {
  return JSON.stringify(value);
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    winner: 'good',
    reason: '所有狼人已被消灭',
    rounds: 3,
    goodVotes: 10,
    goodHits: 6,
    providerFallbacks: makeFallbackBuckets(),
    decisionDegrades: makeDegradeBuckets(),
    llmRequests: { ...makeLLMRequestMetrics(), total: 10, chat: 4, chatJSON: 6, succeeded: 10 },
    effectiveProvider: 'real',
    firstNightWolfTarget: {
      playerId: 'player_3',
      name: '诸葛亮',
      roleType: RoleType.SEER,
      faction: Faction.GOOD,
    },
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log('\n=== sim_report 纯 fixture 测试 ===\n');

  await check('胜率、平均回合、逐票命中与 Wilson 输入只统计合法 winner', () => {
    const report = analyzeSimJsonl([
      line({ type: 'meta', provider: 'mock' }),
      line(result()),
      line(result({ winner: 'wolf', rounds: 5, goodVotes: 4, goodHits: 1 })),
      line(result({ winner: 'draw', rounds: 999, goodVotes: 999, goodHits: 999 })),
    ].join('\n'));
    assert.equal(report.valid, 2);
    assert.equal(report.goodWins, 1);
    assert.equal(report.wolfWins, 1);
    assert.equal(report.goodRate, 0.5);
    assert.equal(report.averageRounds, 4);
    assert.equal(report.goodVotes, 14);
    assert.equal(report.goodHits, 7);
    assert.equal(report.hitRate, 0.5);
    assert.equal(report.ignoredRecords, 1);
    assert.ok(report.goodCI[0] < 0.5 && report.goodCI[1] > 0.5);
  });

  await check('首夜狼刀分别按人物、角色、阵营和座位聚合，不混用跨局 playerId', () => {
    const zhugeSeat3 = result();
    const zhugeSeat5 = result({
      firstNightWolfTarget: {
        playerId: 'player_5',
        name: '诸葛亮',
        roleType: RoleType.VILLAGER,
        faction: Faction.GOOD,
      },
    });
    const zhangfeiSeat3 = result({
      firstNightWolfTarget: {
        playerId: 'player_3',
        name: '张飞',
        roleType: RoleType.VILLAGER,
        faction: Faction.GOOD,
      },
    });
    const report = analyzeSimJsonl([
      line(zhugeSeat3),
      line(zhugeSeat5),
      line(zhangfeiSeat3),
    ].join('\n'));
    assert.equal(report.firstNightTargets.recordedGames, 3);
    assert.deepEqual(report.firstNightTargets.byName.map(item => [item.name, item.count]), [
      ['诸葛亮', 2],
      ['张飞', 1],
    ]);
    assert.deepEqual(report.firstNightTargets.byRole.map(item => [item.roleType, item.count]), [
      [RoleType.VILLAGER, 2],
      [RoleType.SEER, 1],
    ]);
    assert.deepEqual(report.firstNightTargets.bySeat.map(item => [item.playerId, item.count]), [
      ['player_3', 2],
      ['player_5', 1],
    ]);
    assert.deepEqual(report.firstNightTargets.byFaction.map(item => [item.faction, item.count]), [
      [Faction.GOOD, 3],
    ]);
    assert.equal(report.firstNightTargets.byName[0].rate, 2 / 3);
  });

  await check('逻辑请求是 fallback/degrade 分母，并按 reason/kind/operation 分桶', () => {
    const fallback = makeFallbackBuckets();
    fallback.timeout = 2;
    fallback.total = 999;
    fallback.byOperation = { chat: 1, chatJSON: 1 };
    const degrade = makeDegradeBuckets();
    degrade.parse = 1;
    degrade.total = 777;
    degrade.byOperation = { vote: 1 };
    const report = analyzeSimJsonl(line(result({
      providerFallbacks: fallback,
      decisionDegrades: degrade,
      llmRequests: { total: 500, chat: 4, chatJSON: 6, succeeded: 9, failed: 1, cancelled: 0, errors: { timeout: 1 } },
      effectiveProvider: 'mixed',
    })));
    assert.equal(report.llmRequests?.total, 10, 'total 应由 chat+chatJSON 重算');
    assert.equal(report.fallback.total, 2, 'total 应由分类桶重算');
    assert.equal(report.fallback.rate, 0.2);
    assert.deepEqual(report.fallback.byOperation, { chat: 1, chatJSON: 1 });
    assert.equal(report.degrade.total, 1);
    assert.equal(report.degrade.rate, 0.1);
    assert.deepEqual(report.degrade.byOperation, { vote: 1 });
    assert.deepEqual(report.llmRequests?.errors, { timeout: 1 });
  });

  await check('effectiveProvider=real 但有决策降级时不进入严格干净 real', () => {
    const degrade = makeDegradeBuckets();
    degrade.other = 1;
    degrade.total = 1;
    const report = analyzeSimJsonl([
      line(result({ decisionDegrades: degrade })),
      line(result({ winner: 'wolf', llmRequests: { total: 2, chat: 1, chatJSON: 1, succeeded: 1, failed: 1, cancelled: 0, errors: { parse: 1 } } })),
      line(result({ winner: 'good' })),
    ].join('\n'));
    assert.equal(report.effectiveProvider.real, 3);
    assert.equal(report.cleanReal.valid, 1);
    assert.equal(report.cleanReal.goodWins, 1);
  });

  await check('batch_summary 的预算结束快照和差值覆盖 meta baseline', () => {
    const baseline = {
      period: 'p1', tokenBudget: 1000, callBudget: 20, calls: 2,
      settledTokens: 100, reservedTokens: 20, committedTokens: 120, activeReservations: 1,
    };
    const completed = {
      applicability: 'real', ledgerId: 'llm-budget-model.jsonl', period: 'p1',
      tokenBudget: 1000, callBudget: 20, baseline,
      end: { ...baseline, calls: 5, settledTokens: 220, reservedTokens: 0, committedTokens: 220, activeReservations: 0 },
      delta: { calls: 3, settledTokens: 120, reservedTokens: -20, committedTokens: 100 },
      baselineActiveReservations: 1, endActiveReservations: 0,
    };
    const report = analyzeSimJsonl([
      line({ type: 'meta', budget: { ...completed, end: undefined, delta: undefined } }),
      line({ type: 'batch_summary', finishedAt: 'now', budget: completed }),
    ].join('\n'));
    assert.equal(report.budget?.applicability, 'real');
    if (report.budget?.applicability !== 'real') throw new Error('预算类型错误');
    assert.equal(report.budget.delta?.calls, 3);
    assert.equal(report.budget.end?.activeReservations, 0);
  });

  await check('Mock 预算明确为不适用', () => {
    const report = analyzeSimJsonl(line({
      type: 'meta',
      budget: { applicability: 'not_applicable', reason: 'mock_provider' },
    }));
    assert.deepEqual(report.budget, { applicability: 'not_applicable', reason: 'mock_provider' });
  });

  await check('旧 JSONL 保持可读，但缺少分母和首刀时显示未记录而非 0%', () => {
    const report = analyzeSimJsonl(line({
      type: 'result', winner: 'good', reason: '旧数据', rounds: 2,
      goodVotes: 3, goodHits: 1, effectiveProvider: 'real',
    }));
    assert.equal(report.valid, 1);
    assert.equal(report.llmRequests, null);
    assert.equal(report.fallback.rate, null);
    assert.equal(report.degrade.rate, null);
    assert.equal(report.firstNightTargets.recordedGames, 0);
    assert.equal(report.cleanReal.valid, 0, '旧数据缺请求失败字段，不能误算为严格干净');
  });

  await check('非法 JSON、未知类型与非法 winner 不污染统计', () => {
    const report = analyzeSimJsonl([
      '{bad json',
      line({ nope: true }),
      line({ type: 'future_record' }),
      line({ type: 'result', winner: 'nobody', rounds: 99, goodVotes: 99, goodHits: 99 }),
      line({ type: 'error', message: 'worker failed' }),
      line(result()),
    ].join('\n'));
    assert.equal(report.malformedLines, 1);
    assert.equal(report.ignoredRecords, 3);
    assert.equal(report.errors, 1);
    assert.equal(report.valid, 1);
    assert.equal(report.averageRounds, 3);
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) {
    console.error(`失败用例：${failures.join('、')}`);
    process.exitCode = 1;
  }
}

main();
