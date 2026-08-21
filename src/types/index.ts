/**
 * 三国狼人杀 - 全局类型定义
 */

// ============ 枚举 ============

/** 阵营 */
export enum Faction {
  GOOD = 'good',       // 好人阵营
  WOLF = 'wolf',       // 狼人阵营
  NEUTRAL = 'neutral', // 第三方阵营
}

/** 角色身份 */
export enum RoleType {
  VILLAGER = 'villager',   // 平民
  SEER = 'seer',           // 预言家（军师）
  WITCH = 'witch',         // 女巫（神医）
  HUNTER = 'hunter',       // 猎人（猛将）
  GUARD = 'guard',         // 守卫（禁卫）
  WEREWOLF = 'werewolf',   // 狼人（细作）
}

/** 游戏阶段 */
export enum GamePhase {
  NIGHT = 'night',         // 黑夜
  DAWN = 'dawn',           // 天亮结算
  DAY = 'day',             // 白天辩论
  VOTE = 'vote',           // 投票放逐
  END = 'end',             // 游戏结束
}

/** 游戏事件类型 */
export enum EventType {
  GAME_START = 'game_start',
  NIGHT_START = 'night_start',
  WOLF_KILL = 'wolf_kill',
  SEER_CHECK = 'seer_check',
  WITCH_SAVE = 'witch_save',
  WITCH_POISON = 'witch_poison',
  GUARD_PROTECT = 'guard_protect',
  DAWN_RESULT = 'dawn_result',
  DAY_START = 'day_start',
  PLAYER_SPEAK = 'player_speak',
  VOTE_START = 'vote_start',
  PLAYER_VOTE = 'player_vote',
  PLAYER_ELIMINATED = 'player_eliminated',
  HUNTER_SHOOT = 'hunter_shoot',
  LAST_WORDS = 'last_words',
  GAME_END = 'game_end',
}

// ============ 接口 ============

/** 玩家信息 */
export interface Player {
  id: string;
  name: string;           // 三国人物名
  roleType: RoleType;     // 身份
  faction: Faction;       // 阵营
  isAlive: boolean;       // 是否存活
  characterConfig: CharacterConfig; // 人物性格配置
}

/** 人物性格配置 */
export interface CharacterConfig {
  name: string;             // 三国人物名
  title: string;            // 称号，如"卧龙先生"
  personality: string;      // 性格描述
  speechStyle: string;      // 说话风格
  selfReference: string;    // 自称，如"亮"、"操"
  traits: PersonalityTraits; // 五维属性
  catchphrases: string[];   // 口癖/经典台词
}

/** 五维性格属性 (0-100) */
export interface PersonalityTraits {
  intelligence: number;   // 智力
  bravery: number;        // 武力/勇气
  loyalty: number;        // 忠诚度
  temperament: number;    // 暴躁度
  suspicion: number;      // 多疑度
}

/** 游戏状态 */
export interface GameState {
  phase: GamePhase;
  round: number;           // 当前回合数
  players: Player[];       // 所有玩家
  events: GameEvent[];     // 事件日志
  nightActions: NightAction[]; // 当晚行动记录
  eliminatedTonight: string[]; // 今晚被杀的玩家ID
  witchSaveUsed: boolean;  // 女巫解药是否已使用
  witchPoisonUsed: boolean; // 女巫毒药是否已使用
  lastGuardTarget: string | null; // 守卫上轮守护目标（不能连续守同一人）
  sheriffId: string | null;       // 当前警长ID
}

/** 夜晚行动 */
export interface NightAction {
  actorId: string;         // 行动者
  actionType: EventType;   // 行动类型
  targetId: string;        // 目标
  timestamp: number;
  voided?: boolean;        // 因失误（如守卫连续两晚守同一人）导致当晚技能失效，结算时忽略
}

/** 游戏事件 */
export interface GameEvent {
  type: EventType;
  round: number;
  phase: GamePhase;
  data: Record<string, unknown>;
  timestamp: number;
  publicMessage?: string;  // 公开信息（所有人可见）
  privateMessage?: string; // 私密信息（仅相关人可见）
}

/** 投票记录 */
export interface VoteRecord {
  voterId: string;
  targetId: string;
  reason: string;
  round: number;
}

/** Agent 的发言结果 */
export interface SpeechResult {
  innerThoughts: string;   // 内心思考（不公开）
  publicSpeech: string;    // 公开发言
  targetPlayer?: string;   // 指控目标（如有）
}

/** Agent 的夜晚行动结果 */
export interface NightActionResult {
  targetId: string;
  reasoning: string;       // 行动理由（内心）
}

/** LLM 对话消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * AI 思考强度的兼容协议值。档位控制记忆、事实材料、策略深度和规则内失误率；
 * 因好人和狼人会同时增强，不承诺某阵营胜率随档位单调变化。
 */
export type Difficulty = 'novice' | 'standard' | 'expert';

/** 游戏配置 */
export interface GameConfig {
  playerCount: number;
  roles: RoleType[];        // 角色配置
  maxRounds: number;        // 最大回合数
  enableInnerThoughts: boolean; // 是否展示内心OS
  // 人类玩家选择的人物名（参战模式）。为空则全 AI 观战局。
  // 该人物被强制进入本局阵容，其座位标记为人类玩家；角色仍随机分配。
  humanCharacterName?: string;
  // AI 强度档位；默认 standard。观战/参战两条路径都可选。
  aiDifficulty?: Difficulty;
}

/** 信任矩阵条目 */
export interface TrustEntry {
  playerId: string;
  trust: number;            // -100 到 100
  reason: string;           // 信任/不信任的原因
}
