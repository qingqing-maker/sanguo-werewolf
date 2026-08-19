/**
 * retry.ts 的错误分类与重试判定测试（离线，不发任何真实请求）。
 *
 * 重点锁住这次 503 事故的根因：网关返回
 *   503 { error: "authentication backend temporarily unavailable, retry later" }
 * 必须被判定为「可重试的瞬时故障」，而**不能**被判定为认证失败——
 * 否则 circuitBreaker.trip('authentication') 会永久断开，整局后续调用全被拒。
 */
import { LLMError } from './LLMProvider';
import {
  classifyTransportError,
  configuredMaxRetries,
  detectAuthenticationIssue,
  detectBillingIssue,
  isAbortError,
  isRetriableError,
  isTimeoutError,
  withRetry,
} from './retry';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

/** 构造一个近似 SDK APIError 的对象。 */
function apiError(status: number, message: string, headers?: Record<string, string>): any {
  const err: any = new Error(message);
  err.status = status;
  if (headers) err.headers = headers;
  return err;
}

function netError(code: string, message = code): any {
  const err: any = new Error(message);
  err.code = code;
  return err;
}

console.log('\n[本次事故：网关 503 authentication backend temporarily unavailable]');
{
  const err = apiError(503, 'authentication backend temporarily unavailable, retry later');
  check('判定为可重试', isRetriableError(err) === true);
  check('不得判定为认证失败（否则会永久熔断）', detectAuthenticationIssue(err) === null);
  check('不得判定为欠费', detectBillingIssue(err) === null);
  check('分类不是 authentication', classifyTransportError(err) !== 'authentication');
}

console.log('\n[可重试：网关与上游瞬时故障]');
{
  check('500 内部错误', isRetriableError(apiError(500, 'internal server error')));
  check('502 网关错误', isRetriableError(apiError(502, 'bad gateway')));
  check('504 网关超时', isRetriableError(apiError(504, 'gateway timeout')));
  check('529 上游过载', isRetriableError(apiError(529, 'overloaded')));
  check('429 限流', isRetriableError(apiError(429, 'rate limit exceeded, too many requests')));
  check('408 请求超时', isRetriableError(apiError(408, 'request timeout')));
  check('ECONNRESET', isRetriableError(netError('ECONNRESET')));
  check('socket hang up（无状态码）', isRetriableError(new Error('socket hang up')));
  check('fetch failed（无状态码）', isRetriableError(new Error('fetch failed')));
  check('连接超时码', isRetriableError(netError('UND_ERR_CONNECT_TIMEOUT')));
}

console.log('\n[不可重试：重发也不会好]');
{
  check('400 参数错误', isRetriableError(apiError(400, 'invalid request: max_tokens')) === false);
  check('401 认证失败', isRetriableError(apiError(401, 'invalid api key')) === false);
  check('404 模型不存在', isRetriableError(apiError(404, 'model not found')) === false);
  check('402 需付费', isRetriableError(apiError(402, 'payment required')) === false);
  check('预算熔断 LLMError', isRetriableError(new LLMError('budget', undefined, 'budget')) === false);
  check('认证 LLMError', isRetriableError(new LLMError('auth', undefined, 'authentication')) === false);
}

console.log('\n[认证与欠费仍能被正确识别]');
{
  check('401 → 认证失败', detectAuthenticationIssue(apiError(401, 'unauthorized')) !== null);
  check(
    'api key expired 文案 → 认证失败',
    detectAuthenticationIssue(apiError(400, 'API key expired. Please renew')) !== null,
  );
  check('402 → 欠费', detectBillingIssue(apiError(402, 'payment required')) !== null);
  check(
    '403 余额不足 → 欠费',
    detectBillingIssue(apiError(403, 'insufficient balance')) !== null,
  );
  check(
    '429 配额耗尽 → 欠费（该熔断）',
    detectBillingIssue(apiError(429, 'you exceeded your current quota')) !== null,
  );
  check(
    '429 纯限流 → 不算欠费（该重试）',
    detectBillingIssue(apiError(429, 'rate limit reached, too many requests')) === null,
  );
}

console.log('\n[超时识别]');
{
  check('ETIMEDOUT', isTimeoutError(netError('ETIMEDOUT')));
  check('timed out 文案', isTimeoutError(new Error('Request timed out')));
  check('分类为 timeout', classifyTransportError(netError('ETIMEDOUT')) === 'timeout');
  check('普通 500 不算 timeout', classifyTransportError(apiError(500, 'oops')) === 'unknown');
}

