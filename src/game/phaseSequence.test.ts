/**
 * 整局阶段序列集成测试。**不发起任何网络请求、不消耗任何 token**（用离线 MockProvider）。
 *
 * 运行：npm run test:phase-seq
 *
 * 与 PhaseMachine.test.ts 的分工：
 * - PhaseMachine.test.ts 逐条钉死纯转移表（current + signal → next），确定性、无副作用。
 * - 本文件把转移函数**接进真实 GameEngine.start()**，用 MockProvider 跑完整对局，
 *   验证「转移函数驱动 gameLoop」端到端后，对外发出的 phase_change / game_end 事件序列
 *   仍满足结构性质。这是防止重构把 handler 接错线（如自爆后仍进白天、game_end 漏发/多发）的兜底。
 *
 * 断言的是**结构性质**而非逐字序列：一局里死了谁、跳没跳自爆是 mock 决策+随机的结果，
 * 不该写死；但「dawn 前必有同轮 night」「game_end 恰好一次且在最后」这类不变量必须永真。
 *
 * 用多个固定种子跑多局做冒烟：SeededRandomSource 让 mock 局可复现，任一种子跑挂了都能稳定重现。
 */
import * as assert from 'node:assert/strict';
import { GameEngine } from './GameEngine';
import { MockProvider } from '../llm/MockProvider';
import { RoleRegistry } from '../roles/RoleRegistry';
import { EventBus, GameUIEvent } from './EventBus';
import { GameConfig } from '../types';
import { SeededRandomSource } from '../random';

// 整局跑起来会穿插大量展示停顿（delay）。测试只关心事件序列，把节奏归零瞬时跑完。
process.env.FAST_MODE = '1';
// MockProvider 读 difficulty 决定技能档；固定为 standard，避免受外部 .env 干扰。
process.env.AI_DIFFICULTY = 'standard';

// ============ 测试脚手架（与 rules.test.ts 同风格）============

let passed = 0;
let failed = 0;
const failures: string[] = [];

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

interface CapturedEvent {
  type: string;
  data: Record<string, any>;
}

/**
 * 用给定种子跑完整一局，返回按序捕获的事件流。
 * 只收本测试关心的类型，避免无关事件（发言/投票细节）淹没序列断言。
 */
async function runGame(seed: number): Promise<CapturedEvent[]> {
  const mathRandomBefore = Math.random;
  const root = new SeededRandomSource(seed);
  const eventBus = new EventBus();

  const captured: CapturedEvent[] = [];
  const WATCHED = new Set([
    'game_start',
    'phase_change',
    'wolf_explode',
    'game_end',
    'game_cancelled',
  ]);
  eventBus.onAll((e: GameUIEvent) => {
    if (WATCHED.has(e.type)) captured.push({ type: e.type, data: e.data });
  });

  const config: GameConfig = RoleRegistry.getDefaultConfig();
  const engine = new GameEngine(config, new MockProvider(root.fork('provider')), {
    random: root.fork('game'),
    idFactory: () => `test-game-${seed}`,
    eventBus,
  });

  try {
    await engine.start();
  } finally {
    assert.equal(Math.random, mathRandomBefore, '对局不得替换全局 Math.random 引用');
  }
  return captured;
}

/** 从捕获流里抽出 phase_change 的 phase 字符串序列。 */
function phaseSeq(events: CapturedEvent[]): string[] {
  return events.filter(e => e.type === 'phase_change').map(e => e.data.phase);
}

// ============ 用例 ============

