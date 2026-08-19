import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readTTSBudgetConfig, getTTSRuntimeOptions, resetTTSConfiguration } from './TTSFactory';
import { TTSBudgetLedger } from './TTSBudgetLedger';

function main(): void {
  assert.equal(readTTSBudgetConfig({ TTS_PROVIDER: 'edge' }), undefined, 'edge 默认不强制账本');
  assert.throws(() => readTTSBudgetConfig({ TTS_PROVIDER: 'volc' }), /fail closed/);
  assert.throws(() => readTTSBudgetConfig({ TTS_PROVIDER: 'volc', TTS_BUDGET_ENABLED: '0' }), /fail closed/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-config-'));
  try {
    const ledgerPath = path.join(temp, 'budget.jsonl');
    const config = readTTSBudgetConfig({ TTS_PROVIDER: 'volc', TTS_BUDGET_ENABLED: '1',
      TTS_BUDGET_LEDGER_PATH: ledgerPath, TTS_BUDGET_PERIOD: 'test', TTS_CHARACTER_BUDGET: '50', TTS_CALL_BUDGET: '3' });
    assert.equal(config?.ledgerPath, ledgerPath);
    assert.equal(fs.existsSync(ledgerPath), false, '读取配置不能创建账本');

    const options = getTTSRuntimeOptions({ TTS_PROVIDER: 'edge', TTS_MAX_TEXT_CHARACTERS: '12', TTS_CONCURRENCY: '4',
      TTS_QUEUE_LIMIT: '0', TTS_TIMEOUT_MS: '99', TTS_RATE_WINDOW_MS: '100', TTS_SESSION_REQUEST_LIMIT: '2',
      TTS_SESSION_CHARACTER_LIMIT: '20', TTS_IP_REQUEST_LIMIT: '3', TTS_IP_CHARACTER_LIMIT: '30' });
    assert.equal(options.maxTextCharacters, 12);
    assert.equal(options.concurrency, 4);
    assert.equal(options.queueLimit, 0);
    assert.equal(options.timeoutMs, 99);

    const ledger = new TTSBudgetLedger(config!);
    const report = ledger.inspect();
    assert.equal(report.exists, false);
    assert.equal(fs.existsSync(ledgerPath), false, 'inspect 不能创建账本');
    assert.equal(fs.existsSync(`${ledgerPath}.lock`), false, 'inspect 不能创建锁');
  } finally {
    resetTTSConfiguration();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('TTS 配置/只读巡检测试通过');
}

main();
