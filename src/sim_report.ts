import * as fs from 'fs';
import * as path from 'path';
import { diffFingerprints, formatFingerprint } from './simFingerprint';
import { analyzeSimJsonl, SimAggregateReport } from './simReportCore';

/**
 * 独立报告脚本：从 sim_pool.ts 生成的 JSONL 文件重算完整报告。
 * 统计与解析在 simReportCore.ts 中保持纯函数；本文件只负责文件 I/O 和终端格式化。
 */

function pickLatestFile(): string | null {
  const dir = path.join(__dirname, '..', 'runs');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'));
  if (files.length === 0) return null;
  return files
    .map((file) => {
      const full = path.join(dir, file);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)[0].full;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function formatCounter(counter: Record<string, number>): string {
  const parts = Object.entries(counter)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}=${count}`);
  return parts.length > 0 ? parts.join('  ') : '（无）';
}

function printBudget(report: SimAggregateReport): void {
  console.log('预算账本：');
  if (!report.budget) {
    console.log('  （旧文件未记录）');
    return;
  }
  if (report.budget.applicability === 'not_applicable') {
    console.log('  不适用（Mock 批次未读取真实账本）');
    return;
  }
  const budget = report.budget;
  console.log(
    `  ledger=${budget.ledgerId}  period=${budget.period}  ` +
    `tokenBudget=${budget.tokenBudget}  callBudget=${budget.callBudget}`,
  );
  if (!budget.end || !budget.delta) {
    console.log('  批次尚无结束快照（可能中途退出）；仅记录 baseline。');
    return;
  }
  console.log(
    `  账本差值：calls=${budget.delta.calls}  settledTokens=${budget.delta.settledTokens}  ` +
    `reservedTokens=${budget.delta.reservedTokens}  committedTokens=${budget.delta.committedTokens}`,
  );
  console.log(
    `  activeReservations：${budget.baseline.activeReservations} → ${budget.end.activeReservations}`,
  );
  console.log('  注：这是共享本地账本差值，不是云厂商账单；同账本的其他进程调用也可能计入。');
}

interface FileReport {
  file: string;
  report: SimAggregateReport;
}

export function analyzeFile(file: string): FileReport {
  console.log(`读取：${file}\n`);
  const report = analyzeSimJsonl(fs.readFileSync(file, 'utf8'));
  const meta = report.meta;

  console.log('════════════════════════════════════════');
  console.log('     JSONL 数据报告');
  console.log('════════════════════════════════════════');
  if (meta) {
    console.log(
      `provider=${meta.provider}  target=${meta.games} 局  concurrency=${meta.concurrency}` +
      `${meta.wolves !== undefined ? `  wolves=${meta.wolves}` : ''}` +
      `${meta.maxRounds !== undefined ? `  maxRounds=${meta.maxRounds}` : ''}` +
      `  startedAt=${meta.startedAt}`,
    );
    console.log('----------------------------------------');
    for (const line of formatFingerprint(meta.fingerprint)) console.log(line);
  }

  console.log(
    `已完成：${report.valid} 局有效（worker 错误 ${report.errors} 局，` +
    `损坏 JSON ${report.malformedLines} 行，忽略 ${report.ignoredRecords} 条）`,
  );
  console.log('----------------------------------------');
  console.log(
    `狼人胜：${report.wolfWins}  胜率=${pct(report.wolfRate)}  ` +
    `95% CI [${pct(report.wolfCI[0])}, ${pct(report.wolfCI[1])}]`,
  );
  console.log(
    `好人胜：${report.goodWins}  胜率=${pct(report.goodRate)}  ` +
    `95% CI [${pct(report.goodCI[0])}, ${pct(report.goodCI[1])}]`,
  );
  console.log(`平均回合数：${report.averageRounds.toFixed(2)}`);
  console.log(
    `好人逐票读狼命中率：${report.goodHits}/${report.goodVotes} = ${pct(report.hitRate)}  ` +
    `95% CI [${pct(report.hitCI[0])}, ${pct(report.hitCI[1])}]`,
  );
  console.log('----------------------------------------');

  console.log('逻辑 LLM 请求（不含 Provider 内部 HTTP retry attempt）：');
  if (!report.llmRequests) {
    console.log('  （旧文件未记录，fallback/degrade 比率不可计算）');
  } else {
    const requests = report.llmRequests;
    console.log(
      `  total=${requests.total}  chat=${requests.chat}  chatJSON=${requests.chatJSON}  ` +
      `success=${requests.succeeded}  failed=${requests.failed}  cancelled=${requests.cancelled}`,
    );
    console.log(`  最终错误：${formatCounter(requests.errors)}`);
  }

  console.log('Fallback / 决策降级：');
  console.log(
    `  策略=${meta?.fallbackStrategy ?? meta?.fingerprint?.fallback?.strategy ?? '(未记)'}  ` +
    `timeoutMs=${meta?.llmTimeoutMs ?? meta?.fingerprint?.fallback?.timeoutMs ?? '(未记)'}`,
  );
  console.log(
    `  effectiveProvider：real ${report.effectiveProvider.real} / ` +
    `mixed ${report.effectiveProvider.mixed} / mock ${report.effectiveProvider.mock}`,
  );
  console.log(
    `  provider_fallback attempts=${report.fallback.total}  ` +
    `逻辑请求占比=${report.fallback.rate === null ? '未记录' : pct(report.fallback.rate)}`,
  );
  console.log(`    reason：${formatCounter(report.fallback.byReason)}`);
  console.log(`    operation：${formatCounter(report.fallback.byOperation)}`);
  console.log(
    `  ai_decision_degraded=${report.degrade.total}  ` +
    `逻辑请求占比=${report.degrade.rate === null ? '未记录' : pct(report.degrade.rate)}`,
  );
  console.log(`    kind：${formatCounter(report.degrade.byKind)}`);
  console.log(`    operation：${formatCounter(report.degrade.byOperation)}`);
  if (report.cleanReal.valid > 0) {
    console.log(
      `  严格干净 real 好人胜率（无 Mock fallback、无决策降级、无最终请求失败，n=${report.cleanReal.valid}）：` +
      `${pct(report.cleanReal.goodRate)}  95% CI [${pct(report.cleanReal.goodCI[0])}, ${pct(report.cleanReal.goodCI[1])}]`,
    );
  } else {
    console.log('  严格干净 real：无可确认样本（旧文件缺请求指标时不会误算为干净）。');
  }

  console.log('----------------------------------------');
  console.log('首夜最终狼刀目标（不同于最终实际死亡）：');
  if (report.firstNightTargets.recordedGames === 0) {
    console.log('  （旧文件未记录）');
  } else {
    const total = report.firstNightTargets.recordedGames;
    console.log('  按人物：');
    for (const target of report.firstNightTargets.byName) {
      console.log(`    · ${target.name}  ${target.count}/${total} = ${pct(target.rate)}`);
    }
    console.log('  按角色：');
    for (const target of report.firstNightTargets.byRole) {
      console.log(`    · ${target.roleType}  ${target.count}/${total} = ${pct(target.rate)}`);
    }
    console.log('  按座位（用于发现 player_N 位置偏置）：');
    for (const target of report.firstNightTargets.bySeat) {
      console.log(`    · ${target.playerId}  ${target.count}/${total} = ${pct(target.rate)}`);
    }
    console.log('  按阵营：');
    for (const target of report.firstNightTargets.byFaction) {
      console.log(`    · ${target.faction}  ${target.count}/${total} = ${pct(target.rate)}`);
    }
  }

  console.log('----------------------------------------');
  printBudget(report);
  console.log('----------------------------------------');
  console.log('结束原因分类：');
  for (const [reason, stats] of Object.entries(report.reasons).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  · ${reason}  ${stats.count}局  狼胜${stats.wolfWins}/好胜${stats.goodWins}`);
  }
  if (report.errorMessages.length > 0) {
    console.log(`错误明细（${report.errorMessages.length} 条，仅显示前 3 条）：`);
    for (const message of report.errorMessages.slice(0, 3)) console.log(`  · ${message.slice(0, 200)}`);
  }
  console.log('════════════════════════════════════════');
  console.log(
    `SUMMARY provider=${meta?.provider ?? '?'} games=${report.valid} ` +
    `good=${pct(report.goodRate)} wolf=${pct(report.wolfRate)} hitRate=${pct(report.hitRate)} ` +
    `fallback=${report.fallback.total} degrade=${report.degrade.total} ` +
    `cleanReal=${report.cleanReal.valid}`,
  );

  return { file, report };
}

