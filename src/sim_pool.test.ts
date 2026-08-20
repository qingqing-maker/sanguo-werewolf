import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { LedgerReport } from './llm/BudgetLedger';
import type { SimFingerprint } from './simFingerprint';
import {
  BatchLifecycleDependencies,
  finishBatch,
  initializeBatch,
  parseSimPoolOptions,
  SimPoolOptions,
} from './simPoolCore';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error: any) {
    failed++;
    process.stdout.write(`  ✗ ${name}\n      ${String(error?.message || error).split('\n')[0]}\n`);
  }
}

const fingerprint = (provider: string): SimFingerprint => ({
  fingerprintVersion: 2,
  random: { algorithm: 'x', schemaVersion: 2, derivationVersion: 2 },
  promptHash: 'hash',
  llm: provider === 'mock'
    ? { provider: 'mock', modelId: '(mock-无真实模型)', baseHost: null }
    : { provider: 'volcengine', modelId: 'safe-model', baseHost: 'safe.example.com' },
  aiDifficulty: 'standard',
  tacticStyles: true,
  misfire: { seerRepeat: 0.12, guardRepeat: 0.12 },
  pacing: { fastMode: true, scale: 1 },
  fallback: { strategy: 'none', timeoutMs: 60_000 },
  runtime: { node: process.version, platform: process.platform },
});

function snapshot(overrides: Record<string, number> = {}) {
  return {
    period: 'period-1', tokenBudget: 10_000, callBudget: 100,
    calls: 2, settledTokens: 100, reservedTokens: 20,
    committedTokens: 120, activeReservations: 1, ...overrides,
  };
}

function ledgerReport(overrides: Partial<LedgerReport> = {}): LedgerReport {
  return {
    exists: true,
    ledgerPath: 'C:\\Users\\secret\\runs\\llm-budget-safe-model.jsonl',
    lockPath: 'C:\\Users\\secret\\runs\\llm-budget-safe-model.jsonl.lock',
    lockPresent: false,
    configPeriod: 'period-1',
    configTokenBudget: 10_000,
    configCallBudget: 100,
    snapshot: snapshot(),
    pendingReservations: [{ id: 'reservation-secret', tokens: 20, pid: 1, at: 'now' }],
    ...overrides,
  };
}

function options(useReal: boolean): SimPoolOptions {
  return parseSimPoolOptions(
    useReal ? ['--provider=real', '--games=3', '--concurrency=9'] : ['--games=3'],
    { projectRoot: 'C:\\project', nowMs: 42, nowIso: '2026-08-17T01:02:03.000Z' },
  );
}

function fakeDependencies(events: string[] = []): BatchLifecycleDependencies & { written: any[] } {
  const written: any[] = [];
  return {
    written,
    getConfiguredProviderName: () => { events.push('provider'); return 'volcengine'; },
    assertProviderConfiguration: (provider, requireReal) => events.push(`validate:${provider}:${requireReal}`),
    inspectBudget: () => { events.push('budget'); return ledgerReport(); },
    collectFingerprint: (_difficulty, useReal) => { events.push('fingerprint'); return fingerprint(useReal ? 'real' : 'mock'); },
    fallbackStrategy: () => { events.push('fallback'); return 'none'; },
    timeoutMs: () => { events.push('timeout'); return 60_000; },
    nowIso: () => { events.push('time'); return '2026-08-17T01:02:03.000Z'; },
    ensureDirectory: (directory) => events.push(`mkdir:${directory}`),
    writeRecord: (_outPath, record) => { events.push('write'); written.push(record); },
    appendRecord: (_outPath, record) => { events.push('append'); written.push(record); },
  };
}

