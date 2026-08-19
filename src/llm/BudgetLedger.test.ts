/**
 * BudgetLedger 离线测试。**不发起任何网络请求、不消耗任何 token**。
 *
 * 运行：npm run test:budget
 *
 * 覆盖四类关注点：
 * 1. 跨进程并发：真的 fork 子进程，用 O_EXCL 文件锁串行化 reserve/settle，验证
 *    Windows 上 `openSync('wx')` 互斥可靠、不丢更新、不重复计费。
 * 2. 崩溃残留：reserve 已落盘但 settle 没写（进程被 SIGKILL）——悬挂 reservation
 *    应仍占额度，且能被 inspect() 连同 pid/时间报出来。
 * 3. 锁恢复：遗留锁 fail closed（拒绝自动修复）；人工删锁后恢复；正常 reserve/settle
 *    不留下锁文件。
 * 4. 只读 inspect()：不取锁、不创建账本、不写字节；悬挂 reservation 按时间排序；
 *    inspect(false) 按账本 header 汇报（用于 .env 与账本漂移时的诊断）。
 *
 * 子进程协议：`--child <mode> <ledgerPath> <tokens> [extra]`
 *   - reserve         ：reserve 后退出（0=成功，2=预算不足）——用于并发抢占。
 *   - reserve-settle  ：reserve 后 settle(actual=extra) 再退出——用于并发一致性。
 *   - reserve-hang    ：reserve 落盘后打印 RESERVED 并挂起，等父进程 SIGKILL——模拟崩溃残留。
 */
import * as assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BudgetLedger,
  LLMBudgetError,
  PROJECT_TOKEN_BUDGET,
  readBudgetConfig,
} from './BudgetLedger';

const PERIOD = 'offline-budget-test';
const CALL_BUDGET = 100;
// 8 个子进程各预留这么多 token，只有 5 个能成功；其余 3 个应因预算耗尽被拒。
// 显式绑定到 PROJECT_TOKEN_BUDGET 的 1/5，天花板变化时不用再手改。
const CONCURRENT_RESERVATION_TOKENS = Math.floor(PROJECT_TOKEN_BUDGET / 5);

function config(ledgerPath: string, lockTimeoutMs = 500): ConstructorParameters<typeof BudgetLedger>[0] {
  return {
    ledgerPath,
    period: PERIOD,
    tokenBudget: PROJECT_TOKEN_BUDGET,
    callBudget: CALL_BUDGET,
    lockTimeoutMs,
  };
}

// ============ 子进程运行器 ============

/** 跑一个「reserve / reserve-settle」子进程，返回 true=成功(exit0) / false=预算不足(exit2)。 */
function runChild(mode: string, ledgerPath: string, tokens: number, extra?: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const args = ['-r', require.resolve('ts-node/register'), __filename, '--child', mode, ledgerPath, String(tokens)];
    if (extra !== undefined) args.push(String(extra));
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(true);
      else if (code === 2) resolve(false);
      else reject(new Error(`预算测试子进程异常退出 code=${code}: ${stderr}`));
    });
  });
}

interface HangChild {
  child: ChildProcess;
  pid: number;
}

/**
 * 拉起一个 reserve-hang 子进程：它 reserve 落盘后打印 RESERVED 并挂起。
 * Promise 在收到 RESERVED（reserve 已 fsync 到账本、锁已释放）后 resolve，
 * 此时父进程可以安全 SIGKILL 它，从而制造出「reserve 有、settle 无」的崩溃残留。
 */
function spawnHangChild(ledgerPath: string, tokens: number): Promise<HangChild> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-r', require.resolve('ts-node/register'), __filename, '--child', 'reserve-hang', ledgerPath, String(tokens)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!settled && stdout.includes('RESERVED')) {
        settled = true;
        resolve({ child, pid: child.pid! });
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (!settled) reject(new Error(`hang 子进程未预留就退出 code=${code}: ${stderr}`));
    });
  });
}

