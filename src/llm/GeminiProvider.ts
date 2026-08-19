import { GoogleGenAI } from '@google/genai';
import { ChatMessage } from '../types';
import { BudgetLedger, getBudgetLedger } from './BudgetLedger';
import { circuitBreaker, LLMCircuitBreaker } from './LLMCircuitBreaker';
import { LLMError, LLMProvider, readTimeoutMs } from './LLMProvider';
import { parseJsonLoose } from './jsonRepair';
import {
  classifyTransportError,
  detectAuthenticationIssue,
  detectBillingIssue,
  throwIfAborted,
  withRetry,
} from './retry';

const CHAT_MAX_TOKENS = 600;
const JSON_MAX_TOKENS = 300;

/** Gemini Provider；与其他真实 Provider 共用同一跨进程预算账本。 */
export class GeminiProvider implements LLMProvider {
  private client: GoogleGenAI;
  private model: string;
  private timeoutMs: number;

  constructor(
    private readonly breaker: LLMCircuitBreaker = circuitBreaker,
    private readonly ledger: BudgetLedger = getBudgetLedger(),
  ) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY 未配置');
    this.ledger.snapshot();
    this.client = new GoogleGenAI({ apiKey });
    this.model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    this.timeoutMs = readTimeoutMs();
  }

  private promptOf(messages: ChatMessage[], suffix: string): string {
    const conversationContext = messages
      .map(message => `${message.role === 'user' ? '【场景/信息】' : '【你的回复】'}${message.content}`)
      .join('\n');
    return `${conversationContext}\n\n${suffix}`;
  }

  /** 单次 SDK 请求；Gemini 0.11 的 abortSignal/httpOptions 均属于 config。 */
  private async attempt(
    systemPrompt: string,
    prompt: string,
    temperature: number,
    maxTokens: number,
    label: string,
    signal?: AbortSignal,
    responseMimeType?: string,
  ): Promise<string> {
    const reservation = this.breaker.reserve(systemPrompt, [{ role: 'user', content: prompt }], maxTokens);
    let reservationHandled = false;
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: prompt,
        config: {
          systemInstruction: systemPrompt,
          temperature,
          maxOutputTokens: maxTokens,
          responseMimeType,
          abortSignal: signal,
          httpOptions: { timeout: this.timeoutMs },
        },
      });
      const text = response.text;
      if (!text) throw new LLMError(`Gemini 返回空内容 (${label})`, undefined, 'empty');
      reservationHandled = true;
      this.breaker.settle(reservation, (response as any).usageMetadata);
      throwIfAborted(signal);
      return text;
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
    console.error(`[Gemini] ${label} 调用失败 (${kind}): ${error?.message ?? error}`);
    throw new LLMError(`Gemini ${label} 调用失败: ${error?.message ?? error}`, error, kind);
  }

  async chat(systemPrompt: string, messages: ChatMessage[], options?: { signal?: AbortSignal }): Promise<string> {
    const prompt = this.promptOf(messages, '请回复：');
    try {
      return await withRetry(
        () => this.attempt(systemPrompt, prompt, 0.85, CHAT_MAX_TOKENS, 'chat', options?.signal),
        { label: 'Gemini chat', signal: options?.signal },
      );
    } catch (error: any) {
      this.fail('chat', error, options?.signal);
    }
  }

  async chatJSON<T>(
    systemPrompt: string,
    messages: ChatMessage[],
    jsonSchema: string,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    const enrichedSystem = `${systemPrompt}\n\n你必须以纯 JSON 格式回复，格式如下：\n${jsonSchema}\n不要输出任何其他内容，不要输出 markdown 代码块，只输出纯 JSON。`;
    const prompt = this.promptOf(messages, '请以纯 JSON 格式回复：');
    try {
      const content = await withRetry(
        () => this.attempt(
          enrichedSystem,
          prompt,
          0.7,
          JSON_MAX_TOKENS,
          'chatJSON',
          options?.signal,
          'application/json',
        ),
        { label: 'Gemini chatJSON', signal: options?.signal },
      );
      throwIfAborted(options?.signal);
      const parsed = parseJsonLoose<T>(content);
      if (parsed.ok) return parsed.value;
      throw new LLMError(
        `Gemini JSON 解析失败: ${parsed.error.message}, 原文: ${content.slice(0, 160)}, 修复后: ${parsed.repaired.slice(0, 160)}`,
        parsed.error,
        'parse',
      );
    } catch (error: any) {
      this.fail('chatJSON', error, options?.signal);
    }
  }
}
