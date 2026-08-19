/**
 * FallbackLLMProvider 离线测试。
 *
 * 目的：在不发起任何真实 HTTP 请求、不消耗 token 的前提下，锁死以下不变量：
 *   - none：任何 LLMError 都不 fallback，原样重抛；
 *   - transient：仅 timeout/parse/empty 切 backup；budget/billing/authentication 抛；
 *   - on_error：除 budget/billing/authentication 外都切；这三类抛；
 *   - on_budget：仅 budget 切；其他抛；
 *   - primary 成功时不 emit、不调 backup；
 *   - 每次 fallback 都 emit 一次 provider_fallback，字段完整且 mapReason 正确；
 *   - 非 LLMError 一律不 fallback（编程错误应暴露给上层）；
 *   - backup 也抛错时，异常原样透出，不再兜底。
 *
 * 运行：npm run test:fallback
 */
import * as assert from 'node:assert/strict';
import { ChatMessage } from '../types';
import { EventBus, GameUIEvent } from '../game/EventBus';
import { GameEventOfType } from '../game/GameEvents';
import { FallbackLLMProvider } from './FallbackLLMProvider';
import {
  FallbackStrategy,
  LLMError,
  LLMErrorKind,
  LLMProvider,
  ProviderFallbackEventData,
  readFallbackStrategy,
  readTimeoutMs,
} from './LLMProvider';

interface CaseResult { name: string; ok: boolean; error?: string }
const results: CaseResult[] = [];

async function testCase(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e: any) {
    results.push({ name, ok: false, error: String(e?.stack || e?.message || e) });
  }
}

/** 只抛指定 kind 的 LLMError，或按需返回固定字符串。 */
class ThrowingPrimary implements LLMProvider {
  chatCalls = 0;
  chatJSONCalls = 0;
  constructor(private readonly kind: LLMErrorKind | 'ok', private readonly value: string = 'primary-ok') {}
  async chat(_s: string, _m: ChatMessage[]): Promise<string> {
    this.chatCalls++;
    if (this.kind === 'ok') return this.value;
    throw new LLMError(`primary-${this.kind}`, undefined, this.kind);
  }
  async chatJSON<T>(_s: string, _m: ChatMessage[], _sch: string): Promise<T> {
    this.chatJSONCalls++;
    if (this.kind === 'ok') return { via: 'primary' } as unknown as T;
    throw new LLMError(`primary-${this.kind}`, undefined, this.kind);
  }
}

class MarkerBackup implements LLMProvider {
  chatCalls = 0;
  chatJSONCalls = 0;
  async chat(): Promise<string> { this.chatCalls++; return 'backup-ok'; }
  async chatJSON<T>(): Promise<T> { this.chatJSONCalls++; return { via: 'backup' } as unknown as T; }
}

class ThrowingBackup implements LLMProvider {
  async chat(): Promise<string> { throw new Error('backup-also-broken'); }
  async chatJSON<T>(): Promise<T> { throw new Error('backup-also-broken'); }
}

/** 捕获包装 primary 一次调用期间 emit 的 provider_fallback 事件（按顺序）。 */
function captureFallbackEvents(): { bus: EventBus; events: GameEventOfType<'provider_fallback'>[]; dispose: () => void } {
  const bus = new EventBus();
  const events: GameEventOfType<'provider_fallback'>[] = [];
  const handler = (ev: GameUIEvent) => {
    if (ev.type === 'provider_fallback') events.push(ev);
  };
  const unsubscribe = bus.onAll(handler);
  return {
    bus,
    events,
    dispose: unsubscribe,
  };
}

/** 断言 primary 抛该 kind 时，被指定策略是否会走 fallback。 */
async function assertBehavior(
  strategy: FallbackStrategy,
  kind: LLMErrorKind,
  expectFallback: boolean,
): Promise<void> {
  const primary = new ThrowingPrimary(kind);
  const backup = new MarkerBackup();
  const cap = captureFallbackEvents();
  const provider = new FallbackLLMProvider(primary, backup, strategy, 'test-primary', cap.bus);

  let out: string | null = null;
  let thrown: any = null;
  try {
    out = await provider.chat('sys', [{ role: 'user', content: 'q' }]);
  } catch (e) {
    thrown = e;
  }

  if (expectFallback) {
    assert.equal(out, 'backup-ok', `策略=${strategy} kind=${kind} 应 fallback 到 backup`);
    assert.equal(backup.chatCalls, 1, '应恰好调用 backup 一次');
    assert.equal(cap.events.length, 1, '应恰好 emit 一次 provider_fallback');
    const data = cap.events[0].data as ProviderFallbackEventData;
    assert.equal(data.from, 'test-primary');
    assert.equal(data.to, 'mock');
    assert.equal(data.operation, 'chat');
    assert.equal(data.kind, kind);
    assert.ok(typeof data.at === 'string' && data.at.length > 0, 'at 应为 ISO 字符串');
    // reason 与 kind 的映射：unknown → 'error'，其他保持同名。
    const expectedReason = kind === 'unknown' ? 'error' : kind;
    assert.equal(data.reason, expectedReason, `reason 映射应为 ${expectedReason}`);
  } else {
    assert.equal(out, null, `策略=${strategy} kind=${kind} 不应 fallback`);
    assert.ok(thrown instanceof LLMError, '应原样重抛 LLMError');
    assert.equal((thrown as LLMError).kind, kind);
    assert.equal(backup.chatCalls, 0, '不该调用 backup');
    assert.equal(cap.events.length, 0, '不该 emit 事件');
  }
  cap.dispose();
}

