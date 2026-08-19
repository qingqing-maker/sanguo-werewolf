import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ITTSProvider, TTSResult, TTSServiceError } from './TTSProvider';
import { TTSBudgetError, TTSBudgetLedger } from './TTSBudgetLedger';
import { TTSService } from './TTSService';

class FakeProvider implements ITTSProvider {
  readonly name = 'fake';
  calls = 0;
  active = 0;
  maxActive = 0;
  configured = true;
  quota = false;
  constructor(private readonly behavior: (signal?: AbortSignal) => Promise<void> = async () => {}) {}
  isConfigured() { return this.configured; }
  isAvailable() { return this.configured && !this.quota; }
  isQuotaExhausted() { return this.quota; }
  getQuotaReason() { return this.quota ? 'secret upstream detail' : ''; }
  resetQuota() { this.quota = false; }
  async synthesize(_text: string, _player: string, options?: { signal?: AbortSignal }): Promise<TTSResult> {
    this.calls++; this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    try { await this.behavior(options?.signal); return { audio: Buffer.from('offline'), durationMs: 1 }; }
    finally { this.active--; }
  }
}

function reason(error: unknown): string | undefined { return error instanceof TTSServiceError ? error.reason : undefined; }
async function expectReason(promise: Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(promise, error => reason(error) === expected);
}
async function deferred(): Promise<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function main(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-core-'));
  try {
    const ledgerPath = (name: string) => path.join(temp, `${name}.jsonl`);
    const ledger = (name: string, characters = 20, calls = 2, lockTimeoutMs = 50) => new TTSBudgetLedger({ ledgerPath: ledgerPath(name), period: 'offline', characterBudget: characters, callBudget: calls, lockTimeoutMs });

    console.log('=== TTS 核心纯离线测试 ===');

    const unicodeProvider = new FakeProvider();
    const unicodeService = new TTSService({ provider: unicodeProvider, maxTextCharacters: 2 });
    await unicodeService.synthesize({ sessionId: 's', ip: 'i', text: '😀中' });
    await expectReason(unicodeService.synthesize({ sessionId: 's2', ip: 'i2', text: '😀中文' }), 'invalid_message');
    assert.equal(unicodeProvider.calls, 1, '按 Unicode code point 而非 UTF-16 code unit 计数');

    let now = 1_000;
    const rateService = new TTSService({ provider: new FakeProvider(), now: () => now, windowMs: 100,
      sessionRequestLimit: 2, sessionCharacterLimit: 3, ipRequestLimit: 2, ipCharacterLimit: 4 });
    await rateService.synthesize({ sessionId: 'a', ip: 'x', text: 'ab' });
    const rateError = await rateService.synthesize({ sessionId: 'a', ip: 'x', text: 'cd' }).catch(e => e);
    assert.equal(reason(rateError), 'tts_rate_limited'); assert.equal(rateError.retryAfterSeconds, 1);
    now += 101;
    await rateService.synthesize({ sessionId: 'a', ip: 'x', text: 'cd' });
    await expectReason(rateService.synthesize({ sessionId: 'b', ip: 'x', text: 'abc' }), 'tts_rate_limited');

    const gate = await deferred();
    const concurrentProvider = new FakeProvider(() => gate.promise);
    const concurrentService = new TTSService({ provider: concurrentProvider, concurrency: 1, queueLimit: 1 });
    const first = concurrentService.synthesize({ sessionId: '1', ip: '1', text: 'a' });
    const second = concurrentService.synthesize({ sessionId: '2', ip: '2', text: 'b' });
    await expectReason(concurrentService.synthesize({ sessionId: '3', ip: '3', text: 'c' }), 'tts_concurrency_limited');
    gate.resolve(); await Promise.all([first, second]);
    assert.equal(concurrentProvider.maxActive, 1);

    const timeoutProvider = new FakeProvider(signal => new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    const timeoutService = new TTSService({ provider: timeoutProvider, timeoutMs: 10 });
    await expectReason(timeoutService.synthesize({ sessionId: 't', ip: 't', text: 'timeout' }), 'tts_timeout');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(timeoutProvider.active, 0, 'timeout 必须 abort 并清理 provider 调用');

    const budget = ledger('budget', 5, 2);
    const budgetProvider = new FakeProvider(async () => { throw new Error('offline failure'); });
    const budgetService = new TTSService({ provider: budgetProvider, ledger: budget });
    await expectReason(budgetService.synthesize({ sessionId: 'b1', ip: 'b1', text: 'abc' }), 'tts_provider_unavailable');
    assert.equal(budget.snapshot().settledCharacters, 3, '失败调用也保守 settle');
    await expectReason(budgetService.synthesize({ sessionId: 'b2', ip: 'b2', text: 'xyz' }), 'tts_budget_exhausted');
    assert.equal(budgetProvider.calls, 1, '预算不足时不得调用 provider');

    const dual = ledger('dual', 100, 1);
    dual.settle(dual.reserve(1));
    assert.throws(() => dual.reserve(1), TTSBudgetError, 'calls 上限独立生效');
    const hanging = ledger('hanging', 5, 3); hanging.reserve(4);
    assert.throws(() => hanging.reserve(2), TTSBudgetError, '悬挂 reservation 占 characters');

    const corrupt = ledger('corrupt'); fs.writeFileSync(corrupt.ledgerPath, '{bad', 'utf8');
    assert.throws(() => corrupt.snapshot(), TTSBudgetError, '损坏 JSONL fail closed');
    const locked = ledger('locked'); fs.writeFileSync(locked.lockPath, 'orphan', 'utf8');
    assert.throws(() => locked.snapshot(), TTSBudgetError, '遗留 O_EXCL 锁 fail closed');

    const unavailable = new FakeProvider(); unavailable.configured = false;
    await expectReason(new TTSService({ provider: unavailable }).synthesize({ sessionId: 'u', ip: 'u', text: 'x' }), 'tts_provider_unavailable');
    const quota = new FakeProvider(); quota.quota = true;
    const quotaError = await new TTSService({ provider: quota }).synthesize({ sessionId: 'q', ip: 'q', text: 'x' }).catch(e => e);
    assert.equal(reason(quotaError), 'tts_quota_exhausted');
    assert.equal(String(quotaError.message).includes('secret upstream detail'), false, '稳定错误不泄露上游 quotaReason');

    console.log('TTS 核心测试全部通过（未调用真实 TTS）');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
