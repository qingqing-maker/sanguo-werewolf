import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetTTSConfiguration } from '../tts/TTSFactory';
import { resetTTSService } from '../tts/TTSServiceFactory';

/**
 * .env 读写工具 —— 供前端设置页使用。
 *
 * 设计原则：
 * 1. 只暴露/允许修改白名单内的键（ALLOWED_KEYS），其余键（尤其密钥）不通过此通道读写。
 * 2. 敏感键（SENSITIVE_KEYS）读取时只返回掩码，绝不把明文回传浏览器。
 * 3. 写回时逐行保留原文件的注释、空行、未知键，只替换白名单键的值（就地更新，
 *    不存在则追加），避免把用户手写的注释/结构冲掉。
 */

/** 允许通过设置页读写的键。其余键一律忽略（既不读也不写）。 */
export const ALLOWED_KEYS = [
  'LLM_PROVIDER',
  'LLM_MODEL_ID',
  'LLM_API_STYLE',
  'LLM_TOKEN_BUDGET',
  'LLM_CALL_BUDGET',
  'LLM_FALLBACK_STRATEGY',
  'LLM_TIMEOUT_MS',
  'PACING_SCALE',
  'FAST_MODE',
  'TTS_PROVIDER',
  'TTS_MAX_TEXT_CHARACTERS',
  'TTS_RATE_WINDOW_MS',
  'TTS_SESSION_REQUEST_LIMIT',
  'TTS_SESSION_CHARACTER_LIMIT',
  'TTS_IP_REQUEST_LIMIT',
  'TTS_IP_CHARACTER_LIMIT',
  'TTS_CONCURRENCY',
  'TTS_QUEUE_LIMIT',
  'TTS_TIMEOUT_MS',
  'TTS_BUDGET_ENABLED',
  'TTS_CHARACTER_BUDGET',
  'TTS_CALL_BUDGET',
  'TTS_BUDGET_LEDGER_PATH',
  'TTS_BUDGET_PERIOD',
  'PORT',
] as const;

/** 允许的 provider 值（与 ProviderFactory 的 supported 保持一致，外加 mock）。 */
const ALLOWED_PROVIDERS = new Set(['mock', 'openai', 'siliconflow', 'deepseek', 'volcengine', 'anthropic', 'claude', 'gemini']);

/** 允许的 fallback 策略；与 LLMProvider.FALLBACK_STRATEGIES 保持同步。 */
const ALLOWED_FALLBACK_STRATEGIES = new Set(['none', 'transient', 'on_error', 'on_budget']);
const ALLOWED_LLM_API_STYLES = new Set(['chat_completions', 'responses']);

export type AllowedKey = (typeof ALLOWED_KEYS)[number];

