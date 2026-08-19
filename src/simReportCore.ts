import { Faction, RoleType } from './types';
import {
  EffectiveProvider,
  FirstNightWolfTarget,
  LLMRequestMetrics,
  SimBudgetRecord,
  SimGameResult,
} from './simMetrics';

export interface WinReasonStats {
  count: number;
  wolfWins: number;
  goodWins: number;
}

export interface TargetNameDistributionEntry {
  name: string;
  count: number;
  rate: number;
}

export interface TargetRoleDistributionEntry {
  roleType: RoleType;
  count: number;
  rate: number;
}

export interface TargetFactionDistributionEntry {
  faction: Faction;
  count: number;
  rate: number;
}

export interface TargetSeatDistributionEntry {
  playerId: string;
  count: number;
  rate: number;
}

export interface SimAggregateReport {
  meta: any;
  budget: SimBudgetRecord | null;
  valid: number;
  wolfWins: number;
  goodWins: number;
  wolfRate: number;
  goodRate: number;
  wolfCI: [number, number];
  goodCI: [number, number];
  averageRounds: number;
  goodVotes: number;
  goodHits: number;
  hitRate: number;
  hitCI: [number, number];
  reasons: Record<string, WinReasonStats>;
  errors: number;
  errorMessages: string[];
  malformedLines: number;
  ignoredRecords: number;
  fallback: {
    total: number;
    byReason: Record<string, number>;
    byOperation: Record<string, number>;
    rate: number | null;
  };
  degrade: {
    total: number;
    byKind: Record<string, number>;
    byOperation: Record<string, number>;
    rate: number | null;
  };
  llmRequests: {
    recordedGames: number;
    total: number;
    chat: number;
    chatJSON: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    errors: Record<string, number>;
  } | null;
  effectiveProvider: Record<EffectiveProvider, number>;
  cleanReal: {
    valid: number;
    goodWins: number;
    wolfWins: number;
    goodRate: number;
    goodCI: [number, number];
  };
  firstNightTargets: {
    recordedGames: number;
    byName: TargetNameDistributionEntry[];
    byRole: TargetRoleDistributionEntry[];
    byFaction: TargetFactionDistributionEntry[];
    bySeat: TargetSeatDistributionEntry[];
  };
}

export function wilson95(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function addCounter(target: Record<string, number>, source: unknown): void {
  if (!isRecord(source)) return;
  for (const [key, value] of Object.entries(source)) {
    const count = nonNegative(value);
    if (count > 0) target[key] = (target[key] ?? 0) + count;
  }
}

/**
 * 分桶里的分类字段是权威事实；`total` 是历史冗余缓存，可能漂移，不能再相加。
 */
function readBuckets(
  value: unknown,
  nestedKey: 'byOperation',
): { total: number; categories: Record<string, number>; operations: Record<string, number> } {
  const categories: Record<string, number> = {};
  const operations: Record<string, number> = {};
  if (!isRecord(value)) return { total: 0, categories, operations };
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'total') continue;
    if (key === nestedKey) {
      addCounter(operations, raw);
      continue;
    }
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) categories[key] = raw;
  }
  return {
    total: Object.values(categories).reduce((sum, count) => sum + count, 0),
    categories,
    operations,
  };
}

function readLLMRequests(value: unknown): LLMRequestMetrics | null {
  if (!isRecord(value)) return null;
  const chat = nonNegative(value.chat);
  const chatJSON = nonNegative(value.chatJSON);
  return {
    // operation 分类是逻辑请求分母的权威来源，忽略可能漂移的 total。
    total: chat + chatJSON,
    chat,
    chatJSON,
    succeeded: nonNegative(value.succeeded),
    failed: nonNegative(value.failed),
    cancelled: nonNegative(value.cancelled),
    errors: isRecord(value.errors)
      ? Object.fromEntries(Object.entries(value.errors).map(([key, count]) => [key, nonNegative(count)]))
      : {},
  };
}

function isTarget(value: unknown): value is FirstNightWolfTarget {
  return isRecord(value) &&
    typeof value.playerId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.roleType === 'string' &&
    typeof value.faction === 'string';
}

