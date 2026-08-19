/** 游戏随机源算法标识，写入模拟指纹以避免跨算法误比较。 */
export const RNG_ALGORITHM = 'mulberry32';
/** RandomSource 公共行为与种子规范版本。 */
export const RNG_SCHEMA_VERSION = 2;
/** 子流 path 派生算法版本。 */
export const RNG_DERIVATION_VERSION = 1;

/**
 * 游戏结果相关随机性的唯一接口。
 * fork 必须创建独立子流；确定性实现不得消费父流。
 */
export interface RandomSource {
  next(): number;
  int(maxExclusive: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  fork(name: string): RandomSource;
}

/** 集中实现参数校验与无副作用 shuffle。 */
export abstract class AbstractRandomSource implements RandomSource {
  abstract next(): number;
  abstract fork(name: string): RandomSource;

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError('maxExclusive 必须是正整数');
    }
    return Math.floor(this.next() * maxExclusive);
  }

  chance(probability: number): boolean {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError('probability 必须在 [0, 1] 范围内');
    }
    if (probability === 0) return false;
    if (probability === 1) return true;
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('不能从空数组中随机选择');
    return items[this.int(items.length)];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}
