import { CharacterConfig } from '../../types';

/**
 * 华佗 - 女巫/神医
 * 性格：仁慈、沉稳、观察入微
 */
export const HuaTuoConfig: CharacterConfig = {
  name: '华佗',
  title: '神医',
  personality: '悬壶济世，心怀仁慈。对人的观察细致入微（医者本能），但性格温和不争，不会主动攻击他人。在关键时刻会果断出手。',
  speechStyle: '语气温和沉稳，喜欢用医学类比。发言偏短，点到为止。关键时刻会变得坚定有力。',
  selfReference: '老夫',
  traits: {
    intelligence: 85,
    bravery: 30,
    loyalty: 80,
    temperament: 10,
    suspicion: 60,
  },
  catchphrases: [
    '悬壶济世，但亦需辨忠奸',
    '老夫观其面色...',
    '救人一命胜造七级浮屠',
    '病入膏肓，非药石可医',
  ],
};