function main(): void {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const files = args.length > 0 ? args : [pickLatestFile()].filter((file): file is string => !!file);
  if (files.length === 0) {
    console.error('没有找到 JSONL 文件。请指定路径，或先跑 sim_pool.ts 生成 runs/*.jsonl。');
    process.exit(1);
  }
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`文件不存在: ${file}`);
      process.exit(1);
    }
  }

  const reports = files.map(analyzeFile);
  if (reports.length < 2) return;

  console.log('\n════════════════════════════════════════');
  console.log('        多批次对比');
  console.log('════════════════════════════════════════');
  for (const item of reports) {
    const report = item.report;
    console.log(
      `${path.basename(item.file)}  有效${report.valid}局  好人胜率=${pct(report.goodRate)}  ` +
      `读狼命中=${pct(report.hitRate)}  难度=${report.meta?.fingerprint?.aiDifficulty ?? '?'}`,
    );
  }
  console.log('----------------------------------------');
  const base = reports[0];
  for (const other of reports.slice(1)) {
    const diffs = diffFingerprints(base.report.meta?.fingerprint, other.report.meta?.fingerprint);
    const label = `${path.basename(base.file)} vs ${path.basename(other.file)}`;
    if (diffs.length === 0) {
      console.log(`${label}：配置指纹完全一致 ✅ 两批数据可直接比较。`);
    } else {
      console.log(`${label}：配置存在 ${diffs.length} 处差异 ——`);
      for (const diff of diffs) console.log(`  · ${diff}`);
      console.log('  ⚠️ 只有当差异正是要验证的变量时，胜率对比才有意义。');
    }
  }
  console.log('════════════════════════════════════════');
}

if (require.main === module) main();