function incrementMap<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function distributions<K, T extends { count: number; rate: number }>(
  counts: ReadonlyMap<K, number>,
  total: number,
  build: (key: K, count: number, rate: number) => T,
  label: (item: T) => string,
): T[] {
  return [...counts.entries()]
    .map(([key, count]) => build(key, count, total > 0 ? count / total : 0))
    .sort((a, b) => b.count - a.count || label(a).localeCompare(label(b)));
}

export function analyzeSimJsonl(text: string): SimAggregateReport {
  let meta: any = null;
  let budget: SimBudgetRecord | null = null;
  let wolfWins = 0;
  let goodWins = 0;
  let totalRounds = 0;
  let goodVotes = 0;
  let goodHits = 0;
  let errors = 0;
  let malformedLines = 0;
  let ignoredRecords = 0;
  const errorMessages: string[] = [];
  const reasons: Record<string, WinReasonStats> = {};
  const fallbackByReason: Record<string, number> = {};
  const fallbackByOperation: Record<string, number> = {};
  const degradeByKind: Record<string, number> = {};
  const degradeByOperation: Record<string, number> = {};
  let fallbackTotal = 0;
  let degradeTotal = 0;
  let fallbackWithDenominator = 0;
  let degradeWithDenominator = 0;
  let requestRecordedGames = 0;
  const requestTotal: LLMRequestMetrics = {
    total: 0,
    chat: 0,
    chatJSON: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    errors: {},
  };
  const effectiveProvider: Record<EffectiveProvider, number> = { real: 0, mixed: 0, mock: 0 };
  let cleanRealGoodWins = 0;
  let cleanRealWolfWins = 0;
  const targetNameCounts = new Map<string, number>();
  const targetRoleCounts = new Map<RoleType, number>();
  const targetFactionCounts = new Map<Faction, number>();
  const targetSeatCounts = new Map<string, number>();
  let targetRecordedGames = 0;

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      malformedLines++;
      continue;
    }
    if (!isRecord(record) || typeof record.type !== 'string') {
      ignoredRecords++;
      continue;
    }
    if (record.type === 'meta') {
      meta = record;
      if (isRecord(record.budget)) budget = record.budget as SimBudgetRecord;
      continue;
    }
    if (record.type === 'batch_summary') {
      if (isRecord(record.budget)) budget = record.budget as SimBudgetRecord;
      continue;
    }
    if (record.type === 'error') {
      errors++;
      if (typeof record.message === 'string') errorMessages.push(record.message);
      continue;
    }
    if (record.type !== 'result') {
      ignoredRecords++;
      continue;
    }
    if (record.winner !== 'wolf' && record.winner !== 'good') {
      ignoredRecords++;
      continue;
    }

    const result = record as unknown as SimGameResult;
    if (result.winner === 'wolf') wolfWins++;
    else goodWins++;
    totalRounds += nonNegative(result.rounds);
    goodVotes += nonNegative(result.goodVotes);
    goodHits += nonNegative(result.goodHits);
    const reason = typeof result.reason === 'string' && result.reason ? result.reason : '(unknown)';
    const reasonStats = (reasons[reason] ??= { count: 0, wolfWins: 0, goodWins: 0 });
    reasonStats.count++;
    if (result.winner === 'wolf') reasonStats.wolfWins++;
    else reasonStats.goodWins++;

    const fallback = readBuckets(result.providerFallbacks, 'byOperation');
    fallbackTotal += fallback.total;
    addCounter(fallbackByReason, fallback.categories);
    addCounter(fallbackByOperation, fallback.operations);
    const degrade = readBuckets(result.decisionDegrades, 'byOperation');
    degradeTotal += degrade.total;
    addCounter(degradeByKind, degrade.categories);
    addCounter(degradeByOperation, degrade.operations);

    const requests = readLLMRequests(result.llmRequests);
    if (requests) {
      requestRecordedGames++;
      requestTotal.total += requests.total;
      requestTotal.chat += requests.chat;
      requestTotal.chatJSON += requests.chatJSON;
      requestTotal.succeeded += requests.succeeded;
      requestTotal.failed += requests.failed;
      requestTotal.cancelled += requests.cancelled;
      addCounter(requestTotal.errors, requests.errors);
      fallbackWithDenominator += fallback.total;
      degradeWithDenominator += degrade.total;
    }

    const provider = result.effectiveProvider;
    if (provider === 'real' || provider === 'mixed' || provider === 'mock') effectiveProvider[provider]++;
    // 缺少新版请求指标的旧 result 无法证明 failed=0，不能误算成严格干净样本。
    const hasDegradeMetrics = isRecord(result.decisionDegrades);
    if (provider === 'real' && hasDegradeMetrics && degrade.total === 0 && requests?.failed === 0) {
      if (result.winner === 'wolf') cleanRealWolfWins++;
      else cleanRealGoodWins++;
    }

    if (isTarget(result.firstNightWolfTarget)) {
      targetRecordedGames++;
      incrementMap(targetNameCounts, result.firstNightWolfTarget.name);
      incrementMap(targetRoleCounts, result.firstNightWolfTarget.roleType);
      incrementMap(targetFactionCounts, result.firstNightWolfTarget.faction);
      incrementMap(targetSeatCounts, result.firstNightWolfTarget.playerId);
    }
  }

  const valid = wolfWins + goodWins;
  const cleanValid = cleanRealGoodWins + cleanRealWolfWins;
  const firstNightTargets = {
    recordedGames: targetRecordedGames,
    byName: distributions(
      targetNameCounts,
      targetRecordedGames,
      (name, count, rate): TargetNameDistributionEntry => ({ name, count, rate }),
      item => item.name,
    ),
    byRole: distributions(
      targetRoleCounts,
      targetRecordedGames,
      (roleType, count, rate): TargetRoleDistributionEntry => ({ roleType, count, rate }),
      item => item.roleType,
    ),
    byFaction: distributions(
      targetFactionCounts,
      targetRecordedGames,
      (faction, count, rate): TargetFactionDistributionEntry => ({ faction, count, rate }),
      item => item.faction,
    ),
    bySeat: distributions(
      targetSeatCounts,
      targetRecordedGames,
      (playerId, count, rate): TargetSeatDistributionEntry => ({ playerId, count, rate }),
      item => item.playerId,
    ),
  };

  return {
    meta,
    budget,
    valid,
    wolfWins,
    goodWins,
    wolfRate: valid > 0 ? wolfWins / valid : 0,
    goodRate: valid > 0 ? goodWins / valid : 0,
    wolfCI: wilson95(wolfWins, valid),
    goodCI: wilson95(goodWins, valid),
    averageRounds: valid > 0 ? totalRounds / valid : 0,
    goodVotes,
    goodHits,
    hitRate: goodVotes > 0 ? goodHits / goodVotes : 0,
    hitCI: wilson95(goodHits, goodVotes),
    reasons,
    errors,
    errorMessages,
    malformedLines,
    ignoredRecords,
    fallback: {
      total: fallbackTotal,
      byReason: fallbackByReason,
      byOperation: fallbackByOperation,
      rate: requestTotal.total > 0 ? fallbackWithDenominator / requestTotal.total : null,
    },
    degrade: {
      total: degradeTotal,
      byKind: degradeByKind,
      byOperation: degradeByOperation,
      rate: requestTotal.total > 0 ? degradeWithDenominator / requestTotal.total : null,
    },
    llmRequests: requestRecordedGames > 0 ? { recordedGames: requestRecordedGames, ...requestTotal } : null,
    effectiveProvider,
    cleanReal: {
      valid: cleanValid,
      goodWins: cleanRealGoodWins,
      wolfWins: cleanRealWolfWins,
      goodRate: cleanValid > 0 ? cleanRealGoodWins / cleanValid : 0,
      goodCI: wilson95(cleanRealGoodWins, cleanValid),
    },
    firstNightTargets,
  };
}
