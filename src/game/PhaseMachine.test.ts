/**
 * PhaseMachine 转移表单测。**纯逻辑、无副作用、不碰 LLM / EventBus / 游戏状态**。
 *
 * 运行：npm run test:phase-machine
 *
 * 目的：把原先内联在 GameEngine.gameLoop 里的阶段推进逻辑（首夜竞选先于死讯、自爆跳过白天、
 * 胜负判定收尾）抽成 nextPhase 后，用确定性用例逐条钉死每个 (当前阶段, 信号) → 下一阶段，
 * 保证任何后续重构都不会悄悄改掉转移行为。这里只测转移函数本身；整局事件序列由
 * phaseSequence.test.ts 用 MockProvider 端到端冒烟。
 */
import * as assert from 'node:assert/strict';
import { PhaseNode, nextPhase } from './PhaseMachine';

// ============ 测试脚手架（与 rules.test.ts 同风格）============

let passed = 0;
let failed = 0;
const failures: string[] = [];

function report(line: string): void {
  process.stdout.write(line + '\n');
}

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    report(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    failures.push(name);
    report(`  ✗ ${name}`);
    report(`      ${String(e?.message || e).split('\n')[0]}`);
  }
}

// ============ 用例 ============

report('\n=== PhaseMachine 转移表单测 ===\n');

report('[正常轮次转移]');

check('START → NIGHT（无信号）', () => {
  assert.equal(nextPhase(PhaseNode.START, {}), PhaseNode.NIGHT);
});

check('START → NIGHT（省略信号参数）', () => {
  assert.equal(nextPhase(PhaseNode.START), PhaseNode.NIGHT);
});

check('NIGHT → DAWN', () => {
  assert.equal(nextPhase(PhaseNode.NIGHT, {}), PhaseNode.DAWN);
});

check('DAWN → DAY（无自爆、未结束）', () => {
  assert.equal(nextPhase(PhaseNode.DAWN, {}), PhaseNode.DAY);
});

check('DAY → VOTE', () => {
  assert.equal(nextPhase(PhaseNode.DAY, {}), PhaseNode.VOTE);
});

check('VOTE → NIGHT（进入下一轮）', () => {
  assert.equal(nextPhase(PhaseNode.VOTE, {}), PhaseNode.NIGHT);
});

check('一个完整正常轮回：START→NIGHT→DAWN→DAY→VOTE→NIGHT', () => {
  let node = nextPhase(PhaseNode.START, {});
  assert.equal(node, PhaseNode.NIGHT);
  node = nextPhase(node, {});
  assert.equal(node, PhaseNode.DAWN);
  node = nextPhase(node, {});
  assert.equal(node, PhaseNode.DAY);
  node = nextPhase(node, {});
  assert.equal(node, PhaseNode.VOTE);
  node = nextPhase(node, {});
  assert.equal(node, PhaseNode.NIGHT);
});

report('\n[首夜自爆：DAWN 跳过 DAY/VOTE 直接下一轮黑夜]');

check('DAWN + exploded → NIGHT（跳过白天与投票）', () => {
  assert.equal(nextPhase(PhaseNode.DAWN, { exploded: true }), PhaseNode.NIGHT);
});

check('exploded 只对 DAWN 生效：NIGHT + exploded 仍 → DAWN', () => {
  // exploded 语义上只可能由 DAWN 内的首夜竞选产出，其它阶段即便误带该信号也不改变正常转移。
  assert.equal(nextPhase(PhaseNode.NIGHT, { exploded: true }), PhaseNode.DAWN);
});

check('自爆局的转移片段：DAWN(exploded)→NIGHT→DAWN', () => {
  let node = nextPhase(PhaseNode.DAWN, { exploded: true });
  assert.equal(node, PhaseNode.NIGHT);
  node = nextPhase(node, {});
  assert.equal(node, PhaseNode.DAWN);
});

report('\n[游戏结束：gameEnded 从任意阶段 → END，且优先级最高]');

check('DAWN + gameEnded → END', () => {
  assert.equal(nextPhase(PhaseNode.DAWN, { gameEnded: true }), PhaseNode.END);
});

check('VOTE + gameEnded → END', () => {
  assert.equal(nextPhase(PhaseNode.VOTE, { gameEnded: true }), PhaseNode.END);
});

check('NIGHT + gameEnded → END', () => {
  assert.equal(nextPhase(PhaseNode.NIGHT, { gameEnded: true }), PhaseNode.END);
});

check('DAY + gameEnded → END', () => {
  assert.equal(nextPhase(PhaseNode.DAY, { gameEnded: true }), PhaseNode.END);
});

check('gameEnded 优先于 exploded：DAWN + {exploded,gameEnded} → END', () => {
  // 首夜自爆后若同时判定游戏结束（自爆的狼是最后一只等），结束信号应压过自爆的续局转移。
  assert.equal(
    nextPhase(PhaseNode.DAWN, { exploded: true, gameEnded: true }),
    PhaseNode.END,
  );
});

report('\n[END 吸收态]');

check('END → END（幂等，不再转移）', () => {
  assert.equal(nextPhase(PhaseNode.END, {}), PhaseNode.END);
});

check('END + 任意信号仍 → END', () => {
  assert.equal(nextPhase(PhaseNode.END, { exploded: true }), PhaseNode.END);
  assert.equal(nextPhase(PhaseNode.END, { gameEnded: true }), PhaseNode.END);
});

// ============ 收尾 ============

report(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
if (failures.length > 0) {
  report('失败用例：');
  for (const f of failures) report(`  · ${f}`);
}
report('');
if (failed > 0) process.exit(1);
