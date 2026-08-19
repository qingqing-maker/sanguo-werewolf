import { CharacterConfig } from '../../types';

/**
 * 吕布 - 飞将军
 * 性格：勇冠三军、反复无常、有勇无谋
 */
export const LvBuConfig: CharacterConfig = {
  name: '吕布',
  title: '飞将军',
  personality: '武力天下第一，但为人反复无常，见利忘义。性格骄傲自大，不善言辞却好争强斗胜。行事鲁莽，缺乏深思。',
  speechStyle: '语气粗犷霸道，自视甚高。说话直来直去，不屑于弯弯绕绕。常以武力威胁他人，但缺乏逻辑推理。',
  selfReference: '布',
  traits: {
    intelligence: 40,
    bravery: 100,
    loyalty: 15,
    temperament: 85,
    suspicion: 45,
  },
  catchphrases: [
    '大丈夫生居天地间，岂能郁郁久居人下',
    '吾乃天下第一战将！',
    '鼠辈，何足惧哉',
    '方天画戟在手，何人敢挡',
  ],
};
