import { getTTSProvider, getTTSRuntimeOptions } from './TTSFactory';
import { TTSService } from './TTSService';

let instance: TTSService | null = null;

/** Web/CLI 默认入口：统一读取 provider、预算、限流、并发、超时和长度配置。 */
export function getTTSService(): TTSService {
  if (!instance) instance = new TTSService({ provider: getTTSProvider(), ...getTTSRuntimeOptions() });
  return instance;
}

export function resetTTSService(): void { instance = null; }
