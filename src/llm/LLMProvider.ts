import { ChatMessage } from '../types';

/**
 * LLM 调用失败的类别。上层兜底时可据此给出不同的"人设化"解释。
 * - timeout：网络/服务器超时（连接超时、请求超时）——玩家可陈述"刚才断线了"。
 * - billing：欠费/额度耗尽（402/403/429）。
 * - budget：达到本地设置的 token/调用次数预算上限（主动熔断，非账户问题）。
 * - authentication：认证失败（401、API Key 过期或无效）。
 * - empty：模型返回空内容。
 * - parse：JSON 解析失败。
 * - unknown：其他未分类错误。
 */
export type LLMErrorKind = 'timeout' | 'billing' | 'budget' | 'authentication' | 'empty' | 'parse' | 'unknown';

/**
 * Provider fallback 策略。默认 'none' 与历史行为一致（真实 Provider 出错直接抛，
 * 上层由 BaseAgent 各决策点用保守默认值兜底），其余三档提供分级降级：
 *   - transient：仅"值得重试"的瞬时性错误（timeout/parse/empty）转 Mock，
 *                 语义类错误（budget/billing/authentication）仍旧抛出让熔断生效。
 *   - on_error：除熔断类（budget/billing/authentication）外全部转 Mock，
 *                 用于"real 一挂就自动兜底、把这局跑完再看结果"的宽松模式。
 *   - on_budget：只在预算耗尽后转 Mock，其他错原样抛。用于长跑批次里
 *                 "不想因为预算触顶把整批扔掉"的场景，配合报告分档过滤 mock 局。
 * 报告层会为每种策略下的每次实际降级 emit `provider_fallback` 事件，让
 * sim_report / 前端能明确标出"这局里 X 次调用走了 Mock"。
 */
export type FallbackStrategy = 'none' | 'transient' | 'on_error' | 'on_budget';

/** 白名单常量，供校验与 env 解析共享。 */
export const FALLBACK_STRATEGIES: readonly FallbackStrategy[] = ['none', 'transient', 'on_error', 'on_budget'] as const;

/**
 * Provider fallback 事件载荷。EventBus 会自动补 gameId，此结构描述其余字段。
 *
 * `reason` 是"策略视角的原因"，`kind` 是"错误视角的分类"——两者常等价但语义不同：
 * 比如 `kind='billing'` 归到 reason='billing'，但报告聚合时更关心"是什么类型的策略触发"，
 * 因此单列 reason 便于按策略维度分桶。`'startup_mock'` 只在启动就配 mock 时使用，
 * 让报告能区分"启动就是 mock"和"real 中途切 mock"，这是 meta.provider='mock' 无法区分的。
 */
export interface ProviderFallbackEventData {
  reason: 'timeout' | 'parse' | 'empty' | 'error' | 'budget' | 'billing' | 'authentication' | 'startup_mock';
  from: string;
  to: 'mock';
  operation: 'chat' | 'chatJSON';
  kind?: LLMErrorKind;
  at: string;
}

/**
 * 从 env 读取 fallback 策略；非法值告警一次后回退到 'none'（不改变历史行为）。
 * 每次调用都读取，让设置页热更新 process.env 后下一次 createLLMProvider 立即生效。
 */
export function readFallbackStrategy(env: NodeJS.ProcessEnv = process.env): FallbackStrategy {
  const raw = (env.LLM_FALLBACK_STRATEGY || '').trim().toLowerCase();
  if (!raw) return 'none';
  if ((FALLBACK_STRATEGIES as readonly string[]).includes(raw)) return raw as FallbackStrategy;
  console.warn(`[LLM] LLM_FALLBACK_STRATEGY=${raw} 非法（合法值：${FALLBACK_STRATEGIES.join(' / ')}），已回退为 'none'。`);
  return 'none';
}

/**
 * 从 env 读取真实 Provider 的单次 HTTP 超时（毫秒）。默认 60000，允许 5000-600000。
 * 之所以设下限：<5s 在真实模型的长思考场景下几乎必超时，等于关掉了 Provider。
 */
export function readTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.LLM_TIMEOUT_MS || '').trim();
  if (!raw) return 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 5_000 || n > 600_000) {
    console.warn(`[LLM] LLM_TIMEOUT_MS=${raw} 非法（要求 5000-600000 的整数），已回退为默认 60000。`);
    return 60_000;
  }
  return Math.round(n);
}

/**
 * LLM 调用异常。上层可以 catch 后按业务语义兜底，
 * 而不是接收伪造的业务数据（比如 targetId='player_0'）。
 */
export class LLMError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly kind: LLMErrorKind = 'unknown',
  ) {
    super(message);
    this.name = 'LLMError';
  }

  /** 是否为超时类错误（连接超时/请求超时）。 */
  get isTimeout(): boolean {
    return this.kind === 'timeout';
  }

  /** 是否为认证失败（API Key 过期、无效或无权限）。 */
  get isAuthentication(): boolean {
    return this.kind === 'authentication';
  }
}

/**
 * LLM Provider 抽象接口
 * 所有 LLM 实现（OpenAI、Gemini、本地模型）都需要实现此接口
 * 失败时应抛出 LLMError（而非返回业务数据）。
 */
export interface LLMRequestOptions {
  signal?: AbortSignal;
}

export interface LLMProvider {
  /**
   * 发送对话请求
   * @param systemPrompt 系统提示词（角色人设）
   * @param messages 对话历史
   * @returns LLM 的回复内容
   */
  chat(systemPrompt: string, messages: ChatMessage[], options?: LLMRequestOptions): Promise<string>;

  /**
   * 发送结构化输出请求（用于投票、技能等需要解析的场景）
   * @param systemPrompt 系统提示词
   * @param messages 对话历史
   * @param jsonSchema 期望的 JSON 格式描述
   * @returns 解析后的对象
   */
  chatJSON<T>(systemPrompt: string, messages: ChatMessage[], jsonSchema: string, options?: LLMRequestOptions): Promise<T>;
}
