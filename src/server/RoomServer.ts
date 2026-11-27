import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage } from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { EventLog } from './EventLog';
import { createCheckpointCodec, isCheckpointToken, MAX_CHECKPOINT_LENGTH, ROOM_ID_PATTERN } from './GameCheckpointCodec';
import { SessionRegistry } from './SessionRegistry';
import { WebServer } from './WebServer';

interface HostedRoom {
  server: WebServer;
  ownerHash: string;
  lastHostSeen: number;
}

interface RoomServerOptions {
  maxRooms?: number;
  roomIdleMs?: number;
  checkpointKey?: string;
  logDirectory?: string;
}

/** 一个 HTTP 入口，每个房间持有独立的会话、对局、事件和主持人租约。 */
export class RoomServer {
  private readonly app = express();
  private readonly http = createServer(this.app);
  private readonly rooms = new Map<string, HostedRoom>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly lobby: WebServer;
  private readonly legacyLog: EventLog;
  private readonly logs: string;
  private readonly codec;
  private readonly maxRooms: number;
  private readonly roomIdleMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly options: RoomServerOptions = {}) {
    const roomLimit = options.maxRooms ?? Number(process.env.WEB_MAX_ROOMS || 6);
    if (!Number.isInteger(roomLimit) || roomLimit < 1 || roomLimit > 32) {
      throw new RangeError('WEB_MAX_ROOMS 必须是 1 到 32 的整数');
    }
    this.maxRooms = roomLimit;
    this.roomIdleMs = options.roomIdleMs ?? 30 * 60 * 1_000;
    if (!Number.isSafeInteger(this.roomIdleMs) || this.roomIdleMs < 1) throw new RangeError('roomIdleMs 必须是正整数');
    this.logs = options.logDirectory ?? EventLog.defaultDirectory();
    this.codec = createCheckpointCodec(options.checkpointKey);
    this.legacyLog = new EventLog(this.logs);
    this.lobby = new WebServer({ gateway: {}, eventLog: this.legacyLog, checkpointKey: options.checkpointKey });
    this.app.disable('x-powered-by');

    this.app.get('/healthz', (_request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const activeRooms = [...this.rooms.values()].filter(room => room.server.isGameRunning()).length;
      response.json({
        status: 'ok', roomCreated: this.rooms.size > 0, gameRunning: activeRooms > 0,
        checkpoints: !!this.codec, rooms: this.rooms.size, activeRooms, maxRooms: this.maxRooms,
      });
    });
    this.app.post('/api/rooms', express.json({ limit: MAX_CHECKPOINT_LENGTH + 512 }), (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.header('authorization') ?? '')?.[1];
      if (!SessionRegistry.isValidToken(token) || !token) {
        response.status(401).json({ reason: 'authentication_required' });
        return;
      }
      const checkpoint: unknown = request.body?.checkpoint;
      const ownerHash = createHash('sha256').update(token).digest('hex');
      let requestedRoomId: string | undefined;
      if (checkpoint !== undefined) {
        const saved = isCheckpointToken(checkpoint) && this.codec?.open(checkpoint, ownerHash);
        if (!saved) { response.status(400).json({ reason: 'invalid_checkpoint' }); return; }
        requestedRoomId = saved.roomId;
        const events = requestedRoomId
          ? this.roomLog(requestedRoomId).loadEvents(saved.checkpoint.gameId)
          : this.legacyLog.loadEvents(saved.checkpoint.gameId);
        if (events.some(event => event.type === 'game_end' || event.type === 'game_cancelled')) {
          response.status(409).json({ reason: 'ended_checkpoint' });
          return;
        }
      }
      const existing = [...this.rooms].find(([, room]) => room.ownerHash === ownerHash);
      if (existing) {
        if (requestedRoomId && existing[0] !== requestedRoomId) {
          response.status(409).json({ reason: 'room_exists' });
          return;
        }
        response.json({ roomId: existing[0] });
        return;
      }
      const roomId = requestedRoomId ?? randomUUID();
      if (this.rooms.has(roomId) || this.retiring.has(roomId)) {
        response.status(409).json({ reason: 'room_taken' }); return;
      }
      if (this.rooms.size >= this.maxRooms) {
        response.status(503).json({ reason: 'rooms_full' }); return;
      }

      const server = new WebServer({
        gateway: { roomId, onRoomClosed: () => { setImmediate(() => { void this.retire(roomId); }); } },
        eventLog: this.roomLog(roomId),
        checkpointKey: this.options.checkpointKey,
      });
      if (!server.reserveRoom(token)) {
        void server.stop();
        response.status(500).json({ reason: 'server_error' });
        return;
      }
      this.rooms.set(roomId, { server, ownerHash, lastHostSeen: Date.now() });
      response.status(201).json({ roomId });
    });
    this.app.use((request, response) => {
      const room = this.getRoom(request);
      if (!room && this.getRoomId(request) && request.path.startsWith('/api/')) {
        response.status(404).json({ reason: 'room_not_found' }); return;
      }
      (room?.server ?? this.lobby).handleHttp(request, response);
    });
    this.app.use((error: { status?: number }, _req: express.Request, response: express.Response, _next: express.NextFunction) => {
      const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
      response.status(status).json({ reason: status === 500 ? 'server_error' : 'invalid_message' });
    });
    this.http.on('upgrade', (request, socket, head) => {
      (this.getRoom(request)?.server ?? this.lobby).handleUpgrade(request, socket, head);
    });
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.min(30_000, this.roomIdleMs)).unref();
  }

  private roomLog(roomId: string): EventLog {
    return new EventLog(path.join(this.logs, 'rooms', roomId), 6);
  }

  private getRoomId(request: IncomingMessage): string | null {
    const query = (request.url ?? '').split('?', 2)[1];
    const room = new URLSearchParams(query).get('room');
    return room && ROOM_ID_PATTERN.test(room) ? room : null;
  }

  private getRoom(request: IncomingMessage): HostedRoom | undefined {
    const roomId = this.getRoomId(request);
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [roomId, room] of this.rooms) {
      if (room.server.hasConnectedHost()) room.lastHostSeen = now;
      else {
        const idleLimit = room.server.isGameRunning() ? this.roomIdleMs : Math.min(this.roomIdleMs, 90_000);
        if (now - room.lastHostSeen >= idleLimit) void this.retire(roomId);
      }
    }
  }

  private retire(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return this.retiring.get(roomId) ?? Promise.resolve();
    this.rooms.delete(roomId);
    const closed = room.server.stop()
      .catch(error => console.warn('[RoomServer] 关闭房间失败:', error))
      .finally(() => this.retiring.delete(roomId));
    this.retiring.set(roomId, closed);
    return closed;
  }

  start(port = Number(process.env.PORT || 3000), host?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        this.http.off('error', reject);
        const address = this.http.address() as AddressInfo;
        console.log(`[RoomServer] 服务已启动: http://localhost:${address.port}`);
        resolve(address.port);
      });
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.all([...this.rooms.keys()].map(roomId => this.retire(roomId)));
    await Promise.all(this.retiring.values());
    await this.lobby.stop();
    if (this.http.listening) await new Promise<void>((resolve, reject) => {
      this.http.close(error => error ? reject(error) : resolve());
    });
  }
}
