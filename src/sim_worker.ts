import * as dotenv from 'dotenv';
dotenv.config();

// worker：只跑「1 局」真实/模拟对局，把结果以单行 JSON 打到 stdout（RESULT 前缀）。
// 每局显式创建独立 EventBus；worker 隔离仍用于真实 Provider 预算与进程池调度。
// 并行由父进程 sim_pool.ts 用进程池调度。

process.env.FAST_MODE = '1';
const USE_REAL = process.argv.includes('--provider=real') || process.argv.includes('--real');
if (!USE_REAL) process.env.LLM_PROVIDER = 'mock';

import { GameEngine } from './game/GameEngine';
import { RoleRegistry } from './roles/RoleRegistry';
import { createLLMProvider } from './llm/ProviderFactory';
import { LLMProvider, readFallbackStrategy } from './llm/LLMProvider';
import { EventBus } from './game/EventBus';
import { Difficulty, Faction, GameConfig, RoleType } from './types';
import { RandomSource, SeededRandomSource } from './random';
import {
  DegradeBuckets,
  FallbackBuckets,
  FirstNightWolfTarget,
  LLMRequestMetrics,
  makeDegradeBuckets,
  makeFallbackBuckets,
  makeLLMRequestMetrics,
  MetricsLLMProvider,
  incrementCounter,
} from './simMetrics';

function makeProvider(random: RandomSource, eventBus: EventBus): LLMProvider {
  return createLLMProvider(undefined, USE_REAL, { random, eventBus });
}

function getArg(k: string): number | undefined {
  const raw = process.argv.find((a) => a.startsWith(`--${k}=`));
  return raw ? Number(raw.split('=')[1]) : undefined;
}

function getStrArg(k: string): string | undefined {
  const raw = process.argv.find((a) => a.startsWith(`--${k}=`));
  return raw ? raw.split('=').slice(1).join('=') : undefined;
}

function buildConfig(): GameConfig {
  const base = RoleRegistry.getDefaultConfig();
  const wolves = getArg('wolves') ?? 4;
  const villagers = getArg('villagers') ?? 4;
  const maxRounds = getArg('maxRounds') ?? base.maxRounds;
  const roles: RoleType[] = [];
  for (let i = 0; i < wolves; i++) roles.push(RoleType.WEREWOLF);
  roles.push(RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.GUARD);
  for (let i = 0; i < villagers; i++) roles.push(RoleType.VILLAGER);

  // AI 强度档位：不传则沿用 RoleRegistry 默认（standard）。
  // 有了这个开关才能做难度校准——跑 novice/standard/expert 三批对比胜率。
  const rawDifficulty = getStrArg('difficulty');
  const aiDifficulty: Difficulty | undefined =
    rawDifficulty === 'novice' || rawDifficulty === 'standard' || rawDifficulty === 'expert'
      ? rawDifficulty
      : undefined;

  // MockProvider 从 AI_DIFFICULTY 读档选 goodSkill/wolfSkill 起始值；不传难度时按 standard。
  // 必须在 makeProvider() 构造 MockProvider 之前写好（buildConfig 早于 runOne，安全）。
  process.env.AI_DIFFICULTY = aiDifficulty ?? 'standard';

  return {
    ...base,
    playerCount: roles.length,
    roles,
    maxRounds,
    enableInnerThoughts: false,
    ...(aiDifficulty ? { aiDifficulty } : {}),
  };
}

