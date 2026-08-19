/**
 * 微软 Edge TTS 客户端（基于 Edge "朗读"接口的免费 Azure 神经嗓音）。
 *
 * 特点：免费、无需 API Key、无额度限制，适合本地测试。
 * 依赖 npm 包 msedge-tts。音色由角色名映射决定（见 voiceMap.ts）。
 *
 * 注意：走的是微软未公开接口，稳定性不如商业 API，但服务端调用目前可用。
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { ITTSProvider, TTSResult, TTSError, TTSSynthesizeOptions } from './TTSProvider';
import { getEdgeVoiceForCharacter } from './voiceMap';

export class EdgeTTSProvider implements ITTSProvider {
  readonly name = 'edge';

  /** Edge 无需密钥，恒为已配置 */
  isConfigured(): boolean {
    return true;
  }

  /** Edge 免费无额度限制，恒为可用 */
  isAvailable(): boolean {
    return true;
  }

  isQuotaExhausted(): boolean {
    return false;
  }

  getQuotaReason(): string {
    return '';
  }

  resetQuota(): void {
    /* Edge 无额度概念，空实现 */
  }

  async synthesize(text: string, playerName: string, options: TTSSynthesizeOptions = {}): Promise<TTSResult> {
    const characterCount = Array.from(text).length;
    if (!text || text.trim().length === 0) throw new TTSError('文本为空');
    if (characterCount > 1024) throw new TTSError('文本超过 1024 个 Unicode 字符');
    if (options.signal?.aborted) throw new TTSError('Edge TTS 已取消');

    const profile = getEdgeVoiceForCharacter(playerName || '');
    const t0 = Date.now();

    const tts = new MsEdgeTTS();
    const close = () => { try { tts.close(); } catch { /* 忽略关闭异常 */ } };
    options.signal?.addEventListener('abort', close, { once: true });
    try {
      await tts.setMetadata(profile.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const audio = await this.streamToBuffer(tts, text, profile.rate, profile.pitch, options.signal);
      if (audio.length === 0) throw new TTSError('Edge TTS 返回空音频');
      return { audio, durationMs: Date.now() - t0 };
    } catch (e: any) {
      if (e instanceof TTSError) throw e;
      throw new TTSError(`Edge TTS 合成失败: ${e?.message ?? e}`, e);
    } finally {
      options.signal?.removeEventListener('abort', close);
      close();
    }
  }

  /** 把 Edge 的音频流收集成完整 Buffer */
  private streamToBuffer(tts: MsEdgeTTS, text: string, rate: string, pitch: string, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let audioStream;
      try {
        ({ audioStream } = tts.toStream(text, { rate, pitch }));
      } catch (e) {
        reject(e);
        return;
      }
      const chunks: Buffer[] = [];
      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolve(Buffer.concat(chunks));
      };
      const onAbort = () => { audioStream.destroy(); finish(new TTSError('Edge TTS 已取消')); };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      audioStream.on('data', (d: Buffer) => chunks.push(d));
      audioStream.once('end', () => finish());
      audioStream.once('close', () => finish());
      audioStream.once('error', finish);
    });
  }
}
