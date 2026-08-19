import { AbstractRandomSource, RandomSource } from './RandomSource';

/** 将任意有限数值 seed 稳定规范化为 uint32。 */
export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) throw new RangeError('seed 必须是有限数值');
  // 延续历史 sim_worker 的规范：归一化至 [1, 2^32-2]，明确避开零状态。
  return (Math.abs(Math.trunc(seed)) % 0xfffffffe) + 1;
}

/** FNV-1a 32 位 hash；输入包含 root seed 与完整 path。 */
function deriveSeed(rootSeed: number, path: readonly string[]): number {
  const text = `${rootSeed >>> 0}\u0000${path.join('\u0000')}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= code >>> 8;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Mulberry32 确定性随机源。
 * 子流由 root seed + 完整稳定 path 派生，不读取也不推进父流状态。
 */
export class SeededRandomSource extends AbstractRandomSource {
  private state: number;

  constructor(
    private readonly rootSeed: number,
    private readonly path: readonly string[] = [],
  ) {
    super();
    this.rootSeed = normalizeSeed(rootSeed);
    this.path = [...path];
    this.state = this.path.length === 0 ? this.rootSeed : deriveSeed(this.rootSeed, this.path);
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  fork(name: string): RandomSource {
    if (typeof name !== 'string' || name.length === 0) throw new RangeError('fork name 不能为空');
    return new SeededRandomSource(this.rootSeed, [...this.path, name]);
  }
}