/** SIGKILL 子进程并等它真正退出，保证后续 inspect 读到的是稳定状态。 */
function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    child.on('close', () => resolve());
    child.kill('SIGKILL');
  });
}

async function childMain(): Promise<void> {
  const mode = process.argv[3];
  const ledgerPath = process.argv[4];
  const tokens = Number(process.argv[5]);
  const extra = process.argv[6];

  if (mode === 'reserve') {
    try {
      new BudgetLedger(config(ledgerPath, 5_000)).reserve(tokens);
      process.exitCode = 0;
    } catch (error) {
      if (error instanceof LLMBudgetError) process.exitCode = 2;
      else throw error;
    }
    return;
  }

  if (mode === 'reserve-settle') {
    try {
      const ledger = new BudgetLedger(config(ledgerPath, 5_000));
      const reservation = ledger.reserve(tokens);
      ledger.settle(reservation, Number(extra));
      process.exitCode = 0;
    } catch (error) {
      if (error instanceof LLMBudgetError) process.exitCode = 2;
      else throw error;
    }
    return;
  }

  if (mode === 'reserve-hang') {
    // reserve 完整走完（含锁的获取与释放），只是之后不 settle 就挂起。
    new BudgetLedger(config(ledgerPath, 5_000)).reserve(tokens);
    // 通知父进程 reserve 已落盘、锁已释放，可以安全 kill。
    process.stdout.write('RESERVED\n', () => {
      // 挂起等待 SIGKILL——模拟 reserve 之后、settle 之前进程崩溃。
      setInterval(() => {}, 1 << 30);
    });
    return;
  }

  throw new Error(`未知子进程模式: ${mode}`);
}

// ============ 测试脚手架（与 rules.test.ts 同风格）============

let passed = 0;
let failed = 0;
const failures: string[] = [];

