/** TTS 提供者的统一接口与稳定错误类型。 */

export interface TTSResult {
  audio: Buffer;
  durationMs: number;
}

export interface TTSSynthesizeOptions {
  /** 调用方在超时或取消时中止底层网络/流。 */
  signal?: AbortSignal;
}

export type TTSErrorReason =
  | 'authentication_required'
  | 'invalid_message'
  | 'tts_rate_limited'
  | 'tts_concurrency_limited'
  | 'tts_budget_exhausted'
  | 'tts_quota_exhausted'
  | 'tts_timeout'
  | 'tts_provider_unavailable';

/** 可安全映射到 HTTP/协议层的稳定 TTS 错误。 */
export class TTSServiceError extends Error {
  constructor(
    public readonly reason: TTSErrorReason,
    message: string,
    public readonly retryAfterSeconds?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TTSServiceError';
  }
}

export class TTSNotConfiguredError extends Error {
  constructor(message = 'TTS 未配置') {
    super(message);
    this.name = 'TTSNotConfiguredError';
  }
}

export class TTSError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TTSError';
  }
}

export class TTSQuotaExhaustedError extends Error {
  constructor(message = 'TTS 额度已耗尽或账户欠费，已停止调用') {
    super(message);
    this.name = 'TTSQuotaExhaustedError';
  }
}

export interface ITTSProvider {
  readonly name: string;
  isConfigured(): boolean;
  isAvailable(): boolean;
  isQuotaExhausted(): boolean;
  getQuotaReason(): string;
  resetQuota(): void;
  synthesize(text: string, playerName: string, options?: TTSSynthesizeOptions): Promise<TTSResult>;
}
