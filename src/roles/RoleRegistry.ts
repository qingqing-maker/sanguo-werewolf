import { RoleType, GameConfig, Faction } from '../types';
import { ALL_ROLES, Role } from './Role';
import { MathRandomSource, RandomSource } from '../random';

/**
 * 角色注册与分配管理器
 */
export class RoleRegistry {
  /**
   * 获取预设的角色配置（12人标准局）
   */
  static getDefaultConfig(): GameConfig {
    return {
      playerCount: 12,
      roles: [
        RoleType.WEREWOLF,  // 4狼
        RoleType.WEREWOLF,
        RoleType.WEREWOLF,
        RoleType.WEREWOLF,
        RoleType.SEER,      // 1预言家
        RoleType.WITCH,     // 1女巫
        RoleType.HUNTER,    // 1猎人
        RoleType.GUARD,     // 1守卫
        RoleType.VILLAGER,  // 4平民
        RoleType.VILLAGER,
        RoleType.VILLAGER,
        RoleType.VILLAGER,
      ],
      maxRounds: 10,
      enableInnerThoughts: true,
      // 默认走中档；前端不传时也是中档，避免历史链路突然变高阶/新手。
      aiDifficulty: 'standard',
    };
  }

  /**
   * 获取角色详情
   */
  static getRole(type: RoleType): Role {
    return ALL_ROLES[type];
  }

  /**
   * 随机打乱角色分配
   */
  static shuffleRoles(roles: RoleType[], random: RandomSource = new MathRandomSource()): RoleType[] {
    return random.shuffle(roles);
  }

  /**
   * 验证角色配置是否合法
   */
  static validateConfig(config: GameConfig): { valid: boolean; error?: string } {
    if (config.roles.length !== config.playerCount) {
      return { valid: false, error: `角色数量(${config.roles.length})与玩家数量(${config.playerCount})不匹配` };
    }

    const wolfCount = config.roles.filter(r => ALL_ROLES[r].faction === Faction.WOLF).length;
    const goodCount = config.roles.filter(r => ALL_ROLES[r].faction === Faction.GOOD).length;

    if (wolfCount === 0) {
      return { valid: false, error: '至少需要1个狼人' };
    }
    if (goodCount <= wolfCount) {
      return { valid: false, error: '好人数量必须多于狼人数量' };
    }

    return { valid: true };
  }
}
