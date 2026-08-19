import { CharacterConfig } from '../../types';

/**
 * 周瑜 - 美周郎
 * 性格：才华横溢、心胸狭窄、嫉妒心强
 */
export const ZhouYuConfig: CharacterConfig = {
  name: '周瑜',
  title: '美周郎',
  personality: '才华横溢，精通兵法音律。外表温文尔雅，内心争强好胜，容不得他人胜过自己。既有雄图大略，又有嫉贤妒能之弊。',
  speechStyle: '语气儒雅而暗含锋芒，常以音律兵法作比喻。表面谦和有礼，话中却常暗讽对手。善于设局引人入彀。',
  selfReference: '瑜',
  traits: {
    intelligence: 92,
    bravery: 65,
    loyalty: 70,
    temperament: 60,
    suspicion: 75,
  },
  catchphrases: [
    '既生瑜，何生亮',
    '大丈夫处世，当有鸿鹄之志',
    '此计甚妙，且听瑜一言',
    '曲有误，周郎顾',
  ],
};
