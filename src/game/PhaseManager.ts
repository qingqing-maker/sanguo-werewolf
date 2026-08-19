import { GameState, GamePhase, EventType, NightAction, RoleType, Faction } from '../types';
import { BaseAgent } from '../agents/BaseAgent';
import { GameEngine } from './GameEngine';
import { ALL_ROLES } from '../roles/Role';
import { EventPublisher, globalEventBus } from './EventBus';
import { estimateSpeechBaseMs, scalePacingMs } from './pacing';
import { MathRandomSource, RandomSource } from '../random';

/**
 * PhaseManager - 管理游戏各阶段
 * 严格保证：死亡玩家不参与任何后续环节
 */
/** 固定展示停顿的基准毫秒数；实际值统一在 delay() 中乘 PACING_SCALE。 */
const VOTE_PACING_MS = 500;         // 单张投票后停顿
const NIGHT_ACTION_PACING_MS = 300; // 夜晚技能后停顿

/**
 * AI 失误概率配置：让 AI 不再全知全能，偶尔犯"规则允许但策略愚蠢"的错误，更像真人。
 * 注意：这些是**合法**操作（目标存在、在场），只是结果亏——与"保底闸"拦截的非法操作（查死人、
 * 越界 ID）互不冲突。保底闸保证程序不崩，这里保证 AI 会犯错。
 * 均可用 .env 覆盖；留空则用默认值。仅作用于 AI，人类玩家不受影响。
 */
function misfireRate(envKey: string, def: number): number {
  const raw = parseFloat(process.env[envKey] || '');
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  return def;
}
// 预言家：无视"已验记录"重复查验一个查过的玩家（浪费一晚）
const SEER_REPEAT_RATE = () => misfireRate('MISFIRE_SEER_REPEAT', 0.12);
// 守卫：无视"不能连守"规则，仍守上一晚同一人 → 当晚守护失效
const GUARD_REPEAT_RATE = () => misfireRate('MISFIRE_GUARD_REPEAT', 0.12);
// 注：狼人自刀已从"失误注入"升格为**合法战术**（见 executeWolfVote：非首夜候选池含自己和同伴），
// 由狼队投票主动选择，不再随机注入，故原 WOLF_SELFKILL_RATE 常量已删除。

/**
 * 按字数估算发言展示停顿（不含节奏缩放）。
 * 缩放统一交给 delay()，避免 PACING_SCALE 被重复应用。
 */
function estimateSpeechPacingMs(text: string): number {
  return estimateSpeechBaseMs(text);
}

export class PhaseManager {
  private agents: BaseAgent[];
  private state: GameState;
  private engine: GameEngine;
  private readonly wolfInvalidTargetRandom: RandomSource;
  private readonly wolfTieRandom: RandomSource;
  private readonly nightInvalidTargetRandom: RandomSource;
  private readonly seerMisfireTriggerRandom: RandomSource;
  private readonly seerMisfireTargetRandom: RandomSource;
  private readonly guardMisfireTriggerRandom: RandomSource;
  private readonly sheriffFallbackRandom: RandomSource;

  constructor(
    agents: BaseAgent[],
    state: GameState,
    engine: GameEngine,
    random: RandomSource = new MathRandomSource(),
    private readonly eventBus: EventPublisher = globalEventBus,
  ) {
    this.agents = agents;
    this.state = state;
    this.engine = engine;
    this.wolfInvalidTargetRandom = random.fork('wolf-invalid-target');
    this.wolfTieRandom = random.fork('wolf-tie');
    this.nightInvalidTargetRandom = random.fork('night-invalid-target');
    this.seerMisfireTriggerRandom = random.fork('seer-misfire-trigger');
    this.seerMisfireTargetRandom = random.fork('seer-misfire-target');
    this.guardMisfireTriggerRandom = random.fork('guard-misfire-trigger');
    this.sheriffFallbackRandom = random.fork('sheriff-fallback');
  }

  /**
   * 获取所有存活的 Agent
   */
  private getAliveAgents(): BaseAgent[] {
    return this.agents.filter(a => a.player.isAlive);
  }

