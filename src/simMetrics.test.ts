import * as assert from 'node:assert/strict';
import { ChatMessage } from './types';
import { LLMError, LLMProvider, LLMRequestOptions } from './llm/LLMProvider';
import { makeLLMRequestMetrics, MetricsLLMProvider } from './simMetrics';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error: any) {
    failed++;
    process.stdout.write(`  ✗ ${name}\n      ${String(error?.message || error).split('\n')[0]}\n`);
  }
}

class StubProvider implements LLMProvider {
  constructor(
    private readonly chatImpl: (options?: LLMRequestOptions) => Promise<string>,
    private readonly jsonImpl: (options?: LLMRequestOptions) => Promise<unknown>,
  ) {}

  chat(_system: string, _messages: ChatMessage[], options?: LLMRequestOptions): Promise<string> {
    return this.chatImpl(options);
  }

  chatJSON<T>(
    _system: string,
    _messages: ChatMessage[],
    _schema: string,
    options?: LLMRequestOptions,
  ): Promise<T> {
    return this.jsonImpl(options) as Promise<T>;
  }
}

async function main(): Promise<void> {
  console.log('\n=== MetricsLLMProvider 离线测试 ===\n');

  await check('chat/chatJSON 成功时按逻辑调用各计一次并透明返回', async () => {
    const metrics = makeLLMRequestMetrics();
    const provider = new MetricsLLMProvider(
      new StubProvider(async () => 'ok', async () => ({ targetId: 'p1' })),
      metrics,
    );
    assert.equal(await provider.chat('s', []), 'ok');
    assert.deepEqual(await provider.chatJSON('s', [], '{}'), { targetId: 'p1' });
    assert.deepEqual(metrics, {
      total: 2, chat: 1, chatJSON: 1, succeeded: 2, failed: 0, cancelled: 0, errors: {},
    });
  });

  await check('终态 LLMError 按 kind 计 failed 并原样抛出', async () => {
    const expected = new LLMError('坏 JSON', undefined, 'parse');
    const metrics = makeLLMRequestMetrics();
    const provider = new MetricsLLMProvider(
      new StubProvider(async () => { throw expected; }, async () => ({})),
      metrics,
    );
    await assert.rejects(() => provider.chat('s', []), (error) => error === expected);
    assert.equal(metrics.failed, 1);
    assert.equal(metrics.cancelled, 0);
    assert.deepEqual(metrics.errors, { parse: 1 });
  });

  await check('只有请求 signal.aborted 才计主动取消，SDK AbortError 本身仍算失败', async () => {
    const sdkAbort = new Error('sdk aborted');
    sdkAbort.name = 'AbortError';
    const failedMetrics = makeLLMRequestMetrics();
    const failedProvider = new MetricsLLMProvider(
      new StubProvider(async () => { throw sdkAbort; }, async () => ({})),
      failedMetrics,
    );
    await assert.rejects(() => failedProvider.chat('s', []), (error) => error === sdkAbort);
    assert.equal(failedMetrics.failed, 1);
    assert.equal(failedMetrics.cancelled, 0);
    assert.deepEqual(failedMetrics.errors, { unknown: 1 });

    const controller = new AbortController();
    const cancellation = new Error('caller cancelled');
    cancellation.name = 'AbortError';
    const cancelledMetrics = makeLLMRequestMetrics();
    const cancelledProvider = new MetricsLLMProvider(
      new StubProvider(async () => {
        controller.abort();
        throw cancellation;
      }, async () => ({})),
      cancelledMetrics,
    );
    await assert.rejects(
      () => cancelledProvider.chat('s', [], { signal: controller.signal }),
      (error) => error === cancellation,
    );
    assert.equal(cancelledMetrics.cancelled, 1);
    assert.equal(cancelledMetrics.failed, 0);
    assert.deepEqual(cancelledMetrics.errors, {});
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
}

main();
