import { LLMError, LLMErrorKind } from './LLMProvider';

/**
 * LLM 调用的瞬时故障重试与错误分类。
 *
 * 为什么需要这一层：第三方中转网关（Anthropic / OpenAI 兼容格式）经常返回
 * 「503 authentication backend temporarily unavailable, retry later」这类抖动错误——
 * 连错误文案自己都写了 retry later。此前 SDK 与应用层重试均为 0，
 * 一次抖动就让该座位的 speak/decideYesNo 直接退化成兜底文案，
 * 一晚上能毁掉好几个人的发言。这里统一做：能重试的重试，不能重试的立刻放弃。
 *
 * 与 OpenAIProvider.chatJSON 的 parse 重试是两件不同的事：
 *   - 这里重试的是「请求没送到 / 网关没给出结果」（传输层与服务端故障）；
 *   - 那里重试的是「拿到了回复但不是合法 JSON」（模型输出质量）。
 */

/** 可重试的 HTTP 状态码：网关或上游的瞬时故障，重发通常就能成功。 */
const RETRIABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** 可重试的网络层错误码（连接重置、DNS 抖动、连接/首包超时等）。 */
const RETRIABLE_CODES = [
  'econnreset', 'econnrefused', 'econnaborted', 'etimedout', 'epipe',
  'ehostunreach', 'enetunreach', 'eai_again', 'und_err_connect_timeout',
  'und_err_headers_timeout', 'und_err_socket',
];

/** 中转网关常见的瞬时故障文案。命中即视为可重试，不看状态码。 */
const RETRIABLE_MESSAGES = [
  'temporarily unavailable', 'temporarily_unavailable', 'retry later', 'try again',
  'overloaded', 'bad gateway', 'gateway timeout', 'service unavailable',
  'internal server error', 'socket hang up', 'connection error', 'fetch failed',
  'network error', 'timeout', 'timed out', 'aborted',
];

function statusOf(err: any): number | undefined {
  const raw = err?.status ?? err?.statusCode ?? err?.response?.status;
  return typeof raw === 'number' ? raw : undefined;
}

function messageOf(err: any): string {
  return String(err?.message || err || '').toLowerCase();
}

function codeOf(err: any): string {
  return String(err?.code || err?.cause?.code || '').toLowerCase();
}

/** 请求/首包超时（与其他网络错误分开，用于把 kind 标成 'timeout'）。 */
export function isTimeoutError(err: any): boolean {
  const name = String(err?.name || '').toLowerCase();
  const msg = messageOf(err);
  const code = codeOf(err);
  return name.includes('timeout') || msg.includes('timeout') || msg.includes('timed out') ||
    code === 'etimedout' || code === 'econnaborted' ||
    code.includes('und_err_connect_timeout') || code.includes('und_err_headers_timeout');
}

/** 是否为「重发有意义」的瞬时故障。 */
export function isRetriableError(err: any): boolean {
  if (err instanceof LLMError) {
    // budget/billing/authentication：账户或本地额度问题，重发只会白烧调用次数。
    // parse：属于「模型输出质量」，由 Provider 的 chatJSON 带纠正提示单独重试；
    //   而且它的 message 里附了模型原文，原文若恰好含 "timeout" 之类的词，
    //   会被下面的文案匹配误判成网络故障。
    // empty（网关返回空内容）与 timeout 才交给这里重发。
    return err.kind === 'empty' || err.kind === 'timeout';
  }

  const status = statusOf(err);
  if (status !== undefined) {
    if (RETRIABLE_STATUS.has(status)) return true;
    // 其余 4xx（400 参数错误、401 认证、403 无权限、404 模型不存在）重发没有意义。
    if (status >= 400 && status < 500) return false;
    if (status >= 500) return true;
  }

  const code = codeOf(err);
  if (code && RETRIABLE_CODES.some(c => code.includes(c))) return true;

  const msg = messageOf(err);
  return RETRIABLE_MESSAGES.some(m => msg.includes(m));
}

/**
 * 认证失败检测。
 *
 * 关键守卫：状态码属于可重试区间时一律返回 null。
 * 网关的 503 文案里带着 "authentication backend temporarily unavailable"，
 * 若按关键字命中就 trip('authentication')，一次抖动会让熔断器永久断开、
 * 整局后续所有调用被拒——这是必须避免的误判。只有确定是 401/明确的
 * key 失效文案才算认证问题。
 */
export function detectAuthenticationIssue(err: any): string | null {
  const status = statusOf(err);
  if (status !== undefined && RETRIABLE_STATUS.has(status)) return null;
  if (isRetriableError(err) && status === undefined) return null;

  const msg = messageOf(err);
  if (status === 401 ||
    /api key expired|invalid api key|invalid_api_key|authentication_error|unauthorized|无效的?密钥|令牌无效/.test(msg)) {
    return `认证失败（API Key 可能已过期或无效）: ${err?.message ?? ''}`;
  }
  return null;
}

