import { AbstractRandomSource, RandomSource } from './RandomSource';

/** 生产默认随机源。fork 仅提供接口隔离，不承诺可复现性。 */
export class MathRandomSource extends AbstractRandomSource {
  next(): number {
    return Math.random();
  }

  fork(_name: string): RandomSource {
    return new MathRandomSource();
  }
}
