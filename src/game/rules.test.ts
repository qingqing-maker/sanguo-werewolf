/**
 * 规则状态机单测。**不发起任何网络请求、不消耗任何 token**（用 StubProvider 顶替 LLM）。
 *
 * 运行：npm run test:rules
 *
 * 为什么需要这层测试：PhaseManager/VoteManager/GameEngine 里的规则分支非常多——
 * 同守同救奶穿、平票 PK、警长 1.5 票、猎人链、毒杀禁枪、警徽避狼、胜负判定……
 * 这些此前全靠实机跑真实局撞出来，一次撞不到就留在代码里，而且每次重构都可能踩雷。
 * 这里用构造好的状态直接调规则函数，把每条分支钉死。
 *
 * 测试策略：只测**纯规则结算**（输入状态 → 输出死亡/胜负/票型），
 * 不测 LLM 决策质量（那属于难度校准，要靠批量统计而非单测）。
 */
import * as assert from 'node:assert/strict';
import {
  CharacterConfig,
  ChatMessage,
  EventType,
  Faction,
  GameConfig,
  GamePhase,
  GameState,
  NightAction,
  Player,
  RoleType,
} from '../types';
import { BaseAgent } from '../agents/BaseAgent';
import { LLMProvider } from '../llm/LLMProvider';
import { PhaseManager } from './PhaseManager';
import { VoteManager } from './VoteManager';
import { GameEngine } from './GameEngine';
import { ALL_ROLES } from '../roles/Role';
import { EventBus } from './EventBus';

const testEventBus = new EventBus();
import { GameEventType } from './GameEvents';

// 竞选/投票流程里穿插着大量展示停顿（delay）。测试只关心状态与事件序列，
// 把节奏系数归零，让整条流程瞬时跑完，避免单测被真实停顿拖成几十秒。
process.env.FAST_MODE = '1';

// AI 失误注入（预言家重复验人 / 守卫连守）默认有 12% 概率触发，会随机改写夜间行动的
// 目标与 voided 标记——这对「断言 night_action_done / seer_result_private 的确切目标」
// 是不可接受的抖动源。规则结算与事件发射的正确性不该由掷骰子决定，故在测试里归零；
// 失误注入本身是难度校准手段，属于批量模拟的统计范畴，不在单测职责内。
process.env.MISFIRE_SEER_REPEAT = '0';
process.env.MISFIRE_GUARD_REPEAT = '0';

// ============ 测试脚手架 ============

let passed = 0;
let failed = 0;
const failures: string[] = [];

/**
 * 被测代码（PhaseManager/GameEngine）自带大量 console 输出——那是给实机对局看的旁白。
 * 测试时它会把大量用例结果冲得看不清，所以在用例执行期间静音，
 * 只保留测试报告自己的输出（下面的 report* 直接走 process.stdout，不受影响）。
 */
const realConsole = { log: console.log, warn: console.warn, error: console.error };
function muteGameLogs(): void {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}
function unmuteGameLogs(): void {
  console.log = realConsole.log;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
}

/** 测试报告输出：绕过被静音的 console，直接写 stdout。 */
function report(line: string): void {
  process.stdout.write(line + '\n');
}

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  const run = async () => {
    muteGameLogs();
    try {
      await fn();
      unmuteGameLogs();
      passed++;
      report(`  ✓ ${name}`);
    } catch (e: any) {
      unmuteGameLogs();
      failed++;
      failures.push(name);
      report(`  ✗ ${name}`);
      report(`      ${String(e?.message || e).split('\n')[0]}`);
    }
  };
  return run();
}

/**
 * 不发起任何网络请求的 LLM 替身。
 *
 * 关键：`chat`/`chatJSON` 被调用即视为测试设计错误——规则结算不该依赖模型输出。
 * 少数确实要走 Agent 决策的用例（如猎人开枪目标）改用可编程的 ScriptedProvider。
 */
class StubProvider implements LLMProvider {
  async chat(): Promise<string> {
    throw new Error('StubProvider.chat 不应被调用：规则结算不该依赖 LLM');
  }
  async chatJSON<T>(): Promise<T> {
    throw new Error('StubProvider.chatJSON 不应被调用：规则结算不该依赖 LLM');
  }
}

/** 按脚本返回固定 JSON 的 Provider，用于需要 Agent 参与决策的用例（如猎人枪口）。 */
class ScriptedProvider implements LLMProvider {
  constructor(private readonly jsonReplies: any[]) {}
  private idx = 0;
  async chat(): Promise<string> {
    return '[内心]测试[发言]测试发言';
  }
  async chatJSON<T>(): Promise<T> {
    const reply = this.jsonReplies[Math.min(this.idx, this.jsonReplies.length - 1)];
    this.idx++;
    return reply as T;
  }
}

/**
 * 警长竞选专用替身：按 prompt 语境路由单个座位的每个决策。
 *
 * 竞选流程里同一座位会被依次问「上警 / 自爆 / 退水 / 投票」，这些全走 chat/chatJSON，
 * 用纯顺序脚本极易错位（少一次调用整条就偏）。这里改用 prompt 关键词路由，
 * 让每个决策点各自稳定命中，与调用次数解耦。
 *
 * decideYesNo 期望 {decision,reasoning}；vote 期望 {targetId,reason}；演说走 chat()。
 */
interface SeatScript {
  runForSheriff?: boolean;  // 上警阶段是否举手
  explode?: boolean;        // 狼人是否自爆（仅候选狼会被问到）
  withdraw?: boolean;       // 退水阶段是否退水
  voteFor?: string;         // 警下投票目标 id
  pkVoteFor?: string;       // PK 复投目标 id（缺省沿用 voteFor）
}

class SeatBrain implements LLMProvider {
  constructor(private readonly script: SeatScript) {}
  async chat(): Promise<string> {
    // 竞选演说 / PK 演说都走 chat()，返回可被 parseSpeechResponse 解析的最小格式。
    return '[内心]测试[发言]测试竞选演说';
  }
  async chatJSON<T>(_sys: string, messages: ChatMessage[]): Promise<T> {
    const content = messages[messages.length - 1]?.content ?? '';
    // 顺序敏感：先判 decideYesNo 的三种语境，最后兜底到 vote。
    // 关键词取自各调用点传入的 context，互不重叠。
    if (content.includes('上警环节')) {
      return { decision: this.script.runForSheriff ? 'yes' : 'no', reasoning: '测试' } as T;
    }
    if (content.includes('自爆规则')) {
      // decideYesNo：yes=继续发言，no=自爆
      return { decision: this.script.explode ? 'no' : 'yes', reasoning: '测试' } as T;
    }
    if (content.includes('退水环节')) {
      // decideYesNo：yes=继续竞选，no=退水
      return { decision: this.script.withdraw ? 'no' : 'yes', reasoning: '测试' } as T;
    }
    // 其余即警长投票（首轮 context 含「警长投票环节」，PK 轮含「警长PK投票环节」）
    const isPK = content.includes('PK投票环节');
    const target = (isPK && this.script.pkVoteFor) ? this.script.pkVoteFor : this.script.voteFor;
    return { targetId: target, reason: '测试' } as T;
  }
}

/**
 * 白天投票专用替身：按「首轮 / PK 复投」路由投票目标。
 *
 * VoteManager.runVoteRound 给 AI 的 context：首轮含「经过白天辩论」，PK 轮含「平票 PK 复投」。
 * 这里据此区分，让同一座位在首轮与复投里投不同目标，从而能构造出
 * 「首轮平票 → PK 打破 / PK 仍平票」两种事件序列。
 * dayVoteFor 缺省时投给 first candidate 兜底（避免落到随机分支干扰断言）。
 */
interface DayVoteScript {
  dayVoteFor?: string;    // 首轮投票目标 id（缺省弃票）
  pkVoteFor?: string;     // PK 复投目标 id（缺省沿用 dayVoteFor）
}

class DayVoteBrain implements LLMProvider {
  constructor(private readonly script: DayVoteScript) {}
  async chat(): Promise<string> {
    return '[内心]测试[发言]测试白天发言';
  }
  async chatJSON<T>(_sys: string, messages: ChatMessage[]): Promise<T> {
    const content = messages[messages.length - 1]?.content ?? '';
    const isPK = content.includes('PK 复投') || content.includes('平票 PK');
    const target = (isPK && this.script.pkVoteFor) ? this.script.pkVoteFor
      : (this.script.dayVoteFor ?? 'abstain');
    return { targetId: target, reason: '测试' } as T;
  }
}

function makeCharacter(name: string): CharacterConfig {
  return {
    name,
    title: `${name}的称号`,
    personality: '测试性格',
    speechStyle: '测试风格',
    selfReference: '我',
    traits: { aggression: 5, logic: 5, deception: 5, charisma: 5, loyalty: 5 } as any,
    catchphrases: ['测试口头禅'],
  };
}

/** 12 人标准局的角色表：4 狼 + 预言家/女巫/猎人/守卫 + 4 民。 */
const STANDARD_ROLES: RoleType[] = [
  RoleType.WEREWOLF, RoleType.WEREWOLF, RoleType.WEREWOLF, RoleType.WEREWOLF,
  RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.GUARD,
  RoleType.VILLAGER, RoleType.VILLAGER, RoleType.VILLAGER, RoleType.VILLAGER,
];

interface Harness {
  state: GameState;
  agents: BaseAgent[];
  phase: PhaseManager;
  vote: VoteManager;
  engine: GameEngine;
  /** 按 id 后缀取玩家，例如 p(0) → player_0 */
  p: (i: number) => Player;
  /** 按角色取第一个玩家 */
  byRole: (r: RoleType) => Player;
}

/**
 * 搭一局可控的游戏状态。
 *
 * 注意：不走 GameEngine.start()（那会真的跑整局并调 LLM）。
 * 这里手工构造 state + agents，再把它们注入 PhaseManager/VoteManager，
 * 只调用要测的那个规则函数。
 */
