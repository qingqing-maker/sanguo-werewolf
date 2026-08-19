import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChatMessage } from '../types';
import { LLMError } from './LLMProvider';

// 安全天花板：.env 里的 LLM_TOKEN_BUDGET 不得超过此值。
// 作用是防手滑——例如想填 400 万却多打一个 0 变成 4000 万时被拦下。
// 不再要求 .env 上限与它"精确相等"，天花板以内可自由调整上限而无需改代码。
export const PROJECT_TOKEN_BUDGET = 20_000_000;

export interface BudgetConfig {
  ledgerPath: string;
  period: string;
  tokenBudget: number;
  callBudget: number;
  lockTimeoutMs?: number;
}

export interface BudgetReservation {
  id: string;
  tokens: number;
}

export interface BudgetSnapshot {
  period: string;
  tokenBudget: number;
  callBudget: number;
  calls: number;
  settledTokens: number;
  reservedTokens: number;
  committedTokens: number;
  activeReservations: number;
}

/**
 * 只读巡检报告：状态查询命令的返回结构。比 BudgetSnapshot 多出账本路径、锁状态、
 * 剩余额度和悬挂 reservation 明细——这些是"人要看的诊断信息"，而 BudgetSnapshot
 * 是"reserve/settle 内部用的记账口径"，故分成两个类型而不是硬塞进一个。
 *
 * exists=false 时只有路径与配置字段有意义（账本尚未创建，剩余额度无从谈起）。
 */
export interface LedgerReport {
  exists: boolean;
  ledgerPath: string;
  lockPath: string;
  /** 锁文件是否存在。存在意味着有进程正在写，或上次崩溃留下了遗留锁。 */
  lockPresent: boolean;
  /** 当前 env/配置解析出的周期与上限，用于和账本 header 对比是否漂移。 */
  configPeriod: string;
  configTokenBudget: number;
  configCallBudget: number;
  /** 以下字段仅在 exists=true 时存在。 */
  snapshot?: BudgetSnapshot;
  createdAt?: string;
  remainingTokens?: number;
  remainingCalls?: number;
  pendingReservations?: ReservationDetail[];
}

interface HeaderEvent {
  type: 'header';
  version: 1;
  period: string;
  tokenBudget: number;
  callBudget: number;
  createdAt: string;
}

interface ReserveEvent {
  type: 'reserve';
  id: string;
  tokens: number;
  pid: number;
  at: string;
}

interface SettleEvent {
  type: 'settle';
  id: string;
  tokens: number;
  mode: 'usage' | 'full';
  pid: number;
  at: string;
}

type LedgerEvent = HeaderEvent | ReserveEvent | SettleEvent;

/**
 * 悬挂 reservation 的完整信息。reserve 已落盘但对应 settle 没写成（进程崩溃、断电、
 * 被强杀）时留在账本里的记录——它仍占用 token 预算（committedTokens 含它），
 * 但永远不会被结算。状态查询命令要能把它连同 pid 和时间一起报出来，
 * 供人判断"是正在跑的调用，还是上次崩溃的残留"。
 */
export interface ReservationDetail {
  id: string;
  tokens: number;
  pid: number;
  at: string;
}

interface LedgerState {
  calls: number;
  settledTokens: number;
  /** 值改存完整事件（而非仅 tokens），以便状态查询报告 pid/时间。 */
  reservations: Map<string, ReservationDetail>;
  /** 账本首行 header 原文。只读诊断要报告「账本里实际写的是什么」，而非当前 env 期望值。 */
  header: HeaderEvent;
}

export class LLMBudgetError extends LLMError {
  constructor(message: string, cause?: unknown) {
    super(`LLM_BUDGET_EXHAUSTED: ${message}`, cause, 'budget');
    this.name = 'LLMBudgetError';
  }
}

function positiveInteger(name: string, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    throw new LLMBudgetError(`真实 LLM 缺少 ${name} 配置`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LLMBudgetError(`${name} 必须是有限正整数，当前值=${raw}`);
  }
  return value;
}

/**
 * 把模型 ID 归一化成可安全用作文件名/周期名的 slug。
 * 只保留字母数字和 ._-，其余（含斜杠、冒号、空格）折叠成 -，避免路径穿越或非法文件名。
 */
function modelSlug(modelId: string): string {
  const slug = modelId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'unknown-model';
}

