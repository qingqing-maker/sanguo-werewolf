import { createHash, randomUUID } from 'node:crypto';

export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SessionRecord {
  readonly sessionId: string;
  isHost: boolean;
  seatId: string | null;
  gameId: string | null;
  lastAccessAt: number;
}

export type CreateRoomResultCode = 'created' | 'already_creator' | 'room_taken' | 'unknown_session';
export type CloseRoomResultCode = 'closed' | 'room_not_found' | 'not_owner' | 'unknown_session';

export interface SessionRegistryOptions {
  maxSessions?: number;
  idleTtlMs?: number;
}

/** 进程内连接级会话表；单实例只允许一个房间，创建者自动成为主持人。 */
export class SessionRegistry {
  private readonly sessionsByHash = new Map<string, SessionRecord>();
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private roomCreatorSession: SessionRecord | null = null;
  private roomId: string | null = null;

  constructor(options: SessionRegistryOptions = {}) {
    this.maxSessions = options.maxSessions ?? 1_000;
    this.idleTtlMs = options.idleTtlMs ?? 24 * 60 * 60 * 1_000;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1) throw new RangeError('maxSessions 必须是正整数');
    if (!Number.isFinite(this.idleTtlMs) || this.idleTtlMs < 0) throw new RangeError('idleTtlMs 必须是非负数');
  }

  static isValidToken(token: unknown): token is string {
    return typeof token === 'string' && SESSION_TOKEN_PATTERN.test(token);
  }

  authenticate(token: unknown): SessionRecord | null {
    if (!SessionRegistry.isValidToken(token)) return null;
    this.pruneExpired();
    const hash = this.hash(token);
    const existing = this.sessionsByHash.get(hash);
    if (existing) { existing.lastAccessAt = Date.now(); return existing; }
    if (this.sessionsByHash.size >= this.maxSessions) return null;
    const session: SessionRecord = {
      sessionId: randomUUID(),
      isHost: false,
      seatId: null,
      gameId: null,
      lastAccessAt: Date.now(),
    };
    this.sessionsByHash.set(hash, session);
    return session;
  }

  /** 创建单实例房间；同一时刻只有一个会话能成功，创建者自动成为主持人。 */
  createRoom(session: SessionRecord): CreateRoomResultCode {
    if (!this.hasSession(session)) return 'unknown_session';
    if (session.isHost && this.roomCreatorSession === session) return 'already_creator';
    if (this.roomCreatorSession) return 'room_taken';
    session.isHost = true;
    session.lastAccessAt = Date.now();
    this.roomCreatorSession = session;
    this.roomId = randomUUID();
    return 'created';
  }

  /** 关闭空闲房间并释放主持权；活动游戏是否允许关闭由 WebServer 负责判断。 */
  closeRoom(session: SessionRecord): CloseRoomResultCode {
    if (!this.hasSession(session)) return 'unknown_session';
    if (!this.roomCreatorSession || !this.roomId) return 'room_not_found';
    if (this.roomCreatorSession !== session || !session.isHost) return 'not_owner';
    session.isHost = false;
    session.gameId = null;
    session.seatId = null;
    session.lastAccessAt = Date.now();
    this.roomCreatorSession = null;
    this.roomId = null;
    return 'closed';
  }

  findBearer(header: unknown): SessionRecord | null {
    if (typeof header !== 'string') return null;
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) return null;
    this.pruneExpired();
    const session = this.sessionsByHash.get(this.hash(match[1])) ?? null;
    if (session) session.lastAccessAt = Date.now();
    return session;
  }

  bindSeat(session: SessionRecord, gameId: string, seatId: string): void { session.gameId = gameId; session.seatId = seatId; session.lastAccessAt = Date.now(); }
  bindGame(session: SessionRecord, gameId: string): void { session.gameId = gameId; session.seatId = null; session.lastAccessAt = Date.now(); }

  clearGame(gameId?: string): void {
    for (const session of this.sessionsByHash.values()) {
      if (gameId === undefined || session.gameId === gameId) { session.gameId = null; session.seatId = null; }
    }
  }

  hasRoom(): boolean { return !!this.roomCreatorSession && !!this.roomId; }
  getRoomId(): string | null { return this.roomId; }
  getRoomCreator(): SessionRecord | null { return this.roomCreatorSession; }
  isRoomCreator(session: SessionRecord): boolean {
    return this.roomCreatorSession === session && session.isHost;
  }

  get size(): number { return this.sessionsByHash.size; }

  private hasSession(candidate: SessionRecord): boolean {
    for (const session of this.sessionsByHash.values()) if (session === candidate) return true;
    return false;
  }

  private pruneExpired(): void {
    if (this.idleTtlMs === 0) return;
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [hash, session] of this.sessionsByHash) {
      if (!session.isHost && session.lastAccessAt < cutoff && !session.gameId) this.sessionsByHash.delete(hash);
    }
  }

  private hash(token: string): string { return createHash('sha256').update(token, 'utf8').digest('hex'); }
}
