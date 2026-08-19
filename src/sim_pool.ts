import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  assertProviderConfiguration,
  getConfiguredProviderName,
} from './llm/ProviderFactory';
import { getBudgetLedger } from './llm/BudgetLedger';
import { readFallbackStrategy, readTimeoutMs } from './llm/LLMProvider';
import { collectFingerprint } from './simFingerprint';
import { SimGameResult } from './simMetrics';
import {
  BatchLifecycleDependencies,
  finishBatch,
  initializeBatch,
  parseSimPoolOptions,
  SimPoolOptions,
} from './simPoolCore';
import { wilson95 } from './simReportCore';

const WOLF = 'wolf';
const GOOD = 'good';
type OneResult = SimGameResult;

function dependencies(): BatchLifecycleDependencies {
  return {
    getConfiguredProviderName,
    assertProviderConfiguration,
    inspectBudget: () => getBudgetLedger().inspect(),
    collectFingerprint,
    fallbackStrategy: readFallbackStrategy,
    timeoutMs: readTimeoutMs,
    nowIso: () => new Date().toISOString(),
    ensureDirectory: (directory) => fs.mkdirSync(directory, { recursive: true }),
    writeRecord: (outPath, record) => fs.writeFileSync(outPath, `${JSON.stringify(record)}\n`),
    appendRecord: (outPath, record) => fs.appendFileSync(outPath, `${JSON.stringify(record)}\n`),
  };
}

function appendResult(outPath: string, idx: number, result: OneResult): void {
  fs.appendFileSync(outPath, `${JSON.stringify({ type: 'result', idx, ...result })}\n`);
}

function appendError(outPath: string, idx: number, message: string): void {
  fs.appendFileSync(outPath, `${JSON.stringify({ type: 'error', idx, message })}\n`);
}

/** 每个 worker 跑一局；父进程使用管道收集输出，并完整等待 close。 */
function runWorker(options: SimPoolOptions, idx: number): Promise<OneResult> {
  return new Promise((resolve, reject) => {
    const workerPath = path.resolve(__dirname, '..', 'src', 'sim_worker.ts');
    const tsNodeBin = require.resolve('ts-node/dist/bin.js');
    const args = ['--transpile-only', workerPath];
    if (options.useReal) args.push('--provider=real');
    if (options.wolves !== undefined) args.push(`--wolves=${options.wolves}`);
    if (options.villagers !== undefined) args.push(`--villagers=${options.villagers}`);
    if (options.maxRounds !== undefined) args.push(`--maxRounds=${options.maxRounds}`);
    args.push(`--difficulty=${options.difficulty}`);
    args.push(`--seed=${options.seed + idx}`);

    const child = spawn(process.execPath, [tsNodeBin, ...args], {
      env: { ...process.env },
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      const resultLine = stdout.split('\n').find((line) => line.startsWith('RESULT '));
      if (resultLine) {
        try {
          resolve(JSON.parse(resultLine.slice('RESULT '.length)) as OneResult);
          return;
        } catch { /* 统一走下面的错误路径 */ }
      }
      const errorLine = stdout.split('\n').find((line) => line.startsWith('ERROR '));
      reject(new Error(`worker#${idx} 失败 code=${code} ${errorLine ?? stderr.slice(-200)}`));
    });
    child.on('error', reject);
  });
}

