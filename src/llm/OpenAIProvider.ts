import OpenAI from 'openai';
import { ChatMessage } from '../types';
import { BudgetLedger, getBudgetLedger } from './BudgetLedger';
import { parseJsonLoose } from './jsonRepair';
import { circuitBreaker, LLMCircuitBreaker } from './LLMCircuitBreaker';
import { LLMError, LLMProvider, readTimeoutMs } from './LLMProvider';
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

export type OpenAIApiStyle = 'chat_completions' | 'responses';

interface ResponsesApiResult {
  output_text?: unknown;
  output?: Array<{
    content?: Array<{ type?: unknown; text?: unknown }>;
  }>;
  usage?: unknown;
  error?: { code?: unknown; message?: unknown; type?: unknown };
}

class ResponsesApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly headers: Headers,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ResponsesApiError';
  }
}

export function readOpenAIApiStyle(env: NodeJS.ProcessEnv = process.env): OpenAIApiStyle {
  const raw = (env.LLM_API_STYLE || '').trim().toLowerCase();
  if (!raw || raw === 'chat_completions') return 'chat_completions';
  if (raw === 'responses') return 'responses';
  throw new Error(`LLM_API_STYLE 不支持: ${raw}（合法值：chat_completions / responses）`);
}

export function extractResponsesText(response: ResponsesApiResult): string | null {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  const text = parts.join('');
  return text.trim() ? text : null;
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly apiStyle: OpenAIApiStyle;
  private readonly timeoutMs: number;
  private fetchImpl: typeof fetch = fetch;

  constructor(
    private readonly breaker: LLMCircuitBreaker = circuitBreaker,
    private readonly ledger: BudgetLedger = getBudgetLedger(),
  ) {
    const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
    const baseURL = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const model = process.env.LLM_MODEL_ID || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    if (!apiKey) throw new Error('未配置 API Key (LLM_API_KEY 或 OPENAI_API_KEY)');

    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.apiStyle = readOpenAIApiStyle();
    // 构造真实 Provider 时即校验并打开共享账本；配置非法时拒绝启动，而不是等首个请求。
    this.ledger.snapshot();
    // SDK 自带重试关掉，改由应用层 withRetry 负责：SDK 内部重试会绕过预算账本，
    // 导致重试消耗的 token 与调用次数不被记账。
    const timeoutMs = readTimeoutMs();
    this.timeoutMs = timeoutMs;
    this.client = new OpenAI({
      apiKey,
      baseURL,
      timeout: timeoutMs,
      maxRetries: 0,
    });
    this.model = model;
    console.log(
      `[OpenAI兼容] baseURL=${baseURL}, model=${this.model}, apiStyle=${this.apiStyle}, timeout=${timeoutMs}ms, ` +
      `瞬时故障重试=${configuredMaxRetries()} 次（应用层，SDK 重试关闭）`,
    );
  }

  private buildMessages(systemPrompt: string, messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
    return [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];
  }

  private buildResponsesInput(systemPrompt: string, messages: ChatMessage[]): Array<{
    role: 'system' | 'user' | 'assistant';
    content: Array<{ type: 'input_text'; text: string }>;
  }> {
    return [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
      ...messages.map(message => ({
        role: message.role as 'user' | 'assistant',
        content: [{ type: 'input_text' as const, text: message.content }],
      })),
    ];
  }

  private async createResponse(
    systemPrompt: string,
    messages: ChatMessage[],
    temperature: number,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<{ content: string; usage: unknown }> {
    throwIfAborted(signal);
    const controller = new AbortController();
    const timeoutError = new Error(`Responses API 请求超过 ${this.timeoutMs}ms`);
    timeoutError.name = 'TimeoutError';
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(timeoutError), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: this.buildResponsesInput(systemPrompt, messages),
          temperature,
          max_output_tokens: maxTokens,
          thinking: { type: 'disabled' },
        }),
        signal: controller.signal,
      });

      const raw = await response.text();
      let payload: ResponsesApiResult = {};
      if (raw) {
        try {
          payload = JSON.parse(raw) as ResponsesApiResult;
        } catch {
          throw new ResponsesApiError(
            `Responses API 返回非 JSON 内容: ${raw.slice(0, 160)}`,
            response.status,
            response.headers,
          );
        }
      }
      if (!response.ok) {
        const errorMessage = typeof payload.error?.message === 'string'
          ? payload.error.message
          : `Responses API HTTP ${response.status}`;
        throw new ResponsesApiError(
          errorMessage,
          response.status,
          response.headers,
          typeof payload.error?.code === 'string' ? payload.error.code : undefined,
        );
      }
      const content = extractResponsesText(payload);
      if (!content) throw new LLMError('LLM 返回空内容 (responses)', undefined, 'empty');
      return { content, usage: payload.usage };
    } catch (error: unknown) {
      // 调用方取消优先于 fetch/timeout 的兼容错误形状。
      throwIfAborted(signal);
      if (controller.signal.aborted) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 单次 HTTP 尝试（含预算预留与结算）。
   *
   * 预留放在这里而不是重试循环外面，是为了让「一次 reservation 恰好对应一次 HTTP 尝试」
   * 在重试下依然成立：失败的那次按 settleFailure 结掉，重发时重新预留。
   */
  private async attempt(
    systemPrompt: string,
    messages: ChatMessage[],
    temperature: number,
    maxTokens: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const reservation = this.breaker.reserve(systemPrompt, messages, maxTokens);
    let reservationHandled = false;
    try {
      let content: string | null;
      let usage: unknown;
      if (this.apiStyle === 'responses') {
        const response = await this.createResponse(systemPrompt, messages, temperature, maxTokens, signal);
        content = response.content;
        usage = response.usage;
      } else {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: this.buildMessages(systemPrompt, messages),
          temperature,
          max_tokens: maxTokens,
          thinking: { type: 'disabled' },
        } as any, { signal });
        content = response.choices[0]?.message?.content;
        usage = (response as any).usage;
      }
      if (!content) throw new LLMError(`LLM 返回空内容 (${label})`, undefined, 'empty');
      reservationHandled = true;
      this.breaker.settle(reservation, usage);
      // 成功响应必须先按真实 usage 结算，再服从调用方取消；handled 已置位，
      // 后续抛取消时 catch 不会对同一 reservation 二次 settle。
      throwIfAborted(signal);
      return content;
    } catch (error: any) {
      let settlementError: any;
      if (!reservationHandled) {
        try {
          this.breaker.settleFailure(reservation);
        } catch (failure) {
          settlementError = failure;
        }
      }
      // 账本结算仍必须尝试，但人工取消是最终传播的权威结果。
      throwIfAborted(signal);
      if (settlementError) throw settlementError;
      throw error;
    }
  }

  /**
   * 只在**确定不会再重试**时才熔断并包装错误。
   *
   * 瞬时故障已由 withRetry 消化，能走到这里的都是终态失败——此时 trip
   * 才不会因为一次网关抖动而永久断开整局。
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
    try {
      return await withRetry(
        () => this.attempt(systemPrompt, messages, 0.85, CHAT_MAX_TOKENS, 'chat', options?.signal),
        { label: 'chat', signal: options?.signal },
      );
    } catch (error: any) {
      this.fail('chat', error, options?.signal);
    }
  }

  /**
   * 结构化输出。两层重试各管一件事：
   *   - withRetry（在 attemptJSON 内）：请求没送到 / 网关抖动（503、超时、空回复）——原样重发；
   *   - 这里的 catch：拿到了回复但不是合法 JSON——附纠正提示再问一次。
   *
   * 为什么 parse 值得单独重试：它往往是模型一次性抽风（多写了解说、漏了引号、套了围栏），
   * 附上"上次输出不合法"的纠正提示重发通常就能拿到合法 JSON。不重试的话，
   * 这次决策会静默降级成随机选择——对局质量的损失远大于一次调用的成本。
   *
   * 欠费、认证、预算熔断都是重试也不会好的问题，交给 fail() 立即抛出。
   */
  async chatJSON<T>(systemPrompt: string, messages: ChatMessage[], jsonSchema: string, options?: { signal?: AbortSignal }): Promise<T> {
    const enrichedSystem = `${systemPrompt}\n\n你必须严格以 JSON 格式回复，格式如下：\n${jsonSchema}\n不要输出任何其他内容，不要使用 markdown 代码块，只输出纯 JSON。`;

    try {
      return await this.attemptJSON<T>(enrichedSystem, messages, options?.signal);
    } catch (error: any) {
      if (!(error instanceof LLMError) || error.kind !== 'parse') this.fail('chatJSON', error, options?.signal);

      // 第一次响应解析失败到记录日志/发起 correction 之间也可能取消。
      throwIfAborted(options?.signal);
      console.warn(`[LLM] chatJSON 解析失败，附纠正提示重试 1 次: ${error.message}`);
      // 追加一条纠正指令，明确告诉模型上一次哪里错了。
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

  /** 单次结构化请求（含瞬时故障重试）。解析失败抛 kind='parse' 的 LLMError。 */
  private async attemptJSON<T>(enrichedSystem: string, messages: ChatMessage[], signal?: AbortSignal): Promise<T> {
    const content = await withRetry(
      () => this.attempt(enrichedSystem, messages, 0.7, JSON_MAX_TOKENS, 'chatJSON', signal),
      { label: 'chatJSON', signal },
    );

    throwIfAborted(signal);
    // 统一走共享修复模块：剥围栏/前后解说、补引号、去注释与尾逗号、全角引号归一等。
    // 详见 jsonRepair.ts 与 jsonRepair.test.ts（34 条真实畸形用例）。
    const parsed = parseJsonLoose<T>(content);
    if (parsed.ok) return parsed.value;
    throw new LLMError(
      `JSON 解析失败: ${parsed.error.message}, 原文: ${content.slice(0, 160)}, 修复后: ${parsed.repaired.slice(0, 160)}`,
      parsed.error,
      'parse',
    );
  }
}
