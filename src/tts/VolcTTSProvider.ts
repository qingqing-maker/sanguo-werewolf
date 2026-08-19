/**
 * 火山引擎语音合成 (TTS) 客户端
 * 使用 HTTP 接口：POST https://openspeech.bytedance.com/api/v1/tts
 * 文档：https://www.volcengine.com/docs/6561/79820
 *
 * 需要在 .env 中配置：
 *   TTS_APP_ID       - 应用 ID（控制台 → 语音合成 → 应用管理）
 *   TTS_ACCESS_TOKEN - 访问令牌
 *   TTS_CLUSTER      - 集群名，通常是 volcano_tts 或 volcano_icl
 */
import {
  ITTSProvider,
  TTSResult,
  TTSNotConfiguredError,
  TTSError,
  TTSQuotaExhaustedError,
  TTSSynthesizeOptions,
} from './TTSProvider';
import { getVoiceForCharacter } from './voiceMap';

export class VolcTTSProvider implements ITTSProvider {
  readonly name = 'volc';

  private appId: string;
  private accessToken: string;
  private cluster: string;
  private endpoint = 'https://openspeech.bytedance.com/api/v1/tts';

  /** 额度耗尽熔断闩锁：置位后不再发起真实请求 */
  private quotaExhausted = false;
  /** 记录额度耗尽时的原始报错，便于排查 */
  private quotaReason = '';

  constructor() {
    this.appId = process.env.TTS_APP_ID || '';
    this.accessToken = process.env.TTS_ACCESS_TOKEN || '';
    this.cluster = process.env.TTS_CLUSTER || 'volcano_tts';
  }

  /** 是否已完成必要配置 */
  isConfigured(): boolean {
    return !!(this.appId && this.accessToken);
  }

  /** 额度是否已耗尽（熔断中） */
  isQuotaExhausted(): boolean {
    return this.quotaExhausted;
  }

  /**
   * 是否可用 = 已配置 且 额度未耗尽。
   * 前端 / 调用方应据此判断是否继续请求 TTS。
   */
  isAvailable(): boolean {
    return this.isConfigured() && !this.quotaExhausted;
  }

  /** 额度耗尽的原因（原始报错），未耗尽时为空串 */
  getQuotaReason(): string {
    return this.quotaReason;
  }

  /** 手动复位熔断闩锁（例如充值后无需重启进程即可恢复） */
  resetQuota(): void {
    this.quotaExhausted = false;
    this.quotaReason = '';
  }

  /** 置位额度耗尽熔断闩锁（幂等，只在首次记录并打印日志） */
  private tripQuota(reason: string): void {
    if (this.quotaExhausted) return;
    this.quotaExhausted = true;
    this.quotaReason = reason;
    console.warn(`[TTS] 检测到额度耗尽，已熔断，后续不再调用 TTS。原因：${reason}`);
  }

  /**
   * 判断一个错误信息是否属于"额度耗尽 / 欠费"类。
   * 注意：并发限流（并发/concurrent）属于临时错误，不触发永久熔断。
   */
  private isQuotaError(status: number | undefined, code: number | undefined, message: string): boolean {
    const msg = (message || '').toLowerCase();
    // 并发/限流是临时的，不算额度耗尽
    if (/并发|concurren|too many requests|rate limit/.test(msg)) return false;
    // HTTP 402 Payment Required 明确是欠费
    if (status === 402) return true;
    // 火山 TTS 额度/欠费相关业务码（不同版本可能有出入，做宽松匹配）
    const quotaCodes = new Set([3006, 4001, 4003, 4004]);
    if (code !== undefined && quotaCodes.has(code)) return true;
    // 关键字兜底匹配
    return /额度|配额|余额|欠费|用尽|用完|超出限额|超限|quota|insufficient|balance|out of|exhaust|exceed|资源包/.test(msg);
  }

  /**
   * 合成一段语音。音色由角色名映射（voiceMap.ts）决定。
   * @param text 要合成的文本（1-1024 字）
   * @param playerName 角色名（用于选择音色），可为空
   * @returns 音频 Buffer（mp3）
   */
  async synthesize(text: string, playerName: string, options: TTSSynthesizeOptions = {}): Promise<TTSResult> {
    if (!this.isConfigured()) {
      throw new TTSNotConfiguredError(
        'TTS 未配置：请在 .env 中设置 TTS_APP_ID / TTS_ACCESS_TOKEN / TTS_CLUSTER'
      );
    }
    // 额度耗尽后直接短路，不再浪费一次网络请求
    if (this.quotaExhausted) {
      throw new TTSQuotaExhaustedError(
        `TTS 额度已耗尽，已停止调用${this.quotaReason ? `（原因：${this.quotaReason}）` : ''}`
      );
    }
    if (!text || text.trim().length === 0) throw new TTSError('文本为空');
    if (Array.from(text).length > 1024) throw new TTSError('文本超过 1024 个 Unicode 字符');
    if (options.signal?.aborted) throw new TTSError('TTS 请求已取消');

    const profile = getVoiceForCharacter(playerName || '');
    const t0 = Date.now();
    const body = {
      app: {
        appid: this.appId,
        token: this.accessToken,
        cluster: this.cluster,
      },
      user: { uid: 'sanguo-werewolf' },
      audio: {
        voice_type: profile.voiceType,
        encoding: 'mp3',
        speed_ratio: profile.speedRatio ?? 1.0,
        volume_ratio: 1.0,
        pitch_ratio: profile.pitchRatio ?? 1.0,
      },
      request: {
        reqid: `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        text,
        text_type: 'plain',
        operation: 'query',
        with_frontend: 1,
        frontend_type: 'unitTson',
      },
    };

    let resp: Response;
    try {
      resp = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer;${this.accessToken}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (e: any) {
      throw new TTSError(`TTS 网络请求失败: ${e.message}`, e);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const detail = `TTS HTTP ${resp.status}: ${errText.slice(0, 200)}`;
      if (this.isQuotaError(resp.status, undefined, errText)) {
        this.tripQuota(detail);
        throw new TTSQuotaExhaustedError(`TTS 额度已耗尽（${detail}）`);
      }
      throw new TTSError(detail);
    }

    const json = await resp.json() as { code?: number; message?: string; data?: string };
    if (json.code !== undefined && json.code !== 3000) {
      const detail = `TTS 业务错误 code=${json.code}: ${json.message}`;
      if (this.isQuotaError(undefined, json.code, json.message || '')) {
        this.tripQuota(detail);
        throw new TTSQuotaExhaustedError(`TTS 额度已耗尽（${detail}）`);
      }
      throw new TTSError(detail);
    }
    if (!json.data) throw new TTSError('TTS 返回无 data 字段');

    return {
      audio: Buffer.from(json.data, 'base64'),
      durationMs: Date.now() - t0,
    };
  }
}
