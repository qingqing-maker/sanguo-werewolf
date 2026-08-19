import * as path from 'node:path';
import { ITTSProvider } from './TTSProvider';
import { EdgeTTSProvider } from './EdgeTTSProvider';
import { VolcTTSProvider } from './VolcTTSProvider';
import { TTSBudgetConfig, TTSBudgetLedger } from './TTSBudgetLedger';

export interface TTSRuntimeOptions {
  ledger?: TTSBudgetLedger;
  maxTextCharacters: number;
  windowMs: number;
  sessionRequestLimit: number;
  sessionCharacterLimit: number;
  ipRequestLimit: number;
  ipCharacterLimit: number;
  concurrency: number;
  queueLimit: number;
  timeoutMs: number;
}

let instance: ITTSProvider | null = null;
let ledgerInstance: TTSBudgetLedger | null = null;
let runtimeOptions: TTSRuntimeOptions | null = null;

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, allowZero = false): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${key} 必须是${allowZero ? '非负' : '正'}整数`);
  return value;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`TTS 付费账本缺少 ${key} 配置（fail closed）`);
  return value;
}

export function readTTSBudgetConfig(env: NodeJS.ProcessEnv = process.env): TTSBudgetConfig | undefined {
  const kind = (env.TTS_PROVIDER || 'edge').trim().toLowerCase();
  const enabledRaw = env.TTS_BUDGET_ENABLED?.trim();
  if (enabledRaw && enabledRaw !== '0' && enabledRaw !== '1') throw new Error('TTS_BUDGET_ENABLED 只能是 0 或 1');
  if ((kind === 'volc' || kind === 'volcano' || kind === 'huoshan') && enabledRaw !== '1') {
    throw new Error('volc 必须明确设置 TTS_BUDGET_ENABLED=1（缺失或禁用时 fail closed）');
  }
  if (enabledRaw !== '1') return undefined;
  return {
    ledgerPath: path.resolve(required(env, 'TTS_BUDGET_LEDGER_PATH')),
    period: required(env, 'TTS_BUDGET_PERIOD'),
    characterBudget: integer(env, 'TTS_CHARACTER_BUDGET', 0),
    callBudget: integer(env, 'TTS_CALL_BUDGET', 0),
    lockTimeoutMs: integer(env, 'TTS_BUDGET_LOCK_TIMEOUT_MS', 5_000),
  };
}

export function getTTSBudgetLedger(): TTSBudgetLedger | undefined {
  const config = readTTSBudgetConfig();
  if (!config) return undefined;
  if (!ledgerInstance) ledgerInstance = new TTSBudgetLedger(config);
  return ledgerInstance;
}

export function getTTSRuntimeOptions(env: NodeJS.ProcessEnv = process.env): TTSRuntimeOptions {
  if (env === process.env && runtimeOptions) return runtimeOptions;
  const options: TTSRuntimeOptions = {
    ledger: env === process.env ? getTTSBudgetLedger() : undefined,
    maxTextCharacters: integer(env, 'TTS_MAX_TEXT_CHARACTERS', 1024),
    windowMs: integer(env, 'TTS_RATE_WINDOW_MS', 60_000),
    sessionRequestLimit: integer(env, 'TTS_SESSION_REQUEST_LIMIT', 30),
    sessionCharacterLimit: integer(env, 'TTS_SESSION_CHARACTER_LIMIT', 8_000),
    ipRequestLimit: integer(env, 'TTS_IP_REQUEST_LIMIT', 100),
    ipCharacterLimit: integer(env, 'TTS_IP_CHARACTER_LIMIT', 30_000),
    concurrency: integer(env, 'TTS_CONCURRENCY', 2),
    queueLimit: integer(env, 'TTS_QUEUE_LIMIT', 8, true),
    timeoutMs: integer(env, 'TTS_TIMEOUT_MS', 15_000),
  };
  if (env === process.env) runtimeOptions = options;
  return options;
}

export function getTTSProvider(): ITTSProvider {
  if (instance) return instance;
  const kind = (process.env.TTS_PROVIDER || 'edge').trim().toLowerCase();
  switch (kind) {
    case 'volc': case 'volcano': case 'huoshan':
      // 在创建付费 provider 前验证独立硬预算，配置不完整时禁止启动真实调用。
      getTTSRuntimeOptions();
      instance = new VolcTTSProvider();
      console.log('[TTS] 使用火山引擎 TTS（volc）');
      break;
    case 'edge': case 'msedge':
      getTTSRuntimeOptions();
      instance = new EdgeTTSProvider();
      console.log('[TTS] 使用微软 Edge TTS（edge）');
      break;
    default:
      throw new Error(`不支持的 TTS_PROVIDER: ${kind}`);
  }
  return instance;
}

export function resetTTSProvider(): void { instance = null; }
export function resetTTSBudgetLedger(): void { ledgerInstance = null; runtimeOptions = null; }
export function resetTTSRuntimeConfig(): void { runtimeOptions = null; }
export function resetTTSConfiguration(): void {
  resetTTSProvider();
  resetTTSBudgetLedger();
}