/** 欠费/额度耗尽检测。同样跳过可重试状态码，避免把网关抖动当成欠费。 */
export function detectBillingIssue(err: any): string | null {
  const status = statusOf(err);
  const msg = messageOf(err);
  if (status === 402) return `HTTP 402 需付费: ${err?.message ?? ''}`;
  if (status === 403 && /overdue|insufficient|balance|quota|exceeded|forbidden|欠费|余额|额度/.test(msg)) {
    return `HTTP 403 欠费/额度耗尽: ${err?.message ?? ''}`;
  }
  // 429 既可能是「限流」（可重试）也可能是「配额耗尽」（该熔断），靠文案区分。
  if (status === 429 && /quota|billing|balance|欠费|余额|额度/.test(msg) &&
    !/rate limit|too many requests|per minute|tpm|rpm/.test(msg)) {
    return `HTTP 429 配额耗尽: ${err?.message ?? ''}`;
  }
  return null;
}

/** 把异常归一成 LLMErrorKind（不含 parse/empty，那两类由调用方自己判定）。 */
export function classifyTransportError(err: any): LLMErrorKind {
  if (detectAuthenticationIssue(err)) return 'authentication';
  if (detectBillingIssue(err)) return 'billing';
  if (isTimeoutError(err)) return 'timeout';
  return 'unknown';
}

/** 服务端给了 Retry-After 就听它的（秒或 HTTP 日期）。 */
function retryAfterMs(err: any, now: () => number): number | undefined {
  const headers = err?.headers ?? err?.response?.headers;
  if (!headers) return undefined;
  const raw = typeof headers.get === 'function'
    ? headers.get('retry-after')
    : headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000);
  const at = Date.parse(String(raw));
  if (Number.isFinite(at)) return Math.min(Math.max(at - now(), 0), 15_000);
  return undefined;
}

/**
 * 兼容性错误形状识别；不得用它判定调用方是否主动取消。
 * 主动取消的唯一权威条件是对应请求的 signal.aborted。
 */
export function isAbortError(err: any): boolean {
  const name = String(err?.name || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  return name === 'aborterror' || code === 'abort_err' || code === 'aborted';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  throw error;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout>;
  const onAbort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    try {
      throwIfAborted(signal);
    } catch (error) {
      reject(error);
    }
  };
  timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** 默认重试次数（共 5 次尝试）。够扛过网关几秒级的抖动，又不至于让一个座位卡太久。 */
const DEFAULT_MAX_RETRIES = 4;

/** 重试次数：默认 4 次（共 5 次尝试）；可用 LLM_MAX_RETRIES 覆盖，上限 10。 */
export function configuredMaxRetries(): number {
  // 必须先判空再 Number()：Number('') === 0，若直接转换，
  // 「未配置」会被当成「显式关闭重试」，让整层重试静默失效。
  const raw = (process.env.LLM_MAX_RETRIES || '').trim();
  if (!raw) return DEFAULT_MAX_RETRIES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_RETRIES;
  return Math.min(Math.floor(parsed), 10);
}

export interface RetryOptions {
  /** 日志前缀，如 'chat' / 'chatJSON'。 */
  label: string;
  /** 重试次数上限；默认取 configuredMaxRetries()。 */
  maxRetries?: number;
  /** 首次退避基数，毫秒；实际为 base * 2^n + 抖动。 */
  baseDelayMs?: number;
  /** 总时长上限：超过后不再重试，避免游戏长时间卡在一个座位上。 */
  totalBudgetMs?: number;
  /** 主动取消信号；取消时立即停止当前等待且不再尝试。 */
  signal?: AbortSignal;
  /** 以下依赖可注入以便离线、无真实等待地测试；省略时保持历史行为。 */
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * 按指数退避重试 `attempt`。
 *
 * `attempt` 必须自带预算预留与结算（每次 HTTP 尝试对应一次 reservation），
 * 因此这里只负责判定「该不该再来一次」和「等多久」。
 */
export async function withRetry<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxRetries = options.maxRetries ?? configuredMaxRetries();
  const baseDelayMs = options.baseDelayMs ?? 500;
  const totalBudgetMs = options.totalBudgetMs ?? 90_000;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();

  let lastError: any;
  for (let tryIndex = 0; tryIndex <= maxRetries; tryIndex++) {
    throwIfAborted(options.signal);
    try {
      const result = await attempt();
      // SDK promise 成功与调用方 continuation 恢复之间仍可能取消。
      throwIfAborted(options.signal);
      return result;
    } catch (error: any) {
      lastError = error;
      // 只有调用方 signal 是主动取消的权威；SDK 自己命名为 AbortError
      // 仍按普通网络/终态错误分类。
      throwIfAborted(options.signal);
      const isLast = tryIndex === maxRetries;
      if (isLast || !isRetriableError(error)) throw error;

      const backoff = retryAfterMs(error, now) ?? Math.min(baseDelayMs * 2 ** tryIndex, 8_000);
      const delay = backoff + Math.floor(random() * 250);
      if (now() - startedAt + delay > totalBudgetMs) {
        console.error(`[LLM] ${options.label} 重试总时长超限（${totalBudgetMs}ms），放弃`);
        throw error;
      }
      const status = statusOf(error);
      console.warn(
        `[LLM] ${options.label} 瞬时失败${status ? ` (HTTP ${status})` : ''}，` +
        `${delay}ms 后重试 ${tryIndex + 1}/${maxRetries}: ${String(error?.message || error).slice(0, 160)}`,
      );
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}
