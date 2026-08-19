import * as path from 'node:path';
import type { LedgerReport } from './llm/BudgetLedger';
import type { SimFingerprint } from './simFingerprint';
import {
  computeBudgetDelta,
  SimBatchSummaryRecord,
  SimBudgetApplicable,
  SimBudgetRecord,
  SimBudgetSnapshot,
} from './simMetrics';

export type SimDifficulty = 'novice' | 'standard' | 'expert';

export interface SimPoolOptions {
  useReal: boolean;
  games: number;
  requestedConcurrency: number;
  concurrency: number;
  wolves?: number;
  villagers?: number;
  maxRounds?: number;
  difficulty: SimDifficulty;
  seed: number;
  outPath: string;
}

export interface SimMetaRecord {
  type: 'meta';
  provider: 'real' | 'mock';
  games: number;
  concurrency: number;
  wolves?: number;
  villagers?: number;
  maxRounds?: number;
  startedAt: string;
  fallbackStrategy: string;
  llmTimeoutMs: number;
  fingerprint: SimFingerprint;
  seed: number;
  budget: SimBudgetRecord;
}

export interface BatchLifecycleDependencies {
  getConfiguredProviderName(): string;
  assertProviderConfiguration(provider: string, requireReal: boolean): void;
  inspectBudget(): LedgerReport;
  collectFingerprint(difficulty: SimDifficulty, useReal: boolean): SimFingerprint;
  fallbackStrategy(): string;
  timeoutMs(): number;
  nowIso(): string;
  ensureDirectory(directory: string): void;
  writeRecord(outPath: string, record: SimMetaRecord): void;
  appendRecord(outPath: string, record: SimBatchSummaryRecord): void;
}

function argument(argv: readonly string[], key: string): string | undefined {
  const prefix = `--${key}=`;
  const raw = argv.find((value) => value.startsWith(prefix));
  return raw === undefined ? undefined : raw.slice(prefix.length);
}

function positiveInteger(raw: string | undefined, name: string, fallback?: number): number | undefined {
  if (raw === undefined) return fallback;
  if (raw.trim() === '') throw new Error(`--${name} 不能为空`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} 必须是正整数，收到：${raw}`);
  return value;
}

function safeInteger(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (raw.trim() === '') throw new Error(`--${name} 不能为空`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} 必须是非负安全整数，收到：${raw}`);
  return value;
}

