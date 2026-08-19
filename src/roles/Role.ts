import { Faction, RoleType } from '../types';

/**
 * 角色定义接口
 */
export interface Role {
  type: RoleType;
  name: string;           // 角色中文名
  faction: Faction;       // 所属阵营
  description: string;    // 角色描述
  nightPriority: number;  // 夜晚行动优先级（数字越小越先行动）
  hasNightAction: boolean; // 是否有夜晚行动
  canSelfProtect: boolean; // 是否能自保
}

/** 预言家（军师） */
export const SeerRole: Role = {
  type: RoleType.SEER,
  name: '军师（预言家）',
  faction: Faction.GOOD,
  description: '每晚可以查验一名玩家的身份，知晓其为好人还是狼人。',
  nightPriority: 30,
  hasNightAction: true,
  canSelfProtect: false,
};

/** 女巫（神医） */
export const WitchRole: Role = {
  type: RoleType.WITCH,
  name: '神医（女巫）',
  faction: Faction.GOOD,
  description: '拥有一瓶解药和一瓶毒药，每晚只能使用一瓶。解药可以救活当晚被杀的人，毒药可以毒杀一人。不可自救。',
  nightPriority: 40,
  hasNightAction: true,
  canSelfProtect: false,
};

/** 猎人（猛将） */
export const HunterRole: Role = {
  type: RoleType.HUNTER,
  name: '猛将（猎人）',
  faction: Faction.GOOD,
  description: '被杀或被投票出局时，可以开枪带走一名玩家。被女巫毒杀时不能开枪。',
  nightPriority: -1,
  hasNightAction: false,
  canSelfProtect: false,
};

/** 守卫（禁卫） */
export const GuardRole: Role = {
  type: RoleType.GUARD,
  name: '禁卫（守卫）',
  faction: Faction.GOOD,
  description: '每晚可以守护一名玩家（包括自己），使其免受狼人伤害。不能连续两晚守护同一人。',
  nightPriority: 20,
  hasNightAction: true,
  canSelfProtect: true,
};

/** 平民 */
export const VillagerRole: Role = {
  type: RoleType.VILLAGER,
  name: '平民',
  faction: Faction.GOOD,
  description: '没有特殊技能，但拥有投票权。需要通过推理找出狼人。',
  nightPriority: -1,
  hasNightAction: false,
  canSelfProtect: false,
};

/** 狼人（细作） */
export const WerewolfRole: Role = {
  type: RoleType.WEREWOLF,
  name: '细作（狼人）',
  faction: Faction.WOLF,
  description: '每晚与同伴商议后选择击杀一名玩家。白天需要伪装身份，避免被投票出局。',
  nightPriority: 10,
  hasNightAction: true,
  canSelfProtect: false,
};

/** 所有角色 */
export const ALL_ROLES: Record<RoleType, Role> = {
  [RoleType.SEER]: SeerRole,
  [RoleType.WITCH]: WitchRole,
  [RoleType.HUNTER]: HunterRole,
  [RoleType.GUARD]: GuardRole,
  [RoleType.VILLAGER]: VillagerRole,
  [RoleType.WEREWOLF]: WerewolfRole,
};