function report(line: string): void {
  process.stdout.write(line + '\n');
}

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
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

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanguo-budget-'));
  let seq = 0;
  const freshPath = (tag: string) => path.join(tempDir, `${tag}-${seq++}.jsonl`);

  try {
    console.log('\n=== BudgetLedger 离线测试 ===\n');

    // ---- 跨进程并发（Windows O_EXCL 文件锁）----
    console.log('[跨进程并发：文件锁互斥]');

    await check('8 进程抢占 → 恰好 5 个成功，额度精确耗尽', async () => {
      const sharedPath = freshPath('shared');
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => runChild('reserve', sharedPath, CONCURRENT_RESERVATION_TOKENS)),
      );
      assert.equal(outcomes.filter(Boolean).length, 5, '并发预留只能有五个成功');

      const persisted = new BudgetLedger(config(sharedPath)).snapshot();
      assert.equal(persisted.committedTokens, PROJECT_TOKEN_BUDGET);
      assert.equal(persisted.reservedTokens, PROJECT_TOKEN_BUDGET);
      assert.equal(persisted.activeReservations, 5);
      assert.equal(persisted.calls, 5);
      assert.throws(() => new BudgetLedger(config(sharedPath)).reserve(1), LLMBudgetError);
    });

    await check('并发 reserve+settle → 无丢更新、settled 精确等于各进程用量之和', async () => {
      // 6 进程各 reserve(1000) 后 settle(actual=100)，全部应成功。
      // 若锁失效导致读改写竞态，settledTokens/calls 会漂移；这里钉死一致性。
      const sharedPath = freshPath('concurrent-settle');
      const N = 6;
      const ACTUAL = 100;
      const outcomes = await Promise.all(
        Array.from({ length: N }, () => runChild('reserve-settle', sharedPath, 1_000, ACTUAL)),
      );
      assert.equal(outcomes.filter(Boolean).length, N, '所有 reserve+settle 都应成功');

      const snap = new BudgetLedger(config(sharedPath)).snapshot();
      assert.equal(snap.calls, N, `calls 应等于进程数 ${N}`);
      assert.equal(snap.settledTokens, N * ACTUAL, 'settled 应精确等于各进程实际用量之和');
      assert.equal(snap.reservedTokens, 0, '全部结算后不应有残留预留');
      assert.equal(snap.activeReservations, 0);
      assert.equal(snap.committedTokens, N * ACTUAL);
    });

    // ---- 崩溃残留（reserve 已写、settle 未写）----
    console.log('\n[崩溃残留：悬挂 reservation]');

    await check('子进程 reserve 后被 SIGKILL → 悬挂 reservation 仍占额度且可被 inspect 报出', async () => {
      const crashPath = freshPath('crash');
      const HANG_TOKENS = 4_321;
      const hang = await spawnHangChild(crashPath, HANG_TOKENS);
      await killAndWait(hang.child);

      const report = new BudgetLedger(config(crashPath)).inspect();
      assert.equal(report.exists, true);
      assert.equal(report.snapshot!.reservedTokens, HANG_TOKENS, '悬挂预留仍占 token');
      assert.equal(report.snapshot!.committedTokens, HANG_TOKENS, 'committed 含悬挂预留');
      assert.equal(report.snapshot!.settledTokens, 0, '从未 settle');
      assert.equal(report.snapshot!.calls, 1, 'reserve 已计入调用数');
      assert.equal(report.pendingReservations!.length, 1, '应报告 1 条悬挂 reservation');
      assert.equal(report.pendingReservations![0].tokens, HANG_TOKENS);
      assert.equal(report.pendingReservations![0].pid, hang.pid, '应记录崩溃进程的 pid');
      assert.ok(report.pendingReservations![0].at, '应带时间戳供人判断是否崩溃残留');
    });

    await check('崩溃残留后仍能继续记账：悬挂预留持续占额度，新 reserve 在其之上累加', async () => {
      const crashPath = freshPath('crash-continue');
      const hang = await spawnHangChild(crashPath, 5_000);
      await killAndWait(hang.child);

      // 崩溃后账本未损坏、锁已释放 → 后续进程可正常 reserve，且额度从含悬挂预留处继续。
      const ledger = new BudgetLedger(config(crashPath));
      const snap = ledger.settle(ledger.reserve(1_000), 200);
      assert.equal(snap.reservedTokens, 5_000, '悬挂预留仍在（不会被自动回收）');
      assert.equal(snap.settledTokens, 200, '新调用正常结算');
      assert.equal(snap.committedTokens, 5_200, 'committed = 悬挂预留 + 新结算');
      assert.equal(snap.calls, 2, '崩溃的 reserve 与新调用都计入');
    });

    await check('多条悬挂 reservation → inspect 按时间升序排列（最老的最可能是崩溃残留）', async () => {
      const crashPath = freshPath('crash-multi');
      const h1 = await spawnHangChild(crashPath, 111);
      await killAndWait(h1.child);
      const h2 = await spawnHangChild(crashPath, 222);
      await killAndWait(h2.child);

      const pending = new BudgetLedger(config(crashPath)).inspect().pendingReservations!;
      assert.equal(pending.length, 2);
      assert.ok(pending[0].at <= pending[1].at, '悬挂 reservation 应按时间升序');
      assert.equal(pending[0].tokens, 111, '最老的应排在最前');
      assert.equal(pending[1].tokens, 222);
    });

    // ---- 锁恢复三态 ----
    console.log('\n[锁恢复：遗留锁 fail closed / 删锁恢复 / 正常释放不残留]');

    await check('遗留锁存在 → fail closed（拒绝自动修复，抛 LLMBudgetError）', async () => {
      const lockPath = freshPath('locked');
      const lockedLedger = new BudgetLedger(config(lockPath, 40));
      fs.writeFileSync(`${lockPath}.lock`, 'orphaned lock', 'utf8');
      assert.throws(() => lockedLedger.snapshot(), LLMBudgetError, '遗留锁必须 fail closed');
    });

    await check('人工删除遗留锁后 → reserve/settle 恢复正常', async () => {
      const lockPath = freshPath('lock-recover');
      const ledger = new BudgetLedger(config(lockPath, 40));
      // 先建账本（正常 reserve 一笔），再手动放一个遗留锁。
      ledger.settle(ledger.reserve(500), 100);
      fs.writeFileSync(`${lockPath}.lock`, 'orphaned', 'utf8');
      assert.throws(() => ledger.reserve(100), LLMBudgetError, '有遗留锁时应 fail closed');

      // 确认无进程占用后删除遗留锁 → 恢复。
      fs.unlinkSync(`${lockPath}.lock`);
      const snap = ledger.settle(ledger.reserve(300), 50);
      assert.equal(snap.calls, 2, '删锁后能继续记账');
      assert.equal(snap.settledTokens, 150);
    });

    await check('正常 reserve/settle → 完成后不残留 .lock 文件', async () => {
      const lockPath = freshPath('lock-clean');
      const ledger = new BudgetLedger(config(lockPath));
      ledger.settle(ledger.reserve(200), 42);
      assert.equal(fs.existsSync(`${lockPath}.lock`), false, '正常释放不应残留锁文件');
    });

    // ---- 结算语义 ----
    console.log('\n[结算语义：失败按预留计费 / usage 按实际计费]');

    await check('settleFailure → 按完整预留计费（缺 usage 宁可保守）', async () => {
      const failurePath = freshPath('failure');
      const failureLedger = new BudgetLedger(config(failurePath));
      const failedReservation = failureLedger.reserve(1_234);
      const failureSnapshot = failureLedger.settleFailure(failedReservation);
      assert.equal(failureSnapshot.settledTokens, 1_234, '失败必须按完整预留结算');
      assert.equal(failureSnapshot.reservedTokens, 0);
    });

    await check('settle(usage) → 按实际用量计费，释放多预留的部分', async () => {
      const usagePath = freshPath('usage');
      const usageLedger = new BudgetLedger(config(usagePath));
      const usageReservation = usageLedger.reserve(2_000);
      const usageSnapshot = usageLedger.settle(usageReservation, 321);
      assert.equal(usageSnapshot.settledTokens, 321);
      assert.equal(usageSnapshot.committedTokens, 321);
    });

    await check('同一 reservation 重复 settle → 第二次 fail closed 且账本不重复计费', () => {
      const duplicatePath = freshPath('duplicate-settle');
      const ledger = new BudgetLedger(config(duplicatePath));
      const reservation = ledger.reserve(900);
      const first = ledger.settle(reservation, 123);
      assert.equal(first.calls, 1);
      assert.equal(first.settledTokens, 123);

      assert.throws(
        () => ledger.settle(reservation, 456),
        LLMBudgetError,
        '已结算 reservation 不得再次 settle',
      );
      const after = ledger.snapshot();
      assert.equal(after.calls, 1, '重复 settle 不得增加调用次数');
      assert.equal(after.settledTokens, 123, '重复 settle 不得二次增加 token');
      assert.equal(after.activeReservations, 0);
    });

    // ---- 账本损坏 fail closed ----
    console.log('\n[账本损坏：拒绝自动修复]');

    await check('未完成写入（无尾随换行）→ fail closed', async () => {
      const corruptPath = freshPath('corrupt');
      fs.writeFileSync(corruptPath, '{"type":"header"}', 'utf8');
      assert.throws(() => new BudgetLedger(config(corruptPath)).snapshot(), LLMBudgetError);
    });

    // ---- 配置校验 ----
    console.log('\n[配置校验：缺失 / 超天花板]');

    await check('缺失预算配置 → 抛错', () => {
      assert.throws(() => readBudgetConfig({}), LLMBudgetError);
    });

    await check('LLM_TOKEN_BUDGET 超过安全天花板 → 抛错（防手滑多打一个 0）', () => {
      assert.throws(() => readBudgetConfig({
        LLM_TOKEN_BUDGET: String(PROJECT_TOKEN_BUDGET + 1),
        LLM_CALL_BUDGET: '100',
        LLM_BUDGET_LEDGER_PATH: path.join(tempDir, 'ceiling.jsonl'),
        LLM_BUDGET_PERIOD: PERIOD,
      }), LLMBudgetError);
    });

    // ---- 只读 inspect() ----
    console.log('\n[只读 inspect()：不取锁、不创建账本]');

    await check('inspect 不存在的账本 → exists=false，且不创建任何文件', () => {
      const ghostPath = freshPath('ghost');
      const report = new BudgetLedger(config(ghostPath)).inspect();
      assert.equal(report.exists, false, '账本不存在应如实报告');
      assert.equal(fs.existsSync(ghostPath), false, 'inspect 不得创建账本文件');
      assert.equal(fs.existsSync(`${ghostPath}.lock`), false, 'inspect 不得创建锁文件');
    });

    await check('inspect 存在的账本 → 不取锁、不残留锁文件', () => {
      const p = freshPath('inspect-nolock');
      const ledger = new BudgetLedger(config(p));
      ledger.settle(ledger.reserve(1_000), 400);
      ledger.inspect();
      assert.equal(fs.existsSync(`${p}.lock`), false, 'inspect 只读，不应产生锁文件');
    });

    await check('inspect 报告剩余额度与承诺量（以账本 header 为准）', () => {
      const p = freshPath('inspect-remaining');
      const ledger = new BudgetLedger(config(p));
      ledger.settle(ledger.reserve(1_000), 400);
      const r = new BudgetLedger(config(p)).inspect();
      assert.equal(r.snapshot!.settledTokens, 400);
      assert.equal(r.remainingTokens, PROJECT_TOKEN_BUDGET - 400);
      assert.equal(r.remainingCalls, CALL_BUDGET - 1);
      assert.equal(r.lockPresent, false);
    });

    await check('inspect(false) → 即使 .env 配置漂移也能按账本 header 读出真实状态', () => {
      const p = freshPath('inspect-drift');
      // 用一套配置建账本。
      new BudgetLedger(config(p)).settle(new BudgetLedger(config(p)).reserve(500), 200);
      // 换一套「漂移」配置去读：expectConfig=true 会 fail closed，false 则按 header 汇报。
      const drifted = new BudgetLedger({
        ledgerPath: p,
        period: 'DIFFERENT-PERIOD',
        tokenBudget: 12_345,
        callBudget: 7,
      });
      assert.throws(() => drifted.inspect(true), LLMBudgetError, '配置漂移时严格模式应 fail closed');
      const r = drifted.inspect(false);
      assert.equal(r.snapshot!.period, PERIOD, '应按账本 header 的 period 汇报');
      assert.equal(r.snapshot!.tokenBudget, PROJECT_TOKEN_BUDGET, '应按账本 header 的上限汇报');
      assert.equal(r.snapshot!.settledTokens, 200);
    });

    await check('inspect 感知遗留锁文件（lockPresent=true）', () => {
      const p = freshPath('inspect-lock');
      const ledger = new BudgetLedger(config(p));
      ledger.settle(ledger.reserve(100), 50);
      fs.writeFileSync(`${p}.lock`, 'x', 'utf8');
      const r = ledger.inspect();
      assert.equal(r.lockPresent, true, 'inspect 应如实报告锁文件存在');
      fs.unlinkSync(`${p}.lock`);
    });

    // ---- 结果汇总 ----
    console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
    if (failures.length > 0) {
      console.log('失败用例：');
      for (const f of failures) console.log(`  · ${f}`);
    }
    console.log('');
    if (failed > 0) process.exitCode = 1;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') {
  childMain().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