/**
 * 读取预算配置。默认行为：账本路径与周期名按 LLM_MODEL_ID 自动派生，
 * 因此换模型时只需改 LLM_MODEL_ID —— 新模型自动使用新账本、从 0 重新计数，
 * 无需再手动改账本路径/周期名/代码常量（免维护）。
 *
 * 仍支持 LLM_BUDGET_LEDGER_PATH / LLM_BUDGET_PERIOD 显式覆盖（老用法、CI 固定路径等），
 * 只要任一被显式指定就以显式值为准，不再自动派生。
 *
 * token/次数上限继续由 LLM_TOKEN_BUDGET / LLM_CALL_BUDGET 手填（见 PROJECT_TOKEN_BUDGET 天花板）。
 */
export function readBudgetConfig(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
  const tokenBudget = positiveInteger('LLM_TOKEN_BUDGET', env.LLM_TOKEN_BUDGET);
  if (tokenBudget > PROJECT_TOKEN_BUDGET) {
    throw new LLMBudgetError(
      `LLM_TOKEN_BUDGET=${tokenBudget} 超过安全天花板 ${PROJECT_TOKEN_BUDGET}；如确需更高，请调高 BudgetLedger.ts 里的 PROJECT_TOKEN_BUDGET`,
    );
  }
  const callBudget = positiveInteger('LLM_CALL_BUDGET', env.LLM_CALL_BUDGET);

  const explicitLedger = env.LLM_BUDGET_LEDGER_PATH?.trim();
  const explicitPeriod = env.LLM_BUDGET_PERIOD?.trim();

  // 自动派生的基础：模型 ID。换模型 → slug 变 → 账本文件与周期名都变 → 自动新周期从 0 起。
  const slug = modelSlug(env.LLM_MODEL_ID || '');

  const dataDir = env.DATA_DIR?.trim();
  const defaultRunsDir = dataDir ? path.resolve(dataDir, 'runs') : path.resolve('runs');
  const ledgerRaw = explicitLedger || path.resolve(defaultRunsDir, `llm-budget-${slug}.jsonl`);
  const period = explicitPeriod || `auto-${slug}`;

  if (!period || period.length > 128 || /[\r\n]/.test(period)) {
    throw new LLMBudgetError('LLM_BUDGET_PERIOD 非法');
  }
  return {
    ledgerPath: path.resolve(ledgerRaw),
    period,
    tokenBudget,
    callBudget,
  };
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * 严格解析账本全文为内存状态。**纯函数**：只读字符串，不碰文件系统。
 *
 * 抽成独立函数的原因有两个：
 * 1. 只读的 inspect() 与加锁的 loadState() 必须共用**同一套**严格校验，
 *    否则会出现「状态命令说账本没问题，真实调用却 fail closed」这种更糟的分歧。
 * 2. 崩溃场景（截断行、悬挂 reservation、重复 header、未知事件）可以直接喂字符串测，
 *    不必每条都去构造真实文件。
 *
 * expect 为 null 时跳过 header 与当前配置的一致性比对（只做结构合法性校验），
 * 供状态命令在「想读出账本自己声明的上限」时使用——它此时还不知道该期望什么。
 */
export function parseLedgerText(
  raw: string,
  expect: { period: string; tokenBudget: number; callBudget: number } | null,
): LedgerState {
  if (!raw.endsWith('\n')) {
    throw new LLMBudgetError('预算账本存在未完成写入，拒绝自动修复');
  }
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some(line => line.trim() === '')) {
    throw new LLMBudgetError('预算账本为空或包含空事件');
  }

  const events: LedgerEvent[] = lines.map((line, index) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || typeof parsed.type !== 'string') throw new Error('事件不是对象');
      return parsed as unknown as LedgerEvent;
    } catch (error) {
      throw new LLMBudgetError(`预算账本第 ${index + 1} 行损坏`, error);
    }
  });

  const header = events[0];
  if (header.type !== 'header' || header.version !== 1) {
    throw new LLMBudgetError('预算账本首行不是合法 header');
  }
  if (
    typeof header.period !== 'string' ||
    !integer(header.tokenBudget) || !integer(header.callBudget)
  ) {
    throw new LLMBudgetError('预算账本 header 字段非法');
  }
  if (
    expect && (
      header.period !== expect.period ||
      header.tokenBudget !== expect.tokenBudget ||
      header.callBudget !== expect.callBudget
    )
  ) {
    throw new LLMBudgetError('预算账本周期或上限与当前配置不一致；不得自动开启新周期');
  }

  const state: LedgerState = {
    calls: 0,
    settledTokens: 0,
    reservations: new Map(),
    header,
  };
  for (let index = 1; index < events.length; index++) {
    const event = events[index];
    if (event.type === 'header') throw new LLMBudgetError(`预算账本第 ${index + 1} 行重复 header`);
    if (event.type === 'reserve') {
      if (typeof event.id !== 'string' || !integer(event.tokens) || event.tokens <= 0) {
        throw new LLMBudgetError(`预算账本第 ${index + 1} 行 reserve 非法`);
      }
      if (state.reservations.has(event.id)) {
        throw new LLMBudgetError(`预算账本存在重复 reservation ${event.id}`);
      }
      state.calls++;
      // 保留 pid/at：悬挂 reservation 报告要能指出「是哪个进程、什么时候留下的」。
      state.reservations.set(event.id, {
        id: event.id,
        tokens: event.tokens,
        pid: integer(event.pid) ? event.pid : -1,
        at: typeof event.at === 'string' ? event.at : '',
      });
    } else if (event.type === 'settle') {
      if (typeof event.id !== 'string' || !integer(event.tokens) || event.tokens < 0) {
        throw new LLMBudgetError(`预算账本第 ${index + 1} 行 settle 非法`);
      }
      if (!state.reservations.has(event.id)) {
        throw new LLMBudgetError(`预算账本 settle 引用了未知 reservation ${event.id}`);
      }
      state.reservations.delete(event.id);
      state.settledTokens += event.tokens;
    } else {
      throw new LLMBudgetError(`预算账本第 ${index + 1} 行包含未知事件`);
    }
  }
  return state;
}

