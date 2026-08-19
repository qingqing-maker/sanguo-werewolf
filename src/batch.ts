import * as dotenv from 'dotenv';
dotenv.config();

// 强制启用 fast 模式：所有 delay() 短路，一局跑毫秒级
process.env.FAST_MODE = '1';

// provider 由 CLI 决定：--provider=real 用真实 LLM（会花钱），否则 mock（离线免费）。
// 注意：必须在 import provider 之前设好 LLM_PROVIDER，避免熔断器读到旧值。
const USE_REAL = process.argv.includes('--provider=real') || process.argv.includes('--real');
if (!USE_REAL) {
  process.env.LLM_PROVIDER = 'mock';
}

import { GameEngine } from './game/GameEngine';
import { RoleRegistry } from './roles/RoleRegistry';
import {
  assertProviderConfiguration,
  createLLMProvider,
  getConfiguredProviderName,
} from './llm/ProviderFactory';
import { LLMProvider } from './llm/LLMProvider';
import { EventBus } from './game/EventBus';
import { Faction, GameConfig, RoleType } from './types';

/** 按统一配置选择 Provider；真实模式拒绝 mock。 */
function makeProvider(eventBus: EventBus): LLMProvider {
  return createLLMProvider(undefined, USE_REAL, { eventBus });
}

/**
 * 批量模拟入口
 * 用法：
 *   ts-node --transpile-only src/batch.ts --games=500
 *   ts-node --transpile-only src/batch.ts --games=500 --wolves=3
 *   ts-node --transpile-only src/batch.ts --games=500 --wolves=4 --maxRounds=10
 *
 * 输出：
 *   狼人胜、好人胜、平均回合数、95% 置信区间、按结束原因的分类明细。
 */

interface BatchResult {
  games: number;
  wolfWins: number;
  goodWins: number;
  avgRounds: number;
  reasons: Record<string, { count: number; wolfWins: number; goodWins: number }>;
  errors: number;
}

/**
 * 简单的 Wilson score 95% 置信区间。
 * 比 normal-approximation 更稳健，尤其在样本量不大 or 比例接近 0/1 时。
 */
