import { Difficulty } from '../types';

export interface DifficultyProfile {
  difficulty: Difficulty;
  label: string;
  badge: string;
  description: string;
  strategyDepth: number;
  memoryRatio: number;
  maxMemoryItems: number | null;
  keyFactLimit: number;
  dossierRounds: number;
  seerRepeatRate: number;
  guardRepeatRate: number;
}

/**
 * “思考强度”只描述 AI 获得的记忆、事实材料和策略深度。
 * 一局内好人和狼人会同时增强，因此这里不承诺某个阵营的胜率必然单调变化。
 */
export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  novice: {
    difficulty: 'novice',
    label: '轻量思考',
    badge: '🌱 轻量思考',
    description: '短记忆、基础策略，并允许更多规则内的策略失误；运行更轻。',
    strategyDepth: 1,
    memoryRatio: 1,
    maxMemoryItems: 4,
    keyFactLimit: 0,
    dossierRounds: 0,
    seerRepeatRate: 0.20,
    guardRepeatRate: 0.20,
  },
  standard: {
    difficulty: 'standard',
    label: '标准思考',
    badge: '⚔️ 标准思考',
    description: '中等记忆、近期关键事实和常规策略，适合作为默认档。',
    strategyDepth: 2,
    memoryRatio: 0.60,
    maxMemoryItems: null,
    keyFactLimit: 3,
    dossierRounds: 2,
    seerRepeatRate: 0.10,
    guardRepeatRate: 0.10,
  },
  expert: {
    difficulty: 'expert',
    label: '深度思考',
    badge: '🔥 深度思考',
    description: '完整关键事实、长期立场和高级策略；不代表某阵营必然更高胜率。',
    strategyDepth: 3,
    memoryRatio: 1,
    maxMemoryItems: null,
    keyFactLimit: 40,
    dossierRounds: 6,
    seerRepeatRate: 0.02,
    guardRepeatRate: 0.02,
  },
};

export function getDifficultyProfile(difficulty: Difficulty | undefined): DifficultyProfile {
  return DIFFICULTY_PROFILES[difficulty ?? 'standard'];
}

export function difficultyMemoryWindow(difficulty: Difficulty | undefined, base: number): number {
  const profile = getDifficultyProfile(difficulty);
  const absolute = Math.abs(base);
  if (profile.maxMemoryItems !== null) return Math.min(profile.maxMemoryItems, absolute);
  return Math.max(3, Math.floor(absolute * profile.memoryRatio));
}

function envRate(envKey: string): number | null {
  const raw = parseFloat(process.env[envKey] || '');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
}

/** 显式环境变量是全局覆盖；未配置时使用当前思考强度的可测量默认梯度。 */
export function resolveDifficultyMisfireRate(
  difficulty: Difficulty | undefined,
  kind: 'seerRepeat' | 'guardRepeat',
): number {
  const envKey = kind === 'seerRepeat' ? 'MISFIRE_SEER_REPEAT' : 'MISFIRE_GUARD_REPEAT';
  return envRate(envKey) ?? getDifficultyProfile(difficulty)[`${kind}Rate`];
}
