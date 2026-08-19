import * as assert from 'node:assert/strict';
import { AnthropicProvider } from './AnthropicProvider';
import { GeminiProvider } from './GeminiProvider';
import { LLMError } from './LLMProvider';
import { OpenAIProvider } from './OpenAIProvider';

const reservation = {} as any;
const ledger = { snapshot: () => ({}) } as any;
const messages = [{ role: 'user' as const, content: 'hello' }];

function basicBreaker(overrides: Record<string, unknown> = {}): any {
  return {
    reserve: () => reservation,
    settle: () => undefined,
    settleFailure: () => undefined,
    trip: () => undefined,
    ...overrides,
  };
}

function sdkAbort(message = 'bad request'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function main(): Promise<void> {
  const saved = { ...process.env };
  process.env.LLM_API_KEY = 'offline-test';
  process.env.ANTHROPIC_API_KEY = 'offline-test';
  process.env.GEMINI_API_KEY = 'offline-test';
  process.env.LLM_MAX_RETRIES = '0';
  process.env.LLM_TIMEOUT_MS = '12345';
  process.env.LLM_API_STYLE = 'chat_completions';

  try {
    const signal = new AbortController().signal;

    const openai = new OpenAIProvider(basicBreaker(), ledger) as any;
    let openAIOptions: any;
    openai.client = { chat: { completions: { create: async (_body: any, options: any) => {
      openAIOptions = options;
      return { choices: [{ message: { content: 'ok' } }], usage: {} };
    } } } };
    assert.equal(await openai.chat('system', messages, { signal }), 'ok');
    assert.equal(openAIOptions.signal, signal, 'OpenAI SDK 请求应收到 signal');

    process.env.LLM_API_STYLE = 'responses';
    process.env.LLM_BASE_URL = 'https://ark.example/api/v3/';
    process.env.LLM_MODEL_ID = 'doubao-test';
    let responsesUrl = '';
    let responsesRequest: any;
    let responsesUsage: unknown;
    const responses = new OpenAIProvider(basicBreaker({
      settle: (_reservation: unknown, usage: unknown) => { responsesUsage = usage; },
    }), ledger) as any;
    responses.fetchImpl = async (url: string, request: any) => {
      responsesUrl = url;
      responsesRequest = request;
      return new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses ok' }] }],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    assert.equal(await responses.chat('system', messages, { signal }), 'responses ok');
    assert.equal(responsesUrl, 'https://ark.example/api/v3/responses');
    const responsesBody = JSON.parse(responsesRequest.body);
    assert.equal(responsesBody.model, 'doubao-test');
    assert.equal(responsesBody.input[0].role, 'system');
    assert.equal(responsesBody.input[0].content[0].type, 'input_text');
    assert.equal(responsesBody.input[1].content[0].text, 'hello');
    assert.deepEqual(responsesUsage, { input_tokens: 12, output_tokens: 3, total_tokens: 15 });
    process.env.LLM_API_STYLE = 'chat_completions';

    const anthropic = new AnthropicProvider(basicBreaker(), ledger) as any;
    let anthropicOptions: any;
    anthropic.client = { messages: { create: async (_body: any, options: any) => {
      anthropicOptions = options;
      return { content: [{ type: 'text', text: 'ok' }], usage: {} };
    } } };
    assert.equal(await anthropic.chat('system', messages, { signal }), 'ok');
    assert.equal(anthropicOptions.signal, signal, 'Anthropic SDK 请求应收到 signal');

    const gemini = new GeminiProvider(basicBreaker(), ledger) as any;
    let geminiRequest: any;
    gemini.client = { models: { generateContent: async (request: any) => {
      geminiRequest = request;
      return { text: 'ok', usageMetadata: {} };
    } } };
    assert.equal(await gemini.chat('system', messages, { signal }), 'ok');
    assert.equal(geminiRequest.config.abortSignal, signal, 'Gemini config 应收到 abortSignal');
    assert.equal(geminiRequest.config.httpOptions.timeout, 12345, 'Gemini config 应收到统一 timeout');

    // signal 未取消时，SDK 自己抛 AbortError 只是普通终态错误，必须包装分类而非冒充人工取消。
    for (const [name, provider, installFailure] of [
      ['OpenAI', new OpenAIProvider(basicBreaker(), ledger) as any, (p: any, error: Error) => {
        p.client = { chat: { completions: { create: async () => { throw error; } } } };
      }],
      ['Anthropic', new AnthropicProvider(basicBreaker(), ledger) as any, (p: any, error: Error) => {
        p.client = { messages: { create: async () => { throw error; } } };
      }],
      ['Gemini', new GeminiProvider(basicBreaker(), ledger) as any, (p: any, error: Error) => {
        p.client = { models: { generateContent: async () => { throw error; } } };
      }],
    ] as const) {
      const raw = sdkAbort();
      installFailure(provider, raw);
      await assert.rejects(
        provider.chat('system', messages, { signal: new AbortController().signal }),
        (error: any) => error instanceof LLMError && error.cause === raw && error.name === 'LLMError',
        `${name}: 未取消的 SDK AbortError 应走普通终态包装`,
      );
    }

    // 成功响应先 settle，再发现调用方取消；同一 reservation 不得二次 settleFailure。
    for (const [name, createProvider, installSuccess] of [
      ['OpenAI', (b: any) => new OpenAIProvider(b, ledger) as any, (p: any) => {
        p.client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) } } };
      }],
      ['Anthropic', (b: any) => new AnthropicProvider(b, ledger) as any, (p: any) => {
        p.client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }) } };
      }],
      ['Gemini', (b: any) => new GeminiProvider(b, ledger) as any, (p: any) => {
        p.client = { models: { generateContent: async () => ({ text: 'ok', usageMetadata: {} }) } };
      }],
    ] as const) {
      const controller = new AbortController();
      const reason = new Error(`${name} cancelled after settle`);
      let settles = 0;
      let failureSettles = 0;
      const provider = createProvider(basicBreaker({
        settle: () => { settles++; controller.abort(reason); },
        settleFailure: () => { failureSettles++; },
      }));
      installSuccess(provider);
      await assert.rejects(provider.chat('system', messages, { signal: controller.signal }), error => error === reason);
      assert.equal(settles, 1, `${name}: 成功响应应 settle 一次`);
      assert.equal(failureSettles, 0, `${name}: settle 后取消不得二次 settleFailure`);
    }

    // 请求失败时即便 settleFailure 自己抛错，已取消 signal 仍是最终传播结果。
    for (const [name, createProvider, installFailure] of [
      ['OpenAI', (b: any) => new OpenAIProvider(b, ledger) as any, (p: any) => {
        p.client = { chat: { completions: { create: async () => { throw new Error('network failed'); } } } };
      }],
      ['Anthropic', (b: any) => new AnthropicProvider(b, ledger) as any, (p: any) => {
        p.client = { messages: { create: async () => { throw new Error('network failed'); } } };
      }],
      ['Gemini', (b: any) => new GeminiProvider(b, ledger) as any, (p: any) => {
        p.client = { models: { generateContent: async () => { throw new Error('network failed'); } } };
      }],
    ] as const) {
      const controller = new AbortController();
      const reason = new Error(`${name} caller cancelled`);
      let failureSettles = 0;
      const provider = createProvider(basicBreaker({
        settleFailure: () => {
          failureSettles++;
          controller.abort(reason);
          throw new Error('ledger settle failed');
        },
      }));
      installFailure(provider);
      await assert.rejects(provider.chat('system', messages, { signal: controller.signal }), error => error === reason);
      assert.equal(failureSettles, 1, `${name}: 失败 reservation 仍应尝试 settle`);
    }

    // parse error 到 correction 之间取消时，不得记录并发起第二次模型调用。
    for (const [name, provider] of [
      ['OpenAI', new OpenAIProvider(basicBreaker(), ledger) as any],
      ['Anthropic', new AnthropicProvider(basicBreaker(), ledger) as any],
    ] as const) {
      const controller = new AbortController();
      const reason = new Error(`${name} cancelled before correction`);
      let attempts = 0;
      provider.attemptJSON = async () => {
        attempts++;
        controller.abort(reason);
        throw new LLMError('bad json', undefined, 'parse');
      };
      await assert.rejects(
        provider.chatJSON('system', messages, '{}', { signal: controller.signal }),
        error => error === reason,
      );
      assert.equal(attempts, 1, `${name}: 取消后不得发起 correction`);
    }

    console.log('Provider signal/cancellation offline regressions passed');
  } finally {
    process.env = saved;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