async function main() {
  console.log('\n=== 整局阶段序列集成测试（MockProvider，离线）===\n');

  // 固定种子集合：覆盖不同的角色分配与 mock 走向，尽量撞出自爆/速通等分支。
  const SEEDS = [1, 7, 42, 100, 2024, 31337, 88888];

  for (const seed of SEEDS) {
    await check(`种子 ${seed}：game_start 恰好一次且是首个事件`, async () => {
      const ev = await runGame(seed);
      assert.ok(ev.length > 0, '应至少捕获到事件');
      assert.equal(ev[0].type, 'game_start', '首个事件必须是 game_start');
      const starts = ev.filter(e => e.type === 'game_start');
      assert.equal(starts.length, 1, 'game_start 只能有一次');
    });

    await check(`种子 ${seed}：game_end 恰好一次且是最后一个事件`, async () => {
      const ev = await runGame(seed);
      const ends = ev.filter(e => e.type === 'game_end');
      assert.equal(ends.length, 1, 'game_end 必须恰好一次');
      assert.equal(ev[ev.length - 1].type, 'game_end', 'game_end 必须是最后一个事件');
      // 状态机进入 END 才收尾，绝不应发出 game_cancelled（本测试不取消对局）。
      assert.equal(ev.filter(e => e.type === 'game_cancelled').length, 0, '正常结束不应有 game_cancelled');
    });

    await check(`种子 ${seed}：首阶段是 night，每个 dawn 前必有同轮 night`, async () => {
      const ev = await runGame(seed);
      const changes = ev.filter(e => e.type === 'phase_change');
      assert.ok(changes.length > 0, '应有 phase_change');
      assert.equal(changes[0].data.phase, 'night', '第一个 phase_change 必须是 night');

      // 逐个 dawn 校验：其 round 必须有一个更早出现的同 round night。
      const seenNightRounds = new Set<number>();
      for (const c of changes) {
        if (c.data.phase === 'night') seenNightRounds.add(c.data.round);
        if (c.data.phase === 'dawn') {
          assert.ok(seenNightRounds.has(c.data.round), `dawn(round=${c.data.round}) 前应有同轮 night`);
        }
      }
    });

    await check(`种子 ${seed}：sheriff_election 只出现在首夜（round=1，紧跟 dawn）`, async () => {
      const ev = await runGame(seed);
      const changes = ev.filter(e => e.type === 'phase_change');
      const elections = changes.filter(c => c.data.phase === 'sheriff_election');
      // 首夜竞选可能发生也可能不发生取决于流程，但一旦发生只能在 round=1。
      for (const el of elections) {
        assert.equal(el.data.round, 1, 'sheriff_election 只能在首夜');
      }
      // 竞选最多一次（首夜特殊流程）。
      assert.ok(elections.length <= 1, 'sheriff_election 至多一次');
    });

    await check(`种子 ${seed}：phase 字符串全部在允许集合内`, async () => {
      const ev = await runGame(seed);
      const allowed = new Set(['night', 'dawn', 'sheriff_election', 'day', 'vote']);
      for (const p of phaseSeq(ev)) {
        assert.ok(allowed.has(p), `非法 phase 字符串: ${p}`);
      }
    });

    await check(`种子 ${seed}：dawn 之后要么 day，要么 night（自爆跳过白天），要么直接结束`, async () => {
      const ev = await runGame(seed);
      const changes = ev.filter(e => e.type === 'phase_change');
      const explodedRounds = new Set(
        ev.filter(e => e.type === 'wolf_explode').map(() => 1), // 自爆只发生在首夜竞选
      );
      for (let i = 0; i < changes.length; i++) {
        if (changes[i].data.phase !== 'dawn') continue;
        // dawn 之后的下一个 phase_change（若存在）。sheriff_election 是 dawn 内的子阶段，跳过它。
        let j = i + 1;
        while (j < changes.length && changes[j].data.phase === 'sheriff_election') j++;
        if (j >= changes.length) {
          // dawn 后没有更多 phase_change → 本局在 dawn 结算里结束了，合法。
          continue;
        }
        const next = changes[j].data.phase;
        if (explodedRounds.size > 0 && changes[i].data.round === 1) {
          // 首夜自爆：dawn 后应直接是下一轮 night（跳过 day/vote）。
          assert.equal(next, 'night', '首夜自爆后应跳过白天直接进入下一轮 night');
        } else {
          assert.ok(next === 'day', `dawn 后正常应进入 day，实际 ${next}`);
        }
      }
    });

    await check(`种子 ${seed}：每个 vote 之后要么下一轮 night，要么已结束`, async () => {
      const ev = await runGame(seed);
      const changes = ev.filter(e => e.type === 'phase_change');
      for (let i = 0; i < changes.length; i++) {
        if (changes[i].data.phase !== 'vote') continue;
        if (i + 1 >= changes.length) continue; // vote 后无 phase_change → 在 vote 结算里结束，合法
        assert.equal(changes[i + 1].data.phase, 'night', 'vote 后应进入下一轮 night');
        assert.equal(changes[i + 1].data.round, changes[i].data.round + 1, 'night 轮次应 +1');
      }
    });

    await check(`种子 ${seed}：round 单调不减，且每轮 night 唯一`, async () => {
      const ev = await runGame(seed);
      const nights = ev.filter(e => e.type === 'phase_change' && e.data.phase === 'night');
      const rounds = nights.map(n => n.data.round);
      // night 的 round 应为 1,2,3... 严格递增且无重复。
      for (let i = 1; i < rounds.length; i++) {
        assert.equal(rounds[i], rounds[i - 1] + 1, 'night 轮次应逐轮 +1');
      }
    });
  }

  await check('可复现性：同一种子两次跑出的 phase 序列完全一致', async () => {
    const a = phaseSeq(await runGame(42));
    const b = phaseSeq(await runGame(42));
    assert.deepEqual(a, b, '同种子的 mock 局应完全可复现');
  });

  await check('自爆局（若存在）：wolf_explode 当轮 dawn 后无 day/vote，直接下一轮 night', async () => {
    // 扫一批种子找一局真的发生了首夜自爆的，验证「自爆跳过白天」这条转移被端到端遵守。
    // 找不到也不算失败（mock 下自爆是概率事件），只是这条断言在本次运行里未被触发。
    let verified = false;
    for (const seed of [3, 5, 11, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59]) {
      const ev = await runGame(seed);
      const exploded = ev.some(e => e.type === 'wolf_explode');
      if (!exploded) continue;
      const changes = ev.filter(e => e.type === 'phase_change');
      // 首夜自爆：整局不应出现任何 day 或 vote（首夜自爆跳过白天，若随后立刻结束则更不会有）。
      // 更精确的断言：首夜（round=1）的 dawn 之后没有 round=1 的 day/vote。
      const round1Day = changes.some(c => c.data.round === 1 && (c.data.phase === 'day' || c.data.phase === 'vote'));
      assert.ok(!round1Day, '首夜自爆后不应出现首夜的 day/vote');
      verified = true;
      break;
    }
    if (!verified) {
      report('      （本次运行未撞到首夜自爆局，跳过实证；转移表已由 PhaseMachine.test.ts 覆盖）');
    }
  });

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