function harness(
  roles: RoleType[] = STANDARD_ROLES,
  llm?: LLMProvider,
  seatProviders?: (LLMProvider | undefined)[],
): Harness {
  const provider = llm ?? new StubProvider();
  const players: Player[] = roles.map((roleType, i) => ({
    id: `player_${i}`,
    name: `角色${i}`,
    roleType,
    faction: ALL_ROLES[roleType].faction,
    isAlive: true,
    characterConfig: makeCharacter(`角色${i}`),
  }));

  // seatProviders 给单个座位注入专属替身（如竞选流程里每人各自的 SeatBrain）；
  // 缺省座位回落到全局 provider。这样同一局里不同玩家能有各自的决策脚本。
  const agents = players.map((pl, i) => {
    const a = new BaseAgent(pl, seatProviders?.[i] ?? provider, undefined, testEventBus);
    return a;
  });
  for (const a of agents) a.setPlayersRef(players);

  const state: GameState = {
    phase: GamePhase.NIGHT,
    round: 1,
    players,
    events: [],
    nightActions: [],
    eliminatedTonight: [],
    witchSaveUsed: false,
    witchPoisonUsed: false,
    lastGuardTarget: null,
    sheriffId: null,
  };

  const config: GameConfig = {
    playerCount: roles.length,
    roles,
    maxRounds: 10,
    enableInnerThoughts: false,
  } as GameConfig;

  // GameEngine 只用来提供 getConfig()/checkpoint()/waitForHumanInput()；不调 start()。
  const engine = new GameEngine(config, provider, { eventBus: testEventBus });
  // 用测试构造的 state/agents 覆盖引擎内部（引擎构造时会自己随机建一套，这里替换掉）。
  (engine as any).state = state;
  (engine as any).agents = agents;
  const phase = new PhaseManager(agents, state, engine, undefined, testEventBus);
  const vote = new VoteManager(agents, state, engine, testEventBus);
  (engine as any).phaseManager = phase;
  (engine as any).voteManager = vote;

  return {
    state,
    agents,
    phase,
    vote,
    engine,
    p: (i: number) => players[i],
    byRole: (r: RoleType) => players.find(pl => pl.roleType === r)!,
  };
}

/** 往 state 里塞一条夜间行动。 */
function addAction(
  state: GameState,
  actionType: EventType,
  actorId: string,
  targetId: string,
  voided = false,
): void {
  const a: NightAction = { actorId, actionType, targetId, timestamp: Date.now(), voided };
  state.nightActions.push(a);
}

/** 把指定 id 之外的所有人置死，用于构造胜负边界。 */
function killAllExcept(state: GameState, keepIds: string[]): void {
  for (const pl of state.players) {
    pl.isAlive = keepIds.includes(pl.id);
  }
}

/**
 * 按序记录若干事件的发生。返回记录数组（seq 只存类型名，detail 存对应 data）。
 * EventBus 只有 clear() 没有 off()，且测试串行执行——所以进来先 clear() 清干净上一个用例的监听，
 * 再注册本次要收的类型。事件序列断言只关心「发生了哪些、顺序如何」，需要细节时读 detail。
 */
function collectEvents(types: GameEventType[]): { seq: string[]; detail: any[] } {
  testEventBus.clear();
  const seq: string[] = [];
  const detail: any[] = [];
  testEventBus.onAll(e => {
    if (types.includes(e.type)) {
      seq.push(e.type);
      detail.push(e.data);
    }
  });
  return { seq, detail };
}

/**
 * 竞选专用 harness：为每个座位注入一份 SeatBrain 脚本，驱动完整的 executeSheriffElection。
 * scripts[i] 对应 player_i 的决策脚本；未给出的座位回落到「上警但投给自己第一个合法目标」的兜底 provider。
 */
function electionHarness(scripts: (SeatScript | undefined)[], roles: RoleType[] = STANDARD_ROLES): Harness {
  const seatProviders = roles.map((_, i) => (scripts[i] ? new SeatBrain(scripts[i]!) : new SeatBrain({ runForSheriff: false })));
  return harness(roles, undefined, seatProviders);
}

// ============ 天亮结算：守卫 / 女巫 / 奶穿 ============