async function asyncTests(): Promise<void> {
  console.log('\n[withRetry 行为]');

  {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw apiError(503, 'authentication backend temporarily unavailable, retry later');
      return 'ok';
    }, { label: 'test', baseDelayMs: 1 });
    check('503 抖动两次后成功返回', result === 'ok');
    check('恰好尝试 3 次', calls === 3);
  }

  {
    let calls = 0;
    try {
      await withRetry(async () => {
        calls++;
        throw apiError(400, 'invalid request');
      }, { label: 'test', baseDelayMs: 1 });
      check('400 应立刻抛出', false);
    } catch {
      check('400 不重试，只尝试 1 次', calls === 1);
    }
  }

  {
    let calls = 0;
    try {
      await withRetry(async () => {
        calls++;
        throw apiError(503, 'temporarily unavailable');
      }, { label: 'test', maxRetries: 2, baseDelayMs: 1 });
      check('持续失败应抛出', false);
    } catch {
      check('maxRetries=2 → 共 3 次尝试', calls === 3);
    }
  }

  {
    let calls = 0;
    const started = Date.now();
    try {
      await withRetry(async () => {
        calls++;
        throw apiError(503, 'temporarily unavailable');
      }, { label: 'test', maxRetries: 50, baseDelayMs: 40, totalBudgetMs: 200 });
      check('总时长超限应抛出', false);
    } catch {
      check('总时长上限生效（未跑满 51 次）', calls < 51);
      check('确实在预算附近就停了', Date.now() - started < 2_000);
    }
  }

  {
    let calls = 0;
    const started = Date.now();
    try {
      await withRetry(async () => {
        calls++;
        throw apiError(429, 'rate limit', { 'retry-after': '1' });
      }, { label: 'test', maxRetries: 1, baseDelayMs: 5_000 });
    } catch { /* 预期失败 */ }
    const elapsed = Date.now() - started;
    check('Retry-After 覆盖退避基数（约 1s 而非 5s）', calls === 2 && elapsed < 3_000);
  }

  {
    let calls = 0;
    let clock = Date.parse('2030-01-01T00:00:00Z');
    const delays: number[] = [];
    try {
      await withRetry(async () => {
        calls++;
        throw apiError(503, 'temporarily unavailable', {
          'retry-after': 'Tue, 01 Jan 2030 00:00:02 GMT',
        });
      }, {
        label: 'test',
        maxRetries: 1,
        now: () => clock,
        random: () => 0,
        sleep: async ms => { delays.push(ms); clock += ms; },
      });
    } catch { /* 预期失败 */ }
    check('Retry-After 日期使用注入 now', calls === 2 && delays[0] === 2_000);
  }

  {
    let calls = 0;
    const controller = new AbortController();
    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    controller.abort(abort);
    try {
      await withRetry(async () => { calls++; return 'bad'; }, {
        label: 'test', signal: controller.signal,
      });
      check('预取消应抛出', false);
    } catch (error) {
      check('预取消不执行 attempt', calls === 0);
      check('取消错误可识别', isAbortError(error));
    }
  }

  {
    let calls = 0;
    const controller = new AbortController();
    let sleepSignal: AbortSignal | undefined;
    const abort = new Error('cancelled during sleep');
    abort.name = 'AbortError';
    try {
      await withRetry(async () => {
        calls++;
        throw apiError(503, 'temporarily unavailable');
      }, {
        label: 'test',
        signal: controller.signal,
        maxRetries: 3,
        random: () => 0,
        sleep: async (_ms, signal) => {
          sleepSignal = signal;
          controller.abort(abort);
          throw abort;
        },
      });
      check('sleep 取消应抛出', false);
    } catch (error) {
      check('sleep 收到同一 signal', sleepSignal === controller.signal);
      check('sleep 取消后不再重试', calls === 1 && error === abort);
    }
  }

  {
    let calls = 0;
    const controller = new AbortController();
    const sdkAbort = new Error('request aborted by transport');
    sdkAbort.name = 'AbortError';
    try {
      await withRetry(async () => {
        calls++;
        throw sdkAbort;
      }, {
        label: 'test', signal: controller.signal, maxRetries: 1, random: () => 0,
        sleep: async () => undefined,
      });
      check('未取消的 SDK AbortError 应按 transient 重试', false);
    } catch (error) {
      check('未取消的 SDK AbortError 应按 transient 重试', calls === 2 && error === sdkAbort);
    }
  }

  {
    let calls = 0;
    const controller = new AbortController();
    const sdkAbort = new Error('permanent malformed request');
    sdkAbort.name = 'AbortError';
    try {
      await withRetry(async () => {
        calls++;
        throw sdkAbort;
      }, { label: 'test', signal: controller.signal, maxRetries: 3 });
      check('未取消的终态 SDK AbortError 不伪装人工取消', false);
    } catch (error) {
      check('未取消的终态 SDK AbortError 不伪装人工取消', calls === 1 && error === sdkAbort);
    }
  }

  {
    const controller = new AbortController();
    const reason = new Error('caller cancelled after success');
    try {
      await withRetry(async () => {
        controller.abort(reason);
        return 'late-success';
      }, { label: 'test', signal: controller.signal });
      check('成功 continuation 前取消应拒绝结果', false);
    } catch (error) {
      check('成功 continuation 前取消应拒绝结果', error === reason);
    }
  }

  console.log('\n[配置读取]');
  {
    const saved = process.env.LLM_MAX_RETRIES;
    delete process.env.LLM_MAX_RETRIES;
    check('默认 4 次', configuredMaxRetries() === 4);
    process.env.LLM_MAX_RETRIES = '7';
    check('可由环境变量覆盖', configuredMaxRetries() === 7);
    process.env.LLM_MAX_RETRIES = '999';
    check('上限截断到 10', configuredMaxRetries() === 10);
    process.env.LLM_MAX_RETRIES = '0';
    check('可设为 0（关闭重试）', configuredMaxRetries() === 0);
    process.env.LLM_MAX_RETRIES = 'abc';
    check('非法值回落默认', configuredMaxRetries() === 4);
    if (saved === undefined) delete process.env.LLM_MAX_RETRIES;
    else process.env.LLM_MAX_RETRIES = saved;
  }

  console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
  if (failed > 0) process.exit(1);
}

asyncTests().catch(error => {
  console.error(error);
  process.exit(1);
});
