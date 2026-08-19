import { ITTSProvider, TTSNotConfiguredError, TTSQuotaExhaustedError, TTSResult, TTSServiceError } from './TTSProvider';
import { TTSBudgetLedger, TTSBudgetReservation } from './TTSBudgetLedger';
import { getTTSRuntimeOptions } from './TTSFactory';

export interface TTSServiceRequest { sessionId: string; ip: string; text: string; playerName?: string }
export interface TTSServiceStatus { enabled: boolean; provider: string; configured: boolean; quotaExhausted: boolean }
export interface TTSServiceOptions {
  provider: ITTSProvider;
  ledger?: TTSBudgetLedger;
  maxTextCharacters?: number;
  windowMs?: number;
  sessionRequestLimit?: number;
  sessionCharacterLimit?: number;
  ipRequestLimit?: number;
  ipCharacterLimit?: number;
  concurrency?: number;
  queueLimit?: number;
  timeoutMs?: number;
  now?: () => number;
}
interface Hit { at: number; characters: number }
interface Waiting { resolve: () => void; reject: (error: Error) => void }

/** Unicode 边界、双维滑窗、全局 semaphore/有界队列、超时与预算的可注入核心服务。 */
export class TTSService {
  private readonly options: Required<Omit<TTSServiceOptions, 'ledger'>> & Pick<TTSServiceOptions, 'ledger'>;
  private readonly sessionHits = new Map<string, Hit[]>();
  private readonly ipHits = new Map<string, Hit[]>();
  private active = 0;
  private readonly waiting: Waiting[] = [];

  constructor(options: TTSServiceOptions) {
    this.options = { ...getTTSRuntimeOptions(), ...options, now: options.now ?? Date.now };
    for (const key of ['maxTextCharacters', 'windowMs', 'sessionRequestLimit', 'sessionCharacterLimit', 'ipRequestLimit', 'ipCharacterLimit', 'concurrency', 'timeoutMs'] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0) throw new Error(`${key} 必须是正整数`);
    }
    if (!Number.isSafeInteger(this.options.queueLimit) || this.options.queueLimit < 0) throw new Error('queueLimit 必须是非负整数');
  }

  status(): TTSServiceStatus {
    const provider = this.options.provider;
    return {
      enabled: provider.isConfigured() && provider.isAvailable() && !provider.isQuotaExhausted(),
      provider: provider.name,
      configured: provider.isConfigured(),
      quotaExhausted: provider.isQuotaExhausted(),
    };
  }

  async synthesize(request: TTSServiceRequest): Promise<TTSResult> {
    const text = request.text;
    const characters = Array.from(text).length;
    if (!request.sessionId || !request.ip || !text.trim() || characters > this.options.maxTextCharacters) {
      throw new TTSServiceError('invalid_message', 'TTS 请求或文本长度非法');
    }
    const now = this.options.now();
    const sessionHits = this.checkWindow(this.sessionHits, request.sessionId, characters, this.options.sessionRequestLimit, this.options.sessionCharacterLimit, now);
    const ipHits = this.checkWindow(this.ipHits, request.ip, characters, this.options.ipRequestLimit, this.options.ipCharacterLimit, now);
    sessionHits.push({ at: now, characters });
    ipHits.push({ at: now, characters });
    this.sessionHits.set(request.sessionId, sessionHits);
    this.ipHits.set(request.ip, ipHits);
    await this.acquire();
    let reservation: TTSBudgetReservation | undefined;
    try {
      if (!this.options.provider.isConfigured() || !this.options.provider.isAvailable()) {
        if (this.options.provider.isQuotaExhausted()) throw new TTSServiceError('tts_quota_exhausted', 'TTS provider 额度耗尽');
        throw new TTSServiceError('tts_provider_unavailable', 'TTS provider 不可用');
      }
      reservation = this.options.ledger?.reserve(characters);
      return await this.invokeWithTimeout(text, request.playerName || '');
    } catch (error) {
      if (error instanceof TTSServiceError) throw error;
      if (error instanceof TTSQuotaExhaustedError) throw new TTSServiceError('tts_quota_exhausted', 'TTS provider 额度耗尽', undefined, error);
      if (error instanceof TTSNotConfiguredError) throw new TTSServiceError('tts_provider_unavailable', 'TTS provider 未配置', undefined, error);
      throw new TTSServiceError('tts_provider_unavailable', 'TTS provider 调用失败', undefined, error);
    } finally {
      if (reservation) this.options.ledger!.settle(reservation);
      this.release();
    }
  }

  private checkWindow(store: Map<string, Hit[]>, key: string, characters: number, requestLimit: number, characterLimit: number, now: number): Hit[] {
    const cutoff = now - this.options.windowMs;
    const hits = (store.get(key) || []).filter(hit => hit.at > cutoff);
    const used = hits.reduce((sum, hit) => sum + hit.characters, 0);
    if (hits.length + 1 > requestLimit || used + characters > characterLimit) {
      const retryMs = hits.length ? Math.max(1, hits[0].at + this.options.windowMs - now) : this.options.windowMs;
      throw new TTSServiceError('tts_rate_limited', 'TTS 滑动窗口限流', Math.ceil(retryMs / 1000));
    }
    return hits;
  }

  private acquire(): Promise<void> {
    if (this.active < this.options.concurrency) { this.active++; return Promise.resolve(); }
    if (this.waiting.length >= this.options.queueLimit) return Promise.reject(new TTSServiceError('tts_concurrency_limited', 'TTS 等待队列已满'));
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next.resolve(); else this.active--;
  }

  private async invokeWithTimeout(text: string, playerName: string): Promise<TTSResult> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new TTSServiceError('tts_timeout', 'TTS 调用超时')); }, this.options.timeoutMs);
    });
    try { return await Promise.race([this.options.provider.synthesize(text, playerName, { signal: controller.signal }), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