  /**
   * 执行黑夜阶段
   * 狼人统一投票选出一个击杀目标
   */
  async executeNight(): Promise<void> {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🌙 第 ${this.state.round} 轮 - 黑夜降临`);
    console.log(`${'═'.repeat(50)}`);

    this.state.nightActions = [];
    this.state.eliminatedTonight = [];

    // 第一步：守卫守护
    const guardAgents = this.getAliveAgents()
      .filter(a => a.player.roleType === RoleType.GUARD);
    for (const guard of guardAgents) {
      await this.engine.checkpoint();
      await this.executeNightAction(guard);
      await this.delay(NIGHT_ACTION_PACING_MS);
    }

    // 第二步：狼人统一投票选出击杀目标
    await this.executeWolfVote();

    // 第三步：预言家查验
    const seerAgents = this.getAliveAgents()
      .filter(a => a.player.roleType === RoleType.SEER);
    for (const seer of seerAgents) {
      await this.engine.checkpoint();
      await this.executeNightAction(seer);
      await this.delay(NIGHT_ACTION_PACING_MS);
    }

    // 第四步：女巫行动（独立逻辑：解药或毒药）
    await this.executeWitchAction();
  }

  /**
   * 女巫专属行动：一瓶解药 + 一瓶毒药，每晚只能用一瓶，不可自救
   */
  private async executeWitchAction(): Promise<void> {
    const witch = this.getAliveAgents()
      .find(a => a.player.roleType === RoleType.WITCH);

    if (!witch) return;

    // 两瓶药都用完了，不再有行动能力
    if (this.state.witchSaveUsed && this.state.witchPoisonUsed) {
      console.log(`  💊 女巫（${witch.player.name}）已无药可用，跳过行动。`);
      return;
    }

    await this.engine.checkpoint();

    console.log(`  💊 神医（${witch.player.name}）正在行动...`);
    this.eventBus.emit('night_action_start', {
      playerId: witch.player.id,
      playerName: witch.player.name,
      roleName: '神医（女巫）',
    });

    // 获取今晚被狼人杀害的目标
    const wolfKill = this.state.nightActions.find(a => a.actionType === EventType.WOLF_KILL);
    const killedName = wolfKill ? this.getPlayerName(wolfKill.targetId) : null;

    // 判断解药是否可用（未用完 且 有人被杀 且 被杀者不是自己——不可自救）
    const canSave = !this.state.witchSaveUsed && wolfKill && wolfKill.targetId !== witch.player.id;
    // 毒药可选目标：存活且非自己
    const poisonTargets = !this.state.witchPoisonUsed
      ? this.state.players.filter(p => p.isAlive && p.id !== witch.player.id).map(p => p.id)
      : [];

    // 如果两种药都不可用，跳过
    if (!canSave && poisonTargets.length === 0) {
      console.log(`     💊 本轮无可用药品。`);
      return;
    }

    // 构建提示
    let context = '你拥有一瓶解药和一瓶毒药。每晚只能使用其中一瓶。不可自救。\n';
    context += `当前状态：解药${this.state.witchSaveUsed ? '已用完' : '可用'}，毒药${this.state.witchPoisonUsed ? '已用完' : '可用'}。\n`;

    if (canSave) {
      context += `今晚 ${killedName} 被狼人杀害了。\n`;
      context += `- 回答"save"：使用解药救活${killedName}\n`;
    } else if (wolfKill && wolfKill.targetId === witch.player.id) {
      context += '今晚你自己被狼人杀害了，但规则不允许自救。\n';
    } else if (!wolfKill) {
      context += '今晚无人被杀，解药无法使用。\n';
    } else {
      context += '解药已用完。\n';
    }

    if (poisonTargets.length > 0) {
      context += `- 回答玩家ID：使用毒药毒杀该玩家\n`;
      context += `可毒杀目标：${poisonTargets.map(id => `${this.getPlayerName(id)}(${id})`).join('、')}\n`;
      context += `\n【毒药使用策略】毒药极其珍贵，只在以下情况使用：\n`;
      context += `- 有玩家被预言家验出是狼人（在白天发言中提到过）\n`;
      context += `- 有明确证据表明某人是狼人（如被多人质疑且逻辑链条完整）\n`;
      context += `- 如果不确定，选择"pass"！毒错好人等于帮狼人，后果极其严重！\n`;
    }
    context += `- 回答"pass"：本轮不使用任何药\n`;

    const validChoices = [...poisonTargets, 'pass'];
    if (canSave) validChoices.push('save');

    let decision: string;
    if (witch.isHumanPlayer) {
      const input = await this.engine.waitForHumanInput(
        witch.player.id,
        context,
        { targets: validChoices }
      );
      decision = input.targetId || 'pass';
    } else {
      const witchResult = await witch.witchDecide(!!canSave, killedName, poisonTargets);
      if (witchResult.action === 'save') {
        decision = 'save';
      } else if (witchResult.action === 'poison' && witchResult.targetId) {
        decision = witchResult.targetId;
      } else {
        decision = 'pass';
      }
    }

    // 处理决定
    if (decision === 'save' && canSave && wolfKill) {
      // 使用解药
      this.state.witchSaveUsed = true;
      const action: NightAction = {
        actorId: witch.player.id,
        actionType: EventType.WITCH_SAVE,
        targetId: wolfKill.targetId,
        timestamp: Date.now(),
      };
      this.state.nightActions.push(action);
      console.log(`     💊 使用解药救活了 ${killedName}！`);
      witch.receiveNotification(`你使用解药救活了${killedName}。解药已用尽。`);

      this.eventBus.emit('night_action_done', {
        playerId: witch.player.id,
        playerName: witch.player.name,
        roleName: '神医',
        targetName: killedName,
        reasoning: '使用解药',
      });
    } else if (decision !== 'pass' && poisonTargets.includes(decision)) {
      // 使用毒药
      this.state.witchPoisonUsed = true;
      const action: NightAction = {
        actorId: witch.player.id,
        actionType: EventType.WITCH_POISON,
        targetId: decision,
        timestamp: Date.now(),
      };
      this.state.nightActions.push(action);
      console.log(`     ☠️ 使用毒药毒杀了 ${this.getPlayerName(decision)}！`);
      witch.receiveNotification(`你使用毒药毒杀了${this.getPlayerName(decision)}。毒药已用尽。`);

      this.eventBus.emit('night_action_done', {
        playerId: witch.player.id,
        playerName: witch.player.name,
        roleName: '神医',
        targetName: this.getPlayerName(decision),
        reasoning: '使用毒药',
      });
    } else {
      console.log(`     💊 选择本轮不使用药品。`);
      witch.receiveNotification('你选择本轮不使用药品。');
    }
  }

  /**
   * 狼人内部投票：每个狼人各自提出目标，取票数最多的作为最终击杀目标
   */
  private async executeWolfVote(): Promise<void> {
    const wolves = this.getAliveAgents()
      .filter(a => a.player.roleType === RoleType.WEREWOLF);

    if (wolves.length === 0) return;

    // 候选池分两种情形：
    // - 首夜（round === 1）：只列存活的**非狼人**，且下方做匿名化。首夜零信息，
    //   若把自己/同伴放进候选，模型很可能瞎选一个自刀，等于开局送人头（尤其独狼直接自杀），
    //   不是"策略"而是掷骰子定胜负，所以首夜禁止自刀。
    // - 非首夜：候选池 = **全部存活玩家（含狼人自己和同伴）**，把"自刀/刀同伴"升格为
    //   合法战术选项——狼人可据白天局势主动自刀（伪造好人身份、骗女巫解药、制造悲情），
    //   由每只狼各投一票、票数最多者被刀来最终裁决，而不再靠失误注入随机触发。
    const isFirstNight = this.state.round === 1;
    const availableTargets = isFirstNight
      ? this.state.players
          .filter(p => p.isAlive && p.faction !== Faction.WOLF)
          .map(p => p.id)
      : this.state.players
          .filter(p => p.isAlive)
          .map(p => p.id);

    if (availableTargets.length === 0) return;

    console.log(`  🐺 狼人内部商议击杀目标...`);
    this.eventBus.emit('night_action_start', {
      playerId: 'wolves',
      playerName: '狼人阵营',
      roleName: '细作',
    });

    // 每个狼人各自选择目标
    const wolfChoices: { wolfId: string; wolfName: string; targetId: string; reasoning: string }[] = [];

    for (const wolf of wolves) {
      await this.engine.checkpoint();
      const context = this.getWolfContext(wolf);
      let result;
      if (wolf.isHumanPlayer) {
        const input = await this.engine.waitForHumanInput(
          wolf.player.id,
          `夜间行动：${context}`,
          { targets: availableTargets }
        );
        result = { targetId: input.targetId, reasoning: input.reasoning || '人类选择' };
      } else {
        // 首夜：候选池对狼人做**匿名化**（候选-A/B/C），彻底切断 LLM 用「诸葛亮=卧龙=最强好人」
        // 这类训练语料先验锁人的通路，且候选里没有自己/同伴（首夜禁自刀）。
        // 非首夜：候选池含自己和同伴，用 allowSelf 打开自刀专用锚定（否则锚定会声称
        // "候选里没有你自己"，与实际候选自相矛盾）。恢复真名以便结合白天发言/投票判断。
        result = await wolf.nightAction(context, availableTargets, {
          anonymizeCandidates: isFirstNight,
          allowSelf: !isFirstNight,
        });
      }

      // 验证目标合法
      if (!availableTargets.includes(result.targetId)) {
        result.targetId = this.wolfInvalidTargetRandom.pick(availableTargets);
      }

      // 说明：早期版本用 WOLF_SELFKILL_RATE 做"失误注入自刀"（随机把某只狼的提议改成刀狼阵营）。
      // 现在自刀已升格为**合法战术**——非首夜候选池直接包含自己和同伴，狼人可据局势主动选择自刀，
      // 由票数聚合裁决。因此这里不再需要随机注入，删除以免和"策略性自刀"叠加、双重触发。

      wolfChoices.push({
        wolfId: wolf.player.id,
        wolfName: wolf.player.name,
        targetId: result.targetId,
        reasoning: result.reasoning,
      });

      console.log(`     ${wolf.player.name} 提议击杀: ${this.getPlayerName(result.targetId)}`);
    }

    // 统计投票，取票数最多的目标
    const voteCount = new Map<string, number>();
    for (const choice of wolfChoices) {
      voteCount.set(choice.targetId, (voteCount.get(choice.targetId) || 0) + 1);
    }

    // 找出最高票
    let maxVotes = 0;
    let topTargets: string[] = [];
    for (const [targetId, count] of voteCount.entries()) {
      if (count > maxVotes) {
        maxVotes = count;
        topTargets = [targetId];
      } else if (count === maxVotes) {
        topTargets.push(targetId);
      }
    }

    // 平票则随机选一个
    const finalTarget = topTargets.length === 1
      ? topTargets[0]
      : this.wolfTieRandom.pick(topTargets);

    console.log(`  🐺 狼人统一决定击杀: ${this.getPlayerName(finalTarget)}`);

    // 记录为一次统一的 WOLF_KILL 行动
    const action: NightAction = {
      actorId: wolves[0].player.id, // 以第一个狼人为代表
      actionType: EventType.WOLF_KILL,
      targetId: finalTarget,
      timestamp: Date.now(),
    };
    this.state.nightActions.push(action);

    this.eventBus.emit('night_action_done', {
      playerId: 'wolves',
      playerName: '狼人阵营',
      roleName: '细作',
      targetName: this.getPlayerName(finalTarget),
      reasoning: `${wolfChoices.map(c => `${c.wolfName}→${this.getPlayerName(c.targetId)}`).join('，')}`,
    });

    // 通知每个狼人最终结果
    for (const wolf of wolves) {
      wolf.receiveNotification(`今晚狼人统一击杀目标：${this.getPlayerName(finalTarget)}。`);
    }
  }

  /**
   * 执行单个角色的夜晚行动
   */
  private async executeNightAction(agent: BaseAgent): Promise<void> {
    const role = ALL_ROLES[agent.player.roleType];

    // 各角色的可选目标做硬约束（不依赖 prompt 提醒）
    let availableTargets: string[];
    if (agent.player.roleType === RoleType.GUARD) {
      // 守卫：不能连续两晚守同一人；可以守自己
      availableTargets = this.state.players
        .filter(p => p.isAlive && p.id !== this.state.lastGuardTarget)
        .map(p => p.id);
    } else if (agent.player.roleType === RoleType.SEER) {
      // 预言家：不能验自己，也不应重复验已验过的玩家
      const alreadyChecked = new Set(agent.getSeerResults().map(r => r.name));
      availableTargets = this.state.players
        .filter(p => p.isAlive && p.id !== agent.player.id && !alreadyChecked.has(p.name))
        .map(p => p.id);
      // 若所有活人都已验过（极端情况），退回到"存活且非自己"避免锁死
      if (availableTargets.length === 0) {
        availableTargets = this.getAvailableTargets(agent);
      }
    } else {
      availableTargets = this.getAvailableTargets(agent);
    }

    if (availableTargets.length === 0) return;

    console.log(`  🔮 ${role.name}（${agent.player.name}）正在行动...`);

    this.eventBus.emit('night_action_start', {
      playerId: agent.player.id,
      playerName: agent.player.name,
      roleName: role.name,
    });

    let context = '';
    switch (agent.player.roleType) {
      case RoleType.WEREWOLF:
        context = this.getWolfContext(agent);
        break;
      case RoleType.SEER: {
        // 提示预言家已验过的玩家（避免重复验人浪费机会）
        const checked = agent.getSeerResults();
        let hint = '请选择一名存活玩家进行查验，你将得知其是好人还是狼人。';
        if (checked.length > 0) {
          hint += `\n【已验记录（不要重复查验）】${checked.map(r => `${r.name}=${r.isWolf ? '狼' : '好人'}`).join('；')}`;
        }
        hint += '\n【策略】优先查验发言可疑或信息量少的玩家；已验过的玩家结果已确定，无需再验。';
        context = hint;
        break;
      }
      case RoleType.GUARD: {
        const sheriffPlayer = this.state.sheriffId
          ? this.state.players.find(p => p.id === this.state.sheriffId && p.isAlive)
          : null;
        const lastTargetName = this.state.lastGuardTarget
          ? this.getPlayerName(this.state.lastGuardTarget)
          : null;
        let guardHint = '请选择一名存活玩家进行守护（可以是自己），今晚其将免受狼人伤害。';
        guardHint += `\n【规则】不能连续两晚守护同一人${lastTargetName ? `（上一晚你守的是 ${lastTargetName}，今晚不可再守他）` : ''}。`;
        guardHint += '\n【策略提示】';
        guardHint += '\n- 首夜狼人尚不清楚场上信息，刀口可能是任何人，不必执着于守某个"最强好人"。';
        guardHint += '\n- 若场上有玩家跳出预言家/军师身份，狼人大概率会想刀他 → 你可以考虑守护他，但**不要每晚都守同一位**，会被狼队摸清规律。';
        if (sheriffPlayer) {
          guardHint += `\n- 当前警长是 ${sheriffPlayer.name}，可作为高价值守护目标之一。`;
        }
        guardHint += '\n- 守自己也是选项：让狼队猜不透你的模式。';
        guardHint += '\n- 目标是**制造不确定性**，让狼队每晚刀口都可能落空——而不是机械地守同一个"最重要的人"。';
        context = guardHint;
        break;
      }
    }

    let result;
    if (agent.isHumanPlayer) {
      const input = await this.engine.waitForHumanInput(
        agent.player.id,
        `夜间行动：${context}`,
        { targets: availableTargets }
      );
      result = { targetId: input.targetId, reasoning: input.reasoning || '人类选择' };
    } else {
      result = await agent.nightAction(context, availableTargets);
    }

    // 保底闸：无论人类还是 AI，目标必须在本轮合法目标列表内。
    // 覆盖"查死人 / 越界 ID / 瞎编不存在的 ID / 人类改包发非法目标"等**非法**操作——
    // 一律作废并从合法列表随机兜底，保证结算流程不被污染、游戏不会卡死。
    if (!availableTargets.includes(result.targetId)) {
      const fallback = this.nightInvalidTargetRandom.pick(availableTargets);
      console.warn(`  ⚠️ ${role.name}（${agent.player.name}）目标非法（${result.targetId}），已作废并改选 ${this.getPlayerName(fallback)}。`);
      result = { targetId: fallback, reasoning: '原目标无效，系统自动改选合法目标' };
    }

    // === AI 失误注入（禁止全知全能）===
    // 仅作用于 AI。这些是**规则允许但策略愚蠢**的失误，故意选被上面过滤掉的目标，
    // 因此放在保底闸之后（否则会被当成非法目标兜底掉）。voided=true 表示技能当晚失效。
    let voided = false;
    if (!agent.isHumanPlayer) {
      if (agent.player.roleType === RoleType.SEER && this.seerMisfireTriggerRandom.chance(SEER_REPEAT_RATE())) {
        // 预言家失误：无视"已验记录"，重复查验一个查过的存活玩家 → 白白浪费一晚
        const repeatable = agent.getSeerResults()
          .map(r => this.state.players.find(p => p.name === r.name && p.isAlive))
          .filter((p): p is typeof this.state.players[number] => !!p && p.id !== agent.player.id);
        if (repeatable.length > 0) {
          const dup = this.seerMisfireTargetRandom.pick(repeatable);
          result = { targetId: dup.id, reasoning: '（失误）忘了自己验过，重复查验' };
          console.warn(`  🎲 ${role.name}（${agent.player.name}）失误：重复查验 ${dup.name}，本晚查验被浪费。`);
        }
      } else if (agent.player.roleType === RoleType.GUARD && this.guardMisfireTriggerRandom.chance(GUARD_REPEAT_RATE())) {
        // 守卫失误：无视"不能连守"，仍守上一晚同一人 → 当晚守护失效（voided）
        const last = this.state.lastGuardTarget
          ? this.state.players.find(p => p.id === this.state.lastGuardTarget && p.isAlive)
          : null;
        if (last) {
          result = { targetId: last.id, reasoning: '（失误）连续两晚守护同一人，守护失效' };
          voided = true;
          console.warn(`  🎲 ${role.name}（${agent.player.name}）失误：连守 ${last.name}，本晚守护无效。`);
        }
      }
    }

    const action: NightAction = {
      actorId: agent.player.id,
      actionType: this.getActionType(agent.player.roleType),
      targetId: result.targetId,
      timestamp: Date.now(),
      voided,
    };
    this.state.nightActions.push(action);

    // 守卫行动后更新上轮守护目标
    if (agent.player.roleType === RoleType.GUARD) {
      this.state.lastGuardTarget = result.targetId;
    }

    console.log(`     └─ 目标: ${this.getPlayerName(result.targetId)} (${result.reasoning})`);

    // 预言家查验结果通知
    if (agent.player.roleType === RoleType.SEER) {
      const target = this.state.players.find(p => p.id === result.targetId);
      if (target) {
        const isBad = target.faction === Faction.WOLF;
        agent.receiveNotification(`查验结果：${target.name}是${isBad ? '🐺狼人' : '😇好人'}！`);
        agent.addSeerResult(target.name, isBad, this.state.round);
        // 私密事件由 EventVisibility 按 seerId 仅投影给当事座位；观战与运维视角也默认拒绝。
        // AI 预言家的私有信息不依赖前端，统一 emit 后由可见性策略过滤。
        this.eventBus.emit('seer_result_private', {
          seerId: agent.player.id,
          targetName: target.name,
          isWolf: isBad,
          round: this.state.round,
        });
      }
    }

    this.eventBus.emit('night_action_done', {
      playerId: agent.player.id,
      playerName: agent.player.name,
      roleName: role.name,
      targetName: this.getPlayerName(result.targetId),
      reasoning: result.reasoning,
    });
  }

  /**
   * 计算今晚死亡名单，但**不置死、不广播、不通知**。
   * 用于「上警在公布死讯之前」的标准规则：竞选期间，被夜杀者仍在场（能上警、发遗言）。
   */
  computeDawn(): string[] {
    const deaths: string[] = [];
    const wolfKills = this.state.nightActions.filter(a => a.actionType === EventType.WOLF_KILL);
    // 失误连守的守护 voided=true，视为未守护（技能当晚失效）。
    const guardProtect = this.state.nightActions.find(a => a.actionType === EventType.GUARD_PROTECT && !a.voided);
    const witchSave = this.state.nightActions.find(a => a.actionType === EventType.WITCH_SAVE);
    const witchPoison = this.state.nightActions.find(a => a.actionType === EventType.WITCH_POISON);

    if (wolfKills.length > 0) {
      const killTarget = wolfKills[0].targetId;
      const guarded = !!(guardProtect && guardProtect.targetId === killTarget);
      const saved = !!(witchSave && witchSave.targetId === killTarget);
      // 同守同救「奶穿」：两个技能同时作用于同一人 → 反而死
      if (guarded && saved) {
        deaths.push(killTarget);
      } else if (!guarded && !saved) {
        deaths.push(killTarget);
      }
    }
    if (witchPoison && !deaths.includes(witchPoison.targetId)) {
      deaths.push(witchPoison.targetId);
    }
    return deaths;
  }

  /**
   * 公布并结算天亮死讯：置死、广播、通知狼人。
   * 只能在**竞选完成之后**（或首夜以外的正常回合）调用。
   */
  announceDawn(deaths: string[]): void {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🌅 天亮了，公布昨晚战况...`);