function wilson95(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * 构建游戏配置。可通过 CLI 覆盖角色数量。
 */
function buildConfig(overrides: {
  wolves?: number;
  villagers?: number;
  maxRounds?: number;
}): GameConfig {
  const base = RoleRegistry.getDefaultConfig();
  // 默认 12 人：4 狼 + 1 预言家 + 1 女巫 + 1 猎人 + 1 守卫 + 4 平民
  const wolves = overrides.wolves ?? 4;
  const villagers = overrides.villagers ?? 4;
  const maxRounds = overrides.maxRounds ?? base.maxRounds;
  const roles: RoleType[] = [];
  for (let i = 0; i < wolves; i++) roles.push(RoleType.WEREWOLF);
  roles.push(RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.GUARD);
  for (let i = 0; i < villagers; i++) roles.push(RoleType.VILLAGER);
  return {
    ...base,
    playerCount: roles.length,
    roles,
    maxRounds,
    enableInnerThoughts: false,
  };
}

/**
 * 单局：等待 `game_end` 事件。
 * GameEngine.start() 是异步跑完整局，中途没有事件返回胜方，我们订阅事件。
 */
async function runOne(config: GameConfig): Promise<{
  winner: Faction;
  reason: string;
  rounds: number;
  goodVotes: number;   // 好人投出的放逐票总数
  goodHits: number;    // 其中投中狼人的票数
}> {
  return new Promise((resolve, reject) => {
    const eventBus = new EventBus();
    let settled = false;
    let rounds = 0;

    // 逐票命中率埋点：先缓存本局所有放逐投票（voterId→targetId），
    // 局终拿到 game_end 里的完整阵营真值表后再判定命中，避免依赖 provider 内部状态。
    const votes: { voterId: string; targetId: string }[] = [];

    // phase_change 的 night 表示进入新回合。
    eventBus.on('phase_change', (ev) => {
      const r = ev.data.phase === 'night' ? ev.data.round : 0;
      if (typeof r === 'number' && r > rounds) rounds = r;
    });

    // player_vote 只在放逐投票触发（警长竞选走 sheriff_vote），正是我们要的口径。
    eventBus.on('player_vote', (ev) => {
      const voterId = ev.data?.voterId;
      const targetId = ev.data?.targetId;
      if (typeof voterId === 'string' && typeof targetId === 'string' && targetId !== 'abstain') {
        votes.push({ voterId, targetId });
      }
    });

    eventBus.on('game_end', (ev) => {
      if (settled) return;
      settled = true;
      // 从 game_end 的 players 建阵营真值表（含死者，阵营固定不变）
      const factionById = new Map<string, Faction>();
      for (const p of (ev.data?.players ?? [])) {
        factionById.set(p.id, p.faction as Faction);
      }
      let goodVotes = 0;
      let goodHits = 0;
      for (const v of votes) {
        // 只统计"投票者是好人"的票（好人读狼命中率）
        if (factionById.get(v.voterId) === Faction.GOOD) {
          goodVotes++;
          if (factionById.get(v.targetId) === Faction.WOLF) goodHits++;
        }
      }
      resolve({
        winner: ev.data.winner as Faction,
        reason: ev.data.reason as string,
        rounds,
        goodVotes,
        goodHits,
      });
    });

    const llm = makeProvider(eventBus);
    const engine = new GameEngine(config, llm, { eventBus });
    engine.start().catch((err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/**
 * 解析命令行参数：--games=N --wolves=N --villagers=N --maxRounds=N
 */
function parseArgs(): { games: number; wolves?: number; villagers?: number; maxRounds?: number } {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const raw = args.find((a) => a.startsWith(`--${k}=`));
    return raw ? Number(raw.split('=')[1]) : undefined;
  };
  return {
    // 真实 LLM 每局约 200-400 次调用会花钱，默认只跑 3 局试水；mock 默认 200 局。
    games: get('games') ?? (USE_REAL ? 3 : 200),
    wolves: get('wolves'),
    villagers: get('villagers'),
    maxRounds: get('maxRounds'),
  };
}

async function main() {
  assertProviderConfiguration(getConfiguredProviderName(), USE_REAL);
  const args = parseArgs();
  const config = buildConfig(args);

  // 抑制单局日志，避免刷屏
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  const result: BatchResult = {
    games: 0,
    wolfWins: 0,
    goodWins: 0,
    avgRounds: 0,
    reasons: {},
    errors: 0,
  };
  let totalRounds = 0;
  // 逐票命中率累计：好人投出的放逐票总数 & 其中命中狼人的票数
  let totalGoodVotes = 0;
  let totalGoodHits = 0;

  const t0 = Date.now();
  for (let i = 0; i < args.games; i++) {
    try {
      const one = await runOne(config);
      result.games++;
      totalRounds += one.rounds;
      totalGoodVotes += one.goodVotes;
      totalGoodHits += one.goodHits;
      if (one.winner === Faction.WOLF) result.wolfWins++;
      else if (one.winner === Faction.GOOD) result.goodWins++;
      const bucket = (result.reasons[one.reason] ||= { count: 0, wolfWins: 0, goodWins: 0 });
      bucket.count++;
      if (one.winner === Faction.WOLF) bucket.wolfWins++;
      else if (one.winner === Faction.GOOD) bucket.goodWins++;
    } catch {
      result.errors++;
    }
    // 进度点：真实模式每局都报（局少且慢），mock 每 50 局报
    if (USE_REAL || (i + 1) % 50 === 0) {
      origLog(`  已跑 ${i + 1}/${args.games} 局...`);
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  result.avgRounds = result.games > 0 ? totalRounds / result.games : 0;

  // 恢复 console
  console.log = origLog;
  console.warn = origWarn;
  console.error = origErr;

  const wolfRate = result.games > 0 ? result.wolfWins / result.games : 0;
  const goodRate = result.games > 0 ? result.goodWins / result.games : 0;
  const [wLo, wHi] = wilson95(result.wolfWins, result.games);
  const [gLo, gHi] = wilson95(result.goodWins, result.games);

  console.log('\n════════════════════════════════════════');
  console.log('           批量模拟结果');
  console.log('════════════════════════════════════════');
  console.log(`配置：${config.playerCount} 人局，狼 ${(config.roles.filter(r => r === RoleType.WEREWOLF).length)}，神职 4，民 ${config.roles.filter(r => r === RoleType.VILLAGER).length}，maxRounds=${config.maxRounds}`);
  console.log(`样本：${result.games} 局（错误 ${result.errors} 局），耗时 ${dt}s`);
  console.log('----------------------------------------');
  console.log(`狼人胜：${result.wolfWins}  胜率=${(wolfRate * 100).toFixed(2)}%  95% CI [${(wLo * 100).toFixed(2)}%, ${(wHi * 100).toFixed(2)}%]`);
  console.log(`好人胜：${result.goodWins}  胜率=${(goodRate * 100).toFixed(2)}%  95% CI [${(gLo * 100).toFixed(2)}%, ${(gHi * 100).toFixed(2)}%]`);
  console.log(`平均回合数：${result.avgRounds.toFixed(2)}`);
  console.log('----------------------------------------');
  // 逐票读狼命中率：好人投出的放逐票里，投中真狼的比例。这是 mock/real 共用的同一把尺子。
  const hitRate = totalGoodVotes > 0 ? totalGoodHits / totalGoodVotes : 0;
  const [hLo, hHi] = wilson95(totalGoodHits, totalGoodVotes);
  console.log(`好人逐票读狼命中率：${totalGoodHits}/${totalGoodVotes} = ${(hitRate * 100).toFixed(2)}%  95% CI [${(hLo * 100).toFixed(2)}%, ${(hHi * 100).toFixed(2)}%]`);
  console.log('----------------------------------------');
  console.log('结束原因分类：');
  const rows = Object.entries(result.reasons).sort((a, b) => b[1].count - a[1].count);
  for (const [reason, s] of rows) {
    const p = (s.count / result.games) * 100;
    console.log(`  · ${reason}  ${s.count}局 (${p.toFixed(1)}%)  狼胜${s.wolfWins}/好胜${s.goodWins}`);
  }
  console.log('════════════════════════════════════════\n');

  // 机器可读单行汇总，便于扫参数时 grep 过滤
  const wolves = config.roles.filter(r => r === RoleType.WEREWOLF).length;
  console.log(
    `SUMMARY skill=${process.env.GOOD_SKILL ?? '0.52(默认)'} wolves=${wolves} maxRounds=${config.maxRounds} ` +
    `games=${result.games} good=${(goodRate * 100).toFixed(2)}% ` +
    `goodCI=[${(gLo * 100).toFixed(2)},${(gHi * 100).toFixed(2)}] ` +
    `wolf=${(wolfRate * 100).toFixed(2)}% ` +
    `hitRate=${(hitRate * 100).toFixed(2)}% hitCI=[${(hLo * 100).toFixed(2)},${(hHi * 100).toFixed(2)}] ` +
    `provider=${USE_REAL ? 'real' : 'mock'}`,
  );

  // 目标带判定：好人胜率 45%-55% 视为 55 开
  const inBand = goodRate >= 0.45 && goodRate <= 0.55;
  if (inBand) {
    console.log(`✅ 好人胜率 ${(goodRate * 100).toFixed(2)}% 落入 [45%, 55%] 目标带，达标。`);
  } else {
    console.log(`❌ 好人胜率 ${(goodRate * 100).toFixed(2)}% 未落入 [45%, 55%]。`);
    console.log(`   下界 ${(gLo * 100).toFixed(2)}% / 上界 ${(gHi * 100).toFixed(2)}%（95% CI）`);
  }
}

main().catch((e) => {
  console.error('批量模拟失败:', e);
  process.exit(1);
});
