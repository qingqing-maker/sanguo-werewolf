/** 游戏展示节奏的统一计算。纯函数，方便离线精确测试。 */
export interface PacingEnv {
  [key: string]: string | undefined;
  FAST_MODE?: string;
  PACING_SCALE?: string;
}

/**
 * 读取节奏系数。FAST_MODE=1 时所有人工停顿归零；非法值回退正常速度 1。
 * 使用 Number 而非 parseFloat，避免把 `0.5oops` 误解析成 0.5。
 */
export function readPacingScale(env: PacingEnv = process.env): number {
  if (env.FAST_MODE === '1') return 0;
  const raw = env.PACING_SCALE;
  if (raw == null || raw.trim() === '') return 1;
  const scale = Number(raw);
  return Number.isFinite(scale) && scale >= 0 ? scale : 1;
}

/** 按当前节奏缩放毫秒数，统一采用四舍五入。 */
export function scalePacingMs(ms: number, env: PacingEnv = process.env): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms * readPacingScale(env));
}

/**
 * 按发言字数估算未缩放的展示停顿：中文约 4.5 字/秒，另加 500ms 过渡；
 * 最少 1.5 秒、最多 10 秒。缩放统一由 delay 层执行，避免重复乘系数。
 */
export function estimateSpeechBaseMs(text: string): number {
  const len = (text || '').replace(/\s/g, '').length;
  const estimated = Math.round((len / 4.5) * 1000) + 500;
  return Math.max(1500, Math.min(estimated, 10000));
}
