import * as dotenv from 'dotenv';
dotenv.config();

import * as path from 'node:path';
import { TTSBudgetLedger } from './tts/TTSBudgetLedger';
import { readTTSBudgetConfig } from './tts/TTSFactory';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function main(): void {
  const explicit = argument('file');
  let ledger: TTSBudgetLedger;
  if (explicit) {
    ledger = new TTSBudgetLedger({ ledgerPath: path.resolve(explicit), period: 'inspect', characterBudget: 1, callBudget: 1 });
  } else {
    const config = readTTSBudgetConfig();
    if (!config) throw new Error('TTS 预算账本未启用；请用 --file=<path> 查询指定账本');
    ledger = new TTSBudgetLedger(config);
  }
  const report = ledger.inspect(!explicit);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('TTS 预算状态（只读，不创建账本或锁）');
  console.log(`账本: ${report.ledgerPath}`);
  console.log(`存在: ${report.exists ? '是' : '否'}  锁文件: ${report.lockPresent ? '存在' : '无'}`);
  if (!report.snapshot) return;
  const s = report.snapshot;
  console.log(`周期: ${s.period}`);
  console.log(`字符: committed=${s.committedCharacters} / ${s.characterBudget}, remaining=${report.remainingCharacters}`);
  console.log(`调用: calls=${s.calls} / ${s.callBudget}, remaining=${report.remainingCalls}`);
  console.log(`悬挂 reservation: ${s.activeReservations}（${s.reservedCharacters} 字符）`);
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
