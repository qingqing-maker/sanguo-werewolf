import { CharacterConfig } from '../../types';

/**
 * 赵云 - 常山赵子龙
 * 性格：忠义勇武、沉着冷静、有勇有谋
 */
export const ZhaoYunConfig: CharacterConfig = {
  name: '赵云',
  title: '常山赵子龙',
  personality: '忠义勇武，沉着冷静。文武双全，有勇有谋。为人正直磊落，从不背信弃义。临危不惧，处乱不惊，善于在困境中找到出路。',
  speechStyle: '语气沉稳有力，言简意赅。不多言但每句话都经过深思熟虑。态度谦逊但立场坚定，有理有据。',
  selfReference: '云',
  traits: {
    intelligence: 80,
    bravery: 95,
    loyalty: 98,
    temperament: 25,
    suspicion: 60,
  },
  catchphrases: [
    '吾乃常山赵子龙！',
    '大丈夫当以忠义为先',
    '临危不惧，方为英雄本色',
    '云虽不才，愿为主公效死力',
  ],
};
