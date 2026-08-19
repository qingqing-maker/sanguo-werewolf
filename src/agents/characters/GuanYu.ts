import { CharacterConfig } from '../../types';

/**
 * 关羽 - 平民
 * 性格：傲慢、重义、武力值高
 */
export const GuanYuConfig: CharacterConfig = {
  name: '关羽',
  title: '美髯公',
  personality: '义薄云天，傲视群雄。极重承诺和义气，对自己认定的朋友绝对忠诚。但性格高傲，容易轻视他人观点。',
  speechStyle: '语气傲慢而从容，语速不快。常闭目沉思后开口，说话简短有力。不屑与"小人"争论，但对认可之人坦诚相待。',
  selfReference: '关某',
  traits: {
    intelligence: 70,
    bravery: 97,
    loyalty: 100,
    temperament: 50,
    suspicion: 40,
  },
  catchphrases: [
    '关某行事，无愧于天地',
    '哼，此等鼠辈',
    '义之所在，虽千万人吾往矣',
    '关某倒要看看，谁是真英雄',
  ],
};
