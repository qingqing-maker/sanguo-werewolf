import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TTSServiceError } from './TTSProvider';

export interface TTSBudgetConfig {
  ledgerPath: string;
  period: string;
  characterBudget: number;
  callBudget: number;
  lockTimeoutMs?: number;
}

export interface TTSBudgetReservation {
  id: string;
  characters: number;
}

export interface TTSBudgetSnapshot {
  period: string;
  characterBudget: number;
  callBudget: number;
  calls: number;
  settledCharacters: number;
  reservedCharacters: number;
  committedCharacters: number;
  activeReservations: number;
}

/** 只读巡检结果；inspect() 不创建账本、目录或锁。 */
export interface TTSBudgetReport {
  exists: boolean;
  ledgerPath: string;
  lockPath: string;
  lockPresent: boolean;
  snapshot?: TTSBudgetSnapshot;
  createdAt?: string;
  remainingCharacters?: number;
  remainingCalls?: number;
}

type HeaderEvent = { type: 'header'; version: 1; period: string; characterBudget: number; callBudget: number; createdAt: string };
type ReserveEvent = { type: 'reserve'; id: string; characters: number; pid: number; at: string };
type SettleEvent = { type: 'settle'; id: string; characters: number; pid: number; at: string };
type LedgerEvent = HeaderEvent | ReserveEvent | SettleEvent;
interface LedgerState { header: HeaderEvent; calls: number; settledCharacters: number; reservations: Map<string, number> }

export class TTSBudgetError extends TTSServiceError {
  constructor(message: string, cause?: unknown) {
    super('tts_budget_exhausted', message, undefined, cause);
    this.name = 'TTSBudgetError';
  }
}

function safePositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TTSBudgetError(`${name} 必须是有限正整数`);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function parseTTSLedgerText(raw: string, expect: Pick<TTSBudgetConfig, 'period' | 'characterBudget' | 'callBudget'>): LedgerState {
  if (!raw.endsWith('\n')) throw new TTSBudgetError('TTS 预算账本存在未完成写入');
  const lines = raw.slice(0, -1).split('\n');
  if (!lines.length || lines.some(line => !line.trim())) throw new TTSBudgetError('TTS 预算账本为空或包含空事件');
  const events = lines.map((line, index): LedgerEvent => {
    try {
      const value: unknown = JSON.parse(line);
      if (!record(value) || typeof value.type !== 'string') throw new Error('非法事件');
      return value as LedgerEvent;
    } catch (error) { throw new TTSBudgetError(`TTS 预算账本第 ${index + 1} 行损坏`, error); }
  });
  const header = events[0];
  if (header.type !== 'header' || header.version !== 1 || typeof header.period !== 'string' ||
      !integer(header.characterBudget) || !integer(header.callBudget)) throw new TTSBudgetError('TTS 预算账本 header 非法');
  if (header.period !== expect.period || header.characterBudget !== expect.characterBudget || header.callBudget !== expect.callBudget) {
    throw new TTSBudgetError('TTS 预算账本周期或上限与当前配置不一致');
  }
  const state: LedgerState = { header, calls: 0, settledCharacters: 0, reservations: new Map() };
  for (let i = 1; i < events.length; i++) {
    const event = events[i];
    if (event.type === 'reserve') {
      if (typeof event.id !== 'string' || !integer(event.characters) || event.characters <= 0 || state.reservations.has(event.id)) {
        throw new TTSBudgetError(`TTS 预算账本第 ${i + 1} 行 reserve 非法`);
      }
      state.calls++;
      state.reservations.set(event.id, event.characters);
    } else if (event.type === 'settle') {
      if (typeof event.id !== 'string' || !integer(event.characters) || event.characters < 0 || !state.reservations.has(event.id)) {
        throw new TTSBudgetError(`TTS 预算账本第 ${i + 1} 行 settle 非法`);
      }
      state.reservations.delete(event.id);
      state.settledCharacters += event.characters;
    } else throw new TTSBudgetError(`TTS 预算账本第 ${i + 1} 行包含未知事件`);
  }
  return state;
}

/** characters + calls 双上限的跨进程、fail-closed JSONL 账本。 */
export class TTSBudgetLedger {
  readonly ledgerPath: string;
  readonly lockPath: string;
  private readonly config: Required<TTSBudgetConfig>;

  constructor(config: TTSBudgetConfig) {
    if (!path.isAbsolute(config.ledgerPath)) throw new TTSBudgetError('TTS 账本路径必须是绝对路径');
    safePositive(config.characterBudget, 'characterBudget');
    safePositive(config.callBudget, 'callBudget');
    if (!config.period || /[\r\n]/.test(config.period)) throw new TTSBudgetError('TTS 预算周期非法');
    this.ledgerPath = config.ledgerPath;
    this.lockPath = `${config.ledgerPath}.lock`;
    this.config = { ...config, lockTimeoutMs: config.lockTimeoutMs ?? 5_000 };
  }

  reserve(characters: number): TTSBudgetReservation {
    safePositive(characters, 'characters');
    return this.withLock(() => {
      const state = this.loadState();
      const snapshot = this.toSnapshot(state);
      if (snapshot.calls + 1 > this.config.callBudget) throw new TTSBudgetError('TTS 调用次数预算不足');
      if (snapshot.committedCharacters + characters > this.config.characterBudget) throw new TTSBudgetError('TTS 字符预算不足');
      const reservation = { id: `${process.pid}-${Date.now()}-${crypto.randomBytes(12).toString('hex')}`, characters };
      this.append({ type: 'reserve', ...reservation, pid: process.pid, at: new Date().toISOString() });
      return reservation;
    });
  }