const ALL_KINDS: LLMErrorKind[] = ['timeout', 'parse', 'empty', 'budget', 'billing', 'authentication', 'unknown'];

async function main(): Promise<void> {
  // === 每个策略 × 每个 kind 的行为矩阵 ===
  const TRANSIENT_KINDS = new Set<LLMErrorKind>(['timeout', 'parse', 'empty']);
  const HALT_KINDS = new Set<LLMErrorKind>(['budget', 'billing', 'authentication']);

  for (const kind of ALL_KINDS) {
    await testCase(`none 策略 kind=${kind} 一律不 fallback`, () => assertBehavior('none', kind, false));
    await testCase(`transient 策略 kind=${kind}`, () =>
      assertBehavior('transient', kind, TRANSIENT_KINDS.has(kind)));
    await testCase(`on_error 策略 kind=${kind}`, () =>
      assertBehavior('on_error', kind, !HALT_KINDS.has(kind)));
    await testCase(`on_budget 策略 kind=${kind}`, () =>
      assertBehavior('on_budget', kind, kind === 'budget'));
  }

  // === primary 成功：不 emit、不调 backup ===
  await testCase('primary 成功时不 emit、不调 backup', async () => {
    const primary = new ThrowingPrimary('ok', 'good');
    const backup = new MarkerBackup();
    const cap = captureFallbackEvents();
    const provider = new FallbackLLMProvider(primary, backup, 'on_error', 'p', cap.bus);
    const out = await provider.chat('s', [{ role: 'user', content: 'q' }]);
    assert.equal(out, 'good');
    assert.equal(backup.chatCalls, 0);
    assert.equal(cap.events.length, 0);
    cap.dispose();
  });

  // === chatJSON 也走同一分派路径 ===
  await testCase('chatJSON 走同一分派逻辑，operation=chatJSON', async () => {
    const primary = new ThrowingPrimary('timeout');
    const backup = new MarkerBackup();
    const cap = captureFallbackEvents();
    const provider = new FallbackLLMProvider(primary, backup, 'transient', 'p', cap.bus);
    const out = await provider.chatJSON<any>('s', [{ role: 'user', content: 'q' }], '{}');
    assert.deepEqual(out, { via: 'backup' });
    assert.equal(backup.chatJSONCalls, 1);
    assert.equal(cap.events.length, 1);
    assert.equal(cap.events[0].data.operation, 'chatJSON');
    cap.dispose();
  });

  // === 非 LLMError 一律不 fallback ===
  await testCase('primary 抛非 LLMError 一律不 fallback', async () => {
    class WeirdPrimary implements LLMProvider {
      async chat(_systemPrompt: string, _messages: ChatMessage[]): Promise<string> {
        throw new TypeError('bug');
      }
      async chatJSON<T>(_systemPrompt: string, _messages: ChatMessage[], _jsonSchema: string): Promise<T> {
        throw new TypeError('bug');
      }
    }
    const backup = new MarkerBackup();
    const cap = captureFallbackEvents();
    const provider = new FallbackLLMProvider(new WeirdPrimary(), backup, 'on_error', 'p', cap.bus);
    let thrown: any = null;
    try { await provider.chat('s', []); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof TypeError, '应原样透出 TypeError');
    assert.equal(backup.chatCalls, 0);
    assert.equal(cap.events.length, 0);
    cap.dispose();
  });

  // === backup 也抛错时，异常应原样透出（不能再兜底） ===
  await testCase('backup 抛错时异常原样透出', async () => {
    const primary = new ThrowingPrimary('timeout');
    const backup = new ThrowingBackup();
    const cap = captureFallbackEvents();
    const provider = new FallbackLLMProvider(primary, backup, 'transient', 'p', cap.bus);
    let thrown: any = null;
    try { await provider.chat('s', []); } catch (e) { thrown = e; }
    assert.ok(thrown && thrown.message === 'backup-also-broken');
    // fallback 事件在调 backup 之前已 emit，因此仍应有一条。
    assert.equal(cap.events.length, 1);
    cap.dispose();
  });

  // === 主动取消：绝不 fallback/emit，且 signal 全链透传 ===
  await testCase('预取消不 fallback、不 emit', async () => {
    const controller = new AbortController();
    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    controller.abort(abort);
    const primary = new ThrowingPrimary('timeout');
    const backup = new MarkerBackup();
    const cap = captureFallbackEvents();
    const provider = new FallbackLLMProvider(primary, backup, 'transient', 'p', cap.bus);
    let thrown: any;
    try { await (provider as any).chat('s', [], { signal: controller.signal }); } catch (e) { thrown = e; }
    assert.equal(thrown?.name, 'AbortError');
    assert.equal(backup.chatCalls, 0);
    assert.equal(cap.events.length, 0);
    cap.dispose();
  });

  await testCase('未取消 signal 下 AbortError 形状的 LLMError 仍可 fallback', async () => {
    const sdkAbort = new Error('transport aborted');
    sdkAbort.name = 'AbortError';
    class AbortShapedPrimary implements LLMProvider {
      async chat(): Promise<string> { throw new LLMError('transport aborted', sdkAbort, 'timeout'); }
      async chatJSON<T>(): Promise<T> { throw new LLMError('transport aborted', sdkAbort, 'timeout'); }
    }
    const controller = new AbortController();
    const backup = new MarkerBackup();
    const cap = captureFallbackEvents();
    const provider = new FallbackLLMProvider(new AbortShapedPrimary(), backup, 'transient', 'p', cap.bus);
    assert.equal(await provider.chat('s', [], { signal: controller.signal }), 'backup-ok');
    assert.equal(backup.chatCalls, 1);
    assert.equal(cap.events.length, 1);
    cap.dispose();
  });

  await testCase('fallback 时 backup 收到同一 signal', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    class SignalBackup implements LLMProvider {
      async chat(_s: string, _m: ChatMessage[], options?: { signal?: AbortSignal }): Promise<string> {
        received = options?.signal;
        return 'backup-ok';
      }
      async chatJSON<T>(_s: string, _m: ChatMessage[], _j: string, options?: { signal?: AbortSignal }): Promise<T> {
        received = options?.signal;
        return { via: 'backup' } as T;
      }
    }
    const cap = captureFallbackEvents();
    const provider = new FallbackLLMProvider(new ThrowingPrimary('timeout'), new SignalBackup(), 'transient', 'p', cap.bus);
    const out = await (provider as any).chat('s', [], { signal: controller.signal });
    assert.equal(out, 'backup-ok');
    assert.equal(received, controller.signal);
    assert.equal(cap.events.length, 1);
    cap.dispose();
  });

  // === readFallbackStrategy / readTimeoutMs 的 env 解析 ===
  await testCase('readFallbackStrategy 默认/白名单/非法回退', () => {
    assert.equal(readFallbackStrategy({} as any), 'none');
    assert.equal(readFallbackStrategy({ LLM_FALLBACK_STRATEGY: '' } as any), 'none');
    assert.equal(readFallbackStrategy({ LLM_FALLBACK_STRATEGY: 'None' } as any), 'none');
    assert.equal(readFallbackStrategy({ LLM_FALLBACK_STRATEGY: 'transient' } as any), 'transient');
    assert.equal(readFallbackStrategy({ LLM_FALLBACK_STRATEGY: 'ON_ERROR' } as any), 'on_error');
    assert.equal(readFallbackStrategy({ LLM_FALLBACK_STRATEGY: 'on_budget' } as any), 'on_budget');
    // 非法值应回退到 'none'，不能抛错。
    assert.equal(readFallbackStrategy({ LLM_FALLBACK_STRATEGY: 'bogus' } as any), 'none');
  });

  await testCase('readTimeoutMs 默认/合法/越界回退', () => {
    assert.equal(readTimeoutMs({} as any), 60_000);
    assert.equal(readTimeoutMs({ LLM_TIMEOUT_MS: '' } as any), 60_000);
    assert.equal(readTimeoutMs({ LLM_TIMEOUT_MS: '30000' } as any), 30_000);
    assert.equal(readTimeoutMs({ LLM_TIMEOUT_MS: '600000' } as any), 600_000);
    // 越界 / 非数字 / 负数 → 回退默认。
    assert.equal(readTimeoutMs({ LLM_TIMEOUT_MS: '100' } as any), 60_000);
    assert.equal(readTimeoutMs({ LLM_TIMEOUT_MS: '900000' } as any), 60_000);
    assert.equal(readTimeoutMs({ LLM_TIMEOUT_MS: 'abc' } as any), 60_000);
    assert.equal(readTimeoutMs({ LLM_TIMEOUT_MS: '-1' } as any), 60_000);
  });

  // === 报告 ===
  const failed = results.filter(r => !r.ok);
  const pad = String(results.length).length;
  for (const r of results) {
    const idx = String(results.indexOf(r) + 1).padStart(pad);
    if (r.ok) console.log(`  [${idx}] ✅ ${r.name}`);
    else console.log(`  [${idx}] ❌ ${r.name}\n      ${r.error}`);
  }
  console.log(`\nFallbackLLMProvider: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
