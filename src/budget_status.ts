/**
 * 预算账本状态查询命令（只读，不写文件、不取锁、不消耗任何 token）。
 *
 * 用法：
 *   npm run budget:status                          # 读当前 .env 派生/指定的账本
 *   npm run budget:status -- --file=runs/x.jsonl   # 指定账本文件
 *   npm run budget:status -- --all                 # 扫 runs/ 下所有账本
 *   npm run budget:status -- --json                # 机器可读输出
 *
 * 为什么单独做一个命令：跑真实局之前需要先确认「这个周期还剩多少额度、有没有上次崩溃
 * 残留的悬挂 reservation 或遗留锁」。以前只能手动 tail JSONL 自己算，容易看错。
 *
 * 关键设计：全程用 BudgetLedger.inspect()，它**不取锁也不创建文件**。
 * 直接调 snapshot() 是不行的——那会取锁，并且在账本不存在时把账本创建出来，
 * 查一个从没用过的模型反而会写出一个新账本文件，属于查询污染状态。
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BudgetLedger,
  LLMBudgetError,
  LedgerReport,
  readBudgetConfig,
} from './llm/BudgetLedger';

const RULE = '════════════════════════════════════════';
const THIN = '----------------------------------------';

function getStrArg(key: string): string | undefined {
  const raw = process.argv.find(a => a.startsWith(`--${key}=`));
  return raw ? raw.slice(`--${key}=`.length).trim() : undefined;
}

const WANT_JSON = process.argv.includes('--json');
const WANT_ALL = process.argv.includes('--all');

/** 千分位，便于肉眼比对大数字。 */
function num(n: number): string {
  return n.toLocaleString('en-US');
}

function pct(used: number, total: number): string {
  if (total <= 0) return 'n/a';
  return `${((used / total) * 100).toFixed(2)}%`;
}

/**
 * 构造一个只用于读取指定文件的账本实例。
 *
 * 上限/周期填占位值并配合 inspect(false) —— 因为查询时我们**还不知道**该期望什么，
 * 想读的就是账本 header 自己声明的值。若用真实配置去校验，任何 .env 与账本的历史
 * 差异都会让查询直接抛错，而这恰恰是最需要查看状态的时刻。
 */
function ledgerFor(filePath: string): BudgetLedger {
  return new BudgetLedger({
    ledgerPath: path.resolve(filePath),
    period: 'inspect-placeholder',
    tokenBudget: 1,
    callBudget: 1,
  });
}

/** 列出 runs/ 下所有账本 JSONL（跳过 .bak-* 备份与模拟结果文件）。 */
function listLedgerFiles(): string[] {
  const dir = path.resolve('runs');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => f.startsWith('llm-budget-') && f.endsWith('.jsonl'))
    .map(f => path.join(dir, f))
    .sort();
}

interface Outcome {
  file: string;
  report?: LedgerReport;
  error?: string;
}

function inspectFile(filePath: string): Outcome {
  try {
    // expectConfig=false：按账本自身 header 汇报，不与当前 .env 比对。
    return { file: filePath, report: ledgerFor(filePath).inspect(false) };
  } catch (error: any) {
    const message = error instanceof LLMBudgetError
      ? error.message
      : `读取失败: ${String(error?.message ?? error)}`;
    return { file: filePath, error: message };
  }
}

/**
 * 剥掉 ledgerFor() 塞进去的占位配置字段，再交给 JSON 输出。
 *
 * configPeriod/configTokenBudget/configCallBudget 在查询场景下是 'inspect-placeholder' 和 1
 * 这种假值（见 ledgerFor 的说明），它们只是为了满足构造器校验。原样吐给脚本会被当成
 * "当前配置"消费，属于凭空造出的错误事实——当前 .env 的真实配置已在顶层 envConfig 字段给出。
 */
function publicReport(report: LedgerReport): Omit<
  LedgerReport,
  'configPeriod' | 'configTokenBudget' | 'configCallBudget'
> {
  const { configPeriod: _p, configTokenBudget: _t, configCallBudget: _c, ...rest } = report;
  return rest;
}

