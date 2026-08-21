import { Player, CharacterConfig, RoleType, Difficulty } from '../types';
import { BaseAgent } from './BaseAgent';
import { LLMProvider } from '../llm/LLMProvider';
import { CaoCaoConfig } from './characters/CaoCao';
import { ZhugeLiangConfig } from './characters/ZhugeLiang';
import { ZhangFeiConfig } from './characters/ZhangFei';
import { HuaTuoConfig } from './characters/HuaTuo';
import { DianWeiConfig } from './characters/DianWei';
import { LiuBeiConfig } from './characters/LiuBei';
import { SimaYiConfig } from './characters/SimaYi';
import { GuanYuConfig } from './characters/GuanYu';
import { ZhouYuConfig } from './characters/ZhouYu';
import { LvBuConfig } from './characters/LvBu';
import { DiaoChanConfig } from './characters/DiaoChan';
import { ZhaoYunConfig } from './characters/ZhaoYun';
import { MathRandomSource, RandomSource } from '../random';
import { EventPublisher, globalEventBus } from '../game/EventBus';

/**
 * 所有可用的三国人物配置（12人）
 */
const ALL_CHARACTERS: CharacterConfig[] = [
  CaoCaoConfig,
  ZhugeLiangConfig,
  ZhangFeiConfig,
  HuaTuoConfig,
  DianWeiConfig,
  LiuBeiConfig,
  SimaYiConfig,
  GuanYuConfig,
  ZhouYuConfig,
  LvBuConfig,
  DiaoChanConfig,
  ZhaoYunConfig,
];

/**
 * AgentFactory - 根据角色配置创建 Agent 实例
 */
export class AgentFactory {
  private llm: LLMProvider;
  private random: RandomSource;

  constructor(
    llm: LLMProvider,
    random: RandomSource = new MathRandomSource(),
    private readonly eventBus: EventPublisher = globalEventBus,
    private readonly signal?: AbortSignal,
  ) {
    this.llm = llm;
    this.random = random;
  }

  /**
   * 为一局游戏创建所有 Agent
   * @param roles 已分配的角色列表（已打乱顺序）
   * @param forcedCharacterName 人类玩家选定的人物名，必须进入本局阵容（参战模式）；为空则纯随机
   * @param difficulty AI 思考强度的兼容协议值；对全部 AI 座位统一生效
   *   - novice：轻量思考（短记忆、基础策略）
   *   - standard：标准思考（默认）
   *   - expert：深度思考（完整事实和长期策略）
   */
  createAgents(
    roles: RoleType[],
    forcedCharacterName?: string,
    difficulty: Difficulty = 'standard',
  ): BaseAgent[] {
    const characters = this.selectCharacters(roles.length, forcedCharacterName);
    const agents: BaseAgent[] = [];

    for (let i = 0; i < roles.length; i++) {
      const roleType = roles[i];
      const config = characters[i];

      const player: Player = {
        id: `player_${i}`,
        name: config.name,
        roleType,
        faction: this.getFaction(roleType),
        isAlive: true,
        characterConfig: config,
      };

      const agent = new BaseAgent(player, this.llm, this.random.fork(`player/${player.id}`), this.eventBus, this.signal);
      agent.difficulty = difficulty;
      agents.push(agent);
    }

    return agents;
  }

  /**
   * 选择本局使用的三国人物（随机打乱）
   * @param forcedName 若提供，保证该人物落在返回切片里（人类参战模式）；找不到则忽略，退化为纯随机
   */
  private selectCharacters(count: number, forcedName?: string): CharacterConfig[] {
    const shuffled = this.random.fork('character-shuffle').shuffle(ALL_CHARACTERS);

    // 参战模式：把选定人物提到切片范围内。若它在 count 之外，与切片内随机一个位置交换，
    // 保证被选中，同时其余人物仍是随机的。
    if (forcedName) {
      const idx = shuffled.findIndex(c => c.name === forcedName);
      if (idx >= count) {
        const swap = this.random.fork('forced-character-replacement').int(count);
        [shuffled[idx], shuffled[swap]] = [shuffled[swap], shuffled[idx]];
      }
    }

    return shuffled.slice(0, count);
  }

  /**
   * 获取角色对应的阵营
   */
  private getFaction(roleType: RoleType) {
    const { Faction } = require('../types');
    const { ALL_ROLES } = require('../roles/Role');
    return ALL_ROLES[roleType].faction;
  }
}
