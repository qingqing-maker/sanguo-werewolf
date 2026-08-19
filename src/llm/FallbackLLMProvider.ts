import { ChatMessage } from '../types';
import { EventPublisher, globalEventBus } from '../game/EventBus';
import {
  FallbackStrategy,
  LLMError,
  LLMErrorKind,
  LLMProvider,
  LLMRequestOptions,
  ProviderFallbackEventData,
} from './LLMProvider';
import { throwIfAborted } from './retry';

type ProviderWithOptions = LLMProvider;

/**
 * 把主 Provider 和备用 Provider（通常是 MockProvider）包装成一个新的 Provider：
 *   - 主 Provider 成功 → 原样返回；
 *   - 主 Provider 抛 LLMError 且策略允许该 kind fallback → emit `provider_fallback`
 *     并转由备用 Provider 处理**当次调用**；下一次调用仍先试主 Provider；
 *   - 策略不允许 fallback 的错误（含非 LLMError 的意外异常）→ 原样重抛。
 *
 * 为什么不在主 Provider 内部做：
 *   1. 熔断/预算账本在主 Provider 的重试层做；fallback 是"重试都失败之后的语义选择"。
 *      放外面既避免把 Mock 记进主 Provider 的账本，也让熔断状态本身可以驱动 on_budget 策略。
 *   2. 便于测试：主/备两个 Provider 都可注入，策略在构造函数里，纯函数式分派。
 *
 * 每次 fallback 都会 emit 一次事件；主 Provider 成功时不 emit、不调 backup。
 */
export class FallbackLLMProvider implements LLMProvider {
  constructor(
    private readonly primary: LLMProvider,
    private readonly backup: LLMProvider,
    private readonly strategy: FallbackStrategy,
    private readonly primaryName: string,
    private readonly eventBus: EventPublisher = globalEventBus,
  ) {}

  chat(systemPrompt: string, messages: ChatMessage[], options?: LLMRequestOptions): Promise<string> {
    return this.dispatch(
      'chat',
      () => (this.primary as ProviderWithOptions).chat(systemPrompt, messages, options),
      () => (this.backup as ProviderWithOptions).chat(systemPrompt, messages, options),
      options?.signal,
    );
  }

  chatJSON<T>(systemPrompt: string, messages: ChatMessage[], jsonSchema: string, options?: LLMRequestOptions): Promise<T> {
    return this.dispatch<T>(
      'chatJSON',
      () => (this.primary as ProviderWithOptions).chatJSON<T>(systemPrompt, messages, jsonSchema, options),
      () => (this.backup as ProviderWithOptions).chatJSON<T>(systemPrompt, messages, jsonSchema, options),
      options?.signal,
    );
  }

  /**
   * 通用分派：主失败 → 判定是否走 backup → 走则 emit + 调 backup。
   *
   * 关键点：
   * - 非 LLMError 直接抛（意味着不属于 Provider 已知错误分类，可能是编程错误）。
   * - LLMError 但 kind 不在当前策略允许集里，也直接抛，保留熔断/上层兜底原有语义。
   * - backup 自己抛错时不再兜底（避免死循环），原样让上层处理。
   */
  private async dispatch<T>(
    operation: 'chat' | 'chatJSON',
    primaryFn: () => Promise<T>,
    backupFn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    try {
      return await primaryFn();
    } catch (error: any) {
      throwIfAborted(signal);
      if (!(error instanceof LLMError)) throw error;
      if (!this.shouldFallback(error.kind)) throw error;
      // primary 失败后到 emit/backup 之间也可能发生取消；取消必须保持无副作用。
      throwIfAborted(signal);
      const data: ProviderFallbackEventData = {
        reason: this.mapReason(error.kind),
        from: this.primaryName,
        to: 'mock',
        operation,
        kind: error.kind,
        at: new Date().toISOString(),
      };
      try {
        this.eventBus.emit('provider_fallback', data);
      } catch { /* 事件失败不影响 fallback 本身 */ }
      // 打点日志，跑批时便于 grep 统计。
      console.warn(`[LLM fallback] ${this.primaryName} → mock (${operation}, ${error.kind}): ${error.message}`);
      return await backupFn();
    }
  }

  /**
   * 策略判定：给定错误 kind，返回是否应该切 Mock。
   * - none：都不切；
   * - transient：只切"值得重试"的瞬时错（timeout/parse/empty）；
   * - on_error：除熔断类（budget/billing/authentication）外都切；
   * - on_budget：只切预算耗尽。
   */
  private shouldFallback(kind: LLMErrorKind): boolean {
    switch (this.strategy) {
      case 'none':
        return false;
      case 'transient':
        return kind === 'timeout' || kind === 'parse' || kind === 'empty';
      case 'on_error':
        return kind !== 'budget' && kind !== 'billing' && kind !== 'authentication';
      case 'on_budget':
        return kind === 'budget';
    }
  }

  /** 把 LLMErrorKind 映射到事件 reason；unknown 归为 'error'。 */
  private mapReason(kind: LLMErrorKind): ProviderFallbackEventData['reason'] {
    switch (kind) {
      case 'timeout':
      case 'parse':
      case 'empty':
      case 'budget':
      case 'billing':
      case 'authentication':
        return kind;
      case 'unknown':
      default:
        return 'error';
    }
  }
}