function printReport(outcome: Outcome, configHint?: { period: string; tokenBudget: number; callBudget: number }): void {
  const rel = path.relative(process.cwd(), outcome.file) || outcome.file;
  console.log(`\n${RULE}`);
  console.log(`账本: ${rel}`);
  console.log(RULE);

  if (outcome.error) {
    console.log(`⚠️ ${outcome.error}`);
    console.log('账本损坏或不一致时系统 fail closed（拒绝自动修复），真实调用同样会被拒绝。');
    return;
  }

  const r = outcome.report!;
  if (!r.exists) {
    console.log('账本尚不存在（该周期还没有发生过任何真实调用）。');
    // 注意：不要打印 r.configPeriod —— 那是 ledgerFor() 塞的占位值，对用户无意义。
    // 只有在查询「当前 .env 指向的账本」时才有真实 period 可报（由 configHint 传入）。
    if (configHint) {
      console.log(`首次真实调用时会按当前 .env 自动创建，period=${configHint.period}`);
    }
    if (r.lockPresent) console.log(`⚠️ 但发现遗留锁文件: ${r.lockPath}`);
    return;
  }

  const s = r.snapshot!;
  console.log(`周期 period      : ${s.period}`);
  console.log(`创建时间         : ${r.createdAt}`);
  console.log(THIN);
  console.log(`token 上限       : ${num(s.tokenBudget)}`);
  console.log(`已结算 settled   : ${num(s.settledTokens)}`);
  console.log(
    `已预留 reserved  : ${num(s.reservedTokens)}` +
    (s.reservedTokens > 0 ? '   （悬挂中，仍占额度）' : ''),
  );
  console.log(`已承诺 committed : ${num(s.committedTokens)}   (${pct(s.committedTokens, s.tokenBudget)})`);
  console.log(`剩余 token       : ${num(r.remainingTokens!)}`);
  console.log(THIN);
  console.log(`调用上限         : ${num(s.callBudget)}`);
  console.log(`已用调用数       : ${num(s.calls)}   (${pct(s.calls, s.callBudget)})`);
  console.log(`剩余调用数       : ${num(r.remainingCalls!)}`);

  // 与当前 .env 配置的差异：不一致时真实调用会 fail closed，必须显眼提示。
  if (configHint) {
    const mismatch: string[] = [];
    if (configHint.period !== s.period) mismatch.push(`period: .env=${configHint.period} vs 账本=${s.period}`);
    if (configHint.tokenBudget !== s.tokenBudget) mismatch.push(`tokenBudget: .env=${num(configHint.tokenBudget)} vs 账本=${num(s.tokenBudget)}`);
    if (configHint.callBudget !== s.callBudget) mismatch.push(`callBudget: .env=${num(configHint.callBudget)} vs 账本=${num(s.callBudget)}`);
    if (mismatch.length > 0) {
      console.log(THIN);
      console.log('⚠️ 与当前 .env 不一致，真实调用会被拒绝启动（fail closed）：');
      for (const m of mismatch) console.log(`  · ${m}`);
      console.log('  修复：把 .env 改回与账本 header 一致，或换一个新 period/新账本。');
    }
  }

  if (r.lockPresent) {
    console.log(THIN);
    console.log(`⚠️ 存在锁文件: ${r.lockPath}`);
    console.log('  若当前没有任何进程在跑，这是崩溃遗留锁，会让后续调用全部 fail closed。');
    console.log('  确认无进程占用后手动删除该文件即可恢复。');
  }

  const pending = r.pendingReservations ?? [];
  if (pending.length > 0) {
    console.log(THIN);
    console.log(`⚠️ 悬挂 reservation ${pending.length} 条（reserve 已写、settle 未写）：`);
    for (const p of pending) {
      console.log(`  · ${p.id}  tokens=${num(p.tokens)}  pid=${p.pid}  at=${p.at}`);
    }
    console.log('  正在跑的调用会稍后结算；若进程已退出，则是崩溃残留，将永久占用上述额度。');
  } else {
    console.log(THIN);
    console.log('✅ 无悬挂 reservation');
  }

  // 单行机器可读摘要，便于脚本 grep。
  console.log(
    `SUMMARY period=${s.period} settled=${s.settledTokens} reserved=${s.reservedTokens} ` +
    `committed=${s.committedTokens} remainingTokens=${r.remainingTokens} ` +
    `calls=${s.calls} remainingCalls=${r.remainingCalls} pending=${pending.length} lock=${r.lockPresent}`,
  );
}

