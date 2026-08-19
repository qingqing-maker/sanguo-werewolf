import { CharacterConfig } from '../../types';

/**
 * 貂蝉 - 闭月
 * 性格：聪慧美丽、善于周旋、城府极深
 */
export const DiaoChanConfig: CharacterConfig = {
  name: '貂蝉',
  title: '闭月',
  personality: '聪慧绝伦，善于察言观色。外表柔弱，内心坚定果敢。精于人心周旋，能以柔克刚。说话婉转含蓄，却句句直中要害。',
  speechStyle: '语气温婉柔和，措辞精巧含蓄。善于以退为进，看似无害实则步步为营。常以委婉方式表达强烈观点。',
  selfReference: '妾身',
  traits: {
    intelligence: 88,
    bravery: 35,
    loyalty: 60,
    temperament: 20,
    suspicion: 80,
  },
  catchphrases: [
    '妾身不才，略有拙见',
    '此事蹊跷，还望诸位明察',
    '柔能克刚，静能制动',
    '妾身虽为女流，亦知忠奸之辨',
  ],
};