    const wolfKills = this.state.nightActions.filter(a => a.actionType === EventType.WOLF_KILL);
    // voided 的守护（连守失误）不算数——否则会误报"守护成功"。
    const guardProtect = this.state.nightActions.find(a => a.actionType === EventType.GUARD_PROTECT && !a.voided);
    const witchSave = this.state.nightActions.find(a => a.actionType === EventType.WITCH_SAVE);

    // 打印结算细节
    if (wolfKills.length > 0) {
      const killTarget = wolfKills[0].targetId;
      const guarded = !!(guardProtect && guardProtect.targetId === killTarget);
      const saved = !!(witchSave && witchSave.targetId === killTarget);
      if (guarded && saved) {
        console.log(`  ⚠️ 同守同救（奶穿）！${this.getPlayerName(killTarget)} 守卫与解药同时生效，反而丧命！`);
      } else if (guarded) {
        console.log(`  🛡️ 守卫守护了 ${this.getPlayerName(killTarget)}，免于一死！`);
      } else if (saved) {
        console.log(`  💊 女巫救活了 ${this.getPlayerName(killTarget)}！`);
      }
    }

    // 执行死亡。eliminatedTonight 记录的是本夜规则结算出的死亡集合，不能依赖公布瞬间的
    // isAlive：首夜待死狼人可能在竞选中先自爆，此时虽已置死，仍属于昨夜毒杀/刀杀结果，
    // 必须与 dawn_result.deaths 保持一致，供后续遗言、禁枪和复盘逻辑使用。
    for (const deadId of deaths) {
      const player = this.state.players.find(p => p.id === deadId);
      if (!player) continue;
      if (!this.state.eliminatedTonight.includes(deadId)) {
        this.state.eliminatedTonight.push(deadId);
      }
      if (player.isAlive) {
        player.isAlive = false;
        console.log(`  💀 ${player.name} 昨晚被杀害了！`);
      }
    }
    if (deaths.length === 0) {
      console.log(`  ✨ 昨晚是平安夜，无人死亡。`);
    }