/**
 * 剥掉 JSON 输出里的内部占位符字段。
 *
 * ledgerFor() 为了走 inspect(false) 塞了 period='inspect-placeholder'、上限=1 的假配置，
 * 那是实现细节。直接吐给 --json 的消费方会被误读成"这个账本的上限是 1"，
 * 所以序列化前删掉这三个 config* 字段——账本真实的上限在 snapshot 里。
 */
function sanitizeReport(report: LedgerReport | undefined): Record<string, unknown> | null {
  if (!report) return null;
  const { configPeriod: _p, configTokenBudget: _t, configCallBudget: _c, ...rest } = report;
  return rest;
}

/** 用法说明。查询命令没有副作用，帮助信息也就没必要藏。 */
function printHelp(): void {
  console.log(`
预算账本状态查询（只读：不写文件、不取锁、不消耗 token）

用法:
  npm run budget:status                  查当前 .env 指向的账本
  npm run budget:status -- --all         查 runs/ 下所有 llm-budget-*.jsonl
  npm run budget:status -- --file=<path> 查指定账本
  npm run budget:status -- --json        输出 JSON（供脚本消费）

输出含: period、已结算/已预留/已承诺 token、剩余 token、
        已用/剩余调用数、悬挂 reservation 明细、锁文件状态。

退出码: 0 正常；1 参数或读取失败。账本损坏/与 .env 不一致会在输出中标注，
        这类情况真实调用会 fail closed（拒绝自动修复）。
`);
}

function main(): void {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  // 当前 .env 解析出的配置：用于（a）默认账本路径 (b) 对比提示。
  // 配置缺失不算致命——用 --file/--all 仍可查任意账本。
  let envConfig: { ledgerPath: string; period: string; tokenBudget: number; callBudget: number } | null = null;
  let envConfigError: string | null = null;
  try {
    envConfig = readBudgetConfig();
  } catch (error: any) {
    envConfigError = String(error?.message ?? error);
  }

  const explicitFile = getStrArg('file');
  let targets: string[];

  if (WANT_ALL) {
    targets = listLedgerFiles();
    if (targets.length === 0) {
      console.error('runs/ 下没有找到任何 llm-budget-*.jsonl 账本。');
      process.exit(1);
    }
  } else if (explicitFile) {
    targets = [path.resolve(explicitFile)];
  } else if (envConfig) {
    targets = [envConfig.ledgerPath];
  } else {
    console.error(`无法确定账本路径：${envConfigError}`);
    console.error('请用 --file=<path> 指定账本，或用 --all 列出 runs/ 下全部账本。');
    process.exit(1);
  }

  const outcomes = targets.map(inspectFile);

  if (WANT_JSON) {
    console.log(JSON.stringify(
      {
        envConfig: envConfig ?? null,
        envConfigError,
        ledgers: outcomes.map(o => ({
          file: o.file,
          error: o.error ?? null,
          // 剥掉 ledgerFor 的占位配置：那不是任何真实配置，输出会误导脚本。
          report: o.report ? publicReport(o.report) : null,
        })),
      },
      null,
      2,
    ));
    return;
  }

  console.log('\n预算账本状态（只读查询，不写文件、不取锁、不消耗 token）');
  if (envConfigError) {
    console.log(`\n⚠️ 当前 .env 预算配置不可用：${envConfigError}`);
  } else if (envConfig && !WANT_ALL && !explicitFile) {
    console.log(`\n当前 .env 指向: period=${envConfig.period}  tokenBudget=${num(envConfig.tokenBudget)}  callBudget=${num(envConfig.callBudget)}`);
  }

  // 只在查询"当前 .env 对应账本"时做一致性对比；--all/--file 是在看历史账本，
  // 与当前 .env 不一致属正常，不该刷警告。
  const hint = !WANT_ALL && !explicitFile && envConfig
    ? { period: envConfig.period, tokenBudget: envConfig.tokenBudget, callBudget: envConfig.callBudget }
    : undefined;

  for (const outcome of outcomes) printReport(outcome, hint);
  console.log('');
}

main();