async function main() {
  console.log('\n=== 规则状态机单测 ===\n');

  console.log('[天亮结算：狼刀 / 守护 / 解药 / 奶穿]');

  await check('狼刀无人干预 → 目标死亡', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    assert.deepEqual(h.phase.computeDawn(), [h.p(8).id]);
  });

  await check('守卫守中刀口 → 平安夜', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    addAction(h.state, EventType.GUARD_PROTECT, h.byRole(RoleType.GUARD).id, h.p(8).id);
    assert.deepEqual(h.phase.computeDawn(), []);
  });

  await check('女巫解药救中刀口 → 平安夜', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    addAction(h.state, EventType.WITCH_SAVE, h.byRole(RoleType.WITCH).id, h.p(8).id);
    assert.deepEqual(h.phase.computeDawn(), []);
  });

  await check('同守同救（奶穿）→ 目标反而死亡', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    addAction(h.state, EventType.GUARD_PROTECT, h.byRole(RoleType.GUARD).id, h.p(8).id);
    addAction(h.state, EventType.WITCH_SAVE, h.byRole(RoleType.WITCH).id, h.p(8).id);
    assert.deepEqual(h.phase.computeDawn(), [h.p(8).id]);
  });

  await check('守卫守了别人 → 刀口照死', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    addAction(h.state, EventType.GUARD_PROTECT, h.byRole(RoleType.GUARD).id, h.p(9).id);
    assert.deepEqual(h.phase.computeDawn(), [h.p(8).id]);
  });

  await check('连守失误（voided）的守护视为无效 → 刀口照死', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    // voided=true 模拟"连续两晚守同一人"的失误注入
    addAction(h.state, EventType.GUARD_PROTECT, h.byRole(RoleType.GUARD).id, h.p(8).id, true);
    assert.deepEqual(h.phase.computeDawn(), [h.p(8).id]);
  });

  await check('毒药另计：狼刀 + 毒杀 = 两人死', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    addAction(h.state, EventType.WITCH_POISON, h.byRole(RoleType.WITCH).id, h.p(9).id);
    const deaths = h.phase.computeDawn();
    assert.equal(deaths.length, 2);
    assert.ok(deaths.includes(h.p(8).id));
    assert.ok(deaths.includes(h.p(9).id));
  });

  await check('毒杀目标恰好是刀口 → 只记一次（不重复入列）', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    addAction(h.state, EventType.WITCH_POISON, h.byRole(RoleType.WITCH).id, h.p(8).id);
    assert.deepEqual(h.phase.computeDawn(), [h.p(8).id]);
  });

  await check('守护+毒杀同一人 → 仍死（毒药不受守卫保护）', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(9).id);
    addAction(h.state, EventType.GUARD_PROTECT, h.byRole(RoleType.GUARD).id, h.p(8).id);
    addAction(h.state, EventType.WITCH_POISON, h.byRole(RoleType.WITCH).id, h.p(8).id);
    const deaths = h.phase.computeDawn();
    assert.ok(deaths.includes(h.p(8).id), '被毒者应死亡（守卫拦不住毒药）');
    assert.ok(deaths.includes(h.p(9).id), '刀口未被守护应死亡');
  });

  await check('无任何夜间行动 → 平安夜', () => {
    const h = harness();
    assert.deepEqual(h.phase.computeDawn(), []);
  });

  await check('computeDawn 是纯计算：不改动 isAlive', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    h.phase.computeDawn();
    assert.equal(h.p(8).isAlive, true, 'computeDawn 不应置死（那是 announceDawn 的职责）');
  });

  await check('announceDawn 才真正置死', () => {
    const h = harness();
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    const deaths = h.phase.computeDawn();
    h.phase.announceDawn(deaths);
    assert.equal(h.p(8).isAlive, false);
  });

  // ============ 天亮结算的事件序列 ============
  //
  // 上面那批只断言 computeDawn 的**返回值**。但前端与回放消费的是**事件流**：
  // 结算算对了、dawn_result 里字段发错了，UI 照样显示错（例如把奶穿显示成平安夜）。
  // 这里把「结算结果 → dawn_result 事件内容」这一跳也钉死。

  console.log('\n[天亮结算的事件序列：dawn_result]');

  await check('dawn_result：狼刀成功 → deaths 含目标且身份字段完整，isPeacefulNight=false', () => {
    const h = harness();
    const ev = collectEvents(['dawn_result']);
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    h.phase.announceDawn(h.phase.computeDawn());

    assert.deepEqual(ev.seq, ['dawn_result'], '应恰好发出一次 dawn_result');
    const d = ev.detail[0];
    assert.equal(d.isPeacefulNight, false, '有人死亡不是平安夜');
    assert.equal(d.deaths.length, 1);
    assert.equal(d.deaths[0].id, h.p(8).id);
    assert.equal(d.deaths[0].name, h.p(8).name, '事件要带死者姓名供 UI 显示');
    assert.equal(d.deaths[0].roleType, h.p(8).roleType, '要带身份用于终局揭示');
    assert.equal(d.deaths[0].faction, h.p(8).faction);
  });

  await check('dawn_result：平安夜 → deaths 为空且 isPeacefulNight=true', () => {
    const h = harness();
    const ev = collectEvents(['dawn_result']);
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    addAction(h.state, EventType.GUARD_PROTECT, h.byRole(RoleType.GUARD).id, h.p(8).id);
    h.phase.announceDawn(h.phase.computeDawn());

    assert.deepEqual(ev.seq, ['dawn_result']);
    assert.equal(ev.detail[0].isPeacefulNight, true, '守护成功应报平安夜');
    assert.deepEqual(ev.detail[0].deaths, [], '平安夜 deaths 必须为空');
  });

  await check('dawn_result：同守同救（奶穿）→ 事件里目标仍然死亡（不能误报平安夜）', () => {
    const h = harness();
    const ev = collectEvents(['dawn_result']);
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    addAction(h.state, EventType.GUARD_PROTECT, h.byRole(RoleType.GUARD).id, h.p(8).id);
    addAction(h.state, EventType.WITCH_SAVE, h.byRole(RoleType.WITCH).id, h.p(8).id);
    h.phase.announceDawn(h.phase.computeDawn());

    const d = ev.detail[0];
    assert.equal(d.isPeacefulNight, false, '奶穿绝不能被报成平安夜');
    assert.deepEqual(d.deaths.map((x: any) => x.id), [h.p(8).id], '奶穿目标应出现在死亡名单');
  });

  await check('dawn_result：狼刀 + 毒杀 → 事件里两名死者都在（顺序为刀口先、毒杀后）', () => {
    const h = harness();
    const ev = collectEvents(['dawn_result']);
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    addAction(h.state, EventType.WITCH_POISON, h.byRole(RoleType.WITCH).id, h.p(9).id);
    h.phase.announceDawn(h.phase.computeDawn());

    const ids = ev.detail[0].deaths.map((x: any) => x.id);
    assert.deepEqual(ids, [h.p(8).id, h.p(9).id], '死者顺序应与 computeDawn 一致：刀口先、毒杀后');
    assert.equal(ev.detail[0].isPeacefulNight, false);
  });

  await check('dawn_result：resolveDawn（非首夜一次性结算）同样只发一次事件', () => {
    const h = harness();
    const ev = collectEvents(['dawn_result']);
    h.state.round = 2;
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    const deaths = h.phase.resolveDawn();

    assert.deepEqual(deaths, [h.p(8).id]);
    assert.deepEqual(ev.seq, ['dawn_result'], 'resolveDawn 不应重复发 dawn_result');
  });

  await check('computeDawn 不发任何事件（纯计算，竞选期间不得泄露死讯）', () => {
    const h = harness();
    const ev = collectEvents(['dawn_result']);
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    h.phase.computeDawn();

    assert.deepEqual(ev.seq, [], '首夜竞选先于公布死讯：computeDawn 阶段绝不能发 dawn_result');
  });

  // ============ 首夜黑水完整编排：竞选先于死讯 ============

  console.log('\n[首夜黑水完整编排：runDawn 竞选先于死讯]');

  await check('首夜待死候选人仍可发言并当选、待死警下玩家仍可投票，公布后才死亡并传徽', async () => {
    const scripts: (SeatScript | undefined)[] = [];
    // player_8 是待死候选人，player_4 是正常候选人；避免唯一候选自动当选捷径。
    scripts[8] = { runForSheriff: true, withdraw: false, voteFor: 'player_10' };
    scripts[4] = { runForSheriff: true, withdraw: false };
    // player_9 是待死警下投票者；所有警下票投 player_8，保证待死者先当选警长。
    for (const i of [0, 1, 2, 3, 5, 6, 7, 9, 10, 11]) {
      scripts[i] = { runForSheriff: false, voteFor: 'player_8' };
    }
    const h = electionHarness(scripts);
    addAction(h.state, EventType.WOLF_KILL, h.p(0).id, h.p(8).id);
    addAction(h.state, EventType.WITCH_POISON, h.byRole(RoleType.WITCH).id, h.p(9).id);

    testEventBus.clear();
    const observed: Array<{ type: string; data: any; pendingAlive: [boolean, boolean] }> = [];
    const watched: GameEventType[] = [
      'phase_change',
      'sheriff_election_start',
      'sheriff_speech',
      'sheriff_vote',
      'sheriff_elected',
      'dawn_result',
      'sheriff_transfer',
    ];
    testEventBus.onAll(event => {
      if (!watched.includes(event.type)) return;
      observed.push({
        type: event.type,
        data: event.data,
        pendingAlive: [h.p(8).isAlive, h.p(9).isAlive],
      });
    });

    const signal = await (h.engine as any).runDawn();

    assert.deepEqual(signal, {}, '正常竞选与死讯结算不应触发自爆/终局信号');
    const starts = observed.filter(event => event.type === 'sheriff_election_start');
    assert.equal(starts.length, 1, '竞选应启动恰好一次');
    assert.ok(starts[0].data.candidates.some((p: any) => p.id === h.p(8).id), '待死 player_8 仍应进入候选人名单');
    assert.ok(starts[0].data.voters.some((p: any) => p.id === h.p(9).id), '待死 player_9 仍应进入警下投票者名单');

    const pendingSpeech = observed.find(
      event => event.type === 'sheriff_speech' && event.data.playerId === h.p(8).id,
    );
    const pendingVote = observed.find(
      event => event.type === 'sheriff_vote' && event.data.voterId === h.p(9).id,
    );
    assert.ok(pendingSpeech, '待死候选人应实际完成警上发言');
    assert.ok(pendingVote, '待死警下玩家应实际投出警长票');
    assert.deepEqual(pendingSpeech!.pendingAlive, [true, true], '警上发言时两名待死者仍应存活');
    assert.deepEqual(pendingVote!.pendingAlive, [true, true], '警下投票时两名待死者仍应存活');

    const electedIndex = observed.findIndex(event => event.type === 'sheriff_elected');
    const dawnIndexes = observed
      .map((event, index) => event.type === 'dawn_result' ? index : -1)
      .filter(index => index >= 0);
    assert.equal(observed[electedIndex].data.sheriffId, h.p(8).id, '待死候选人应能在公布死讯前当选');
    assert.deepEqual(observed[electedIndex].pendingAlive, [true, true], '当选事件发生时待死者仍应存活');
    assert.equal(dawnIndexes.length, 1, 'dawn_result 必须恰好一次');
    assert.ok(electedIndex < dawnIndexes[0], '警长当选必须严格早于公布死讯');
    assert.ok(
      observed.filter(event => event.type === 'sheriff_speech' || event.type === 'sheriff_vote')
        .every(event => observed.indexOf(event) < dawnIndexes[0]),
      '全部竞选发言和投票都必须早于 dawn_result',
    );
    assert.deepEqual(
      observed[dawnIndexes[0]].data.deaths.map((death: any) => death.id),
      [h.p(8).id, h.p(9).id],
      'dawn_result 应同时公布刀口与毒杀目标',
    );
    assert.deepEqual(observed[dawnIndexes[0]].pendingAlive, [false, false], '只有公布死讯时两名玩家才正式死亡');
    assert.deepEqual(h.state.eliminatedTonight, [h.p(8).id, h.p(9).id], '夜间死亡账本应与 dawn_result 一致');

    const transferIndex = observed.findIndex(event => event.type === 'sheriff_transfer');
    assert.ok(transferIndex > dawnIndexes[0], '待死警长应在死讯公布后传承警徽');
    assert.equal(observed[transferIndex].data.fromId, h.p(8).id);
    assert.equal(observed[transferIndex].data.toId, h.p(10).id);
    assert.equal(h.state.sheriffId, h.p(10).id, '死者不得继续持有警徽');
    assert.equal(h.p(8).isAlive, false);
    assert.equal(h.p(9).isAlive, false);
  });

  await check('首夜中毒狼人警上自爆：死讯事件与夜间死亡账本保持同一集合', async () => {
    const scripts: (SeatScript | undefined)[] = [];
    // 至少两人上警才能进入发言/自爆分支；player_0 同时是昨夜毒杀目标。
    scripts[0] = { runForSheriff: true, explode: true };
    scripts[4] = { runForSheriff: true };
    for (const i of [1, 2, 3, 5, 6, 7, 8, 9, 10, 11]) {
      scripts[i] = { runForSheriff: false, voteFor: 'player_4' };
    }
    const h = electionHarness(scripts);
    addAction(h.state, EventType.WOLF_KILL, h.p(1).id, h.p(8).id);
    addAction(h.state, EventType.WITCH_POISON, h.byRole(RoleType.WITCH).id, h.p(0).id);
    const ev = collectEvents(['wolf_explode', 'sheriff_election_end', 'dawn_result']);

    const signal = await (h.engine as any).runDawn();

    assert.deepEqual(signal, { exploded: true }, '警上自爆应让 runDawn 跳过白天');
    assert.deepEqual(
      ev.seq,
      ['wolf_explode', 'sheriff_election_end', 'dawn_result'],
      '自爆与竞选终止必须早于昨夜死讯公布',
    );
    assert.equal(ev.detail[1].result, 'wolf_explode');
    const dawnIds = ev.detail[2].deaths.map((death: any) => death.id);
    assert.deepEqual(dawnIds, [h.p(8).id, h.p(0).id], '死讯应包含刀口和中毒自爆狼');
    assert.deepEqual(h.state.eliminatedTonight, dawnIds, '夜间死亡账本必须与 dawn_result.deaths 完全一致');
    assert.equal(h.p(0).isAlive, false);
    assert.equal(h.state.sheriffId, null, '自爆后警徽流失');
  });

  // ============ 胜负判定 ============

  console.log('\n[胜负判定]');

  await check('狼人全灭 → 好人胜', () => {
    const h = harness();
    for (const pl of h.state.players) {
      if (pl.faction === Faction.WOLF) pl.isAlive = false;
    }
    const r = h.phase.checkGameEnd();
    assert.equal(r.ended, true);
    assert.equal(r.winner, Faction.GOOD);
  });

  await check('神职全灭（屠神）→ 狼人胜', () => {
    const h = harness();
    for (const pl of h.state.players) {
      if ([RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.GUARD].includes(pl.roleType)) {
        pl.isAlive = false;
      }
    }
    const r = h.phase.checkGameEnd();
    assert.equal(r.ended, true);
    assert.equal(r.winner, Faction.WOLF);
  });

  await check('平民全灭（屠民）→ 狼人胜', () => {
    const h = harness();
    for (const pl of h.state.players) {
      if (pl.roleType === RoleType.VILLAGER) pl.isAlive = false;
    }
    const r = h.phase.checkGameEnd();
    assert.equal(r.ended, true);
    assert.equal(r.winner, Faction.WOLF);
  });

  await check('好人阵营尚有神+民存活 → 未结束', () => {
    const h = harness();
    // 杀掉 2 狼 2 民，仍有神职和平民存活
    h.p(0).isAlive = false;
    h.p(1).isAlive = false;
    h.p(8).isAlive = false;
    h.p(9).isAlive = false;
    const r = h.phase.checkGameEnd();
    assert.equal(r.ended, false);
  });

  await check('狼人全灭优先于屠神判定（同时满足时好人胜）', () => {
    const h = harness();
    // 狼全死 + 神全死：好人阵营的"消灭所有狼"应优先
    for (const pl of h.state.players) {
      if (pl.faction === Faction.WOLF) pl.isAlive = false;
      if ([RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.GUARD].includes(pl.roleType)) {
        pl.isAlive = false;
      }
    }
    const r = h.phase.checkGameEnd();
    assert.equal(r.winner, Faction.GOOD, '狼人已全灭，好人应获胜');
  });

  await check('达到 maxRounds → 狼人胜（好人未能在限定回合清狼）', () => {
    const h = harness();
    h.state.round = 10; // config.maxRounds = 10
    const r = h.phase.checkGameEnd();
    assert.equal(r.ended, true);
    assert.equal(r.winner, Faction.WOLF);
  });

  // ============ 终局事件：game_end 的载荷 ============
  //
  // checkGameEnd 只返回判定结果；真正让前端显示终局的是 announceWinner 发的 game_end 事件。
  // 前端靠它的 players 数组做"全场身份揭示"——这是唯一允许一次性公开所有身份的时刻，
  // 所以字段必须齐全（12 人全在、带 roleType/faction），否则终局面板会缺人或显示 undefined。

  console.log('\n[终局事件：game_end 载荷]');

  await check('好人胜 → game_end 带 winner=good 与完整 12 人身份', async () => {
    testEventBus.clear();
    const h = harness();
    for (const pl of h.state.players) {
      if (pl.faction === Faction.WOLF) pl.isAlive = false;
    }
    const end = h.phase.checkGameEnd();
    const ev = collectEvents(['game_end']);

    (h.engine as any).announceWinner(end.winner!, end.reason!);

    assert.deepEqual(ev.seq, ['game_end'], 'game_end 应恰好发一次');
    const d = ev.detail[0];
    assert.equal(d.winner, Faction.GOOD);
    assert.equal(d.reason, end.reason, 'reason 应原样透传判定理由');
    assert.equal(d.players.length, 12, '终局揭示必须包含全部 12 个座位（含已死）');
    // 每个座位都要带身份字段，前端揭示面板依赖它们
    for (const p of d.players) {
      assert.ok(p.id && p.name, '座位需带 id/name');
      assert.ok(p.roleType, '终局必须揭示 roleType');
      assert.ok(p.faction, '终局必须揭示 faction');
      assert.equal(typeof p.isAlive, 'boolean');
    }
    // 4 狼全灭：狼座位应全部 isAlive=false
    const wolves = d.players.filter((p: any) => p.faction === Faction.WOLF);
    assert.equal(wolves.length, 4);
    assert.ok(wolves.every((p: any) => p.isAlive === false), '好人胜时狼应全部死亡');
  });

  await check('屠神 → game_end 带 winner=wolf', async () => {
    testEventBus.clear();
    const h = harness();
    for (const pl of h.state.players) {
      if ([RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.GUARD].includes(pl.roleType)) {
        pl.isAlive = false;
      }
    }
    const end = h.phase.checkGameEnd();
    const ev = collectEvents(['game_end']);

    (h.engine as any).announceWinner(end.winner!, end.reason!);

    assert.equal(ev.detail[0].winner, Faction.WOLF);
    assert.match(ev.detail[0].reason, /神职/, 'reason 应说明屠神');
  });

  await check('回合耗尽 → game_end 理由为回合数耗尽且狼胜', async () => {
    testEventBus.clear();
    const h = harness();
    const ev = collectEvents(['game_end']);

    // 主循环 runVote 里的兜底分支就是这样调的
    (h.engine as any).announceWinner(Faction.WOLF, '回合数耗尽');

    assert.deepEqual(ev.seq, ['game_end']);
    assert.equal(ev.detail[0].winner, Faction.WOLF);
    assert.equal(ev.detail[0].reason, '回合数耗尽');
  });

  // ============ 投票：票权 / 平票 / 弃票 ============

  console.log('\n[投票结算：警长 1.5 票 / 平票 / 弃票]');

  /** 直接测 VoteManager 的私有票数统计，避免驱动整轮 LLM 投票。 */
  function tally(h: Harness, votes: { voterId: string; targetId: string }[]): Map<string, number> {
    const records = votes.map(v => ({ ...v, reason: '测试', round: 1 }));
    return (h.vote as any).tallyVotes(records);
  }
  function topVoted(h: Harness, t: Map<string, number>): { maxVotes: number; tiedIds: string[] } {
    return (h.vote as any).findTopVoted(t);
  }

  await check('普通票各计 1 票', () => {
    const h = harness();
    const t = tally(h, [
      { voterId: h.p(1).id, targetId: h.p(8).id },
      { voterId: h.p(2).id, targetId: h.p(8).id },
    ]);
    assert.equal(t.get(h.p(8).id), 2);
  });

  await check('警长票计 1.5 票', () => {
    const h = harness();
    h.state.sheriffId = h.p(1).id;
    const t = tally(h, [{ voterId: h.p(1).id, targetId: h.p(8).id }]);
    assert.equal(t.get(h.p(8).id), 1.5);
  });

  await check('警长 1.5 票可反超一张普通票（1.5 > 1）', () => {
    const h = harness();
    h.state.sheriffId = h.p(1).id;
    const t = tally(h, [
      { voterId: h.p(1).id, targetId: h.p(8).id }, // 警长 1.5
      { voterId: h.p(2).id, targetId: h.p(9).id }, // 普通 1
    ]);
    const top = topVoted(h, t);
    assert.deepEqual(top.tiedIds, [h.p(8).id]);
    assert.equal(top.maxVotes, 1.5);
  });

  await check('弃票不计入任何人票数', () => {
    const h = harness();
    const t = tally(h, [
      { voterId: h.p(1).id, targetId: 'abstain' },
      { voterId: h.p(2).id, targetId: h.p(8).id },
    ]);
    assert.equal(t.get('abstain'), undefined);
    assert.equal(t.get(h.p(8).id), 1);
  });

  await check('投给已死玩家的票不计入（二次存活校验）', () => {
    const h = harness();
    h.p(8).isAlive = false;
    const t = tally(h, [{ voterId: h.p(1).id, targetId: h.p(8).id }]);
    assert.equal(t.get(h.p(8).id), undefined);
  });

  await check('平票 → tiedIds 返回多人（触发 PK）', () => {
    const h = harness();
    const t = tally(h, [
      { voterId: h.p(1).id, targetId: h.p(8).id },
      { voterId: h.p(2).id, targetId: h.p(9).id },
    ]);
    const top = topVoted(h, t);
    assert.equal(top.tiedIds.length, 2);
  });

  await check('唯一最高票 → tiedIds 只有一人', () => {
    const h = harness();
    const t = tally(h, [
      { voterId: h.p(1).id, targetId: h.p(8).id },
      { voterId: h.p(2).id, targetId: h.p(8).id },
      { voterId: h.p(3).id, targetId: h.p(9).id },
    ]);
    const top = topVoted(h, t);
    assert.deepEqual(top.tiedIds, [h.p(8).id]);
  });

  await check('全员弃票 → 无人被放逐（tiedIds 为空）', () => {
    const h = harness();
    const t = tally(h, [
      { voterId: h.p(1).id, targetId: 'abstain' },
      { voterId: h.p(2).id, targetId: 'abstain' },
    ]);
    const top = topVoted(h, t);
    assert.equal(top.tiedIds.length, 0);
  });

  await check('警长 1.5 票与两张普通票可构成平票（1.5 vs 1.5 不可能，验证 2 vs 1.5）', () => {
    const h = harness();
    h.state.sheriffId = h.p(1).id;
    const t = tally(h, [
      { voterId: h.p(1).id, targetId: h.p(8).id }, // 1.5
      { voterId: h.p(2).id, targetId: h.p(9).id },
      { voterId: h.p(3).id, targetId: h.p(9).id }, // 2.0
    ]);
    const top = topVoted(h, t);
    assert.deepEqual(top.tiedIds, [h.p(9).id], '2 票应压过警长的 1.5 票');
  });

  // ============ 猎人：开枪 / 毒杀禁枪 / 猎人链 ============

  console.log('\n[猎人技能：开枪 / 毒杀禁枪 / 猎人链]');

  await check('猎人被狼刀 → 可以开枪带走目标', async () => {
    // ScriptedProvider 让猎人选中 player_0（狼）
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_0', reasoning: '测试' }]));
    const hunter = h.byRole(RoleType.HUNTER);
    hunter.isAlive = false;
    const shot = await (h.engine as any).handleHunterDeath([hunter.id], '昨夜被狼人杀害');
    assert.deepEqual(shot, ['player_0']);
    assert.equal(h.p(0).isAlive, false, '被枪杀者应置死');
  });

  await check('猎人被女巫毒死 → 禁枪（不触发任何击杀）', async () => {
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_0', reasoning: '测试' }]));
    const hunter = h.byRole(RoleType.HUNTER);
    hunter.isAlive = false;
    // 关键：登记一条针对猎人的毒杀行动
    addAction(h.state, EventType.WITCH_POISON, h.byRole(RoleType.WITCH).id, hunter.id);
    const shot = await (h.engine as any).handleHunterDeath([hunter.id], '昨夜被毒杀');
    assert.deepEqual(shot, [], '被毒死的猎人不能开枪');
    assert.equal(h.p(0).isAlive, true, '不应有人被枪杀');
  });

  await check('猎人链：猎人A 打死猎人B → B 也能开枪', async () => {
    // 两个猎人的自定义阵容
    const roles: RoleType[] = [
      RoleType.WEREWOLF, RoleType.WEREWOLF, RoleType.WEREWOLF, RoleType.WEREWOLF,
      RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.HUNTER,
      RoleType.GUARD, RoleType.VILLAGER, RoleType.VILLAGER, RoleType.VILLAGER,
    ];
    // 第一枪：hunterA(player_6) 打 hunterB(player_7)；第二枪：hunterB 打 player_0
    const h = harness(roles, new ScriptedProvider([
      { targetId: 'player_7', reasoning: 'A 打 B' },
      { targetId: 'player_0', reasoning: 'B 反打狼' },
    ]));
    h.p(6).isAlive = false;
    const shot = await (h.engine as any).handleHunterDeath([h.p(6).id], '白天被投票放逐');
    assert.ok(shot.includes('player_7'), '猎人A 应打死猎人B');
    assert.ok(shot.includes('player_0'), '猎人B 应触发连锁开枪');
    assert.equal(h.p(7).isAlive, false);
    assert.equal(h.p(0).isAlive, false);
  });

  await check('非猎人死亡 → 不触发开枪', async () => {
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_0', reasoning: '测试' }]));
    h.p(8).isAlive = false; // 平民
    const shot = await (h.engine as any).handleHunterDeath([h.p(8).id], '白天被投票放逐');
    assert.deepEqual(shot, []);
  });

  await check('猎人开枪目标非法 → 由兜底逻辑改选合法目标', async () => {
    // 返回一个不存在的 ID，迫使 BaseAgent 的合法性校验兜底
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: '不存在的人', reasoning: '测试' }]));
    const hunter = h.byRole(RoleType.HUNTER);
    hunter.isAlive = false;
    const shot = await (h.engine as any).handleHunterDeath([hunter.id], '白天被投票放逐');
    assert.equal(shot.length, 1, '应仍然打出一枪（兜底到合法目标）');
    const target = h.state.players.find(pl => pl.id === shot[0]);
    assert.ok(target, '兜底目标必须是真实存在的玩家');
    assert.notEqual(shot[0], hunter.id, '不能打自己');
  });

  // ============ 猎人技能的事件序列 ============
  //
  // 上面那批断言 handleHunterDeath 的返回值与 isAlive。这里补事件流：
  // hunter_shoot 的发射次数、顺序、字段，以及它与 player_last_words 的先后关系
  // （标准规则：先开枪、再遗言——顺序错了 UI 上会先看到遗言再看到枪响）。

  console.log('\n[猎人技能的事件序列：hunter_shoot]');

  await check('hunter_shoot：开枪发出一次事件，字段含枪手与目标身份', async () => {
    testEventBus.clear();
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_0', reasoning: '测试' }]));
    const ev = collectEvents(['hunter_shoot']);
    const hunter = h.byRole(RoleType.HUNTER);
    hunter.isAlive = false;

    await (h.engine as any).handleHunterDeath([hunter.id], '白天被投票放逐');

    assert.deepEqual(ev.seq, ['hunter_shoot'], '应恰好发出一次 hunter_shoot');
    const d = ev.detail[0];
    assert.equal(d.hunterId, hunter.id);
    assert.equal(d.hunterName, hunter.name);
    assert.equal(d.targetId, 'player_0');
    assert.equal(d.targetName, h.p(0).name);
    assert.equal(d.targetRoleType, h.p(0).roleType, '要带目标身份用于 UI 翻牌');
    assert.equal(d.targetFaction, h.p(0).faction);
  });

  await check('hunter_shoot：被毒杀禁枪 → 不发任何 hunter_shoot 事件', async () => {
    testEventBus.clear();
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_0', reasoning: '测试' }]));
    const ev = collectEvents(['hunter_shoot']);
    const hunter = h.byRole(RoleType.HUNTER);
    hunter.isAlive = false;
    addAction(h.state, EventType.WITCH_POISON, h.byRole(RoleType.WITCH).id, hunter.id);

    await (h.engine as any).handleHunterDeath([hunter.id], '昨夜被毒杀');

    assert.deepEqual(ev.seq, [], '被毒的猎人不得发出 hunter_shoot');
  });

  await check('hunter_shoot：猎人链按 A→B、B→狼 的顺序各发一次事件', async () => {
    testEventBus.clear();
    const roles: RoleType[] = [
      RoleType.WEREWOLF, RoleType.WEREWOLF, RoleType.WEREWOLF, RoleType.WEREWOLF,
      RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.HUNTER,
      RoleType.GUARD, RoleType.VILLAGER, RoleType.VILLAGER, RoleType.VILLAGER,
    ];
    const h = harness(roles, new ScriptedProvider([
      { targetId: 'player_7', reasoning: 'A 打 B' },
      { targetId: 'player_0', reasoning: 'B 反打狼' },
    ]));
    const ev = collectEvents(['hunter_shoot']);
    h.p(6).isAlive = false;

    await (h.engine as any).handleHunterDeath([h.p(6).id], '白天被投票放逐');

    assert.equal(ev.seq.length, 2, '猎人链应发出两次 hunter_shoot');
    // 顺序必须是 A 先开枪、B 后开枪——链式结算的因果顺序不能颠倒
    assert.equal(ev.detail[0].hunterId, 'player_6', '第一枪应由猎人A 打出');
    assert.equal(ev.detail[0].targetId, 'player_7');
    assert.equal(ev.detail[1].hunterId, 'player_7', '第二枪应由被打死的猎人B 打出');
    assert.equal(ev.detail[1].targetId, 'player_0');
  });

  await check('事件顺序：先 hunter_shoot 再 player_last_words（标准规则先开枪后遗言）', async () => {
    testEventBus.clear();
    // LastWordsSpy 风格：chat() 返回遗言，chatJSON() 返回枪口
    class ShootThenWords implements LLMProvider {
      async chat(): Promise<string> { return '（遗言）'; }
      async chatJSON<T>(): Promise<T> {
        return { targetId: 'player_0', reasoning: '测试' } as T;
      }
    }
    const h = harness(STANDARD_ROLES, new ShootThenWords());
    const ev = collectEvents(['hunter_shoot', 'player_last_words']);
    const hunter = h.byRole(RoleType.HUNTER);
    hunter.isAlive = false;

    await (h.engine as any).handleHunterDeath(
      [hunter.id], '白天被投票放逐', { allowLastWords: true },
    );

    assert.deepEqual(
      ev.seq, ['hunter_shoot', 'player_last_words'],
      '必须先开枪再遗言：顺序颠倒会让 UI 先播遗言后播枪响',
    );
  });

  await check('非猎人死亡 → 不发 hunter_shoot 事件', async () => {
    testEventBus.clear();
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_0', reasoning: '测试' }]));
    const ev = collectEvents(['hunter_shoot']);
    h.p(8).isAlive = false; // 平民

    await (h.engine as any).handleHunterDeath([h.p(8).id], '白天被投票放逐');

    assert.deepEqual(ev.seq, [], '平民出局不得触发 hunter_shoot');
  });

  // ============ 猎人遗言守卫（RULES.md）============
  //
  // 规则：夜间死亡仅首夜有遗言，第二晚起「哑巴」；白天投票放逐永远有遗言。
  // 此前 handleHunterDeath 无条件在开枪之后调 lastWords()，第二夜被狼刀的猎人也发遗言。
  // 现在守卫已上移到调用点（GameEngine 主循环传 allowLastWords），下列用例锁死这条链。
  //
  // 用捕获型 Provider 记录 lastWords 是否被真的调用：只需断言 chat() 有没有被触发即可。
  // EventBus 是全局单例，用例开始时 clear() 清干净，避免测试之间互相影响。

  console.log('\n[猎人遗言守卫：夜间守首夜、放逐永远有]');

  /**
   * 记录 BaseAgent.lastWords() 是否被调用的 Provider。
   * lastWords 走 chat()（非 chatJSON），所以 chat() 被命中 = 触发了遗言生成。
   * hunterShoot 走 chatJSON()，同一 provider 里两条路径互不干扰。
   */
  class LastWordsSpy implements LLMProvider {
    chatCalls = 0;
    constructor(private readonly shootTargetId: string) {}
    async chat(): Promise<string> {
      this.chatCalls++;
      return '（遗言）';
    }
    async chatJSON<T>(): Promise<T> {
      return { targetId: this.shootTargetId, reasoning: '测试' } as T;
    }
  }

  await check('首夜猎人被狼刀 → 开枪后发遗言', async () => {
    testEventBus.clear();
    const spy = new LastWordsSpy('player_0');
    const h = harness(STANDARD_ROLES, spy);
    const hunter = h.byRole(RoleType.HUNTER);
    hunter.isAlive = false;
    h.state.round = 1;

    const lastWordsEvents: string[] = [];
    testEventBus.on('player_last_words', e => { lastWordsEvents.push(e.data.playerName); });

    await (h.engine as any).handleHunterDeath([hunter.id], '昨夜被狼人杀害', { allowLastWords: true });
    assert.equal(spy.chatCalls, 1, '首夜死亡的猎人必须发遗言');
    assert.deepEqual(lastWordsEvents, [hunter.name], '事件应恰好广播一次');
  });

  await check('第二夜猎人被狼刀 → 开枪但不发遗言（这次修复的核心场景）', async () => {
    testEventBus.clear();
    const spy = new LastWordsSpy('player_0');
    const h = harness(STANDARD_ROLES, spy);
    const hunter = h.byRole(RoleType.HUNTER);
    hunter.isAlive = false;
    h.state.round = 2;

    const lastWordsEvents: string[] = [];
    testEventBus.on('player_last_words', e => { lastWordsEvents.push(e.data.playerName); });

    // 调用点即代表 GameEngine 主循环 round>=2 分支的参数
    const shot = await (h.engine as any).handleHunterDeath(
      [hunter.id], '昨夜被狼人杀害', { allowLastWords: false },
    );
    assert.deepEqual(shot, ['player_0'], '第二夜猎人仍要能开枪');
    assert.equal(spy.chatCalls, 0, '第二夜及以后夜间死亡不得发遗言');
    assert.deepEqual(lastWordsEvents, [], '不得广播 player_last_words');
  });

  await check('白天投票放逐猎人 → 无论第几轮都发遗言', async () => {
    testEventBus.clear();
    const spy = new LastWordsSpy('player_0');
    const h = harness(STANDARD_ROLES, spy);
    const hunter = h.byRole(RoleType.HUNTER);
    hunter.isAlive = false;
    h.state.round = 3; // 明确不在首夜

    const lastWordsEvents: string[] = [];
    testEventBus.on('player_last_words', e => { lastWordsEvents.push(e.data.playerName); });

    // 主循环里投票放逐分支不传 opts，默认 allowLastWords=true
    await (h.engine as any).handleHunterDeath([hunter.id], '白天被投票放逐');
    assert.equal(spy.chatCalls, 1, '放逐出局的猎人永远有遗言');
    assert.deepEqual(lastWordsEvents, [hunter.name]);
  });

  await check('猎人链在第二夜被刀：A、B 都开枪、都无遗言', async () => {
    testEventBus.clear();
    // A 打 B，B 反打 player_0
    class ChainSpy implements LLMProvider {
      chatCalls = 0;
      private idx = 0;
      private readonly replies = [
        { targetId: 'player_7', reasoning: 'A→B' },
        { targetId: 'player_0', reasoning: 'B→狼' },
      ];
      async chat(): Promise<string> { this.chatCalls++; return '（遗言）'; }
      async chatJSON<T>(): Promise<T> {
        return this.replies[Math.min(this.idx++, this.replies.length - 1)] as T;
      }
    }
    const roles: RoleType[] = [
      RoleType.WEREWOLF, RoleType.WEREWOLF, RoleType.WEREWOLF, RoleType.WEREWOLF,
      RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.HUNTER,
      RoleType.GUARD, RoleType.VILLAGER, RoleType.VILLAGER, RoleType.VILLAGER,
    ];
    const spy = new ChainSpy();
    const h = harness(roles, spy);
    h.p(6).isAlive = false;
    h.state.round = 2;

    const lastWordsEvents: string[] = [];
    testEventBus.on('player_last_words', e => { lastWordsEvents.push(e.data.playerName); });

    const shot = await (h.engine as any).handleHunterDeath(
      [h.p(6).id], '昨夜被狼人杀害', { allowLastWords: false },
    );
    assert.ok(shot.includes('player_7') && shot.includes('player_0'), '猎人链应正常触发');
    assert.equal(spy.chatCalls, 0, '第二夜死亡的猎人链，A、B 都不得发遗言');
    assert.deepEqual(lastWordsEvents, []);
  });

  await check('猎人被毒杀 → 既不开枪也不发遗言（毒杀禁枪守卫独立生效）', async () => {
    testEventBus.clear();
    const spy = new LastWordsSpy('player_0');
    const h = harness(STANDARD_ROLES, spy);
    const hunter = h.byRole(RoleType.HUNTER);
    hunter.isAlive = false;
    h.state.round = 1; // 即使首夜，被毒也不发
    addAction(h.state, EventType.WITCH_POISON, h.byRole(RoleType.WITCH).id, hunter.id);

    const lastWordsEvents: string[] = [];
    testEventBus.on('player_last_words', e => { lastWordsEvents.push(e.data.playerName); });

    const shot = await (h.engine as any).handleHunterDeath(
      [hunter.id], '昨夜被毒杀', { allowLastWords: true },
    );
    assert.deepEqual(shot, [], '被毒的猎人不能开枪');
    assert.equal(spy.chatCalls, 0, '被毒的猎人也不发遗言');
    assert.deepEqual(lastWordsEvents, []);
  });

  // ============ 警徽传承 ============

  console.log('\n[警徽传承]');

  await check('警长死亡 → 警徽传给指定继承人', async () => {
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_9', reason: '测试' }]));
    h.state.sheriffId = h.p(1).id;
    h.p(1).isAlive = false;
    await (h.engine as any).handleSheriffTransfer([h.p(1).id]);
    assert.equal(h.state.sheriffId, 'player_9');
  });

  await check('预言家当警长时：警徽不会传给已验出的狼', async () => {
    // 让 LLM 硬选一个已验狼（player_0），验证二次保护会强制改选
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_0', reason: '故意选狼' }]));
    const seer = h.byRole(RoleType.SEER);
    h.state.sheriffId = seer.id;
    const seerAgent = h.agents.find(a => a.player.id === seer.id)!;
    // 预言家验出 player_0 是狼
    seerAgent.addSeerResult(h.p(0).name, true, 1);
    seer.isAlive = false;
    await (h.engine as any).handleSheriffTransfer([seer.id]);
    assert.notEqual(h.state.sheriffId, 'player_0', '警徽绝不能传给已验出的狼');
    assert.ok(h.state.sheriffId, '应当仍然传出警徽');
  });

  await check('非警长死亡 → 警徽归属不变', async () => {
    const h = harness();
    h.state.sheriffId = h.p(1).id;
    h.p(8).isAlive = false;
    await (h.engine as any).handleSheriffTransfer([h.p(8).id]);
    assert.equal(h.state.sheriffId, h.p(1).id);
  });

  await check('本局无警长时 → 传承逻辑直接跳过', async () => {
    const h = harness();
    h.state.sheriffId = null;
    h.p(1).isAlive = false;
    await (h.engine as any).handleSheriffTransfer([h.p(1).id]);
    assert.equal(h.state.sheriffId, null);
  });

  await check('警长死亡且场上无其他存活玩家 → 警徽置空', async () => {
    const h = harness();
    h.state.sheriffId = h.p(1).id;
    killAllExcept(h.state, [h.p(1).id]);
    h.p(1).isAlive = false;
    await (h.engine as any).handleSheriffTransfer([h.p(1).id]);
    assert.equal(h.state.sheriffId, null);
  });

  // ============ 警徽传承的事件序列 ============
  //
  // 上面断言的是 state.sheriffId 这个内部状态。但 UI 上"警徽从谁传给了谁"完全依赖
  // sheriff_transfer 事件的 from/to 字段——状态对了而事件字段错了，前端警徽图标就会挂错人。
  // 这里把「该发时发且字段正确」「不该发时一次都不发」两侧都钉死。

  console.log('\n[警徽传承的事件序列：sheriff_transfer]');

  await check('sheriff_transfer：传承发出一次事件，from/to 四个字段都正确', async () => {
    testEventBus.clear();
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_9', reason: '测试' }]));
    const ev = collectEvents(['sheriff_transfer']);
    h.state.sheriffId = h.p(1).id;
    h.p(1).isAlive = false;

    await (h.engine as any).handleSheriffTransfer([h.p(1).id]);

    assert.deepEqual(ev.seq, ['sheriff_transfer'], '应恰好发出一次 sheriff_transfer');
    const d = ev.detail[0];
    assert.equal(d.fromId, h.p(1).id, '来源应是死亡的老警长');
    assert.equal(d.fromName, h.p(1).name);
    assert.equal(d.toId, 'player_9', '目标应是指定的继承人');
    assert.equal(d.toName, h.p(9).name);
    // 事件与内部状态必须一致，否则 UI 与后端会对不上
    assert.equal(h.state.sheriffId, d.toId, '事件里的 toId 必须与 state.sheriffId 一致');
  });

  await check('sheriff_transfer：非警长死亡 → 不发事件', async () => {
    testEventBus.clear();
    const h = harness();
    const ev = collectEvents(['sheriff_transfer']);
    h.state.sheriffId = h.p(1).id;
    h.p(8).isAlive = false;

    await (h.engine as any).handleSheriffTransfer([h.p(8).id]);

    assert.deepEqual(ev.seq, [], '死的不是警长，不该有传承事件');
  });

  await check('sheriff_transfer：本局无警长 → 不发事件', async () => {
    testEventBus.clear();
    const h = harness();
    const ev = collectEvents(['sheriff_transfer']);
    h.state.sheriffId = null;
    h.p(1).isAlive = false;

    await (h.engine as any).handleSheriffTransfer([h.p(1).id]);

    assert.deepEqual(ev.seq, [], '无警长时不该有传承事件');
  });

  await check('sheriff_transfer：无人可继承 → 警徽置空且不发事件', async () => {
    testEventBus.clear();
    const h = harness();
    const ev = collectEvents(['sheriff_transfer']);
    h.state.sheriffId = h.p(1).id;
    killAllExcept(h.state, [h.p(1).id]);
    h.p(1).isAlive = false;

    await (h.engine as any).handleSheriffTransfer([h.p(1).id]);

    assert.deepEqual(ev.seq, [], '没有继承人时不该发出传承事件');
    assert.equal(h.state.sheriffId, null, '警徽应置空');
  });

  await check('sheriff_transfer：预言家避狼后，事件里的 toId 不是已验狼', async () => {
    testEventBus.clear();
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_0', reason: '故意选狼' }]));
    const ev = collectEvents(['sheriff_transfer']);
    const seer = h.byRole(RoleType.SEER);
    h.state.sheriffId = seer.id;
    const seerAgent = h.agents.find(a => a.player.id === seer.id)!;
    seerAgent.addSeerResult(h.p(0).name, true, 1);
    seer.isAlive = false;

    await (h.engine as any).handleSheriffTransfer([seer.id]);

    assert.deepEqual(ev.seq, ['sheriff_transfer'], '仍应传出警徽');
    // 二次保护改选后，事件里的目标也必须同步改掉——不能状态改了而事件还播着狼
    assert.notEqual(ev.detail[0].toId, 'player_0', '事件里的继承人不能是已验狼');
    assert.equal(ev.detail[0].toId, h.state.sheriffId, '事件与状态必须一致');
  });

  // ============ 狼人夜刀投票（每狼各提一名，票数最多者被刀，非首夜允许自刀）============

  console.log('\n[狼人夜刀投票：多狼提名 / 策略自刀 / 首夜禁自刀]');

  await check('非首夜：多狼投不同目标 → 取票数最多者为击杀目标', async () => {
    // player_0..3 是狼；3 票投 player_8、1 票投 player_9 → 应击杀 player_8
    const h = harness(STANDARD_ROLES, new ScriptedProvider([
      { targetId: 'player_8', reasoning: '集火' },
      { targetId: 'player_8', reasoning: '集火' },
      { targetId: 'player_8', reasoning: '集火' },
      { targetId: 'player_9', reasoning: '异见' },
    ]));
    h.state.round = 2; // 非首夜
    await (h.phase as any).executeWolfVote();
    const kill = h.state.nightActions.find(a => a.actionType === EventType.WOLF_KILL);
    assert.ok(kill, '应产生一次 WOLF_KILL');
    assert.equal(kill!.targetId, 'player_8', '票数最多的 player_8 应被击杀');
  });

  await check('非首夜：狼人可策略性自刀（多数票投向一只狼自己）→ 该狼被刀', async () => {
    // 3 票投 player_0（狼自己），1 票投 player_8 → 自刀成功，击杀目标就是狼 player_0
    const h = harness(STANDARD_ROLES, new ScriptedProvider([
      { targetId: 'player_0', reasoning: '自刀骗解药' },
      { targetId: 'player_0', reasoning: '配合自刀' },
      { targetId: 'player_0', reasoning: '配合自刀' },
      { targetId: 'player_8', reasoning: '异见' },
    ]));
    h.state.round = 2;
    await (h.phase as any).executeWolfVote();
    const kill = h.state.nightActions.find(a => a.actionType === EventType.WOLF_KILL);
    assert.ok(kill, '应产生一次 WOLF_KILL');
    assert.equal(kill!.targetId, 'player_0', '自刀应生效：击杀目标是狼 player_0 自己');
    assert.equal(h.p(0).faction, Faction.WOLF, '前提校验：player_0 确实是狼（证明这是自刀而非误伤）');
  });

  await check('首夜：候选池排除狼人 → 即使狼想刀同伴也会被兜底改成非狼目标', async () => {
    // 首夜（round===1）候选池只含非狼人；这里所有狼都返回狼队 id（player_1），
    // nightAction 合法性校验会把非法目标随机改成候选池里的非狼玩家。
    const h = harness(STANDARD_ROLES, new ScriptedProvider([
      { targetId: 'player_1', reasoning: '首夜想自刀' },
      { targetId: 'player_1', reasoning: '首夜想自刀' },
      { targetId: 'player_1', reasoning: '首夜想自刀' },
      { targetId: 'player_1', reasoning: '首夜想自刀' },
    ]));
    h.state.round = 1; // 首夜
    await (h.phase as any).executeWolfVote();
    const kill = h.state.nightActions.find(a => a.actionType === EventType.WOLF_KILL);
    assert.ok(kill, '应产生一次 WOLF_KILL');
    const target = h.state.players.find(p => p.id === kill!.targetId)!;
    assert.notEqual(target.faction, Faction.WOLF, '首夜击杀目标不能是狼人（禁止首夜自刀）');
  });

  await check('非首夜：狼队平票 → 仍产出一个合法击杀目标（不崩、不空）', async () => {
    // 2 狼投 player_8、2 狼投 player_9 → 平票随机取其一
    const h = harness(STANDARD_ROLES, new ScriptedProvider([
      { targetId: 'player_8', reasoning: 'a' },
      { targetId: 'player_8', reasoning: 'a' },
      { targetId: 'player_9', reasoning: 'b' },
      { targetId: 'player_9', reasoning: 'b' },
    ]));
    h.state.round = 2;
    await (h.phase as any).executeWolfVote();
    const kill = h.state.nightActions.find(a => a.actionType === EventType.WOLF_KILL);
    assert.ok(kill, '平票也必须产出击杀目标');
    assert.ok(['player_8', 'player_9'].includes(kill!.targetId), '平票结果应在两个并列最高票之间');
  });

  await check('只剩一只狼：独狼提名直接生效（非首夜含自己也不强制自刀）', async () => {
    const h = harness(STANDARD_ROLES, new ScriptedProvider([
      { targetId: 'player_8', reasoning: '独狼选人' },
    ]));
    h.state.round = 2;
    // 只留 player_0 一只狼存活，其余狼出局
    h.p(1).isAlive = false;
    h.p(2).isAlive = false;
    h.p(3).isAlive = false;
    await (h.phase as any).executeWolfVote();
    const kill = h.state.nightActions.find(a => a.actionType === EventType.WOLF_KILL);
    assert.ok(kill, '独狼也要能产出击杀目标');
    assert.equal(kill!.targetId, 'player_8', '独狼提名应直接生效');
  });

  // ============ 狼刀的事件序列 ============
  //
  // 狼队夜刀对外只发一对 night_action_start / night_action_done（以"狼人阵营"这个虚拟身份），
  // 绝不能每只狼各发一次——否则观战 UI 会把狼队人数直接漏给观众。
  // 且 done 事件的 reasoning 里聚合了每只狼的提名流向，是复盘狼队内部分歧的唯一来源。

  console.log('\n[狼刀的事件序列：night_action_done 聚合]');

  await check('night_action_done：4 狼商议只发一对事件，且以"狼人阵营"身份聚合', async () => {
    testEventBus.clear();
    const h = harness(STANDARD_ROLES, new ScriptedProvider([
      { targetId: 'player_8', reasoning: '集火' },
      { targetId: 'player_8', reasoning: '集火' },
      { targetId: 'player_8', reasoning: '集火' },
      { targetId: 'player_9', reasoning: '异见' },
    ]));
    h.state.round = 2;
    const ev = collectEvents(['night_action_start', 'night_action_done']);

    await (h.phase as any).executeWolfVote();

    // 4 只狼提名，但对外只有一对事件——不能按狼数发 4 对
    assert.deepEqual(
      ev.seq, ['night_action_start', 'night_action_done'],
      '狼队夜刀对外只应发一对事件（否则会漏狼队人数）',
    );
    const start = ev.detail[0];
    assert.equal(start.playerId, 'wolves', '发起者应是虚拟的 wolves 而非某只具体的狼');
    assert.equal(start.playerName, '狼人阵营');

    const done = ev.detail[1];
    assert.equal(done.playerId, 'wolves');
    assert.equal(done.targetName, h.p(8).name, '最终目标应是票数最多的 player_8');
    // reasoning 聚合了每只狼的提名流向：4 只狼 → 4 个箭头
    assert.equal(
      (done.reasoning.match(/→/g) || []).length, 4,
      'reasoning 应聚合全部 4 只狼的提名流向',
    );
    assert.ok(done.reasoning.includes(h.p(9).name), '异见票的目标也应出现在聚合理由里');
  });

  await check('night_action_done：自刀时事件目标就是那只狼自己', async () => {
    testEventBus.clear();
    const h = harness(STANDARD_ROLES, new ScriptedProvider([
      { targetId: 'player_0', reasoning: '自刀骗解药' },
      { targetId: 'player_0', reasoning: '配合' },
      { targetId: 'player_0', reasoning: '配合' },
      { targetId: 'player_8', reasoning: '异见' },
    ]));
    h.state.round = 2;
    const ev = collectEvents(['night_action_done']);

    await (h.phase as any).executeWolfVote();

    assert.deepEqual(ev.seq, ['night_action_done']);
    assert.equal(ev.detail[0].targetName, h.p(0).name, '自刀应如实播报目标是狼自己');
  });

  await check('night_action_done：独狼也只发一对事件', async () => {
    testEventBus.clear();
    const h = harness(STANDARD_ROLES, new ScriptedProvider([
      { targetId: 'player_8', reasoning: '独狼选人' },
    ]));
    h.state.round = 2;
    h.p(1).isAlive = false;
    h.p(2).isAlive = false;
    h.p(3).isAlive = false;
    const ev = collectEvents(['night_action_start', 'night_action_done']);

    await (h.phase as any).executeWolfVote();

    assert.deepEqual(ev.seq, ['night_action_start', 'night_action_done']);
    // 独狼只有一个箭头，但身份仍是"狼人阵营"——不能因为只剩一只就暴露具体是谁
    assert.equal(ev.detail[1].playerId, 'wolves', '独狼也不能暴露具体座位');
    assert.equal((ev.detail[1].reasoning.match(/→/g) || []).length, 1);
  });

  await check('night_action_done：狼人全灭 → 不发任何夜刀事件', async () => {
    testEventBus.clear();
    const h = harness();
    h.state.round = 2;
    for (const pl of h.state.players) {
      if (pl.faction === Faction.WOLF) pl.isAlive = false;
    }
    const ev = collectEvents(['night_action_start', 'night_action_done']);

    await (h.phase as any).executeWolfVote();

    assert.deepEqual(ev.seq, [], '没有存活狼人时不该有夜刀事件');
    assert.equal(
      h.state.nightActions.filter(a => a.actionType === EventType.WOLF_KILL).length, 0,
      '也不该产生 WOLF_KILL 行动',
    );
  });

  // ============ 预言家查验的私密事件 ============
  //
  // seer_result_private 是全场唯一会携带"某人是不是狼"的事件。EventVisibility 策略按
  // seerId 做座位门控，只放行给该预言家本人。所以这里必须钉死：
  // 事件必须带 seerId、结果必须与目标真实阵营一致、且绝不能捎带多余的身份字段。
  // 一旦字段错了（比如 seerId 写成 targetId），遮罩层就会把验人结果发给错误的座位。

  console.log('\n[预言家查验：seer_result_private 私密事件]');

  await check('验到狼 → seer_result_private 带 seerId 且 isWolf=true', async () => {
    testEventBus.clear();
    // 预言家(player_4) 查验 player_0（狼）
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_0', reasoning: '查他' }]));
    const seer = h.byRole(RoleType.SEER);
    const seerAgent = h.agents.find(a => a.player.id === seer.id)!;
    const ev = collectEvents(['seer_result_private', 'night_action_done']);

    await (h.phase as any).executeNightAction(seerAgent);

    assert.ok(ev.seq.includes('seer_result_private'), '查验后必须发私密结果事件');
    const priv = ev.detail[ev.seq.indexOf('seer_result_private')];
    assert.equal(priv.seerId, seer.id, 'seerId 必须是预言家本人（遮罩层据此门控）');
    assert.equal(priv.targetName, h.p(0).name);
    assert.equal(priv.isWolf, true, 'player_0 是狼，结果必须为 true');
    assert.equal(priv.round, h.state.round);
    // 内存里的查验记录也要同步落账，否则警徽传承的"避狼"保护读不到
    assert.deepEqual(
      seerAgent.seerResults.map(r => ({ name: r.name, isWolf: r.isWolf })),
      [{ name: h.p(0).name, isWolf: true }],
    );
  });

  await check('验到好人 → isWolf=false', async () => {
    testEventBus.clear();
    // 查验 player_8（平民）
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_8', reasoning: '查他' }]));
    const seer = h.byRole(RoleType.SEER);
    const seerAgent = h.agents.find(a => a.player.id === seer.id)!;
    const ev = collectEvents(['seer_result_private']);

    await (h.phase as any).executeNightAction(seerAgent);

    assert.deepEqual(ev.seq, ['seer_result_private']);
    assert.equal(ev.detail[0].isWolf, false, 'player_8 是好人，结果必须为 false');
    assert.equal(ev.detail[0].seerId, seer.id);
  });

  await check('seer_result_private 不得泄露目标的具体角色（只有阵营真假）', async () => {
    testEventBus.clear();
    // 查验女巫：结果应只说"好人"，不能带 roleType=witch
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_5', reasoning: '查他' }]));
    const seer = h.byRole(RoleType.SEER);
    const seerAgent = h.agents.find(a => a.player.id === seer.id)!;
    assert.equal(h.p(5).roleType, RoleType.WITCH, '前提校验：player_5 是女巫');
    const ev = collectEvents(['seer_result_private']);

    await (h.phase as any).executeNightAction(seerAgent);

    const priv = ev.detail[0];
    assert.equal(priv.isWolf, false);
    // 预言家只能得知"好人/狼人"，不能得知对方是女巫——多发字段等于免费送神职情报
    assert.equal(priv.roleType, undefined, '不得携带 roleType');
    assert.equal(priv.faction, undefined, '不得携带 faction 原文');
  });

  await check('守卫行动 → 不发 seer_result_private（私密事件不串角色）', async () => {
    testEventBus.clear();
    const h = harness(STANDARD_ROLES, new ScriptedProvider([{ targetId: 'player_8', reasoning: '守他' }]));
    const guard = h.byRole(RoleType.GUARD);
    const guardAgent = h.agents.find(a => a.player.id === guard.id)!;
    const ev = collectEvents(['seer_result_private', 'night_action_done']);

    await (h.phase as any).executeNightAction(guardAgent);

    assert.ok(!ev.seq.includes('seer_result_private'), '守卫不该发查验结果事件');
    assert.ok(ev.seq.includes('night_action_done'), '但仍应有常规的行动完成事件');
    // 守卫的 lastGuardTarget 要落账，供"不能连守"规则使用
    assert.equal(h.state.lastGuardTarget, 'player_8');
  });

  // ============ 退水资格 / PK 复投 / 二次平票警徽流失 ============

  console.log('\n[警长竞选：退水资格 / 二次平票流失]');

  await check('退水：候选人退水触发 sheriff_withdraw，退水者退出竞选且失去投票权', async () => {
    // player_4(预言家)/8/9 上警，其中 player_9 退水；其余人不上警，作为警下投票者。
    // 三人都是好人（seer/民/民），不会被问自爆，专测退水分支。
    const scripts: (SeatScript | undefined)[] = [];
    scripts[4] = { runForSheriff: true, withdraw: false };
    scripts[8] = { runForSheriff: true, withdraw: false };
    scripts[9] = { runForSheriff: true, withdraw: true };
    // 未上警的警下投票者需要一个合法投票目标，否则 vote() 收到 undefined targetId 会崩。
    // 都投 player_4（候选人之一），投给谁不影响本用例断言（只测退水资格）。
    for (const i of [0, 1, 2, 3, 5, 6, 7, 10, 11]) scripts[i] = { runForSheriff: false, voteFor: 'player_4' };
    const h = electionHarness(scripts);
    const ev = collectEvents(['sheriff_withdraw', 'sheriff_vote', 'sheriff_election_end']);

    await h.phase.executeSheriffElection();

    // 退水事件恰好一次，且是 player_9
    const withdraws = ev.detail.filter((_, i) => ev.seq[i] === 'sheriff_withdraw');
    assert.equal(withdraws.length, 1, '应恰好触发一次退水');
    assert.equal(withdraws[0].playerId, h.p(9).id, '退水者应为 player_9');

    // 退水者失去投票权：警下投票的投票者里绝不含退水者
    const voterIds = ev.detail.filter((_, i) => ev.seq[i] === 'sheriff_vote').map(d => d.voterId);
    assert.ok(!voterIds.includes(h.p(9).id), '退水者不得参与警长投票');
    // 未退水的候选人（player_4/8）本就不属于警下投票群体
    assert.ok(
      !voterIds.includes(h.p(4).id) && !voterIds.includes(h.p(8).id),
      '候选人不参与警下投票',
    );

    // 退水者不可能当选
    assert.notEqual(h.state.sheriffId, h.p(9).id, '退水者不能当选警长');
  });

  await check('二次平票：警长 PK 复投仍平票 → 警徽流失（tie_lost），无人当选', async () => {
    // player_4/5 两人上警；其余 10 名警下玩家五五分票 → 首轮平票 → PK 仍平票 → 流失。
    // SeatBrain 未设 pkVoteFor 时 PK 沿用 voteFor，保证两轮票型一致、二次平票必现。
    const scripts: (SeatScript | undefined)[] = [];
    scripts[4] = { runForSheriff: true };
    scripts[5] = { runForSheriff: true };
    for (const i of [0, 1, 2, 3, 6]) scripts[i] = { runForSheriff: false, voteFor: 'player_4' };
    for (const i of [7, 8, 9, 10, 11]) scripts[i] = { runForSheriff: false, voteFor: 'player_5' };
    const h = electionHarness(scripts);
    const ev = collectEvents(['sheriff_election_end', 'sheriff_elected']);

    await h.phase.executeSheriffElection();

    const ends = ev.detail.filter((_, i) => ev.seq[i] === 'sheriff_election_end');
    assert.ok(ends.some(d => d.result === 'tie_lost'), '二次平票应以 tie_lost 收场');
    assert.ok(!ev.seq.includes('sheriff_elected'), '警徽流失时不应有人当选');
    assert.equal(h.state.sheriffId, null, '警徽流失，本局无警长');
  });

  console.log('\n[白天投票：平票 PK 复投]');

  await check('PK 复投：首轮平票触发 vote_pk_start，复投打破平局并放逐', async () => {
    // 4 人存活：player_0/1(狼)、player_8/9(民)。
    // 首轮 0 vs 8 各 2 票平票 → PK；复投集火 player_0 → player_0 被放逐。
    const seat: (LLMProvider | undefined)[] = [];
    seat[0] = new DayVoteBrain({ dayVoteFor: 'player_8', pkVoteFor: 'player_8' });
    seat[1] = new DayVoteBrain({ dayVoteFor: 'player_8', pkVoteFor: 'player_0' });
    seat[8] = new DayVoteBrain({ dayVoteFor: 'player_0', pkVoteFor: 'player_0' });
    seat[9] = new DayVoteBrain({ dayVoteFor: 'player_0', pkVoteFor: 'player_0' });
    const h = harness(STANDARD_ROLES, undefined, seat);
    killAllExcept(h.state, ['player_0', 'player_1', 'player_8', 'player_9']);
    const ev = collectEvents(['vote_pk_start', 'vote_tie', 'player_eliminated']);

    const eliminated = await h.vote.executeVote();

    assert.ok(ev.seq.includes('vote_pk_start'), '首轮平票应触发 PK 复投');
    assert.ok(!ev.seq.includes('vote_tie'), 'PK 打破平局，不应再有 vote_tie');
    assert.equal(eliminated, 'player_0', 'PK 复投集火后 player_0 被放逐');
    const elim = ev.detail.filter((_, i) => ev.seq[i] === 'player_eliminated');
    assert.equal(elim.length, 1, '应恰好一次放逐结算');
    assert.equal(elim[0].playerId, 'player_0');
  });

  await check('PK 复投仍平票 → vote_tie，本轮无人被放逐', async () => {
    // 4 人存活：首轮 0 vs 8 平票 → PK；PK 里 0/8 互投对方、1 投 0、9 投 8 → 仍 2:2 平票。
    const seat: (LLMProvider | undefined)[] = [];
    seat[0] = new DayVoteBrain({ dayVoteFor: 'player_8', pkVoteFor: 'player_8' });
    seat[1] = new DayVoteBrain({ dayVoteFor: 'player_8', pkVoteFor: 'player_0' });
    seat[8] = new DayVoteBrain({ dayVoteFor: 'player_0', pkVoteFor: 'player_0' });
    seat[9] = new DayVoteBrain({ dayVoteFor: 'player_0', pkVoteFor: 'player_8' });
    const h = harness(STANDARD_ROLES, undefined, seat);
    killAllExcept(h.state, ['player_0', 'player_1', 'player_8', 'player_9']);
    const ev = collectEvents(['vote_pk_start', 'vote_tie', 'player_eliminated']);

    const eliminated = await h.vote.executeVote();

    assert.ok(ev.seq.includes('vote_pk_start'), '首轮平票应触发 PK 复投');
    assert.ok(ev.seq.includes('vote_tie'), 'PK 仍平票应触发 vote_tie');
    assert.ok(!ev.seq.includes('player_eliminated'), 'PK 仍平票则无人被放逐');
    assert.equal(eliminated, null, '返回 null 表示本轮无人出局');
  });

  // ============ 收尾 ============

  console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
  if (failures.length > 0) {
    console.log('失败用例：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log('');
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('测试运行器异常：', e);
  process.exit(1);
});