/** 敏感键：读取时只返回掩码。设置页目前不含这些键，此处保留以防将来放开。 */
const SENSITIVE_KEYS = new Set<string>(['LLM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'TTS_ACCESS_TOKEN']);

function envPath(): string {
  return path.resolve(process.cwd(), '.env');
}

/** 把敏感值掩码成 `前4…后3` 形式，短值直接全掩。 */
function maskValue(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-3)}`;
}

/**
 * 解析 .env 成 { key: rawValue } 映射。只做最朴素的 `KEY=VALUE` 解析：
 * - 忽略空行和以 # 开头的注释行
 * - 值不去引号（本项目 .env 不用引号包裹）
 * - 重复键后者覆盖前者（与 dotenv 行为一致）
 */
function parseEnv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    map.set(key, value);
  }
  return map;
}

/**
 * 读取当前设置（仅白名单键）。敏感键返回掩码值和 masked=true 标记。
 * 找不到 .env 或某键缺失时，该键返回空串。
 */
export function readSettings(): Record<string, { value: string; masked: boolean }> {
  let text = '';
  try {
    text = fs.readFileSync(envPath(), 'utf8');
  } catch {
    // .env 不存在：返回全空
  }
  const parsed = parseEnv(text);
  const out: Record<string, { value: string; masked: boolean }> = {};
  for (const key of ALLOWED_KEYS) {
    const raw = parsed.get(key) ?? '';
    if (SENSITIVE_KEYS.has(key) && raw) {
      out[key] = { value: maskValue(raw), masked: true };
    } else {
      out[key] = { value: raw, masked: false };
    }
  }
  return out;
}

/** 校验单个键的值是否合法。返回错误信息，null 表示合法。 */
function validate(key: AllowedKey, value: string): string | null {
  switch (key) {
    case 'LLM_PROVIDER': {
      const v = value.trim().toLowerCase();
      if (!v) return 'LLM_PROVIDER 不能为空';
      if (!ALLOWED_PROVIDERS.has(v)) return `LLM_PROVIDER 只能是：${Array.from(ALLOWED_PROVIDERS).join(' / ')}`;
      return null;
    }
    case 'LLM_MODEL_ID':
      if (!value.trim()) return 'LLM_MODEL_ID 不能为空';
      if (value.length > 128) return 'LLM_MODEL_ID 过长';
      if (/[\r\n]/.test(value)) return 'LLM_MODEL_ID 含非法字符';
      return null;
    case 'LLM_API_STYLE': {
      const v = value.trim().toLowerCase();
      if (!v) return null;
      if (!ALLOWED_LLM_API_STYLES.has(v)) {
        return `LLM_API_STYLE 只能是：${Array.from(ALLOWED_LLM_API_STYLES).join(' / ')}`;
      }
      return null;
    }
    case 'LLM_TOKEN_BUDGET': {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n <= 0) return 'LLM_TOKEN_BUDGET 必须是正整数';
      return null;
    }
    case 'LLM_CALL_BUDGET': {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n <= 0) return 'LLM_CALL_BUDGET 必须是正整数';
      return null;
    }
    case 'LLM_FALLBACK_STRATEGY': {
      const v = value.trim().toLowerCase();
      if (!v) return null; // 允许空值（等价 'none'，历史默认）
      if (!ALLOWED_FALLBACK_STRATEGIES.has(v)) {
        return `LLM_FALLBACK_STRATEGY 只能是：${Array.from(ALLOWED_FALLBACK_STRATEGIES).join(' / ')}`;
      }
      return null;
    }
    case 'LLM_TIMEOUT_MS': {
      if (!value.trim()) return null; // 空值等价于默认 60000
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 5000 || n > 600000) return 'LLM_TIMEOUT_MS 必须是 5000-600000 的整数';
      return null;
    }
    case 'PACING_SCALE': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return 'PACING_SCALE 必须是 >=0 的数';
      return null;
    }
    case 'FAST_MODE':
      if (value !== '0' && value !== '1' && value !== '') return 'FAST_MODE 只能是 0 或 1';
      return null;
    case 'TTS_PROVIDER': {
      const v = value.trim().toLowerCase();
      if (!v) return null; // 允许空值（使用默认）
      if (!['edge', 'volc'].includes(v)) return 'TTS_PROVIDER 只能是：edge / volc';
      return null;
    }
    case 'TTS_BUDGET_ENABLED':
      if (value !== '0' && value !== '1') return 'TTS_BUDGET_ENABLED 只能是 0 或 1';
      return null;
    case 'TTS_QUEUE_LIMIT': {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0) return 'TTS_QUEUE_LIMIT 必须是非负整数';
      return null;
    }
    case 'TTS_MAX_TEXT_CHARACTERS':
    case 'TTS_RATE_WINDOW_MS':
    case 'TTS_SESSION_REQUEST_LIMIT':
    case 'TTS_SESSION_CHARACTER_LIMIT':
    case 'TTS_IP_REQUEST_LIMIT':
    case 'TTS_IP_CHARACTER_LIMIT':
    case 'TTS_CONCURRENCY':
    case 'TTS_TIMEOUT_MS':
    case 'TTS_CHARACTER_BUDGET':
    case 'TTS_CALL_BUDGET': {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n <= 0) return `${key} 必须是正整数`;
      return null;
    }
    case 'TTS_BUDGET_LEDGER_PATH':
      if (!value.trim() || !path.isAbsolute(value)) return 'TTS_BUDGET_LEDGER_PATH 必须是绝对路径';
      if (/\r|\n/.test(value)) return 'TTS_BUDGET_LEDGER_PATH 含非法字符';
      return null;
    case 'TTS_BUDGET_PERIOD':
      if (!value.trim() || value.length > 128 || /\r|\n/.test(value)) return 'TTS_BUDGET_PERIOD 非法';
      return null;
    case 'PORT': {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1 || n > 65535) return 'PORT 必须是 1-65535';
      return null;
    }
    default:
      return '未知配置项';
  }
}

/**
 * 写回设置：只更新白名单键，逐行保留注释/空行/未知键。
 * @param updates 要更新的键值（只处理白名单内的键）
 * @returns { applied: 实际写入的键, errors: 校验失败的键→原因 }
 */
export function writeSettings(updates: Record<string, string>): {
  applied: string[];
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const clean: Partial<Record<AllowedKey, string>> = {};

  for (const [key, value] of Object.entries(updates)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) continue; // 忽略非白名单键
    const k = key as AllowedKey;
    const v = String(value ?? '').trim();
    const err = validate(k, v);
    if (err) {
      errors[k] = err;
    } else {
      clean[k] = v;
    }
  }

  const applied = Object.keys(clean);
  if (applied.length === 0) return { applied, errors };

  const file = envPath();
  let original = '';
  try {
    original = fs.readFileSync(file, 'utf8');
  } catch {
    original = '';
  }

  const lines = original.length > 0 ? original.split(/\r?\n/) : [];
  const written = new Set<string>();

  // 就地替换已存在的键（跳过注释行）
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in clean && !written.has(key)) {
      lines[i] = `${key}=${clean[key as AllowedKey]}`;
      written.add(key);
    }
  }

  // 未在文件中出现的键：追加到末尾
  const missing = applied.filter(k => !written.has(k));
  if (missing.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push('# —— 由设置页追加 ——');
    for (const k of missing) lines.push(`${k}=${clean[k as AllowedKey]}`);
  }

  const output = lines.join('\n');
  const finalText = output.endsWith('\n') ? output : `${output}\n`;
  fs.writeFileSync(file, finalText, 'utf8');

  // 同步更新当前进程的 process.env，让实时读取项（PACING_SCALE/FAST_MODE）立即生效
  for (const k of applied) process.env[k] = clean[k as AllowedKey];
  if (applied.some(k => k.startsWith('TTS_'))) {
    resetTTSService();
    resetTTSConfiguration();
  }

  return { applied, errors };
}
