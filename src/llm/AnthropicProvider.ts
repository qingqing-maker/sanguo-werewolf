import Anthropic from '@anthropic-ai/sdk';
import { ChatMessage } from '../types';
import { BudgetLedger, getBudgetLedger } from './BudgetLedger';
import { circuitBreaker, LLMCircuitBreaker } from './LLMCircuitBreaker';
import { LLMError, LLMProvider, readTimeoutMs } from './LLMProvider';
import { parseJsonLoose } from './jsonRepair';
import {
  classifyTransportError,
  configuredMaxRetries,
  detectAuthenticationIssue,
  detectBillingIssue,
  throwIfAborted,
  withRetry,
} from './retry';

const CHAT_MAX_TOKENS = 600;
const JSON_MAX_TOKENS = 300;

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      last.content = `${last.content}\n${message.content}`;
    } else {
      out.push({ role: message.role, content: message.content });
    }
  }
  if (out.length === 0 || out[0].role !== 'user') out.unshift({ role: 'user', content: '（开始）' });
  return out;
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;
  private reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';

  constructor(
    private readonly breaker: LLMCircuitBreaker = circuitBreaker,
    private readonly ledger: BudgetLedger = getBudgetLedger(),
  ) {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY;
    const keySource = process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' :
      process.env.LLM_API_KEY ? 'LLM_API_KEY' : '未配置';
    const baseURL = process.env.ANTHROPIC_BASE_URL || process.env.LLM_BASE_URL;
    const model = process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL_ID || 'claude-3-5-sonnet-latest';
    const effortRaw = (process.env.LLM_REASONING_EFFORT || '').trim().toLowerCase();
    const validEfforts = ['minimal', 'low', 'medium', 'high'] as const;
    this.reasoningEffort = validEfforts.includes(effortRaw as any) ? effortRaw as any : undefined;
    if (!apiKey) throw new Error('未配置 API Key (LLM_API_KEY 或 ANTHROPIC_API_KEY)');

    this.ledger.snapshot();
    // SDK 自带重试关掉，改由应用层 withRetry 负责：SDK 重试会绕过预算账本，
    // 导致重试消耗的 token 与调用次数不被记账。
    const timeoutMs = readTimeoutMs();
    this.client = new Anthropic({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 0 });
    this.model = model;
    console.log(
      `[Anthropic] baseURL=${baseURL ?? '默认'}, model=${this.model}, timeout=${timeoutMs}ms, ` +
      `keySource=${keySource}, reasoning=${this.reasoningEffort ?? '默认'}, ` +
      `瞬时故障重试=${configuredMaxRetries()} 次（应用层，SDK 重试关闭）`,
    );
  }

  private buildBody(systemPrompt: string, messages: ChatMessage[], temperature: number, maxTokens: number): any {
    const body: any = {
      model: this.model,
      system: systemPrompt,
      messages: toAnthropicMessages(messages),
      max_tokens: maxTokens,
      temperature,
    };
    if (this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;
    return body;
  }

  /**
   * 单次 HTTP 尝试（含预算预留与结算）。
   *
   * 预留放在这里而不是重试循环外面，是为了让「一次 reservation 恰好对应一次 HTTP 尝试」
   * 这个不变量在重试下依然成立：失败的那次按 settleFailure 结掉，
   * 重发时重新预留。否则账本会漏记重试消耗的调用次数。
   */
  private async attempt(body: any, label: string, signal?: AbortSignal): Promise<Anthropic.Message> {
    const reservation = this.breaker.reserve(body.system, body.messages, body.max_tokens);
    let reservationHandled = false;
    try {
      const response = await this.client.messages.create(body, { signal });
      const text = extractText(response);
      if (!text) throw new LLMError(`LLM 返回空内容 (${label})`, undefined, 'empty');
      reservationHandled = true;
      this.breaker.settle(reservation, response.usage);
      throwIfAborted(signal);
      return response;
    } catch (error: any) {
      let settlementError: any;
      if (!reservationHandled) {
        try {
          this.breaker.settleFailure(reservation);
        } catch (failure) {
          settlementError = failure;
        }
      }
      throwIfAborted(signal);
      if (settlementError) throw settlementError;
      throw error;
    }
  }

  /**
   * 只在**确定不会再重试**时才熔断并包装错误。
   *
   * 顺序很重要：瞬时故障已经被 withRetry 消化掉了，能走到这里的都是终态失败，
   * 此时 trip 才不会因为一次网关抖动而永久断开整局。
   */
  private fail(label: string, error: any, signal?: AbortSignal): never {
    throwIfAborted(signal);
    if (error instanceof LLMError && (error.kind === 'budget' || error.kind === 'parse')) throw error;
    const authenticationIssue = detectAuthenticationIssue(error);
    const billingIssue = detectBillingIssue(error);
    if (authenticationIssue) this.breaker.trip(authenticationIssue, 'authentication');
    else if (billingIssue) this.breaker.trip(billingIssue, 'billing');
    const kind = error instanceof LLMError && error.kind !== 'unknown'
      ? error.kind
      : classifyTransportError(error);
    console.error(`[LLM] ${label} 调用失败 (${kind}): ${error?.message ?? error}`);
    throw new LLMError(`${label} 调用失败: ${error?.message ?? error}`, error, kind);
  }

  async chat(systemPrompt: string, messages: ChatMessage[], options?: { signal?: AbortSignal }): Promise<string> {
    const body = this.buildBody(systemPrompt, messages, 0.85, CHAT_MAX_TOKENS);
    try {
      const response = await withRetry(
        () => this.attempt(body, 'chat', options?.signal),
        { label: 'chat', signal: options?.signal },
      );
      return extractText(response);
    } catch (error: any) {
      this.fail('chat', error, options?.signal);
    }
  }

  /**
   * 结构化输出。两层重试各管一件事：
   *   - withRetry：请求没送到 / 网关抖动（503、超时、空回复）——原样重发；
   *   - 外层 catch：拿到了回复但不是合法 JSON——附纠正提示再问一次。
   */
  async chatJSON<T>(systemPrompt: string, messages: ChatMessage[], jsonSchema: string, options?: { signal?: AbortSignal }): Promise<T> {
    const enrichedSystem = `${systemPrompt}\n\n你必须严格以 JSON 格式回复，格式如下：\n${jsonSchema}\n不要输出任何其他内容，不要使用 markdown 代码块，只输出纯 JSON。所有字符串字段都要用双引号包裹。`;
    try {
      return await this.attemptJSON<T>(enrichedSystem, messages, options?.signal);
    } catch (error: any) {
      if (!(error instanceof LLMError) || error.kind !== 'parse') this.fail('chatJSON', error, options?.signal);

      throwIfAborted(options?.signal);
      console.warn(`[LLM] chatJSON 解析失败，附纠正提示重试 1 次: ${error.message}`);
      const correction: ChatMessage = {
        role: 'user',
        content:
          '你上一次的回复不是合法 JSON（可能包含了解说文字、markdown 代码块、注释或引号错误）。' +
          `请**只**输出符合下面格式的纯 JSON，不要输出任何其他字符：\n${jsonSchema}`,
      };
      try {
        return await this.attemptJSON<T>(enrichedSystem, [...messages, correction], options?.signal);
      } catch (retryError: any) {
        this.fail('chatJSON 重试后', retryError, options?.signal);
      }
    }
  }

  /** 单次结构化请求（含瞬时故障重试）。解析失败抛 kind='parse'。 */
  private async attemptJSON<T>(enrichedSystem: string, messages: ChatMessage[], signal?: AbortSignal): Promise<T> {
    const body = this.buildBody(enrichedSystem, messages, 0.7, JSON_MAX_TOKENS);
    const response = await withRetry(
      () => this.attempt(body, 'chatJSON', signal),
      { label: 'chatJSON', signal },
    );
    throwIfAborted(signal);
    const content = extractText(response);

    const parsed = parseJsonLoose<T>(content);
    if (parsed.ok) return parsed.value;
    throw new LLMError(
      `JSON 解析失败: ${parsed.error.message}, 原文: ${content.slice(0, 160)}, 修复后: ${parsed.repaired.slice(0, 160)}`,
      parsed.error,
      'parse',
    );
  }
}