function timestampFilePart(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

export function parseSimPoolOptions(
  argv: readonly string[],
  context: { projectRoot: string; nowMs: number; nowIso: string },
): SimPoolOptions {
  const useReal = argv.includes('--provider=real') || argv.includes('--real');
  const games = positiveInteger(argument(argv, 'games'), 'games', useReal ? 3 : 200)!;
  const requestedConcurrency = positiveInteger(
    argument(argv, 'concurrency'),
    'concurrency',
    useReal ? 1 : 8,
  )!;
  const rawDifficulty = argument(argv, 'difficulty');
  const difficulty = (rawDifficulty ?? 'standard') as SimDifficulty;
  if (!['novice', 'standard', 'expert'].includes(difficulty)) {
    throw new Error(`--difficulty 只能是 novice / standard / expert，收到：${rawDifficulty}`);
  }
  const outArg = argument(argv, 'out');
  if (outArg !== undefined && outArg.trim() === '') throw new Error('--out 不能为空，必须是 JSONL 文件路径');
  const outPath = outArg !== undefined
    ? path.resolve(context.projectRoot, outArg)
    : path.join(
        context.projectRoot,
        'runs',
        `${useReal ? 'real' : 'mock'}-${timestampFilePart(context.nowIso)}.jsonl`,
      );
  return {
    useReal,
    games,
    requestedConcurrency,
    concurrency: useReal ? 1 : requestedConcurrency,
    wolves: positiveInteger(argument(argv, 'wolves'), 'wolves'),
    villagers: positiveInteger(argument(argv, 'villagers'), 'villagers'),
    maxRounds: positiveInteger(argument(argv, 'maxRounds'), 'maxRounds'),
    difficulty,
    seed: safeInteger(argument(argv, 'seed'), 'seed', context.nowMs),
    outPath,
  };
}

export function budgetFromLedgerReport(report: LedgerReport): SimBudgetApplicable {
  if (!report.exists || !report.snapshot) throw new Error('真实 Provider 配置校验后未找到预算账本快照');
  const baseline: SimBudgetSnapshot = { ...report.snapshot };
  return {
    applicability: 'real',
    ledgerId: path.basename(report.ledgerPath),
    period: baseline.period,
    tokenBudget: baseline.tokenBudget,
    callBudget: baseline.callBudget,
    baseline,
    baselineActiveReservations: baseline.activeReservations,
  };
}

export function completeBudget(
  baseline: SimBudgetRecord,
  report?: LedgerReport,
): SimBudgetRecord {
  if (baseline.applicability === 'not_applicable') return baseline;
  if (!report?.exists || !report.snapshot) throw new Error('批次结束时无法读取预算账本快照');
  const end: SimBudgetSnapshot = { ...report.snapshot };
  return {
    ...baseline,
    end,
    delta: computeBudgetDelta(baseline.baseline, end),
    endActiveReservations: end.activeReservations,
  };
}

export function buildMetaRecord(
  options: SimPoolOptions,
  budget: SimBudgetRecord,
  fingerprint: SimFingerprint,
  settings: { startedAt: string; fallbackStrategy: string; llmTimeoutMs: number },
): SimMetaRecord {
  return {
    type: 'meta',
    provider: options.useReal ? 'real' : 'mock',
    games: options.games,
    concurrency: options.concurrency,
    wolves: options.wolves,
    villagers: options.villagers,
    maxRounds: options.maxRounds,
    startedAt: settings.startedAt,
    fallbackStrategy: settings.fallbackStrategy,
    llmTimeoutMs: settings.llmTimeoutMs,
    fingerprint,
    seed: options.seed,
    budget,
  };
}

export function buildBatchSummaryRecord(
  budget: SimBudgetRecord,
  completed: boolean,
  finishedAt: string,
): SimBatchSummaryRecord {
  return { type: 'batch_summary', finishedAt, completed, budget };
}

export function initializeBatch(
  options: SimPoolOptions,
  dependencies: BatchLifecycleDependencies,
): { budget: SimBudgetRecord; meta: SimMetaRecord } {
  const provider = options.useReal ? dependencies.getConfiguredProviderName() : 'mock';
  dependencies.assertProviderConfiguration(provider, options.useReal);
  // 账本获取必须延迟到真实分支内部，Mock 不得求值真实账本单例。
  const budget: SimBudgetRecord = options.useReal
    ? budgetFromLedgerReport(dependencies.inspectBudget())
    : { applicability: 'not_applicable', reason: 'mock_provider' };
  const fingerprint = dependencies.collectFingerprint(options.difficulty, options.useReal);
  const meta = buildMetaRecord(options, budget, fingerprint, {
    startedAt: dependencies.nowIso(),
    fallbackStrategy: dependencies.fallbackStrategy(),
    llmTimeoutMs: dependencies.timeoutMs(),
  });
  dependencies.ensureDirectory(path.dirname(options.outPath));
  dependencies.writeRecord(options.outPath, meta);
  return { budget, meta };
}

export function finishBatch(
  options: SimPoolOptions,
  baseline: SimBudgetRecord,
  done: number,
  dependencies: BatchLifecycleDependencies,
): SimBatchSummaryRecord {
  const budget = completeBudget(
    baseline,
    baseline.applicability === 'real' ? dependencies.inspectBudget() : undefined,
  );
  const summary = buildBatchSummaryRecord(budget, done === options.games, dependencies.nowIso());
  dependencies.appendRecord(options.outPath, summary);
  return summary;
}