  /** 成功和失败均按已提交给 provider 的完整字符数保守结算。 */
  settle(reservation: TTSBudgetReservation): TTSBudgetSnapshot {
    return this.withLock(() => {
      const state = this.loadState();
      if (state.reservations.get(reservation.id) !== reservation.characters) throw new TTSBudgetError('TTS reservation 不存在或不一致');
      this.append({ type: 'settle', ...reservation, pid: process.pid, at: new Date().toISOString() });
      state.reservations.delete(reservation.id);
      state.settledCharacters += reservation.characters;
      return this.toSnapshot(state);
    });
  }

  snapshot(): TTSBudgetSnapshot { return this.withLock(() => this.toSnapshot(this.loadState())); }

  /** 只读巡检：不取锁，也不创建目录、账本或锁文件。 */
  inspect(expectConfig = true): TTSBudgetReport {
    const base = {
      exists: fs.existsSync(this.ledgerPath),
      ledgerPath: this.ledgerPath,
      lockPath: this.lockPath,
      lockPresent: fs.existsSync(this.lockPath),
    };
    if (!base.exists) return base;
    let raw: string;
    try { raw = fs.readFileSync(this.ledgerPath, 'utf8'); }
    catch (error) { throw new TTSBudgetError('无法读取 TTS 预算账本', error); }
    const expect = expectConfig
      ? this.config
      : this.headerExpectation(raw);
    const state = parseTTSLedgerText(raw, expect);
    const snapshot = this.toSnapshotFromHeader(state);
    return {
      ...base,
      snapshot,
      createdAt: state.header.createdAt,
      remainingCharacters: snapshot.characterBudget - snapshot.committedCharacters,
      remainingCalls: snapshot.callBudget - snapshot.calls,
    };
  }

  private headerExpectation(raw: string): Pick<TTSBudgetConfig, 'period' | 'characterBudget' | 'callBudget'> {
    try {
      const first = raw.split('\n', 1)[0];
      const header: unknown = JSON.parse(first);
      if (!record(header) || typeof header.period !== 'string' || !integer(header.characterBudget) || !integer(header.callBudget)) {
        throw new Error('header 非法');
      }
      return { period: header.period, characterBudget: header.characterBudget, callBudget: header.callBudget };
    } catch (error) { throw new TTSBudgetError('TTS 预算账本 header 非法', error); }
  }

  private withLock<T>(operation: () => T): T {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    const started = Date.now();
    let fd: number;
    while (true) {
      try { fd = fs.openSync(this.lockPath, 'wx'); break; }
      catch (error: any) {
        if (error?.code !== 'EEXIST') throw new TTSBudgetError('无法创建 TTS 预算锁', error);
        if (Date.now() - started >= this.config.lockTimeoutMs) throw new TTSBudgetError('TTS 预算锁被占用或为遗留锁', error);
        sleepSync(20);
      }
    }
    let result: T | undefined; let failure: unknown;
    try { result = operation(); } catch (error) { failure = error; }
    try { fs.closeSync(fd); fs.unlinkSync(this.lockPath); }
    catch (error) { throw new TTSBudgetError('无法释放 TTS 预算锁，后续请求 fail closed', error); }
    if (failure) throw failure;
    return result as T;
  }

  private loadState(): LedgerState {
    if (!fs.existsSync(this.ledgerPath)) {
      const header: HeaderEvent = { type: 'header', version: 1, period: this.config.period, characterBudget: this.config.characterBudget, callBudget: this.config.callBudget, createdAt: new Date().toISOString() };
      let fd: number | undefined;
      try { fd = fs.openSync(this.ledgerPath, 'wx'); fs.writeFileSync(fd, `${JSON.stringify(header)}\n`); fs.fsyncSync(fd); }
      catch (error) { throw new TTSBudgetError('无法初始化 TTS 预算账本', error); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    let raw: string;
    try { raw = fs.readFileSync(this.ledgerPath, 'utf8'); }
    catch (error) { throw new TTSBudgetError('无法读取 TTS 预算账本', error); }
    return parseTTSLedgerText(raw, this.config);
  }

  private append(event: ReserveEvent | SettleEvent): void {
    let fd: number | undefined;
    try { fd = fs.openSync(this.ledgerPath, 'a'); fs.writeFileSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); }
    catch (error) { throw new TTSBudgetError('无法持久化 TTS 预算事件', error); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  private toSnapshot(state: LedgerState): TTSBudgetSnapshot {
    const snapshot = this.toSnapshotFromHeader(state);
    return { ...snapshot, period: this.config.period, characterBudget: this.config.characterBudget, callBudget: this.config.callBudget };
  }

  private toSnapshotFromHeader(state: LedgerState): TTSBudgetSnapshot {
    let reservedCharacters = 0;
    for (const value of state.reservations.values()) reservedCharacters += value;
    return { period: state.header.period, characterBudget: state.header.characterBudget, callBudget: state.header.callBudget,
      calls: state.calls, settledCharacters: state.settledCharacters, reservedCharacters,
      committedCharacters: state.settledCharacters + reservedCharacters, activeReservations: state.reservations.size };
  }
}