export async function runSimPool(options: SimPoolOptions): Promise<void> {
  const lifecycle = dependencies();
  const { budget: budgetBaseline } = initializeBatch(options, lifecycle);
  console.log(
    `并行模拟：games=${options.games} concurrency=${options.concurrency} ` +
    `provider=${options.useReal ? 'real' : 'mock'}` +
    `${options.wolves !== undefined ? ` wolves=${options.wolves}` : ''}` +
    `${options.maxRounds !== undefined ? ` maxRounds=${options.maxRounds}` : ''}`,
  );
  const startedAt = Date.now();

  let wolfWins = 0;
  let goodWins = 0;
  let errors = 0;
  let done = 0;
  let totalRounds = 0;
  let totalGoodVotes = 0;
  let totalGoodHits = 0;
  const reasons: Record<string, { count: number; wolfWins: number; goodWins: number }> = {};
  let next = 0;
  let budgetRejected = false;

  async function worker(): Promise<void> {
    while (next < options.games && !budgetRejected) {
      const idx = next++;
      try {
        const result = await runWorker(options, idx);
        appendResult(options.outPath, idx, result);
        if (result.winner === WOLF) wolfWins++;
        else if (result.winner === GOOD) goodWins++;
        totalRounds += result.rounds;
        totalGoodVotes += result.goodVotes;
        totalGoodHits += result.goodHits;
        const bucket = (reasons[result.reason] ??= { count: 0, wolfWins: 0, goodWins: 0 });
        bucket.count++;
        if (result.winner === WOLF) bucket.wolfWins++;
        else if (result.winner === GOOD) bucket.goodWins++;
      } catch (error: any) {
        errors++;
        const message = String(error?.message || error);
        appendError(options.outPath, idx, message);
        if (options.useReal && message.includes('LLM_BUDGET_EXHAUSTED')) {
          budgetRejected = true;
          console.log(`  预算已拒绝，停止启动新局：${message}`);
        } else {
          console.log(`  worker 失败：${message}`);
        }
      }
      done++;
      console.log(
        `  进度 ${done}/${options.games}（狼胜${wolfWins}/好胜${goodWins}/错误${errors}） ` +
        `→ ${path.basename(options.outPath)}`,
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.games) }, () => worker()),
  );

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const valid = wolfWins + goodWins;
  const wolfRate = valid > 0 ? wolfWins / valid : 0;
  const goodRate = valid > 0 ? goodWins / valid : 0;
  const [goodLow, goodHigh] = wilson95(goodWins, valid);
  const [wolfLow, wolfHigh] = wilson95(wolfWins, valid);
  const hitRate = totalGoodVotes > 0 ? totalGoodHits / totalGoodVotes : 0;
  const [hitLow, hitHigh] = wilson95(totalGoodHits, totalGoodVotes);

  console.log('\n════════════════════════════════════════');
  console.log('        并行模拟结果');
  console.log('════════════════════════════════════════');
  console.log(`样本：${valid} 局有效（错误 ${errors} 局），耗时 ${seconds}s`);
  console.log('----------------------------------------');
  console.log(`狼人胜：${wolfWins}  胜率=${(wolfRate * 100).toFixed(2)}%  95% CI [${(wolfLow * 100).toFixed(2)}%, ${(wolfHigh * 100).toFixed(2)}%]`);
  console.log(`好人胜：${goodWins}  胜率=${(goodRate * 100).toFixed(2)}%  95% CI [${(goodLow * 100).toFixed(2)}%, ${(goodHigh * 100).toFixed(2)}%]`);
  console.log(`平均回合数：${valid > 0 ? (totalRounds / valid).toFixed(2) : '0'}`);
  console.log('----------------------------------------');
  console.log(`好人逐票读狼命中率：${totalGoodHits}/${totalGoodVotes} = ${(hitRate * 100).toFixed(2)}%  95% CI [${(hitLow * 100).toFixed(2)}%, ${(hitHigh * 100).toFixed(2)}%]`);
  console.log('----------------------------------------');
  console.log('结束原因分类：');
  for (const [reason, stats] of Object.entries(reasons).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  · ${reason}  ${stats.count}局  狼胜${stats.wolfWins}/好胜${stats.goodWins}`);
  }
  console.log('════════════════════════════════════════');
  finishBatch(options, budgetBaseline, done, lifecycle);
  console.log(
    `SUMMARY provider=${options.useReal ? 'real' : 'mock'} games=${valid} ` +
    `good=${(goodRate * 100).toFixed(2)}% goodCI=[${(goodLow * 100).toFixed(2)},${(goodHigh * 100).toFixed(2)}] ` +
    `wolf=${(wolfRate * 100).toFixed(2)}% ` +
    `hitRate=${(hitRate * 100).toFixed(2)}% hitCI=[${(hitLow * 100).toFixed(2)},${(hitHigh * 100).toFixed(2)}]`,
  );
}

async function main(): Promise<void> {
  const dotenv = await import('dotenv');
  dotenv.config();
  const now = new Date();
  const options = parseSimPoolOptions(process.argv.slice(2), {
    projectRoot: path.join(__dirname, '..'),
    nowMs: now.getTime(),
    nowIso: now.toISOString(),
  });
  await runSimPool(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('并行模拟失败:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