async function main(): Promise<void> {
  console.log('\n=== sim_pool 编排层离线测试 ===\n');

  await check('Mock 只校验 mock，绝不读取真实 Provider 名称或预算账本', () => {
    const events: string[] = [];
    const deps = fakeDependencies(events);
    deps.getConfiguredProviderName = () => { throw new Error('Mock 不得读取真实 Provider'); };
    deps.inspectBudget = () => { throw new Error('Mock 不得读取真实账本'); };
    const initialized = initializeBatch(options(false), deps);
    assert.equal(initialized.budget.applicability, 'not_applicable');
    assert.equal(events[0], 'validate:mock:false');
    assert.equal(initialized.meta.fingerprint.llm.provider, 'mock');
  });

  await check('真实配置失败时不巡检、不建目录、不采集指纹、不写 meta', () => {
    const events: string[] = [];
    const deps = fakeDependencies(events);
    deps.assertProviderConfiguration = () => { events.push('validate'); throw new Error('bad config'); };
    assert.throws(() => initializeBatch(options(true), deps), /bad config/);
    assert.deepEqual(events, ['provider', 'validate']);
    assert.equal(deps.written.length, 0);
  });

  await check('真实启动严格按 Provider→校验→baseline→指纹/meta→目录→写入', () => {
    const events: string[] = [];
    const deps = fakeDependencies(events);
    const initialized = initializeBatch(options(true), deps);
    assert.deepEqual(events, [
      'provider', 'validate:volcengine:true', 'budget', 'fingerprint',
      'time', 'fallback', 'timeout', `mkdir:${path.dirname(options(true).outPath)}`, 'write',
    ]);
    assert.equal(initialized.meta.concurrency, 1, '真实模式必须强制串行');
  });

  await check('meta 白名单脱敏账本，只保留文件名和 snapshot', () => {
    const deps = fakeDependencies();
    const { meta } = initializeBatch(options(true), deps);
    const serialized = JSON.stringify(meta);
    assert.ok(serialized.includes('llm-budget-safe-model.jsonl'));
    for (const secret of ['Users\\\\secret', '.lock', 'reservation-secret', 'API_KEY_SENTINEL']) {
      assert.equal(serialized.includes(secret), false, `不得包含 ${secret}`);
    }
    if (meta.budget.applicability !== 'real') throw new Error('预算类型错误');
    assert.deepEqual(Object.keys(meta.budget).sort(), [
      'applicability', 'baseline', 'baselineActiveReservations', 'callBudget',
      'ledgerId', 'period', 'tokenBudget',
    ]);
  });

  await check('账本路径脱敏同时兼容 Windows 与 POSIX 路径', () => {
    for (const ledgerPath of [
      'C:\\Users\\secret\\runs\\llm-budget-safe-model.jsonl',
      '/home/secret/runs/llm-budget-safe-model.jsonl',
    ]) {
      const deps = fakeDependencies();
      deps.inspectBudget = () => ledgerReport({ ledgerPath });
      const { meta } = initializeBatch(options(true), deps);
      if (meta.budget.applicability !== 'real') throw new Error('预算类型错误');
      assert.equal(meta.budget.ledgerId, 'llm-budget-safe-model.jsonl');
      assert.equal(JSON.stringify(meta).includes('secret'), false);
    }
  });

  await check('summary completed 表示全部局号已尝试，不等同于全部成功', () => {
    const deps = fakeDependencies();
    const initialized = initializeBatch(options(false), deps);
    assert.equal(finishBatch(options(false), initialized.budget, 3, deps).completed, true);
    assert.equal(finishBatch(options(false), initialized.budget, 2, deps).completed, false);
  });

  await check('真实 summary 记录 end/delta，Mock 不读取结束账本', () => {
    const realDeps = fakeDependencies();
    const real = initializeBatch(options(true), realDeps);
    realDeps.inspectBudget = () => ledgerReport({ snapshot: snapshot({ calls: 5, settledTokens: 250, reservedTokens: 0, committedTokens: 250, activeReservations: 0 }) });
    const summary = finishBatch(options(true), real.budget, 3, realDeps);
    if (summary.budget.applicability !== 'real') throw new Error('预算类型错误');
    assert.deepEqual(summary.budget.delta, { calls: 3, settledTokens: 150, reservedTokens: -20, committedTokens: 130 });
    assert.equal(summary.budget.endActiveReservations, 0);

    const mockDeps = fakeDependencies();
    const mock = initializeBatch(options(false), mockDeps);
    mockDeps.inspectBudget = () => { throw new Error('Mock 收尾不得读账本'); };
    assert.equal(finishBatch(options(false), mock.budget, 3, mockDeps).budget.applicability, 'not_applicable');
  });

  await check('参数解析支持默认路径、嵌套 --out 和路径内等号', () => {
    const context = { projectRoot: 'C:\\project', nowMs: 99, nowIso: '2026-08-17T01:02:03.004Z' };
    const defaults = parseSimPoolOptions([], context);
    assert.equal(defaults.games, 200);
    assert.equal(defaults.concurrency, 8);
    assert.ok(defaults.outPath.endsWith(path.join('runs', 'mock-2026-08-17T01-02-03-004Z.jsonl')));
    const custom = parseSimPoolOptions(['--out=nested/a=b.jsonl'], context);
    assert.equal(custom.outPath, path.resolve(context.projectRoot, 'nested/a=b.jsonl'));
  });

  await check('空 out 和非法数字参数 fail fast', () => {
    const context = { projectRoot: 'C:\\project', nowMs: 99, nowIso: '2026-08-17T01:02:03.004Z' };
    assert.throws(() => parseSimPoolOptions(['--out='], context), /--out 不能为空/);
    for (const bad of ['--games=0', '--concurrency=-1', '--seed=-1', '--maxRounds=1.5']) {
      assert.throws(() => parseSimPoolOptions([bad], context));
    }
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
}

main();