    this.eventBus.emit('dawn_result', {
      deaths: deaths.map(id => {
        const p = this.state.players.find(pl => pl.id === id);
        return {
          id,
          name: this.getPlayerName(id),
          roleType: p?.roleType,
          faction: p?.faction,
        };
      }),
      isPeacefulNight: deaths.length === 0,
    });

    // 通知狼人击杀结果
    if (wolfKills.length > 0) {
      const killTarget = wolfKills[0].targetId;
      const targetName = this.getPlayerName(killTarget);
      const wolves = this.getAliveAgents().filter(a => a.player.faction === Faction.WOLF);
      const killSucceeded = deaths.includes(killTarget);
      for (const wolf of wolves) {
        if (killSucceeded) {
          wolf.receiveNotification(`昨晚你们击杀${targetName}成功，${targetName}已死亡。`);
        } else {
          wolf.receiveNotification(`昨晚你们击杀${targetName}失败了，目标被救活或被守护。白天发言时注意不要暴露你知道击杀失败的事实。`);
        }
      }
    }
  }

  /**
   * 兼容旧接口：一次性计算+公布死讯（用于非首轮）。
   */
  resolveDawn(): string[] {
    const deaths = this.computeDawn();
    this.announceDawn(deaths);
    return deaths;
  }


  /**
   * 执行白天辩论阶段
   * 只有存活玩家参与发言和听取
   */
  async executeDay(): Promise<void> {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`☀️ 第 ${this.state.round} 轮 - 白天辩论`);
    console.log(`${'═'.repeat(50)}`);

    // 严格获取存活的 Agent
    const aliveAgents = this.getAliveAgents();

    const deathNotice = this.state.eliminatedTonight.length > 0
      ? `昨晚，${this.state.eliminatedTonight.map(id => this.getPlayerName(id)).join('、')}被杀害了。`
      : '昨晚是平安夜，无人死亡。';

    for (const agent of aliveAgents) {
      agent.receiveNotification(deathNotice);
    }

    const context = `${deathNotice}\n请分析谁最可疑，给出你的判断。`;

    // 非警长玩家依次发言
    for (const agent of aliveAgents) {
      // 警长跳过普通发言（归票环节再发言）
      if (this.state.sheriffId && agent.player.id === this.state.sheriffId) continue;

      await this.engine.checkpoint();
      // 再次确认存活（可能在辩论中被猎人带走）
      if (!agent.player.isAlive) continue;

      console.log(`\n  ┌─── ${agent.player.name}（${agent.player.characterConfig.title}）发言 ───`);

      let speech;
      if (agent.isHumanPlayer) {
        const input = await this.engine.waitForHumanInput(
          agent.player.id,
          '请发表你的发言',
          { context }
        );
        speech = { innerThoughts: '（人类玩家）', publicSpeech: input.speech || '...' };
      } else {
        speech = await agent.speak(context, this.state);
      }

      console.log(`  │ 💭 [内心] ${speech.innerThoughts}`);
      console.log(`  │`);
      console.log(`  │ 🗣️ [发言] ${speech.publicSpeech}`);
      console.log(`  └${'─'.repeat(45)}`);

      this.eventBus.emit('player_speak', {
        playerId: agent.player.id,
        playerName: agent.player.name,
        title: agent.player.characterConfig.title,
        innerThoughts: speech.innerThoughts,
        publicSpeech: speech.publicSpeech,
        round: this.state.round,
      });

      // 只让存活的其他玩家听到发言
      for (const other of this.getAliveAgents()) {
        if (other.player.id !== agent.player.id) {
          other.hearSpeech(agent.player.id, agent.player.name, speech.publicSpeech);
        }
      }

      await this.delay(estimateSpeechPacingMs(speech.publicSpeech));
    }

    // === 警长归票发言（所有人发言后、投票前） ===
    if (this.state.sheriffId) {
      const sheriffAgent = aliveAgents.find(a => a.player.id === this.state.sheriffId);
      if (sheriffAgent && sheriffAgent.player.isAlive) {
        await this.engine.checkpoint();
        const sheriffName = this.getPlayerName(this.state.sheriffId);
        console.log(`\n  ┌─── 🏅 警长${sheriffName}归票发言 ───`);

        let speech;
        if (sheriffAgent.isHumanPlayer) {
          const input = await this.engine.waitForHumanInput(
            this.state.sheriffId,
            '警长归票发言：请总结大家的发言，引导投票方向',
            { context }
          );
          speech = { innerThoughts: '（人类玩家）', publicSpeech: input.speech || '...' };
        } else {
          const sheriffContext = `${deathNotice}\n你是警长，所有人已经发言完毕。请总结大家的发言，分析谁最可疑，引导投票方向。你的发言将影响接下来的投票。`;
          speech = await sheriffAgent.speak(sheriffContext, this.state);
        }

        console.log(`  │ 💭 [内心] ${speech.innerThoughts}`);
        console.log(`  │`);
        console.log(`  │ 🗣️ [归票] ${speech.publicSpeech}`);
        console.log(`  └${'─'.repeat(45)}`);

        this.eventBus.emit('sheriff_final_speech', {
          sheriffId: this.state.sheriffId,
          sheriffName,
          innerThoughts: speech.innerThoughts,
          speech: speech.publicSpeech,
          round: this.state.round,
        });

        // 让所有存活玩家听到归票发言
        for (const other of this.getAliveAgents()) {
          if (other.player.id !== sheriffAgent.player.id) {
            other.hearSpeech(sheriffAgent.player.id, sheriffName, speech.publicSpeech);
          }
        }

        await this.delay(estimateSpeechPacingMs(speech.publicSpeech));
      }
    }
  }

  /**
   * 检查游戏是否结束
   */
  checkGameEnd(): { ended: boolean; winner?: Faction; reason?: string } {
    const alivePlayers = this.state.players.filter(p => p.isAlive);
    const aliveWolves = alivePlayers.filter(p => p.faction === Faction.WOLF);

    // 好人获胜：所有狼人被消灭
    if (aliveWolves.length === 0) {
      return { ended: true, winner: Faction.GOOD, reason: '所有狼人已被消灭！' };
    }

    // 狼人获胜条件1：所有神职被消灭（预言家、女巫、猎人、守卫）
    const godRoles = [RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.GUARD];
    const aliveGods = alivePlayers.filter(p => godRoles.includes(p.roleType));
    if (aliveGods.length === 0) {
      return { ended: true, winner: Faction.WOLF, reason: '所有神职角色已被消灭，狼人获胜！' };
    }

    // 狼人获胜条件2：所有村民被消灭
    const aliveVillagers = alivePlayers.filter(p => p.roleType === RoleType.VILLAGER);
    if (aliveVillagers.length === 0) {
      return { ended: true, winner: Faction.WOLF, reason: '所有村民已被消灭，狼人获胜！' };
    }

    if (this.state.round >= this.engine.getConfig().maxRounds) {
      return { ended: true, winner: Faction.WOLF, reason: '回合数耗尽，狼人存活获胜。' };
    }

    return { ended: false };
  }

  /**
   * 获取可用目标：只能选存活的非自己的玩家
   */
  private getAvailableTargets(agent: BaseAgent): string[] {
    return this.state.players
      .filter(p => p.isAlive && p.id !== agent.player.id)
      .map(p => p.id);
  }

  private getWolfContext(agent: BaseAgent): string {
    const fellowWolves = this.agents
      .filter(a => a.player.roleType === RoleType.WEREWOLF && a.player.id !== agent.player.id && a.player.isAlive)
      .map(a => a.player.name);

    const wolfInfo = fellowWolves.length > 0
      ? `你的狼人同伴是：${fellowWolves.join('、')}。`
      : '你是唯一存活的狼人。';

    // 首夜特殊策略：白天尚未发生任何发言/竞选/投票/验人，狼人对场上任何人的真实身份一无所知。
    // 观察到的问题：LLM 会依据训练语料对三国人物的先验（"卧龙=谋士=最强好人"）解释"威胁最大"，
    //   导致首夜狼刀高度集中在诸葛亮。原文那句"优先选择对好人威胁最大的角色"在零信息条件下会被 LLM
    //   直接解读为"按人物名气/职业刻板印象排序"。
    // 修复：首夜换成"零信息 → 从候选中随机挑选，严禁按名气/称号/职业刻板印象锁人"的显式指令，
    //   并去掉"威胁最大"这个暗桩。非首夜保留威胁度判断，但明确要求依据白天真实信息而非人物名气。
    if (this.state.round === 1) {
      return (
        `${wolfInfo}\n` +
        `【首夜特殊指令 - 必读】\n` +
        `- 现在是第一夜，白天尚未发生任何发言、竞选、投票或技能公开，你对候选目标里每个人的身份/职业一无所知。\n` +
        `- 为了排除元游戏偏见，本轮候选池已**匿名化**为"候选-A / 候选-B / 候选-C..."——你看不到他们的真实姓名、称号或典故，只有编号和 player_id。这是刻意为之。\n` +
        `- 你**不需要**、也**不允许**尝试反推每个编号背后是谁；即便你能猜到，也严禁把猜测当作决策依据。\n` +
        `- 具体做法：从候选池里**随机**挑一个编号作为击杀目标，reasoning 只需写"首夜零信息，随机选择"。回复的 targetId 用括号里的 player_X 形式。`
      );
    }

    // 非首夜：候选池含**全部存活玩家**（好人 + 你自己 + 狼同伴），允许策略性自刀。
    // 自刀不是失误，而是一种高级战术：把刀口打在自己或同伴身上，用一条"命"换取身份伪装，
    // 常见收益是骗过女巫的解药、洗白被怀疑的同伴、或制造"我方也死人了"的假象。
    // 但自刀是纯亏一张牌的操作，只在有明确战术收益时才用，否则正常刀好人。
    const selfKillHint =
      `\n【自刀战术（可选，非强制）】候选里包含你自己和狼同伴——这是刻意开放的。\n` +
      `- 自刀/刀同伴属于**合法高级战术**，不是失误：适用于"骗女巫解药""替被踩的同伴洗白""伪造狼队也死人"等场景。\n` +
      `- 代价是白白折损一名狼，只有当伪装收益明显大于损失时才做；没有清晰理由就正常刀好人。\n` +
      `- 若决定自刀，reasoning 里要写清战术意图（例如"我今天被多人怀疑，自刀洗清嫌疑，让好人误判狼数"）。`;

    return (
      `${wolfInfo}\n请选择今晚要击杀的目标。判断"威胁"只依据白天已公开的发言/投票/技能信息` +
      `（如已跳预言家、已报验人结果），而不是人物本身的名气或称号。` +
      selfKillHint
    );
  }



  private getActionType(roleType: RoleType): EventType {
    switch (roleType) {
      case RoleType.WEREWOLF: return EventType.WOLF_KILL;
      case RoleType.SEER: return EventType.SEER_CHECK;
      case RoleType.GUARD: return EventType.GUARD_PROTECT;
      case RoleType.WITCH: return EventType.WITCH_POISON; // 女巫默认行动记为毒药；救人另走 WITCH_SAVE 分支
      default:
        throw new Error(`getActionType: 未支持的角色类型 ${roleType}`);
    }
  }

  private getPlayerName(id: string): string {
    const player = this.state.players.find(p => p.id === id);
    return player ? player.name : id;
  }

  private delay(ms: number): Promise<void> {
    const scaled = scalePacingMs(ms);
    if (scaled <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, scaled));
  }

  /**
   * 警长竞选（标准流程）：
   * 1. 上警阶段：AI决定是否上警
   * 2. 警上玩家依次发言（竞选演说）— 狼人可自爆
   * 3. 退水阶段：警上玩家可选择退水
   * 4. 警下玩家投票选举
   * 5. 平票PK → 二次平票则警徽流失
   */
  async executeSheriffElection(_pendingDeathIds: string[] = []): Promise<{ exploded: boolean }> {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🏅 警长竞选`);
    console.log(`${'═'.repeat(50)}`);

    // 标准规则：首夜被夜杀者在整个竞选流程中都当作存活（能上警、发言、退水、被投、当选）；
    // 死讯要等竞选完全结束才由主循环调用 announceDawn 公布。
    const alivePlayers = this.getAliveAgents();

    // === 1. 上警阶段：AI 决定是否竞选 ===
    console.log(`\n  📢 法官：现在开始竞选警长，想要竞选的玩家请举手！`);

    let candidates: BaseAgent[] = [];
    let voters: BaseAgent[] = [];

    for (const agent of alivePlayers) {
      await this.engine.checkpoint();

      let wantsToRun: boolean;
      if (agent.isHumanPlayer) {
        const input = await this.engine.waitForHumanInput(
          agent.player.id,
          '是否参与警长竞选？',
          { type: 'confirm', options: ['上警', '不上警'] }
        );
        wantsToRun = input.choice === '上警';
      } else {
        // AI 根据阵营与角色特性决定是否上警
        const isWolf = agent.player.faction === Faction.WOLF;
        const isSeer = agent.player.roleType === RoleType.SEER;

        let context: string;
        let defaultYes: boolean;
        if (isSeer) {
          // 预言家：几乎一定要上警（报验人 + 1.5 票）
          context = `警长竞选上警环节。你是预言家/军师，手握昨夜查验结果。上警可以在归票发言中报出验人信息，并用 1.5 票推狼——这是你最大的价值。请决定：上警（yes）还是不上警（no）？`;
          defaultYes = true;
        } else if (isWolf) {
          // 狼人：需要战术判断——冲预言家搅局 or 隐藏在警下
          context = `警长竞选上警环节。你是狼人。\n【策略】\n- 上警"抢警"可以跳假预言家搅乱好人节奏、争夺 1.5 票权，但会被好人重点盯防。\n- 不上警则隐藏在警下，观察真预言家跳出后再想办法反咬。\n- 一般狼队至少派 1-2 人冲警（尤其冲预言家位）；如果你性格张扬或已想好战术就上，否则可以让位给同伴。\n请决定：上警（yes）还是不上警（no）？`;
          defaultYes = false;
        } else {
          // 普通好人（村民、女巫、猎人、守卫）：竞选是策略选择，不必人人上警
          context = `警长竞选上警环节。你是好人。\n【策略】\n- 场上通常只需要 3-5 人上警：预言家必上，其余由发言强、判断敏锐的玩家上。\n- 平民一窝蜂上警反而稀释警长的价值、容易被狼人混入伪装。\n- 如果你觉得自己发言能力一般，或场上已经有很多人举手，不上警把票投给可信的好人更好。\n- 但如果场上很少人举手、你有信心争夺警徽，就上。\n请根据你的角色实力和场面判断：上警（yes）还是不上警（no）？`;
          // 神职（女巫/猎人/守卫）默认上警，平民默认不上警
          defaultYes = agent.player.roleType !== RoleType.VILLAGER;
        }

        const decision = await agent.decideYesNo(context, defaultYes);
        wantsToRun = decision.yes;
      }

      if (wantsToRun) {
        candidates.push(agent);
        console.log(`  🙋 ${agent.player.name} 上警`);
      } else {
        voters.push(agent);
      }
    }

    this.eventBus.emit('sheriff_election_start', {
      candidates: candidates.map(a => ({ id: a.player.id, name: a.player.name })),
      voters: voters.map(a => ({ id: a.player.id, name: a.player.name })),
    });

    // 无人上警
    if (candidates.length === 0) {
      console.log(`\n  ⚠️ 无人竞选警长，本局无警长。`);
      this.eventBus.emit('sheriff_election_end', { result: 'no_candidates' });
      for (const agent of alivePlayers) {
        agent.receiveNotification('本局无人竞选警长，不设警长。');
      }
      return { exploded: false };
    }

    // 只有一人上警，直接当选
    if (candidates.length === 1) {
      this.state.sheriffId = candidates[0].player.id;
      const name = candidates[0].player.name;
      console.log(`\n  🏅 ${name} 唯一竞选者，自动当选警长！`);
      this.eventBus.emit('sheriff_elected', { sheriffId: candidates[0].player.id, sheriffName: name, votes: 0 });
      for (const agent of alivePlayers) {
        agent.receiveNotification(`${name}当选为本局警长，拥有1.5票投票权和归票发言权。`);
      }
      return { exploded: false };
    }

    // === 2. 警上发言阶段（狼人可自爆） ===
    console.log(`\n  📢 警上发言阶段（${candidates.length}人竞选）：`);

    // 收集每位候选人的演说原文，用于投票阶段给 AI 看真实上下文（否则 AI 只知道候选人名字，
    // 完全不知道谁说了什么、谁跳了预言家、谁公开攻击了谁，投票就退化成随机猜）。
    const speechesByCandidate = new Map<string, string>();

    for (const agent of candidates) {
      await this.engine.checkpoint();

      // 狼人可以选择自爆
      if (agent.player.faction === Faction.WOLF) {
        let wantsExplode = false;
        if (agent.isHumanPlayer) {
          const input = await this.engine.waitForHumanInput(
            agent.player.id,
            '你是狼人，是否自爆？（自爆后本局无警长，直接进入黑夜）',
            { type: 'confirm', options: ['发言', '自爆'] }
          );
          wantsExplode = input.choice === '自爆';
        } else {
          // 由 AI 根据局势决策是否自爆（默认不自爆）
          const aliveWolves = this.state.players.filter(p => p.isAlive && p.faction === Faction.WOLF).map(p => p.name);
          const aliveGoods = this.state.players.filter(p => p.isAlive && p.faction !== Faction.WOLF).map(p => p.name);
          const explodeCtx = `你是狼人${agent.player.name}，正处于警长竞选发言环节。当前存活狼人：${aliveWolves.join('、')}（含你）；存活好人：${aliveGoods.join('、')}。\n\n【自爆规则】自爆会立即公开你的狼人身份、你死亡，警徽流失，本局无警长，直接进入黑夜（跳过所有发言与投票）。\n\n【何时该自爆】仅在以下情况才自爆：\n- 场上真预言家即将报出你或你的队友是狼人；\n- 好人已抱团锁定你，警长竞选中你必然被票出；\n- 打断关键好人（如预言家）的信息传递。\n\n默认应当【继续发言】伪装好人，除非上述局势非常明显。请决定：继续发言（yes）还是自爆（no）？`;
          const decision = await agent.decideYesNo(explodeCtx, true); // 默认继续发言，不自爆
          wantsExplode = !decision.yes;
        }

        if (wantsExplode) {
          agent.player.isAlive = false;
          console.log(`\n  💥 ${agent.player.name} 自爆！身份是狼人！`);
          console.log(`  ⚠️ 警弽流失，本局无警长，直接进入黑夜！`);

          this.eventBus.emit('wolf_explode', {
            playerId: agent.player.id,
            playerName: agent.player.name,
          });
          this.eventBus.emit('sheriff_election_end', { result: 'wolf_explode' });

          for (const a of alivePlayers) {
            a.receiveNotification(`${agent.player.name}在警长竞选中自爆，身份是狼人！本局无警长，直接进入黑夜。`);
          }

          return { exploded: true };
        }
      }

      let speech: string;
      if (agent.isHumanPlayer) {
        const input = await this.engine.waitForHumanInput(
          agent.player.id,
          '请发表警长竞选演说',
          { type: 'speech' }
        );
        speech = input.speech || '竞选警长';
      } else {
        const context = '警长竞选演说环节。你需要说服警下玩家把警徽投给你。请在发言中展示你的分析能力、明确表态、暗示（但不必直接暴露）你的身份价值。演说不要泄漏机密（如具体验人结果，除非你决定跳预言家）。';
        const result = await agent.speak(context, this.state);
        speech = result.publicSpeech;
      }

      console.log(`  🏅 ${agent.player.name}：${speech.substring(0, 100)}${speech.length > 100 ? '...' : ''}`);
      speechesByCandidate.set(agent.player.id, speech);
      this.eventBus.emit('sheriff_speech', {
        playerId: agent.player.id,
        playerName: agent.player.name,
        speech,
      });

      // 让所有人听到演说
      for (const other of alivePlayers) {
        if (other.player.id !== agent.player.id) {
          other.hearSpeech(agent.player.id, agent.player.name, speech);
        }
      }

      await this.delay(estimateSpeechPacingMs(speech));
    }

    // === 3. 退水阶段 ===
    console.log(`\n  📢 退水阶段：警上玩家可选择退水`);
    const withdrawals: string[] = [];

    for (const agent of [...candidates]) {
      await this.engine.checkpoint();

      let withdraw: boolean;
      if (agent.isHumanPlayer) {
        const input = await this.engine.waitForHumanInput(
          agent.player.id,
          '是否退水（放弃竞选）？',
          { type: 'confirm', options: ['继续竞选', '退水'] }
        );
        withdraw = input.choice === '退水';
      } else {
        // AI 根据场上形势决定是否退水（decision.yes = 是否继续竞选）
        const context = `你正在竞选警长，现在是退水环节。你已经上警并发表了竞选演说。除非你有明确理由（如判断竞争极其不利、或作为狼人想隐藏身份），否则应当【继续竞选】而不是退水。注意：退水后你将彻底退出本次警长选举，既不能被选也不能参与投票（连投票权都失去）。\n请决定：继续竞选（yes）还是退水放弃（no）？`;
        const decision = await agent.decideYesNo(context, true); // 默认继续竞选
        withdraw = !decision.yes;
      }

      if (withdraw) {
        withdrawals.push(agent.player.id);
        candidates = candidates.filter(a => a.player.id !== agent.player.id);
        // 标准规则：退水者彻底退出警长竞选 —— 既不能被投（已从 candidates 移除），
        // 也不属于"警下"投票群体，不能参与本次警长选举投票（不加入 voters）。
        console.log(`  💧 ${agent.player.name} 退水（放弃竞选，同时失去本次警长投票权）`);
        this.eventBus.emit('sheriff_withdraw', {
          playerId: agent.player.id,
          playerName: agent.player.name,
        });
      }
    }

    // 标准规则：首夜被夜杀者在整套竞选流程（上警、发言、退水、投票、当选）中都视为存活，
    // 直到竞选彻底结束才公布死讯。此处不做剔除。

    // 退水后检查
    if (candidates.length === 0) {
      console.log(`\n  ⚠️ 所有候选人退水，本局无警长。`);
      this.eventBus.emit('sheriff_election_end', { result: 'all_withdrawn' });
      for (const agent of alivePlayers) {
        agent.receiveNotification('所有警长候选人退水，本局不设警长。');
      }
      return { exploded: false };
    }

    if (candidates.length === 1) {
      this.state.sheriffId = candidates[0].player.id;
      const name = candidates[0].player.name;
      console.log(`\n  🏅 ${name} 为唯一剩余候选人，自动当选警长！`);
      this.eventBus.emit('sheriff_elected', { sheriffId: candidates[0].player.id, sheriffName: name, votes: 0 });
      for (const agent of alivePlayers) {
        agent.receiveNotification(`${name}当选为本局警长，拥有1.5票投票权和归票发言权。`);
      }
      return { exploded: false };
    }

    // === 4. 警下投票 ===
    const elected = await this.sheriffVoteRound(candidates, voters, alivePlayers, false, speechesByCandidate);

    if (elected) {
      this.state.sheriffId = elected.player.id;
      console.log(`\n  🏅 ${elected.player.name} 当选为警长！`);
      this.eventBus.emit('sheriff_elected', {
        sheriffId: elected.player.id,
        sheriffName: elected.player.name,
        votes: 0,
      });
      for (const agent of alivePlayers) {
        agent.receiveNotification(`${elected.player.name}当选为本局警长，拥有1.5票投票权和归票发言权。`);
      }
    } else {
      console.log(`\n  ⚠️ 二次平票，警徽流失，本局无警长。`);
      this.eventBus.emit('sheriff_election_end', { result: 'tie_lost' });
      for (const agent of alivePlayers) {
        agent.receiveNotification('警长竞选两次平票，警徽流失，本局不设警长。');
      }
    }
    return { exploded: false };
  }

  /**
   * 警长投票轮次（复用于首轮和PK轮）
   * 返回当选者或 null（平票需PK/流失）
   */
  private async sheriffVoteRound(
    candidates: BaseAgent[],
    voters: BaseAgent[],
    allPlayers: BaseAgent[],
    isPK: boolean,
    speechesByCandidate: Map<string, string>
  ): Promise<BaseAgent | null> {
    const roundName = isPK ? 'PK投票' : '警下投票';
    console.log(`\n  🗳️ ${roundName}（${voters.length}人投票，${candidates.length}人候选）：`);

    const candidateIds = candidates.map(a => a.player.id);
    const voteResults: Record<string, number> = {};
    for (const id of candidateIds) {
      voteResults[id] = 0;
    }

    // 把每位候选人刚才的竞选演说原文拼出来，作为投票上下文喂给 AI。
    // 否则 vote() 只能看到"候选人：A、B、C"这样的空信息，就只能靠记忆里可能被挤掉的碎片乱猜，
    // 导致出现"张飞攻击了华佗，但华佗仍投张飞"这类不符合发言逻辑的怪票。
    const speechDigest = candidates.map(c => {
      const raw = speechesByCandidate.get(c.player.id) || '（未发言/演说记录缺失）';
      const trimmed = raw.length > 260 ? raw.slice(0, 260) + '…' : raw;
      return `【${c.player.name}(${c.player.id})的${isPK ? 'PK' : '竞选'}演说】${trimmed}`;
    }).join('\n');

    for (const agent of voters) {
      await this.engine.checkpoint();

      let targetId: string;
      if (agent.isHumanPlayer) {
        const input = await this.engine.waitForHumanInput(
          agent.player.id,
          `请投票选出警长候选人`,
          { targets: candidateIds }
        );
        targetId = input.targetId;
      } else {
        const candidateNames = candidateIds.map(id => `${this.getPlayerName(id)}(${id})`).join('、');
        const context =
`警长${isPK ? 'PK' : ''}投票环节。候选人：${candidateNames}。

以下是每位候选人刚才的演说原文，请**严格基于发言内容**判断谁最像好人、谁最像狼人，谁值得把警徽（含1.5票权）交给他：
${speechDigest}

【判断纪律（必读）】
- 如果某位候选人跳了预言家/军师并报出了具体验人结果（如"昨夜验了 X 是好人/狼人"）——这是关键身份信号，除非有明显对跳，否则应当优先考虑投他。
- 如果某位候选人在演说中主要用来攻击/辱骂特定玩家（"XX那厮"、"XX鬼鬼祟祟"）而没有给出实质推理，那攻击方比被攻击方更可疑：狼人常靠泼脏水抢警。
- **不要投给公开怀疑你自己的人**（除非你是狼人想埋线）——这是最起码的自保逻辑。
- **不要因为演说风格张扬/嗓门大就跟票**，粗话和自吹不是好人证明。
- 综合演说的信息量、验人价值、逻辑清晰度做决定，不要凭首字母/位置随便挑。`;
        const result = await agent.vote(context, candidateIds);
        targetId = result.targetId;
      }

      if (!candidateIds.includes(targetId)) {
        targetId = this.sheriffFallbackRandom.pick(candidateIds);
      }

      voteResults[targetId] = (voteResults[targetId] || 0) + 1;
      console.log(`     ${agent.player.name} → ${this.getPlayerName(targetId)}`);

      this.eventBus.emit('sheriff_vote', {
        voterId: agent.player.id,
        voterName: agent.player.name,
        targetId,
        targetName: this.getPlayerName(targetId),
      });

      await this.delay(VOTE_PACING_MS);
    }

    // 统计结果
    const sortedResults = Object.entries(voteResults).sort((a, b) => b[1] - a[1]);
    const maxVotes = sortedResults[0][1];
    const winners = sortedResults.filter(([_, v]) => v === maxVotes);

    console.log(`  📊 ${roundName}结果：`);
    for (const [id, count] of sortedResults) {
      console.log(`     ${this.getPlayerName(id)}: ${count} 票`);
    }

    // 发送竞选投票结果给前端
    const tally = sortedResults.map(([id, count]) => ({
      name: this.getPlayerName(id),
      votes: count,
    }));
    this.eventBus.emit('sheriff_vote_result', { tally });

    if (winners.length === 1) {
      return candidates.find(a => a.player.id === winners[0][0]) || null;
    }

    // 平票
    if (isPK) {
      // PK轮再次平票 → 警徽流失
      return null;
    }

    // 首轮平票 → PK发言 + 二次投票
    console.log(`\n  ⚖️ 平票！进入PK发言环节`);
    const pkCandidates = winners.map(([id]) => candidates.find(a => a.player.id === id)!).filter(Boolean);

    // PK 阶段收集每位候选人的最新演说，供 vote() 拿到真实上下文。
    // 用一份新 map，避免 PK 阶段的演说与首轮混淆（PK 演说是覆盖式的最新表态）。
    const pkSpeechesByCandidate = new Map<string, string>();

    // PK发言
    for (const agent of pkCandidates) {
      await this.engine.checkpoint();

      let speech: string;
      if (agent.isHumanPlayer) {
        const input = await this.engine.waitForHumanInput(
          agent.player.id,
          '平票PK：请再次发表竞选演说',
          { type: 'speech' }
        );
        speech = input.speech || 'PK发言';
      } else {
        const context = '警长竞选平票PK环节！你需要再次发言争取选票。请阐述你为什么比对手更适合当警长。';
        const result = await agent.speak(context, this.state);
        speech = result.publicSpeech;
      }

      console.log(`  🏅 [PK] ${agent.player.name}：${speech.substring(0, 100)}${speech.length > 100 ? '...' : ''}`);
      pkSpeechesByCandidate.set(agent.player.id, speech);
      this.eventBus.emit('sheriff_pk_speech', {
        playerId: agent.player.id,
        playerName: agent.player.name,
        speech,
      });

      for (const other of allPlayers) {
        if (other.player.id !== agent.player.id) {
          other.hearSpeech(agent.player.id, agent.player.name, speech);
        }
      }

      await this.delay(estimateSpeechPacingMs(speech));
    }

    // PK投票（仍由警下投票）：把 PK 演说原文喂给下一轮 vote()
    return await this.sheriffVoteRound(pkCandidates, voters, allPlayers, true, pkSpeechesByCandidate);
  }
}