async function runOne(config: GameConfig, root: RandomSource): Promise<{
  winner: string; reason: string; rounds: number; goodVotes: number; goodHits: number;
  providerFallbacks: FallbackBuckets;
  decisionDegrades: DegradeBuckets;
  llmRequests: LLMRequestMetrics;
  firstNightWolfTarget: FirstNightWolfTarget | null;
  effectiveProvider: 'real' | 'mixed' | 'mock';
}> {
  return new Promise((resolve, reject) => {
    const eventBus = new EventBus();
    let settled = false;
    let rounds = 0;
    const votes: { voterId: string; targetId: string }[] = [];
    // provider_fallback / ai_decision_degraded 都在 game 期间累计；跑完塞进 result 行。
    // 事件订阅到 game_end 就够——game_end 之后进程即将退出，不需要 off。
    const providerFallbacks = makeFallbackBuckets();
    const decisionDegrades = makeDegradeBuckets();
    const llmRequests = makeLLMRequestMetrics();
    let firstNightWolfTargetName: string | null = null;

    // 回合数统计。注意事件名必须是 `phase_change`——此前这里监听的是 `round_start`，
    // 而 GameEngine 从来没有发过这个事件，于是每批报告里的"平均回合数"恒为 0.00
    // （这个指标一直是坏的，只是没人核对过）。phase_change 每次阶段切换都带当前 round。
    eventBus.on('phase_change', (ev) => {
      const r = ev.data?.round;
      if (typeof r === 'number' && r > rounds) rounds = r;
    });
    eventBus.on('player_vote', (ev) => {
      const voterId = ev.data?.voterId;
      const targetId = ev.data?.targetId;
      if (typeof voterId === 'string' && typeof targetId === 'string' && targetId !== 'abstain') {
        votes.push({ voterId, targetId });
      }
    });
    eventBus.on('night_action_done', (ev) => {
      if (rounds === 1 && ev.data?.playerId === 'wolves' && typeof ev.data.targetName === 'string') {
        firstNightWolfTargetName = ev.data.targetName;
      }
    });
    // Provider 层的兜底（FallbackLLMProvider 分派到 Mock）：按 reason 和逻辑 operation 分桶。
    eventBus.on('provider_fallback', (ev) => {
      const reason = ev.data?.reason;
      const operation = ev.data?.operation;
      if (
        reason === 'timeout' || reason === 'parse' || reason === 'empty' || reason === 'error' ||
        reason === 'budget' || reason === 'billing' || reason === 'authentication' || reason === 'startup_mock'
      ) {
        providerFallbacks[reason]++;
        providerFallbacks.total++;
      }
      if (typeof operation === 'string') incrementCounter(providerFallbacks.byOperation, operation);
    });
    // BaseAgent 决策级降级（走保守默认值）：按 kind 和业务 operation 分桶。
    eventBus.on('ai_decision_degraded', (ev) => {
      const kind = ev.data?.kind;
      const operation = ev.data?.operation;
      if (kind === 'timeout' || kind === 'parse' || kind === 'other') {
        decisionDegrades[kind]++;
        decisionDegrades.total++;
      }
      if (typeof operation === 'string') incrementCounter(decisionDegrades.byOperation, operation);
    });
    eventBus.on('game_end', (ev) => {
      if (settled) return;
      settled = true;
      const playerSnapshots = ev.data?.players ?? [];
      const factionById = new Map<string, Faction>();
      for (const p of playerSnapshots) factionById.set(p.id, p.faction as Faction);
      let firstNightWolfTarget: FirstNightWolfTarget | null = null;
      if (firstNightWolfTargetName) {
        const target = playerSnapshots.find((p) => p.name === firstNightWolfTargetName);
        if (target) {
          firstNightWolfTarget = {
            playerId: target.id,
            name: target.name,
            roleType: target.roleType,
            faction: target.faction,
          };
        }
      }
      let goodVotes = 0, goodHits = 0;
      for (const v of votes) {
        if (factionById.get(v.voterId) === Faction.GOOD) {
          goodVotes++;
          if (factionById.get(v.targetId) === Faction.WOLF) goodHits++;
        }
      }
      // effectiveProvider 只描述是否启用了 Mock：mock（启动即 mock）/ mixed（至少一次 fallback）
      // / real（未切 Mock）。real 仍可能发生决策降级，严格干净样本由报告端另行判定。
      const effectiveProvider: 'real' | 'mixed' | 'mock' = USE_REAL
        ? (providerFallbacks.total > 0 ? 'mixed' : 'real')
        : 'mock';
      resolve({
        winner: ev.data.winner, reason: ev.data.reason, rounds, goodVotes, goodHits,
        providerFallbacks, decisionDegrades, llmRequests, firstNightWolfTarget, effectiveProvider,
      });
    });
    eventBus.on('llm_alert', (ev) => {
      if (settled || ev.data?.kind !== 'budget') return;
      // `on_budget` 的设计就是"预算熔断后仍由 Mock 把本局跑完"：熔断器先 emit llm_alert，
      // FallbackLLMProvider 随后捕获同一个 budget LLMError 并切 backup。此时不能像历史逻辑那样
      // 立刻 reject，否则 provider_fallback 还没机会生效。其他策略仍保持 fail closed。
      if (USE_REAL && readFallbackStrategy() === 'on_budget') return;
      settled = true;
      reject(new Error(`LLM_BUDGET_EXHAUSTED: ${String(ev.data?.reason || '预算拒绝')}`));
    });

    const provider = new MetricsLLMProvider(
      makeProvider(root.fork('provider'), eventBus),
      llmRequests,
    );
    const engine = new GameEngine(config, provider, { random: root.fork('game'), eventBus });
    engine.start().catch((err) => { if (!settled) { settled = true; reject(err); } });
  });
}

async function main() {
  // --verbose：诊断模式，保留单局日志 + 打心跳，用于排查卡点。
  // 默认（并行池调用时）静音，只保留最终 RESULT 行。
  const VERBOSE = process.argv.includes('--verbose');
  if (!VERBOSE) {
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
  } else {
    // 心跳：每 15s 打一次已耗时，确认进程没死、在等 API
    const started = Date.now();
    setInterval(() => {
      process.stderr.write(`  [心跳] 已运行 ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    }, 15000).unref();
  }
  // 同一 root 下 provider/game 使用独立子流，不再覆盖全局 Math.random。
  const seed = getArg('seed');
  const root = new SeededRandomSource(seed !== undefined && Number.isFinite(seed) ? seed : Date.now());

  const config = buildConfig();
  try {
    const one = await runOne(config, root);
    process.stdout.write('RESULT ' + JSON.stringify(one) + '\n');
    process.exit(0);
  } catch (e: any) {
    process.stdout.write('ERROR ' + JSON.stringify({ message: String(e?.message || e) }) + '\n');
    process.exit(1);
  }
}

main();
