import { AnthropicProvider } from './AnthropicProvider';
import { FallbackLLMProvider } from './FallbackLLMProvider';
import { GeminiProvider } from './GeminiProvider';
import { BudgetLedger, getBudgetLedger } from './BudgetLedger';
import { FALLBACK_STRATEGIES, LLMProvider, readFallbackStrategy } from './LLMProvider';
import { MockProvider } from './MockProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { MathRandomSource, RandomSource } from '../random';
import { EventPublisher, globalEventBus } from '../game/EventBus';
import { LLMCircuitBreaker } from './LLMCircuitBreaker';

export function getConfiguredProviderName(): string {
  return (process.env.LLM_PROVIDER || 'mock').trim().toLowerCase();
}

export function assertProviderConfiguration(
  provider = getConfiguredProviderName(),
  requireReal = false,
  ledger?: BudgetLedger,
): void {
  const normalized = provider.trim().toLowerCase();
  if (requireReal && normalized === 'mock') {
    throw new Error('--provider=real 需要将 LLM_PROVIDER 配置为真实 Provider');
  }

  // Fallback 策略在这里做白名单校验：即便 provider=mock 也允许配（无副作用，方便切换）。
  const rawStrategy = (process.env.LLM_FALLBACK_STRATEGY || '').trim().toLowerCase();
  if (rawStrategy && !(FALLBACK_STRATEGIES as readonly string[]).includes(rawStrategy)) {
    throw new Error(`不支持的 LLM_FALLBACK_STRATEGY: ${rawStrategy}（合法值：${FALLBACK_STRATEGIES.join(' / ')}）`);
  }

  if (normalized === 'mock') return;

  const supported = ['openai', 'siliconflow', 'deepseek', 'volcengine', 'anthropic', 'claude', 'gemini'];
  if (!supported.includes(normalized)) throw new Error(`不支持的 LLM_PROVIDER: ${provider}`);

  // 读取账本也会校验固定 100000 token、调用上限、路径、周期以及账本完整性。
  (ledger ?? getBudgetLedger()).snapshot();

  if (['openai', 'siliconflow', 'deepseek', 'volcengine'].includes(normalized)) {
    if (!process.env.LLM_API_KEY && !process.env.OPENAI_API_KEY) {
      throw new Error('未配置 API Key (LLM_API_KEY 或 OPENAI_API_KEY)');
    }
  } else if (normalized === 'anthropic' || normalized === 'claude') {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.LLM_API_KEY) {
      throw new Error('未配置 API Key (LLM_API_KEY 或 ANTHROPIC_API_KEY)');
    }
  } else if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY 未配置');
  }
}

/**
 * 构造裸的真实 Provider（不含 fallback 包装）。
 * 提取出来是为了让 createLLMProvider 里"包装/不包装"两条路径共用同一构造逻辑，
 * 也让 fallback 策略下 primary 的 console.log 只打一次。
 */
function buildPrimary(
  normalized: string,
  breaker: LLMCircuitBreaker,
  ledger: BudgetLedger,
): LLMProvider {
  switch (normalized) {
    case 'openai':
    case 'siliconflow':
    case 'deepseek':
    case 'volcengine':
      console.log(`[LLM] 使用 ${normalized} (模型: ${process.env.LLM_MODEL_ID || 'gpt-4o-mini'})`);
      return new OpenAIProvider(breaker, ledger);
    case 'anthropic':
    case 'claude':
      console.log(`[LLM] 使用 Anthropic (模型: ${process.env.LLM_MODEL_ID || 'claude-3-5-sonnet-latest'})`);
      return new AnthropicProvider(breaker, ledger);
    case 'gemini':
      console.log(`[LLM] 使用 Gemini (模型: ${process.env.GEMINI_MODEL || 'gemini-2.5-flash'})`);
      return new GeminiProvider(breaker, ledger);
    default:
      throw new Error(`不支持的 LLM_PROVIDER: ${normalized}`);
  }
}

export interface ProviderFactoryOptions {
  random?: RandomSource;
  eventBus?: EventPublisher;
  ledger?: BudgetLedger;
  breaker?: LLMCircuitBreaker;
}

export function createLLMProvider(
  provider = getConfiguredProviderName(),
  requireReal = false,
  options: ProviderFactoryOptions = {},
): LLMProvider {
  const random = options.random ?? new MathRandomSource();
  const eventBus = options.eventBus ?? globalEventBus;
  const normalized = provider.trim().toLowerCase();
  assertProviderConfiguration(normalized, requireReal, options.ledger);

  if (normalized === 'mock') {
    console.log('[LLM] 使用 Mock Provider（模拟模式）');
    return new MockProvider(random.fork('mock'));
  }

  const ledger = options.ledger ?? getBudgetLedger();
  const breaker = options.breaker ?? new LLMCircuitBreaker(eventBus, ledger);
  const primary = buildPrimary(normalized, breaker, ledger);

  // Fallback 策略仅在真实 Provider 上生效。mock 已经是"最后一档"，无需再包一层。
  const strategy = readFallbackStrategy();
  if (strategy === 'none') return primary;

  console.log(`[LLM] fallback 策略=${strategy}，backup=mock（真实调用失败时按策略切换）`);
  return new FallbackLLMProvider(primary, new MockProvider(random.fork('fallback-mock')), strategy, normalized, eventBus);
}