/**
 * 跨进程持久化预算账本。所有修改都在 `${ledgerPath}.lock` 独占锁内完成。
 * 锁和日志均不做自动修复：崩溃遗留锁、截断日志或未知事件一律 fail closed。
 */
export class BudgetLedger {
  readonly ledgerPath: string;
  readonly lockPath: string;
  private readonly config: Required<BudgetConfig>;

  constructor(config: BudgetConfig) {
    if (!path.isAbsolute(config.ledgerPath)) {
      throw new LLMBudgetError('账本路径必须是绝对路径');
    }
    if (!Number.isSafeInteger(config.tokenBudget) || config.tokenBudget <= 0) {
      throw new LLMBudgetError('tokenBudget 必须是有限正整数');
    }
    if (!Number.isSafeInteger(config.callBudget) || config.callBudget <= 0) {
      throw new LLMBudgetError('callBudget 必须是有限正整数');
    }
    if (!config.period || /[\r\n]/.test(config.period)) {
      throw new LLMBudgetError('预算周期标识非法');
    }
    this.ledgerPath = config.ledgerPath;
    this.lockPath = `${config.ledgerPath}.lock`;
    this.config = { ...config, lockTimeoutMs: config.lockTimeoutMs ?? 5_000 };
  }

  reserve(tokens: number): BudgetReservation {
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      throw new LLMBudgetError(`预留 token 必须是有限正整数，当前值=${tokens}`);
    }
    return this.withLock(() => {
      const state = this.loadState();
      const snapshot = this.toSnapshot(state);
      if (snapshot.calls + 1 > this.config.callBudget) {
        throw new LLMBudgetError(`调用次数预算不足：${snapshot.calls}/${this.config.callBudget}`);
      }
      if (snapshot.committedTokens + tokens > this.config.tokenBudget) {
        throw new LLMBudgetError(
          `token 预算不足：已承诺 ${snapshot.committedTokens}，本次需预留 ${tokens}，上限 ${this.config.tokenBudget}`,
        );
      }
      const reservation: BudgetReservation = {
        id: `${process.pid}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}`,
        tokens,
      };
      this.appendEvent({
        type: 'reserve',
        id: reservation.id,
        tokens,
        pid: process.pid,
        at: new Date().toISOString(),
      });
      return reservation;
    });
  }

  /** usage 缺失时传 undefined；该 reservation 将按完整预留结算。 */
  settle(reservation: BudgetReservation, actualTokens?: number): BudgetSnapshot {
    return this.withLock(() => {
      const state = this.loadState();
      const reserved = state.reservations.get(reservation.id);
      // reservations 的值已从 number 改为 ReservationDetail，比较改用 .tokens。
      if (reserved === undefined || reserved.tokens !== reservation.tokens) {
        throw new LLMBudgetError(`reservation ${reservation.id} 不存在或与账本不一致`);
      }
      const hasUsage = typeof actualTokens === 'number' && Number.isFinite(actualTokens) && actualTokens >= 0;
      const charged = hasUsage ? Math.ceil(actualTokens!) : reserved.tokens;
      this.appendEvent({
        type: 'settle',
        id: reservation.id,
        tokens: charged,
        mode: hasUsage ? 'usage' : 'full',
        pid: process.pid,
        at: new Date().toISOString(),
      });
      state.reservations.delete(reservation.id);
      state.settledTokens += charged;
      return this.toSnapshot(state);
    });
  }

  settleFailure(reservation: BudgetReservation): BudgetSnapshot {
    return this.settle(reservation, undefined);
  }

  snapshot(): BudgetSnapshot {
    return this.withLock(() => this.toSnapshot(this.loadState()));
  }

  /**
   * 只读巡检：给状态查询命令用，**不取锁、不创建账本、不写任何字节**。
   *
   * 为什么不能直接用 snapshot()：
   * - snapshot() 走 withLock()，会创建并删除 `.lock` 文件。查状态时如果正好有对局在跑，
   *   两边会互相抢锁；更糟的是查询本身可能因锁超时而失败，而"查看状态"绝不该被写操作阻塞。
   * - snapshot() → loadState() 在账本不存在时会**创建**一个带 header 的新账本。
   *   查一个从未用过的模型，反而在 runs/ 里凭空写出一个空账本，是明确的副作用污染。
   *
   * 因此 inspect() 直接读文件并复用 parseLedgerText 的严格校验。
   * 代价是可能读到"正被写入的瞬间状态"——但 appendEvent 是整行 append + fsync，
   * 最坏情况是读到尾行不完整，此时 parseLedgerText 会因"未完成写入"抛错，
   * 属于 fail closed，不会给出错误数字。
   *
   * @param expectConfig 是否用当前配置校验 header。false 时按账本自身 header 汇报，
   *   这样即便 .env 上限改过、与账本不一致，也仍能查看账本真实状态（诊断场景需要）。
   */
  inspect(expectConfig = true): LedgerReport {
    if (!fs.existsSync(this.ledgerPath)) {
      return {
        exists: false,
        ledgerPath: this.ledgerPath,
        lockPath: this.lockPath,
        lockPresent: fs.existsSync(this.lockPath),
        configPeriod: this.config.period,
        configTokenBudget: this.config.tokenBudget,
        configCallBudget: this.config.callBudget,
      };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.ledgerPath, 'utf8');
    } catch (error) {
      throw new LLMBudgetError(`无法读取预算账本 ${this.ledgerPath}`, error);
    }

    const state = parseLedgerText(
      raw,
      expectConfig
        ? {
            period: this.config.period,
            tokenBudget: this.config.tokenBudget,
            callBudget: this.config.callBudget,
          }
        : null,
    );

    const pending: ReservationDetail[] = [];
    let reservedTokens = 0;
    for (const [id, detail] of state.reservations.entries()) {
      reservedTokens += detail.tokens;
      pending.push({ id, tokens: detail.tokens, pid: detail.pid, at: detail.at });
    }
    // 按时间排序，最老的悬挂 reservation 排在前面——它最可能是崩溃残留。
    pending.sort((a, b) => a.at.localeCompare(b.at));

    // 汇报以账本 header 为准：expectConfig=false 时二者可能不同，
    // 而"账本里实际是什么"才是诊断需要的事实。
    const tokenBudget = state.header.tokenBudget;
    const callBudget = state.header.callBudget;

    return {
      exists: true,
      ledgerPath: this.ledgerPath,
      lockPath: this.lockPath,
      lockPresent: fs.existsSync(this.lockPath),
      configPeriod: this.config.period,
      configTokenBudget: this.config.tokenBudget,
      configCallBudget: this.config.callBudget,
      snapshot: {
        period: state.header.period,
        tokenBudget,
        callBudget,
        calls: state.calls,
        settledTokens: state.settledTokens,
        reservedTokens,
        committedTokens: state.settledTokens + reservedTokens,
        activeReservations: state.reservations.size,
      },
      createdAt: state.header.createdAt,
      remainingTokens: tokenBudget - (state.settledTokens + reservedTokens),
      remainingCalls: callBudget - state.calls,
      pendingReservations: pending,
    };
  }

  private withLock<T>(operation: () => T): T {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    const started = Date.now();
    let lockFd: number;
    while (true) {
      try {
        // Windows 也使用 openSync(lock, 'wx')，依赖 O_EXCL 原子创建实现跨进程互斥。
        lockFd = fs.openSync(this.lockPath, 'wx');
        break;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') {
          throw new LLMBudgetError(`无法创建预算锁 ${this.lockPath}`, error);
        }
        if (Date.now() - started >= this.config.lockTimeoutMs) {
          throw new LLMBudgetError(`预算锁被占用或为崩溃遗留锁：${this.lockPath}`, error);
        }
        sleepSync(20);
      }
    }

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = operation();
    } catch (error) {
      operationError = error;
    }

    let releaseError: unknown;
    try {
      fs.closeSync(lockFd);
      fs.unlinkSync(this.lockPath);
    } catch (error) {
      releaseError = error;
    }
    if (releaseError) {
      throw new LLMBudgetError(`无法释放预算锁，后续请求将 fail closed：${this.lockPath}`, releaseError);
    }
    if (operationError) throw operationError;
    return result as T;
  }

  private loadState(): LedgerState {
    if (!fs.existsSync(this.ledgerPath)) {
      const header: HeaderEvent = {
        type: 'header',
        version: 1,
        period: this.config.period,
        tokenBudget: this.config.tokenBudget,
        callBudget: this.config.callBudget,
        createdAt: new Date().toISOString(),
      };
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.ledgerPath, 'wx');
        fs.writeFileSync(fd, `${JSON.stringify(header)}\n`, 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        throw new LLMBudgetError(`无法初始化预算账本 ${this.ledgerPath}`, error);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.ledgerPath, 'utf8');
    } catch (error) {
      throw new LLMBudgetError(`无法读取预算账本 ${this.ledgerPath}`, error);
    }
    return parseLedgerText(raw, {
      period: this.config.period,
      tokenBudget: this.config.tokenBudget,
      callBudget: this.config.callBudget,
    });
  }

  private appendEvent(event: ReserveEvent | SettleEvent): void {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.ledgerPath, 'a');
      fs.writeFileSync(fd, `${JSON.stringify(event)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      throw new LLMBudgetError(`无法持久化预算事件 ${event.type}`, error);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private toSnapshot(state: LedgerState): BudgetSnapshot {
    let reservedTokens = 0;
    // reservations 的值现在是完整事件（tokens/pid/at），累加取 .tokens。
    for (const detail of state.reservations.values()) reservedTokens += detail.tokens;
    return {
      period: this.config.period,
      tokenBudget: this.config.tokenBudget,
      callBudget: this.config.callBudget,
      calls: state.calls,
      settledTokens: state.settledTokens,
      reservedTokens,
      committedTokens: state.settledTokens + reservedTokens,
      activeReservations: state.reservations.size,
    };
  }
}

let sharedLedger: BudgetLedger | null = null;

export function getBudgetLedger(): BudgetLedger {
  if (!sharedLedger) sharedLedger = new BudgetLedger(readBudgetConfig());
  return sharedLedger;
}

/**
 * 释放共享账本单例。设置页保存 .env 后调用，让下一次 getBudgetLedger() 用新的 env 值重建，
 * 避免"改了 .env 但账本仍绑在旧路径/旧上限"。不影响已落盘的账本文件，只丢弃内存里的单例引用。
 */
export function resetBudgetLedger(): void {
  sharedLedger = null;
}

/** UTF-8 字节数作为 token 上界，再加协议/角色余量；故意高估而非追求计费精度。 */
export function estimateRequestTokens(
  systemPrompt: string,
  messages: ChatMessage[],
  maxOutputTokens: number,
): number {
  let inputUpperBound = Buffer.byteLength(systemPrompt, 'utf8') + 512;
  for (const message of messages) {
    inputUpperBound += Buffer.byteLength(message.role, 'utf8');
    inputUpperBound += Buffer.byteLength(message.content, 'utf8');
    inputUpperBound += 32;
  }
  return inputUpperBound + maxOutputTokens;
}

/**
 * 优先 total_tokens；否则合并供应商常见的输入/输出 usage 字段。
 *
 * 注意「全 0 视为缺失」：一次成功返回文本的调用不可能真的消耗 0 token，
 * 但部分第三方中转站（Anthropic 兼容网关）会恒定回传 usage 全 0。
 * 若把 0 当成真实用量，settle 时每次都记 0，token 预算就永远停在 0、熔断彻底失效。
 * 因此这里按「未上报」处理，交由 settle 回落到预留量（估算上界）计费——
 * 宁可高估也不能让防超支的闸门失灵。
 */
export function extractUsageTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const total = usage.total_tokens ?? usage.totalTokens;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) return Math.ceil(total);

  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens;
  const validInput = typeof input === 'number' && Number.isFinite(input) && input >= 0;
  const validOutput = typeof output === 'number' && Number.isFinite(output) && output >= 0;
  // 拆分 usage 必须同时具备输入和输出；部分 usage 不能证明实际总量，按缺失处理。
  if (!validInput || !validOutput) return undefined;
  const sum = (input as number) + (output as number);
  // 输入输出同时为 0：网关没有真实上报，按缺失处理而非按 0 计费。
  if (sum <= 0) return undefined;
  return Math.ceil(sum);
}
