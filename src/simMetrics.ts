import { ChatMessage, Faction, RoleType } from './types';
import {
  LLMError,
  LLMErrorKind,
  LLMProvider,
  LLMRequestOptions,
} from './llm/LLMProvider';

export type EffectiveProvider = 'real' | 'mixed' | 'mock';
export type LogicalLLMOperation = 'chat' | 'chatJSON';

export interface FallbackBuckets {
  total: number;
  timeout: number;
  parse: number;
  empty: number;
  error: number;
  budget: number;
  billing: number;
  authentication: number;
  startup_mock: number;
  byOperation: Record<string, number>;
}

export interface DegradeBuckets {
  total: number;
  timeout: number;
  parse: number;
  other: number;
  byOperation: Record<string, number>;
}

export interface LLMRequestMetrics {
  /** Agent 发起的逻辑请求数，不是 Provider 内部 HTTP retry attempt 数。 */
  total: number;
  chat: number;
  chatJSON: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  errors: Record<string, number>;
}

export interface FirstNightWolfTarget {
  playerId: string;
  name: string;
  roleType: RoleType;
  faction: Faction;
}

export interface SimGameResult {
  winner: string;
  reason: string;
  rounds: number;
  goodVotes: number;
  goodHits: number;
  providerFallbacks?: FallbackBuckets;
  decisionDegrades?: DegradeBuckets;
  llmRequests?: LLMRequestMetrics;
  firstNightWolfTarget?: FirstNightWolfTarget | null;
  effectiveProvider?: EffectiveProvider;
}

export interface SimBudgetSnapshot {
  period: string;
  tokenBudget: number;
  callBudget: number;
  calls: number;
  settledTokens: number;
  reservedTokens: number;
  committedTokens: number;
  activeReservations: number;
}

export interface SimBudgetDelta {
  calls: number;
  settledTokens: number;
  reservedTokens: number;
  committedTokens: number;
}

export interface SimBudgetNotApplicable {
  applicability: 'not_applicable';
  reason: 'mock_provider';
}

export interface SimBudgetApplicable {
  applicability: 'real';
  ledgerId: string;
  period: string;
  tokenBudget: number;
  callBudget: number;
  baseline: SimBudgetSnapshot;
  end?: SimBudgetSnapshot;
  delta?: SimBudgetDelta;
  baselineActiveReservations?: number;
  endActiveReservations?: number;
}

export type SimBudgetRecord = SimBudgetNotApplicable | SimBudgetApplicable;

export interface SimBatchSummaryRecord {
  type: 'batch_summary';
  finishedAt: string;
  completed: boolean;
  budget: SimBudgetRecord;
}

export function makeFallbackBuckets(): FallbackBuckets {
  return {
    total: 0,
    timeout: 0,
    parse: 0,
    empty: 0,
    error: 0,
    budget: 0,
    billing: 0,
    authentication: 0,
    startup_mock: 0,
    byOperation: {},
  };
}

export function makeDegradeBuckets(): DegradeBuckets {
  return { total: 0, timeout: 0, parse: 0, other: 0, byOperation: {} };
}

export function makeLLMRequestMetrics(): LLMRequestMetrics {
  return {
    total: 0,
    chat: 0,
    chatJSON: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    errors: {},
  };
}

function errorKind(error: unknown): LLMErrorKind {
  return error instanceof LLMError ? error.kind : 'unknown';
}

/**
 * 只统计业务层的一次 chat/chatJSON 调用；底层 retry、JSON 纠正重试和 fallback backup
 * 都仍属于同一次逻辑请求。包装器不改写参数、结果或异常，AbortSignal 也原样透传。
 */
export class MetricsLLMProvider implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    private readonly metrics: LLMRequestMetrics,
  ) {}

  chat(systemPrompt: string, messages: ChatMessage[], options?: LLMRequestOptions): Promise<string> {
    return this.measure('chat', () => this.inner.chat(systemPrompt, messages, options), options?.signal);
  }

  chatJSON<T>(
    systemPrompt: string,
    messages: ChatMessage[],
    jsonSchema: string,
    options?: LLMRequestOptions,
  ): Promise<T> {
    return this.measure(
      'chatJSON',
      () => this.inner.chatJSON<T>(systemPrompt, messages, jsonSchema, options),
      options?.signal,
    );
  }

  private async measure<T>(
    operation: LogicalLLMOperation,
    request: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.metrics.total++;
    this.metrics[operation]++;
    try {
      const result = await request();
      this.metrics.succeeded++;
      return result;
    } catch (error) {
      // 调用方 signal 是主动取消的唯一权威；SDK 自带 AbortError 不应被误算为取消。
      if (signal?.aborted) {
        this.metrics.cancelled++;
      } else {
        this.metrics.failed++;
        const kind = errorKind(error);
        this.metrics.errors[kind] = (this.metrics.errors[kind] ?? 0) + 1;
      }
      throw error;
    }
  }
}

export function incrementCounter(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

export function computeBudgetDelta(
  baseline: SimBudgetSnapshot,
  end: SimBudgetSnapshot,
): SimBudgetDelta {
  return {
    calls: end.calls - baseline.calls,
    settledTokens: end.settledTokens - baseline.settledTokens,
    reservedTokens: end.reservedTokens - baseline.reservedTokens,
    committedTokens: end.committedTokens - baseline.committedTokens,
  };
}
