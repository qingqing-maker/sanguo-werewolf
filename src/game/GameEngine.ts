import { GameState, GamePhase, Faction, GameConfig, RoleType, EventType } from '../types';
import { BaseAgent } from '../agents/BaseAgent';
import { AgentFactory } from '../agents/AgentFactory';
import { RoleRegistry } from '../roles/RoleRegistry';
import { PhaseManager } from './PhaseManager';
import { VoteManager } from './VoteManager';
import { LLMProvider } from '../llm/LLMProvider';
import { EventPublisher, globalEventBus } from './EventBus';
import { scalePacingMs } from './pacing';
import { PhaseNode, TransitionSignal, nextPhase } from './PhaseMachine';
import { randomUUID } from 'node:crypto';
import { MathRandomSource, RandomSource } from '../random';

export interface PendingHumanInputSnapshot {
  readonly requestId: string;
  readonly gameId: string;
  readonly playerId: string;
  readonly prompt: string;
  readonly options: Record<string, unknown>;
}

interface PendingHumanInput extends PendingHumanInputSnapshot {
  validate: (input: unknown) => input is Record<string, unknown>;
  resolve: (input: any) => void;
  reject: (error: Error) => void;
}

const MAX_HUMAN_SPEECH_LENGTH = 2_000;

function isPlainInput(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inputValidator(options: Record<string, unknown>): (input: unknown) => input is Record<string, unknown> {
  const targets = Array.isArray(options.targets) ? options.targets.filter((value): value is string => typeof value === 'string') : null;
  const choices = options.type === 'confirm' && Array.isArray(options.options)
    ? options.options.filter((value): value is string => typeof value === 'string')
    : null;
  const speech = options.type === 'speech' || typeof options.context === 'string';
  const allowEmpty = options.allowEmpty === true;
  return (input: unknown): input is Record<string, unknown> => {
    if (!isPlainInput(input)) return false;
    const keys = Object.keys(input);
    if (targets) return keys.every(key => ['targetId', 'reason', 'reasoning'].includes(key))
      && typeof input.targetId === 'string' && targets.includes(input.targetId)
      && (input.reason === undefined || typeof input.reason === 'string' && input.reason.length <= 256)
      && (input.reasoning === undefined || typeof input.reasoning === 'string' && input.reasoning.length <= 256);
    if (choices) return keys.length === 1 && keys[0] === 'choice'
      && typeof input.choice === 'string' && choices.includes(input.choice);
    if (speech) return keys.length === 1 && keys[0] === 'speech'
      && typeof input.speech === 'string' && input.speech.length <= MAX_HUMAN_SPEECH_LENGTH
      && (allowEmpty || input.speech.trim().length > 0);
    return false;
  };
}

export type HumanInputResult = {
  accepted: boolean;
  reason?: 'no_pending_input' | 'wrong_game' | 'wrong_request' | 'wrong_seat' | 'invalid_input';
};

export interface SeatPrivateSnapshot {
  seatId: string;
  roleType: RoleType;
  faction: Faction;
  wolfPartners?: Array<{ id: string; name: string }>;
  seerResults?: ReadonlyArray<{ name: string; isWolf: boolean; round: number }>;
  pendingInput: PendingHumanInputSnapshot | null;
}
export interface GameEngineOptions {
  random?: RandomSource;
  /** 对局 ID 属于基础设施标识，不得消耗游戏随机流。 */
  idFactory?: () => string;
  eventBus?: EventPublisher;
}

/**
 * GameEngine - 游戏主引擎
 * 支持暂停/继续/重启、猎人技能、人类玩家介入
 */
export class GameEngine {
  private readonly gameId: string;
  private readonly random: RandomSource;
  private readonly sheriffTransferRandom: RandomSource;
  private readonly eventBus: EventPublisher;

  getGameId(): string {
    return this.gameId;
  }

  private config: GameConfig;
  getConfig(): GameConfig { return this.config; }
  getPhaseRound(): { phase: GamePhase | null; round: number } {
    return this.state ? { phase: this.state.phase, round: this.state.round } : { phase: null, round: 0 };
  }
  private llm: LLMProvider;
  private agents: BaseAgent[] = [];
  private state!: GameState;
  private phaseManager!: PhaseManager;
  private voteManager!: VoteManager;

  // 暂停/取消控制
  private _paused = false;
  private _cancelled = false;
  private abortController = new AbortController();
  private _pausePromise: Promise<void> | null = null;
  private _pauseResolve: (() => void) | null = null;

  // 同一时刻至多存在一个人类输入请求。
  private pendingHumanInput: PendingHumanInput | null = null;

  constructor(config: GameConfig, llm: LLMProvider, options: GameEngineOptions = {}) {
    this.config = config;
    this.llm = llm;
    this.random = options.random ?? new MathRandomSource();
    this.eventBus = options.eventBus ?? globalEventBus;
    this.sheriffTransferRandom = this.random.fork('sheriff-transfer');
    this.gameId = (options.idFactory ?? randomUUID)();
  }

  get paused(): boolean { return this._paused; }
  get cancelled(): boolean { return this._cancelled; }

  /**
   * 获取当前所有玩家信息
   */
  getPlayers() {
    return this.agents.map(a => ({
      id: a.player.id,
      name: a.player.name,
      title: a.player.characterConfig.title,
      roleType: a.player.roleType,
      faction: a.player.faction,
      isAlive: a.player.isAlive,
      isHumanPlayer: a.isHumanPlayer,
    }));
  }

  /**
   * 将指定玩家设置为人类控制
   */
  setHumanPlayer(playerId: string): boolean {
    const agent = this.agents.find(a => a.player.id === playerId);
    if (agent) {
      for (const candidate of this.agents) candidate.isHumanPlayer = candidate === agent;
      console.log(`[Engine] 人类玩家接管: ${agent.player.name}`);
      return true;
    }
    return false;
  }

  /**
   * 取消人类玩家接管
   */
  removeHumanPlayer(playerId: string): boolean {
    const agent = this.agents.find(a => a.player.id === playerId);
    if (agent) {
      agent.isHumanPlayer = false;
      console.log(`[Engine] AI 重新接管: ${agent.player.name}`);
      return true;
    }
    return false;
  }

  /**
   * 返回当前被标记为人类控制的座位 id；无人类座位（观战模式）时返回 null。
   * 供服务端遮罩层判断本局是否需要隐藏他人身份。
   */
  getHumanPlayerId(): string | null {
    return this.agents.find(a => a.isHumanPlayer)?.player.id ?? null;
  }

  /**
   * 暂停游戏
   */
  pause(): void {
    if (!this._paused) {
      this._paused = true;
      this._pausePromise = new Promise(resolve => {
        this._pauseResolve = resolve;
      });
      console.log('[Engine] 游戏已暂停');
      this.eventBus.emit('game_paused', {});
    }
  }

  /**
   * 继续游戏
   */
  resume(): void {
    if (this._paused && this._pauseResolve) {
      this._paused = false;
      this._pauseResolve();
      this._pausePromise = null;
      this._pauseResolve = null;
      console.log('[Engine] 游戏已继续');
      this.eventBus.emit('game_resumed', {});
    }
  }

  /**
   * 取消/终止游戏
   */
  cancel(): void {
    this._cancelled = true;
    this.abortController.abort();
    const pending = this.pendingHumanInput;
    this.pendingHumanInput = null;
    pending?.reject(new Error('GAME_CANCELLED'));
    // 取消暂停只解除内部阻塞，不发布“游戏继续”这一语义事件。
    if (this._paused) {
      this._paused = false;
      this._pauseResolve?.();
      this._pausePromise = null;
      this._pauseResolve = null;
    }
    console.log('[Engine] 游戏已终止');
  }

  /** 返回 pending 的只读深拷贝。 */
  getPendingHumanInput(): PendingHumanInputSnapshot | null {
    const pending = this.pendingHumanInput;
    if (!pending) return null;
    return {
      requestId: pending.requestId,
      gameId: pending.gameId,
      playerId: pending.playerId,
      prompt: pending.prompt,
      options: JSON.parse(JSON.stringify(pending.options)) as Record<string, unknown>,
    };
  }

  /** 返回指定座位的最小私有快照，不包含 memory、prompt 或推理过程。 */
  getSeatPrivateSnapshot(seatId: string): SeatPrivateSnapshot | null {
    const agent = this.agents.find(candidate => candidate.player.id === seatId);
    if (!agent) return null;
    const wolves = agent.player.faction === Faction.WOLF
      ? this.agents.filter(candidate => candidate.player.faction === Faction.WOLF && candidate !== agent)
        .map(candidate => ({ id: candidate.player.id, name: candidate.player.name }))
      : undefined;
    const seerResults = agent.player.roleType === RoleType.SEER ? agent.getSeerResults() : undefined;
    const pending = this.getPendingHumanInput();
    return {
      seatId,
      roleType: agent.player.roleType,
      faction: agent.player.faction,
      ...(wolves ? { wolfPartners: wolves } : {}),
      ...(seerResults ? { seerResults } : {}),
      pendingInput: pending?.playerId === seatId ? pending : null,
    };
  }

  /** 校验对局、请求和服务端绑定座位后才消费输入。 */
  receiveHumanInput(gameId: string, requestId: string, seatId: string, input: any): HumanInputResult {
    const pending = this.pendingHumanInput;
    if (!pending) return { accepted: false, reason: 'no_pending_input' };
    if (pending.gameId !== gameId) return { accepted: false, reason: 'wrong_game' };
    if (pending.requestId !== requestId) return { accepted: false, reason: 'wrong_request' };
    if (pending.playerId !== seatId) return { accepted: false, reason: 'wrong_seat' };
    if (!pending.validate(input)) return { accepted: false, reason: 'invalid_input' };
    this.pendingHumanInput = null;
    pending.resolve(input);
    return { accepted: true };
  }

  /** 先登记 pending 再发布事件，避免同步监听方错过请求。 */
  waitForHumanInput(playerId: string, prompt: string, options: any): Promise<any> {
    if (this.pendingHumanInput) return Promise.reject(new Error('HUMAN_INPUT_ALREADY_PENDING'));
    const requestId = randomUUID();
    const normalizedOptions = JSON.parse(JSON.stringify(options ?? {})) as Record<string, unknown>;
    const validate = inputValidator(normalizedOptions);
    return new Promise((resolve, reject) => {
      this.pendingHumanInput = {
        requestId,
        gameId: this.gameId,
        playerId,
        prompt,
        options: normalizedOptions,
        validate,
        resolve,
        reject,
      };
      this.eventBus.emit('human_input_required', { requestId, playerId, prompt, options: { ...this.pendingHumanInput.options } });
    });
  }

  /**
   * 收集遗言：人类座位由玩家自己手输，AI 座位才交给 LLM 生成。
   * 三处发遗言的调用点（放逐 / 猎人开枪后 / 首夜被刀）统一走这里，
   * 避免人类玩家的遗言被 AI 代笔。人类走 speech 文本框链路，回传 { speech }。
   */
  async collectLastWords(agent: BaseAgent, causeOfDeath?: string): Promise<string> {
    if (agent.isHumanPlayer) {
      const causeText = causeOfDeath ? `（${causeOfDeath}）` : '';
      const input = await this.waitForHumanInput(
        agent.player.id,
        `你已出局${causeText}，请留下遗言（可直接留空跳过）`,
        { type: 'speech', allowEmpty: true },
      );
      const speech = input && typeof input.speech === 'string' ? input.speech.trim() : '';
      return speech;
    }
    return agent.lastWords(causeOfDeath);
  }

  /**
   * 暂停检查点 - 在每个关键步骤前调用
   * public 以便 PhaseManager/VoteManager 在每个玩家操作前检查
   */
  async checkpoint(): Promise<void> {
    if (this._cancelled) throw new Error('GAME_CANCELLED');
    if (this._paused && this._pausePromise) {
      await this._pausePromise;
    }
    if (this._cancelled) throw new Error('GAME_CANCELLED');
  }

  /**
   * 启动一局游戏
   */
  async start(onInitialized?: (gameId: string, players: ReturnType<GameEngine['getPlayers']>) => void): Promise<void> {
    return this.eventBus.runWithGameId(this.gameId, () => this.startInContext(onInitialized));
  }

  private async startInContext(onInitialized?: (gameId: string, players: ReturnType<GameEngine['getPlayers']>) => void): Promise<void> {
    this._paused = false;
    this._cancelled = false;
    if (this.abortController.signal.aborted) this.abortController = new AbortController();

    this.printBanner();

    const validation = RoleRegistry.validateConfig(this.config);
    if (!validation.valid) {
      throw new Error(`游戏配置无效: ${validation.error}`);
    }

    this.initialize();
    // 服务端在任何 game_start/私密事件投影前完成会话与座位绑定。
    onInitialized?.(this.gameId, this.getPlayers());

    // 人类若是狼，把队友名单附到它自己的座位上——notifyWolves 只写内存 agent 状态，
    // 前端读不到；而 game_start 的遮罩层会保留人类自己座位的字段，故走这里传递。
    const humanId = this.getHumanPlayerId();
    const humanSeat = humanId ? this.state.players.find(p => p.id === humanId) : null;
    let humanWolfPartners: string[] | undefined;
    if (humanSeat && humanSeat.faction === Faction.WOLF) {
      humanWolfPartners = this.state.players
        .filter(p => p.faction === Faction.WOLF && p.id !== humanId)
        .map(p => p.name);
    }

    this.eventBus.emit('game_start', {
      players: this.state.players.map(p => ({
        id: p.id,
        name: p.name,
        title: p.characterConfig.title,
        roleType: p.roleType,
        faction: p.faction,
        isAlive: p.isAlive,
        // 仅人类自己的狼座位带此字段；遮罩层剥离他人身份时会保留它。
        ...(p.id === humanId && humanWolfPartners ? { wolfPartners: humanWolfPartners } : {}),
      })),
      config: this.config,
    });

    this.printRoleAssignment();

    try {
      await this.gameLoop();
    } catch (e: any) {
      // 本局 signal/_cancelled 是主动取消的权威；不能依赖底层异常恰好被
      // BaseAgent 翻译成某个固定文案。
      if (this._cancelled || this.abortController.signal.aborted || e?.message === 'GAME_CANCELLED') {
        console.log('[Engine] 游戏被终止');
        this.eventBus.emit('game_cancelled', {});
      } else {
        throw e;
      }
    }
  }

  /**
   * 初始化游戏
   */
  private initialize(): void {
    const shuffledRoles = RoleRegistry.shuffleRoles(this.config.roles, this.random.fork('roles'));
    const factory = new AgentFactory(
      this.llm,
      this.random.fork('agents'),
      this.eventBus,
      this.abortController.signal,
    );
    this.agents = factory.createAgents(
      shuffledRoles,
      this.config.humanCharacterName,
      this.config.aiDifficulty ?? 'standard',
    );

    this.state = {
      phase: GamePhase.NIGHT,
      round: 0,
      players: this.agents.map(a => a.player),
      events: [],
      nightActions: [],
      eliminatedTonight: [],
      witchSaveUsed: false,
      witchPoisonUsed: false,
      lastGuardTarget: null,
      sheriffId: null,
    };

    // 给每个 Agent 设置玩家列表引用
    for (const agent of this.agents) {
      agent.initializeTrust(this.state.players);
      agent.setPlayersRef(this.state.players);
    }

    this.phaseManager = new PhaseManager(this.agents, this.state, this, this.random.fork('phases'), this.eventBus);
    this.voteManager = new VoteManager(this.agents, this.state, this, this.eventBus);

    // 参战模式：把选定人物的座位标记为人类控制。人物由 AgentFactory 保证已在阵容内。
    if (this.config.humanCharacterName) {
      const seat = this.agents.find(a => a.player.name === this.config.humanCharacterName);
      if (seat) this.setHumanPlayer(seat.player.id);
    }

    this.notifyWolves();
  }

  /**
   * 通知狼人彼此的身份
   * 私密事件：由 EventVisibility 按 wolfId 仅投影给该狼人座位，
   * 让人类扮演的狼人也能立即在 UI 上看到"你的同伴是谁"。
   * AI 狼人不依赖此事件（走 receiveNotification 到内存），但一起发一份不影响。
   */
  private notifyWolves(): void {
    const wolves = this.agents.filter(a => a.player.faction === Faction.WOLF);
    for (const wolf of wolves) {
      const partners = wolves
        .filter(w => w.player.id !== wolf.player.id)
        .map(w => w.player.name);
      if (partners.length > 0) {
        wolf.receiveNotification(`你的狼人同伴是：${partners.join('、')}。白天互相掩护。`);
        // 私密事件：推给前端让人类狼人立即看到同伴；可见性策略仅对匹配 wolfId 的座位放行，
        // 观战与运维视角默认拒绝。
        this.eventBus.emit('wolf_partners_private', {
          wolfId: wolf.player.id,
          wolfName: wolf.player.name,
          partners,
        });
      }
    }
  }

  /**
   * 游戏主循环 - 状态机驱动器
   *
   * 阶段推进逻辑（首夜竞选先于死讯、自爆跳过白天、胜负判定收尾、maxRounds 兜底）已抽到
   * PhaseMachine.nextPhase 这张纯转移表里。这里只负责：取下一阶段 → 执行对应 handler →
   * 用 handler 回传的信号问下一步去哪，直到进入 END。每个 handler 内部逻辑与 emit 与
   * 重构前完全一致，只是从一整段顺序代码拆成了可分派的方法。
   */
  private async gameLoop(): Promise<void> {
    let node = nextPhase(PhaseNode.START, {});
    while (node !== PhaseNode.END) {
      const signal = await this.runPhase(node);
      node = nextPhase(node, signal);
    }
  }

  /**
   * 执行单个阶段，返回驱动状态机转移的信号。
   */
  private async runPhase(node: PhaseNode): Promise<TransitionSignal> {
    switch (node) {
      case PhaseNode.NIGHT:
        return this.runNight();
      case PhaseNode.DAWN:
        return this.runDawn();
      case PhaseNode.DAY:
        return this.runDay();
      case PhaseNode.VOTE:
        return this.runVote();
      default:
        // START/END 不会被派发到这里（驱动器只在 node !== END 时调用，且 START 已在入口转移掉）。
        return {};
    }
  }

  /**
   * 黑夜阶段：回合数递增 + 狼刀/守卫/预言家/女巫夜间行动。
   */
  private async runNight(): Promise<TransitionSignal> {
    this.state.round++;
    await this.checkpoint();
    this.state.phase = GamePhase.NIGHT;
    this.eventBus.emit('phase_change', { phase: 'night', round: this.state.round });
    await this.delay(1000);
    await this.phaseManager.executeNight();
    return {};
  }

  /**
   * 天亮结算阶段：首夜走「竞选先于死讯」特殊流程（含自爆分支），后续轮次一次性结算并公布；
   * 随后统一处理猎人链、夜死遗言、警徽传承与胜负判定。
   * 返回信号：exploded（首夜自爆 → 跳过白天）、gameEnded（已判定结束 → 转 END）。
   */
  private async runDawn(): Promise<TransitionSignal> {
    await this.checkpoint();
    this.state.phase = GamePhase.DAWN;
    this.eventBus.emit('phase_change', { phase: 'dawn', round: this.state.round });
    await this.delay(500);

    let nightDeaths: string[];
    if (this.state.round === 1) {
      // === 首夜特殊流程：竞选先于公布死讯 ===
      // 标准规则：警长竞选在「昨夜死讯公布之前」进行；被夜杀者在整套竞选流程（上警、发言、
      // 退水、投票、当选）中全程视为存活，直到竞选完全结束才由法官公布死讯。
      // 步骤：计算死讯（不置死）→ 竞选 →（若无自爆则）公布死讯 → 猎人开枪 → 警长传承。
      nightDeaths = this.phaseManager.computeDawn();

      await this.checkpoint();
      this.eventBus.emit('phase_change', { phase: 'sheriff_election', round: this.state.round });
      await this.delay(500);
      const electionResult = await this.phaseManager.executeSheriffElection(nightDeaths);

      // 无论自爆与否，都在竞选结束后立即公布昨夜死讯（自爆只是吞警徽、跳白天辩论/投票）
      this.phaseManager.announceDawn(nightDeaths);

      if (electionResult.exploded) {
        // 狼人在警上发言阶段自爆：警徽流失、警长竞选终止。
        // 死讯已公布 → 猎人开枪、警长传承照常结算，然后跳过白天辩论和投票，直接进入下一轮黑夜。
        // 首夜自爆分支：仍属首夜死亡，猎人开枪后允许发遗言（与规则「首夜死有遗言」一致）。
        const nightShotDeathsExplode = await this.handleHunterDeath(
          nightDeaths, '昨夜被狼人杀害', { allowLastWords: true },
        );
        await this.handleNightDeathLastWords(nightDeaths);
        await this.handleSheriffTransfer([...nightDeaths, ...nightShotDeathsExplode]);
        const endCheck = this.phaseManager.checkGameEnd();
        if (endCheck.ended) {
          this.announceWinner(endCheck.winner!, endCheck.reason!);
          return { gameEnded: true };
        }
        return { exploded: true };
      }
    } else {
      // 后续轮次：一次性结算并公布
      nightDeaths = this.phaseManager.resolveDawn();
    }

    // 猎人被夜杀时触发技能（返回值包含猎人枪杀新增死亡，需合并进传承检查）。
    // 遗言规则：只有首夜死者才有遗言，第二晚及以后夜里死亡一律「哑巴」——
    // 猎人也不例外，所以这里按 round 决定是否允许发遗言，避免第二夜猎人被刀
    // 走 handleHunterDeath 分支时绕过 handleNightDeathLastWords 的首夜守卫。
    const nightShotDeaths = await this.handleHunterDeath(
      nightDeaths, '昨夜被狼人杀害', { allowLastWords: this.state.round === 1 },
    );

    // 夜间死亡遗言（标准规则：仅首夜死者有遗言，第二晚起无。方法内部按轮次守卫）
    await this.handleNightDeathLastWords(nightDeaths);

    // 警长传承（合并夜晚死亡 + 猎人枪杀新增死亡）
    await this.handleSheriffTransfer([...nightDeaths, ...nightShotDeaths]);

    // 检查游戏结束
    const afterNight = this.phaseManager.checkGameEnd();
    if (afterNight.ended) {
      this.announceWinner(afterNight.winner!, afterNight.reason!);
      return { gameEnded: true };
    }
    return {};
  }

  /**
   * 白天辩论阶段。
   */
  private async runDay(): Promise<TransitionSignal> {
    await this.checkpoint();
    this.state.phase = GamePhase.DAY;
    this.eventBus.emit('phase_change', { phase: 'day', round: this.state.round });
    await this.delay(500);
    await this.phaseManager.executeDay();
    return {};
  }

  /**
   * 投票放逐阶段：投票 + 猎人开枪 + 警长传承 + 胜负判定 + maxRounds 兜底。
   * 返回 gameEnded 时状态机转 END，否则进入下一轮黑夜。
   */
  private async runVote(): Promise<TransitionSignal> {
    await this.checkpoint();
    this.state.phase = GamePhase.VOTE;
    this.eventBus.emit('phase_change', { phase: 'vote', round: this.state.round });
    await this.delay(500);
    const eliminated = await this.voteManager.executeVote();

    // 猎人被投票放逐时触发技能（合并枪杀新增死亡到传承检查）
    if (eliminated) {
      const dayShotDeaths = await this.handleHunterDeath([eliminated], '白天被投票放逐');

      // 警长传承
      await this.handleSheriffTransfer([eliminated, ...dayShotDeaths]);
    }

    // 检查游戏结束
    const afterVote = this.phaseManager.checkGameEnd();
    if (afterVote.ended) {
      this.announceWinner(afterVote.winner!, afterVote.reason!);
      return { gameEnded: true };
    }

    // 防止无限循环
    if (this.state.round >= this.config.maxRounds) {
      this.announceWinner(Faction.WOLF, '回合数耗尽');
      return { gameEnded: true };
    }
    return {};
  }

  /**
   * 猎人死亡时开枪带人（被女巫毒死时不能开枪）
   * 返回猎人枪杀新增的死亡玩家 ID，供上层继续做警徽传承等结算。
   * 若目标也是猎人，允许连锁开枪，用 visited 防止重复处理。
   *
   * @param opts.allowLastWords 是否允许开枪后发遗言。规则要求：
   *   - 首夜死亡（含首夜自爆分支）与白天投票放逐：允许（true）
   *   - 第二夜及以后夜里死亡：一律「哑巴」（false）——原实现在这里无条件发遗言，
   *     导致第二夜被狼刀的猎人也能留遗言，违反标准规则。守卫由调用点决定并显式传入，
   *     比在这里读 state.round 或匹配 causeOfDeath 文案更明确、更容易被回归测试锁死。
   *   - 猎人链的下一环沿用调用点传入的值：A、B 属于同一次死亡结算，
   *     A 能发遗言时 B 也能（首夜/放逐），A 不能时 B 也不能（第二夜以后）。
   */
  private async handleHunterDeath(
    deadIds: string[],
    causeOfDeath = '被淘汰',
    opts: { allowLastWords?: boolean } = {},
  ): Promise<string[]> {
    const allowLastWords = opts.allowLastWords ?? true;
    const shotDeaths: string[] = [];
    const visited = new Set<string>();
    const queue = [...deadIds];

    while (queue.length > 0) {
      const deadId = queue.shift()!;
      if (visited.has(deadId)) continue;
      visited.add(deadId);

      const player = this.state.players.find(p => p.id === deadId);
      if (!player || player.roleType !== RoleType.HUNTER) continue;

      // 被女巫毒死的猎人不能开枪
      const poisonedByWitch = this.state.nightActions
        .find(a => a.actionType === EventType.WITCH_POISON && a.targetId === deadId);
      if (poisonedByWitch) {
        console.log(`\n  🏹 猎人${player.name}被毒杀，无法发动技能。`);
        continue;
      }

      const agent = this.agents.find(a => a.player.id === deadId);
      if (!agent) continue;

      // 猎人可以选择存活的玩家开枪
      const targets = this.state.players
        .filter(p => p.isAlive && p.id !== deadId)
        .map(p => p.id);

      if (targets.length === 0) continue;

      console.log(`\n  🏹 猎人${player.name}发动技能！`);

      let targetId: string;
      if (agent.isHumanPlayer) {
        const input = await this.waitForHumanInput(deadId, '猎人技能：选择带走的目标', { targets });
        targetId = input.targetId;
      } else {
        targetId = await agent.hunterShoot(targets);
      }

      const target = this.state.players.find(p => p.id === targetId);
      if (target && target.isAlive) {
        target.isAlive = false;
        shotDeaths.push(target.id);
        console.log(`  🏹 ${player.name}开枪带走了${target.name}！`);

        this.eventBus.emit('hunter_shoot', {
          hunterId: player.id,
          hunterName: player.name,
          targetId: target.id,
          targetName: target.name,
          targetRoleType: target.roleType,
          targetFaction: target.faction,
        });

        // 通知所有存活玩家
        for (const a of this.agents.filter(ag => ag.player.isAlive)) {
          a.receiveNotification(`猎人${player.name}临死前开枪带走了${target.name}！`);
        }

        // 目标若也是猎人，允许其连锁开枪
        if (target.roleType === RoleType.HUNTER) {
          queue.push(target.id);
        }
      }

      // 猎人开枪之后，给猎人自己一个遗言（标准规则：先开枪再遗言）。
      // allowLastWords=false 时（第二夜及以后夜间死亡）直接跳过，猎人正常开枪但不留遗言。
      if (allowLastWords) {
        try {
          const words = await this.collectLastWords(agent, causeOfDeath);
          if (words) {
            console.log(`  📜 猎人${player.name}遗言: ${words}`);
            this.eventBus.emit('player_last_words', {
              playerId: player.id,
              playerName: player.name,
              words,
            });
            for (const a of this.agents.filter(ag => ag.player.isAlive)) {
              a.receiveLastWords(player.name, words);
            }
          }
        } catch (e: any) {
          if (e?.message === 'GAME_CANCELLED') throw e;
          // 遗言失败不影响游戏进程
        }
      }
    }
    return shotDeaths;
  }

  /**
   * 夜间死亡遗言（标准规则）：
   * - 仅首夜（round===1）死者有遗言；第二晚及以后夜间死者「哑巴」出局，无遗言。
   * - 猎人的遗言由 handleHunterDeath 在开枪之后统一处理，这里跳过猎人避免重复。
   * - 遗言会广播给所有存活玩家（仅进入普通记忆并标注待辨真伪），这是好人传递信息的核心途径，
   *   尤其预言家首夜被刀时能借遗言报出验人结果——属于标准打法，但不会被系统自动认证。
   */
  private async handleNightDeathLastWords(deadIds: string[]): Promise<void> {
    // 只有首夜死亡才有遗言
    if (this.state.round !== 1) return;

    for (const deadId of deadIds) {
      const player = this.state.players.find(p => p.id === deadId);
      if (!player) continue;
      // 猎人遗言由 handleHunterDeath 处理（先开枪再遗言），此处跳过防止重复
      if (player.roleType === RoleType.HUNTER) continue;

      const agent = this.agents.find(a => a.player.id === deadId);
      if (!agent) continue;

      try {
        const words = await this.collectLastWords(agent, '昨夜被狼人杀害');
        if (words) {
          console.log(`  📜 ${player.name}遗言: ${words}`);
          this.eventBus.emit('player_last_words', {
            playerId: player.id,
            playerName: player.name,
            words,
          });
          for (const a of this.agents.filter(ag => ag.player.isAlive)) {
            a.receiveLastWords(player.name, words);
          }
        }
      } catch (e: any) {
        if (e?.message === 'GAME_CANCELLED') throw e;
        // 遗言失败不影响游戏进程
      }
    }
  }

  /**
   * 警长死亡时传承警徽
   */
  private async handleSheriffTransfer(deadIds: string[]): Promise<void> {
    if (!this.state.sheriffId) return;
    if (!deadIds.includes(this.state.sheriffId)) return;

    const deadSheriff = this.state.players.find(p => p.id === this.state.sheriffId);
    if (!deadSheriff) return;

    const agent = this.agents.find(a => a.player.id === this.state.sheriffId);
    const alivePlayers = this.state.players.filter(p => p.isAlive && p.id !== this.state.sheriffId);

    if (alivePlayers.length === 0) {
      this.state.sheriffId = null;
      return;
    }

    const targets = alivePlayers.map(p => p.id);
    let inheritId: string;

    if (agent && agent.isHumanPlayer) {
      const input = await this.waitForHumanInput(
        this.state.sheriffId,
        '你是警长，死亡前请指定一名玩家继承警徽',
        { targets }
      );
      inheritId = input.targetId;
    } else if (agent) {
      // 构建传承上下文，注入查验记录（如果是预言家）
      let seerWarning = '';
      let knownWolfIds: string[] = [];
      if (agent.getSeerResults() && agent.getSeerResults().length > 0) {
        const wolves = agent.getSeerResults().filter(r => r.isWolf).map(r => r.name);
        const goods = agent.getSeerResults().filter(r => !r.isWolf).map(r => r.name);
        // 找出已验狼人的ID
        knownWolfIds = targets.filter(id => {
          const p = this.state.players.find(pl => pl.id === id);
          return p && wolves.includes(p.name);
        });
        if (wolves.length > 0) {
          seerWarning += `\n⚠️【重要】你的查验记录显示以下玩家是狼人：${wolves.join('、')}。绝对不要把警徽传给狼人！`;
        }
        if (goods.length > 0) {
          seerWarning += `\n✅ 你的查验记录显示以下玩家是好人：${goods.join('、')}。优先把警徽传给已验证的好人！`;
        }
      }

      // 从候选列表中排除已知狼人
      const safeTargets = targets.filter(id => !knownWolfIds.includes(id));
      const finalTargets = safeTargets.length > 0 ? safeTargets : targets;

      const context = `你是警长，临死前请指定一名存活玩家继承警徽。候选人：${finalTargets.map(id => {
        const p = this.state.players.find(pl => pl.id === id);
        return `${p?.name}(${id})`;
      }).join('、')}${seerWarning}\n\n选择你最信任的好人继承警徽，这对好人阵营至关重要！`;
      const result = await agent.vote(context, finalTargets);
      inheritId = result.targetId;

      // 二次保护：如果LLM仍选了已知狼人，强制重选
      if (knownWolfIds.includes(inheritId) && safeTargets.length > 0) {
        inheritId = this.sheriffTransferRandom.pick(safeTargets);
      }
    } else {
      inheritId = this.sheriffTransferRandom.pick(targets);
    }

    if (!targets.includes(inheritId)) {
      inheritId = this.sheriffTransferRandom.pick(targets);
    }

    this.state.sheriffId = inheritId;
    const newSheriffName = this.state.players.find(p => p.id === inheritId)?.name || inheritId;

    console.log(`  🏅 警长${deadSheriff.name}将警徽传给了${newSheriffName}！`);

    this.eventBus.emit('sheriff_transfer', {
      fromId: deadSheriff.id,
      fromName: deadSheriff.name,
      toId: inheritId,
      toName: newSheriffName,
    });

    // 通知所有存活玩家
    for (const a of this.agents.filter(ag => ag.player.isAlive)) {
      a.receiveNotification(`警长${deadSheriff.name}将警徽传给了${newSheriffName}。`);
    }
  }

  /**
   * 宣布胜利
   */
  private announceWinner(winner: Faction, reason: string): void {
    console.log(`\n${'★'.repeat(50)}`);
    console.log(`\n🏆 游戏结束！`);
    console.log(`\n   胜利阵营: ${winner === Faction.GOOD ? '🟢 好人阵营' : '🔴 狼人阵营'}`);
    console.log(`   原因: ${reason}`);
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`\n📋 最终身份揭示：`);
    for (const player of this.state.players) {
      const status = player.isAlive ? '✅存活' : '❌已死';
      const factionIcon = player.faction === Faction.WOLF ? '🐺' : '😇';
      console.log(`   ${factionIcon} ${player.name}（${player.characterConfig.title}）- ${this.getRoleName(player.roleType)} [${status}]`);
    }
    console.log(`\n${'★'.repeat(50)}`);

    this.eventBus.emit('game_end', {
      winner,
      reason,
      players: this.state.players.map(p => ({
        id: p.id,
        name: p.name,
        title: p.characterConfig.title,
        roleType: p.roleType,
        faction: p.faction,
        isAlive: p.isAlive,
      })),
    });
  }

  private delay(ms: number): Promise<void> {
    const scaled = scalePacingMs(ms);
    if (scaled <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, scaled));
  }

  private printBanner(): void {
    console.log(`
╔══════════════════════════════════════════════════╗
║          ⚔️  三 国 狼 人 杀  ⚔️                  ║
║       Multi-Agent Werewolf Game Engine           ║
╚══════════════════════════════════════════════════╝
    `);
  }

  private printRoleAssignment(): void {
    console.log(`\n📜 本局角色分配（观众视角）：`);
    console.log(`${'─'.repeat(50)}`);
    for (const agent of this.agents) {
      const p = agent.player;
      const factionIcon = p.faction === Faction.WOLF ? '🐺' : '😇';
      console.log(`  ${factionIcon} ${p.name}（${p.characterConfig.title}）→ ${this.getRoleName(p.roleType)}`);
    }
    console.log(`${'─'.repeat(50)}\n`);
  }

  private getRoleName(roleType: string): string {
    const names: Record<string, string> = {
      werewolf: '🗡️ 细作（狼人）',
      seer: '🔮 军师（预言家）',
      witch: '💊 神医（女巫）',
      hunter: '🏹 猛将（猎人）',
      guard: '🛡️ 禁卫（守卫）',
      villager: '👤 平民',
    };
    return names[roleType] || roleType;
  }
}
