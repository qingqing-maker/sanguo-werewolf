import { ChatMessage } from '../types';
import { EventPublisher, globalEventBus } from '../game/EventBus';
import { BudgetLedger, BudgetReservation, extractUsageTokens, getBudgetLedger, estimateRequestTokens } from './BudgetLedger';
import { LLMError, LLMErrorKind } from './LLMProvider';

/** 进程内熔断状态；硬预算本身由跨进程持久化账本执行。 */
export class LLMCircuitBreaker {
  private tripped = false;
  private reason = '';
  private tripKind: LLMErrorKind = 'unknown';

  constructor(
    private readonly eventBus: EventPublisher = globalEventBus,
    private readonly injectedLedger?: BudgetLedger,
  ) {}

  private get ledger(): BudgetLedger { return this.injectedLedger ?? getBudgetLedger(); }

  trip(reason: string, kind: LLMErrorKind = 'billing'): boolean {
    if (this.tripped) return false;
    this.tripped = true;
    this.reason = reason;
    this.tripKind = kind;
    console.error(`[LLM 熔断] ${reason}`);
    console.error('[LLM 熔断] 所有后续真实 LLM 调用将被阻止。');
    try {
      this.eventBus.emit('llm_alert', { level: 'error', kind, reason });
    } catch { /* 告警失败不影响熔断 */ }
    return true;
  }

  check(): void {
    if (this.tripped) throw new LLMError(`LLM 已熔断: ${this.reason}`, undefined, this.tripKind);
  }

  reserve(systemPrompt: string, messages: ChatMessage[], maxOutputTokens: number): BudgetReservation {
    this.check();
    try {
      const tokens = estimateRequestTokens(systemPrompt, messages, maxOutputTokens);
      const reservation = this.ledger.reserve(tokens);
      return reservation;
    } catch (error: any) {
      this.trip(error?.message || String(error), 'budget');
      throw error instanceof LLMError
        ? error
        : new LLMError(`LLM_BUDGET_EXHAUSTED: ${error?.message || error}`, error, 'budget');
    }
  }

  settle(reservation: BudgetReservation, usage: unknown): void {
    try {
      const snapshot = this.ledger.settle(reservation, extractUsageTokens(usage));
      if (snapshot.settledTokens + snapshot.reservedTokens > snapshot.tokenBudget) {
        this.trip(`usage 超出预留并突破 token 上限 ${snapshot.tokenBudget}`, 'budget');
      }
    } catch (error: any) {
      this.trip(error?.message || String(error), 'budget');
      throw error instanceof LLMError
        ? error
        : new LLMError(`LLM_BUDGET_EXHAUSTED: ${error?.message || error}`, error, 'budget');
    }
  }

  settleFailure(reservation: BudgetReservation): void {
    try {
      this.ledger.settleFailure(reservation);
    } catch (error: any) {
      this.trip(error?.message || String(error), 'budget');
      throw error instanceof LLMError
        ? error
        : new LLMError(`LLM_BUDGET_EXHAUSTED: ${error?.message || error}`, error, 'budget');
    }
  }

  isTripped(): boolean { return this.tripped; }
}

export const circuitBreaker = new LLMCircuitBreaker();
