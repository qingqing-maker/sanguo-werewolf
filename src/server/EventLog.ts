import fs from 'fs';
import path from 'path';
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  GameUIEvent,
  isGameEventType,
} from '../game/GameEvents';

/**
 * EventLog - 游戏事件日志持久化（方案2：事件回放）
 *
 * 每局事件追加写入独立 JSONL。读取时只在内存中兼容旧协议，不改写历史文件。
 */
export class EventLog {
  private dir: string;
  private currentGameId: string | null = null;
  private stream: fs.WriteStream | null = null;
  private buffer: GameUIEvent[] = [];
  private maxGames: number;

  constructor(dir?: string, maxGames = 20) {
    const configuredDir = process.env.EVENT_LOG_DIR?.trim();
    const dataDir = process.env.DATA_DIR?.trim();
    this.dir = dir || configuredDir || (dataDir
      ? path.resolve(dataDir, 'game-logs')
      : path.resolve(__dirname, '../../game-logs'));
    this.maxGames = maxGames;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (e: unknown) {
      console.warn(`[EventLog] 创建日志目录失败: ${this.errorMessage(e)}`);
    }
  }

  /** 记录事件；任意带 gameId 的首条事件都可以建立当前日志。 */
  record(event: GameUIEvent): void {
    const gameId = event.data.gameId;
    if (!gameId) return;

    if (gameId !== this.currentGameId) this.rotate(gameId);

    const previous = this.buffer.at(-1)?.sequence ?? 0;
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0 || event.sequence <= previous) {
      console.warn(`[EventLog] 拒绝非法或非递增 sequence=${String(event.sequence)}: gameId=${gameId}`);
      return;
    }

    this.buffer.push(event);
    if (this.stream) {
      try {
        this.stream.write(JSON.stringify(event) + '\n');
      } catch (e: unknown) {
        console.warn(`[EventLog] 写入失败: ${this.errorMessage(e)}`);
      }
    }
  }

  private rotate(gameId: string): void {
    if (this.stream) {
      try { this.stream.end(); } catch { /* 忽略关闭错误 */ }
      this.stream = null;
    }

    this.currentGameId = gameId;
    this.buffer = [];
    const filePath = path.join(this.dir, `${this.sanitize(gameId)}.jsonl`);
    try {
      const stream = fs.createWriteStream(filePath, { flags: 'a' });
      stream.on('error', (e: Error) => {
        console.warn(`[EventLog] 日志流失败: ${this.errorMessage(e)}`);
        if (this.stream === stream) this.stream = null;
      });
      this.stream = stream;
    } catch (e: unknown) {
      console.warn(`[EventLog] 打开日志文件失败: ${this.errorMessage(e)}`);
      this.stream = null;
    }
    this.cleanupOldLogs();
  }

  loadEvents(gameId: string): GameUIEvent[] {
    if (gameId === this.currentGameId && this.buffer.length > 0) return [...this.buffer];
    return this.readFile(path.join(this.dir, `${this.sanitize(gameId)}.jsonl`));
  }

  getLatestGameId(): string | null {
    if (this.currentGameId) return this.currentGameId;
    try {
      const files = fs.readdirSync(this.dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, mtime: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      return files.length === 0 ? null : files[0].f.replace(/\.jsonl$/, '');
    } catch {
      return null;
    }
  }

  loadLatestEvents(): { gameId: string; events: GameUIEvent[] } | null {
    const gameId = this.getLatestGameId();
    return gameId ? { gameId, events: this.loadEvents(gameId) } : null;
  }

  private readFile(filePath: string): GameUIEvent[] {
    try {
      if (!fs.existsSync(filePath)) return [];
      const events: GameUIEvent[] = [];
      let lastSequence = 0;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const decoded = this.decode(JSON.parse(trimmed), filePath, index + 1, lastSequence);
          if (decoded) {
            events.push(decoded);
            lastSequence = decoded.sequence;
          }
        } catch {
          console.warn(`[EventLog] 跳过损坏行: ${filePath}:${index + 1}`);
        }
      });
      return events;
    } catch (e: unknown) {
      console.warn(`[EventLog] 读取失败: ${this.errorMessage(e)}`);
      return [];
    }
  }

  /**
   * 旧事件缺版本时按 v1 解码，缺 sequence 时仅在内存补为上一条之后；未来版本、
   * 非法 sequence 以及显式重复/倒序均拒绝，避免回放游标被污染。
   */
  private decode(value: unknown, filePath: string, line: number, lastSequence: number): GameUIEvent | null {
    if (!value || typeof value !== 'object') {
      console.warn(`[EventLog] 跳过非法事件: ${filePath}:${line}`);
      return null;
    }
    const raw = value as Record<string, unknown>;
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== CURRENT_EVENT_SCHEMA_VERSION) {
      console.warn(`[EventLog] 跳过未知 schemaVersion=${String(raw.schemaVersion)}: ${filePath}:${line}`);
      return null;
    }
    if (!isGameEventType(raw.type) || !raw.data || typeof raw.data !== 'object' || typeof raw.timestamp !== 'number') {
      console.warn(`[EventLog] 跳过非法事件: ${filePath}:${line}`);
      return null;
    }

    const sequence = raw.sequence === undefined ? lastSequence + 1 : raw.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) <= 0 || (sequence as number) <= lastSequence) {
      console.warn(`[EventLog] 跳过非法或非递增 sequence=${String(raw.sequence)}: ${filePath}:${line}`);
      return null;
    }
    return {
      ...raw,
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
      sequence,
    } as GameUIEvent;
  }

  private cleanupOldLogs(): void {
    try {
      const files = fs.readdirSync(this.dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, mtime: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const { f } of files.slice(this.maxGames)) {
        try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* 忽略清理错误 */ }
      }
    } catch { /* 忽略清理错误 */ }
  }

  private sanitize(gameId: string): string {
    return gameId.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
