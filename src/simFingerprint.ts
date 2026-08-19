/**
 * 模拟批次的「配置指纹」。
 *
 * 要解决的问题：批量模拟的报告此前只记了 provider/games/concurrency/wolves/maxRounds。
 * 三个月后拿同样的命令再跑一遍，结果对不上时**无法归因**——是改了 prompt？换了模型？
 * 调了难度？动了失误注入率？统计对比失去意义。
 *
 * 指纹把「所有会影响对局结果的输入」快照进 JSONL 的 meta 行，让任意两份报告可以逐字段 diff。
 *
 * 设计约束：
 * 1. **只记录、不改变行为**。这个模块是纯读取，不设默认值、不回写 env。
 * 2. **如实反映运行时真实值**，包含 env 未设时代码里的兜底默认值——
 *    否则"没配 = 空白"，而空白无法区分"用了默认 0.12"还是"当时代码默认是 0.2"。
 * 3. **绝不记录密钥**。API Key 一律不进指纹，只记 baseURL 主机名用于区分服务商端点。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readFallbackStrategy, readTimeoutMs } from './llm/LLMProvider';
import { RNG_ALGORITHM, RNG_DERIVATION_VERSION, RNG_SCHEMA_VERSION } from './random';

/** 与 PhaseManager.misfireRate 保持一致的读取逻辑（那里是私有函数，这里只读同样的 env）。 */
function readRate(envKey: string, def: number): number {
  const raw = parseFloat(process.env[envKey] || '');
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  return def;
}

/** 与 BaseAgent.tacticsEnabled 保持一致：off/0/false/no 关闭，其余开启。 */
function readTacticStyles(): boolean {
  const raw = (process.env.TACTIC_STYLES || '').trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

/** 只取主机名，绝不带路径/查询串（避免把签名参数之类的敏感信息带进指纹）。 */
function safeHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * prompt 版本标识。
 *
 * prompt 全在 BaseAgent.ts 里（system prompt、各决策点的指令文本），所以直接对该文件内容取
 * SHA-256 前 12 位作为版本号。改一个字就会变，比人工维护版本号可靠——人总会忘记手动 +1。
 *
 * 读不到文件时返回 'unknown' 而不是抛错：指纹是诊断信息，不该让模拟跑不起来。
 */
function promptFingerprint(): string {
  const candidates = [
    path.join(__dirname, 'agents', 'BaseAgent.ts'),
    path.join(__dirname, '..', 'src', 'agents', 'BaseAgent.ts'),
  ];
  for (const file of candidates) {
    try {
      const src = fs.readFileSync(file, 'utf-8');
      return crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
    } catch {
      // 换下一个候选路径（ts-node 直跑用 src/，编译后用 dist/）
    }
  }
  return 'unknown';
}

export interface SimFingerprint {
  /** 指纹结构版本；将来加字段时便于 report 兼容旧文件。 */
  fingerprintVersion: number;
  /** 游戏随机算法及子流派生契约；任一版本变化都代表历史 seed 局面不可直接比较。 */
  random: {
    algorithm: string;
    schemaVersion: number;
    derivationVersion: number;
  };
  /** BaseAgent.ts 内容哈希前 12 位；prompt 有任何改动都会变。 */
  promptHash: string;
  /** LLM 相关：模型 slug 与端点主机。绝不含 API Key。 */
  llm: {
    provider: string | null;
    modelId: string | null;
    baseHost: string | null;
  };
  /** AI 强度档位（全场统一）。 */
  aiDifficulty: string;
  /** 说话风格（战术人格）总开关。 */
  tacticStyles: boolean;
  /** 失误注入率——直接影响胜率，必须记。
   *  注意：狼人自刀已从"失误注入"升格为狼人可主动选择的战术，不再由概率触发，
   *  故这里不再记录 wolfSelfkill（旧变量 MISFIRE_WOLF_SELFKILL 已废弃）。 */
  misfire: {
    seerRepeat: number;
    guardRepeat: number;
  };
  /** 节奏设置。不影响胜负，但影响耗时，便于解释"为什么这批跑得慢"。 */
  pacing: {
    fastMode: boolean;
    scale: number;
  };
  /**
   * Provider fallback 配置——直接决定 real 批次遇到错误是抛还是转 Mock，
   * 因此必须钉进指纹。策略不同会让"看上去同一模型"的两批数据不可比：
   *   - 'none' 批次：错误直接落到 BaseAgent 决策级兜底；
   *   - 'transient'/'on_error' 批次：部分决策会被 Mock 接管，胜率解读要看 fallback 计数。
   * timeoutMs 决定单次 HTTP 超时窗口，明显影响 timeout 触发率与耗时。
   */
  fallback: {
    strategy: string;
    timeoutMs: number;
  };
  /** 运行环境，用于区分不同机器/Node 版本。 */
  runtime: {
    node: string;
    platform: string;
  };
}

/**
 * 采集当前进程的配置指纹。
 *
 * @param aiDifficulty 本批次使用的难度档；由调用方传入（命令行参数优先于 env）
 * @param useReal 是否为真实 LLM 批次。**必须如实传**：mock 批次不能把 .env 里的
 *   真实模型 slug 记进指纹，否则几个月后看这份文件会以为"这批数据是 doubao 跑出来的"，
 *   而实际上是 MockProvider 的固定套路——两者的胜率毫无可比性。
 */
export function collectFingerprint(aiDifficulty: string, useReal: boolean): SimFingerprint {
  const scaleRaw = parseFloat(process.env.PACING_SCALE || '1');
  return {
    fingerprintVersion: 2,
    random: {
      algorithm: RNG_ALGORITHM,
      schemaVersion: RNG_SCHEMA_VERSION,
      derivationVersion: RNG_DERIVATION_VERSION,
    },
    promptHash: promptFingerprint(),
    // mock 批次不跑任何真实模型：三个字段一律标 mock，避免把 .env 的真实模型误记成数据来源。
    llm: useReal
      ? {
          provider: process.env.LLM_PROVIDER || null,
          modelId: process.env.LLM_MODEL_ID || process.env.OPENAI_MODEL || null,
          baseHost: safeHost(process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL),
        }
      : { provider: 'mock', modelId: '(mock-无真实模型)', baseHost: null },
    aiDifficulty,
    tacticStyles: readTacticStyles(),
    misfire: {
      seerRepeat: readRate('MISFIRE_SEER_REPEAT', 0.12),
      guardRepeat: readRate('MISFIRE_GUARD_REPEAT', 0.12),
    },
    pacing: {
      fastMode: process.env.FAST_MODE === '1',
      scale: Number.isFinite(scaleRaw) && scaleRaw >= 0 ? scaleRaw : 1,
    },
    fallback: {
      strategy: readFallbackStrategy(),
      timeoutMs: readTimeoutMs(),
    },
    runtime: {
      node: process.version,
      platform: process.platform,
    },
  };
}

/** 指纹的多行可读呈现，供报告打印。 */
export function formatFingerprint(fp: SimFingerprint | null | undefined): string[] {
  if (!fp) {
    // 旧文件没有指纹字段：明确说出来，而不是假装一切正常。
    return ['配置指纹：（缺失——该文件由加入指纹功能之前的版本生成，无法与新报告做配置对比）'];
  }
  const lines: string[] = ['配置指纹：'];
  lines.push(`  · prompt 版本(BaseAgent.ts 哈希)：${fp.promptHash}`);
  if (fp.random) {
    lines.push(`  · 随机：${fp.random.algorithm} schema=${fp.random.schemaVersion} derivation=${fp.random.derivationVersion}`);
  } else {
    lines.push('  · 随机：（旧文件无字段，seed 结果不可与新版直接比较）');
  }
  lines.push(`  · 模型：${fp.llm.modelId ?? '(未设)'}  provider=${fp.llm.provider ?? '(未设)'}  端点=${fp.llm.baseHost ?? '(未设)'}`);
  lines.push(`  · AI 难度：${fp.aiDifficulty}   说话风格：${fp.tacticStyles ? '开' : '关'}`);
  lines.push(
    `  · 失误注入：预言家重复验=${fp.misfire.seerRepeat}  守卫连守=${fp.misfire.guardRepeat}（狼人自刀已改为主动战术，不再计失误率）`,
  );
  lines.push(`  · 节奏：FAST_MODE=${fp.pacing.fastMode ? '1' : '0'}  PACING_SCALE=${fp.pacing.scale}`);
  if (fp.fallback) {
    lines.push(`  · Fallback：策略=${fp.fallback.strategy}  超时=${fp.fallback.timeoutMs}ms`);
  } else {
    lines.push('  · Fallback：（旧文件无字段——按默认 none / 60000ms 解读）');
  }
  lines.push(`  · 运行环境：node ${fp.runtime.node} / ${fp.runtime.platform}`);
  return lines;
}

/**
 * 对比两份指纹，列出所有差异字段。
 *
 * 用途：拿两批模拟结果做胜率对比时，先确认"除了想改的那一项，其他都一样"。
 * 若返回非空且包含意料之外的字段，那两批数据就不可直接比较。
 */
export function diffFingerprints(
  a: SimFingerprint | null | undefined,
  b: SimFingerprint | null | undefined,
): string[] {
  if (!a || !b) return ['至少一方缺少配置指纹，无法对比'];
  const diffs: string[] = [];
  const walk = (x: any, y: any, prefix: string) => {
    for (const key of new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])) {
      const vx = x?.[key];
      const vy = y?.[key];
      const label = prefix ? `${prefix}.${key}` : key;
      if (vx && vy && typeof vx === 'object' && typeof vy === 'object') {
        walk(vx, vy, label);
      } else if (vx !== vy) {
        diffs.push(`${label}: ${JSON.stringify(vx)} → ${JSON.stringify(vy)}`);
      }
    }
  };
  walk(a, b, '');
  return diffs;
}
