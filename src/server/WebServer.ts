import express from 'express';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { EventBus, GameEventBus } from '../game/EventBus';
import { GameUIEvent } from '../game/GameEvents';
import { GameController } from './GameController';
import { EventLog } from './EventLog';
import { getTTSService } from '../tts/TTSServiceFactory';
import { TTSService } from '../tts/TTSService';
import { TTSErrorReason, TTSServiceError } from '../tts/TTSProvider';
import { readSettings, writeSettings } from './EnvConfig';
import { resetBudgetLedger } from '../llm/BudgetLedger';
import { projectEventForPublicReplay, projectEventForViewer, projectPlayersForViewer, ViewerContext } from './EventVisibility';
import { SessionRecord, SessionRegistry } from './SessionRegistry';
import { ClientCommand, decodeClientCommand, decodeGameConfig, transportEvent, TransportCapabilities, TransportReasonCode } from './WebProtocol';

interface ConnectionContext {
  ws: WebSocket;
  connectionId: string;
  session: SessionRecord | null;
  authTimer: NodeJS.Timeout | null;
}

export interface WebServerOptions {
  port?: number;
  controller?: GameController;
  eventLog?: EventLog;
  authTimeoutMs?: number;
  sessionRegistry?: SessionRegistry;
  ttsService?: TTSService;
  eventBus?: GameEventBus;
}

/** Express + WebSocket 服务；认证、座位与权限均绑定到服务端会话。 */
export class WebServer {
  private readonly app = express();
  private readonly server = createServer(this.app);
  private readonly wss = new WebSocketServer({ server: this.server });
  private readonly clients = new Set<ConnectionContext>();
  private readonly gameController: GameController;
  private readonly eventLog: EventLog;
  private readonly sessions: SessionRegistry;
  private readonly ttsService: TTSService;
  private readonly eventBus: GameEventBus;
  private readonly authTimeoutMs: number;
  private unsubscribeEventBus: (() => void) | null = null;
  private port: number;
  private nextConnectionId = 1;

  constructor(options: WebServerOptions = {}) {
    this.port = options.port ?? parseInt(process.env.PORT || '3000', 10);
    this.eventBus = options.eventBus ?? new EventBus();
    this.gameController = options.controller ?? new GameController(undefined, this.eventBus);
    this.eventLog = options.eventLog ?? new EventLog();
    this.sessions = options.sessionRegistry ?? new SessionRegistry();
    this.ttsService = options.ttsService ?? getTTSService();
    this.authTimeoutMs = options.authTimeoutMs ?? 5_000;
    this.setupExpress();
    this.setupWebSocket();
    this.unsubscribeEventBus = this.eventBus.onAll(event => this.handleGameEvent(event));
  }

  private setupExpress(): void {
    this.app.disable('x-powered-by');
    if (process.env.TRUST_PROXY === '1') this.app.set('trust proxy', 1);
    this.app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com data:; connect-src 'self' ws: wss:; img-src 'self' data:; " +
        "media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
      next();
    });
    this.app.use(express.json({ limit: '32kb' }));
    this.app.get('/healthz', (_req, res) => {
      const state = this.gameController.getState();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ status: 'ok', roomCreated: this.sessions.hasRoom(), gameRunning: state.isRunning });
    });
    this.app.use(express.static(path.resolve(__dirname, '../../public')));

    const authenticatedOnly: express.RequestHandler = (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      const session = this.sessions.findBearer(req.header('authorization'));
      if (!session) { res.status(401).json({ success: false, reason: 'authentication_required' }); return; }
      next();
    };
    const hostOnly: express.RequestHandler = (req, res, next) => {
      const session = this.sessions.findBearer(req.header('authorization'));
      if (!session) { res.status(401).json({ success: false, reason: 'authentication_required' }); return; }
      if (!session.isHost) { res.status(403).json({ success: false, reason: 'forbidden' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      next();
    };
    const noStore: express.RequestHandler = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };

    this.app.post('/api/game/start', hostOnly, async (req, res) => {
      const rawConfig = req.body?.config;
      const config = decodeGameConfig(rawConfig);
      if (config === null) { res.status(400).json({ success: false, reason: 'invalid_message' }); return; }
      try {
        const run = this.gameController.startGame(rawConfig === undefined ? undefined : config);
        res.json({ success: true, message: '游戏已启动' });
        run.catch(error => console.error('[API] 游戏错误:', error instanceof Error ? error.message : String(error)));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'GAME_BUSY') { res.status(409).json({ success: false, reason: 'busy' }); return; }
        console.error('[API] 游戏错误:', message);
        res.status(500).json({ success: false, reason: 'server_error' });
      }
    });
    this.app.post('/api/game/pause', hostOnly, (_req, res) => { this.gameController.pauseGame(); res.json({ success: true }); });
    this.app.post('/api/game/resume', hostOnly, (_req, res) => { this.gameController.resumeGame(); res.json({ success: true }); });
    this.app.post('/api/game/cancel', hostOnly, (_req, res) => { this.gameController.cancelGame(); res.json({ success: true }); });
    this.app.post('/api/game/join', hostOnly, (_req, res) => res.status(410).json({ success: false, reason: 'deprecated' }));
    this.app.post('/api/game/leave', hostOnly, (_req, res) => res.status(410).json({ success: false, reason: 'deprecated' }));

    this.app.get('/api/game/state', noStore, (_req, res) => {
      const state = this.gameController.getState();
      res.json({ ...state, humanCharacterName: null, players: projectPlayersForViewer(state.players, { kind: 'spectator', omniscient: false }) });
    });
    this.app.get('/api/game/players', noStore, (_req, res) => {
      res.json({ players: projectPlayersForViewer(this.gameController.getPlayers(), { kind: 'spectator', omniscient: false }) });
    });

    this.app.get('/api/tts/status', authenticatedOnly, (_req, res) => {
      res.json(this.ttsService.status());
    });
    this.app.post('/api/tts', authenticatedOnly, async (req, res) => {
      const session = this.sessions.findBearer(req.header('authorization'))!;
      try {
        const result = await this.ttsService.synthesize({
          sessionId: session.sessionId,
          ip: this.requestIp(req),
          text: req.body?.text,
          playerName: typeof req.body?.playerName === 'string' ? req.body.playerName.slice(0, 64) : undefined,
        });
        res.type('audio/mpeg').send(result.audio);
      } catch (error: unknown) {
        const stable = error instanceof TTSServiceError
          ? error
          : new TTSServiceError('tts_provider_unavailable', 'TTS provider 调用失败', undefined, error);
        const status = this.ttsHttpStatus(stable.reason);
        if (stable.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(stable.retryAfterSeconds));
        res.status(status).json({ success: false, reason: stable.reason });
      }
    });

    this.app.get('/api/settings', hostOnly, (_req, res) => {
      try { res.json({ success: true, settings: readSettings() }); }
      catch (error: any) { res.status(500).json({ success: false, error: error.message }); }
    });
    this.app.post('/api/settings', hostOnly, (req, res) => {
      try {
        const updates = req.body?.settings;
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) { res.status(400).json({ success: false, error: '缺少 settings 对象' }); return; }
        const { applied, errors } = writeSettings(updates);
        const budgetKeys = ['LLM_PROVIDER', 'LLM_MODEL_ID', 'LLM_TOKEN_BUDGET', 'LLM_CALL_BUDGET'];
        if (applied.some(key => budgetKeys.includes(key))) resetBudgetLedger();
        res.json({ success: Object.keys(errors).length === 0, applied, errors });
      } catch (error: any) { res.status(500).json({ success: false, error: error.message }); }
    });
    this.app.post('/api/settings/test-mode', hostOnly, (_req, res) => {
      try {
        const current = readSettings();
        const isMock = (current.LLM_PROVIDER?.value || '').toLowerCase() === 'mock';
        const updates = isMock ? { LLM_PROVIDER: 'volcengine', FAST_MODE: '0', TTS_PROVIDER: 'volc' } : { LLM_PROVIDER: 'mock', FAST_MODE: '1', TTS_PROVIDER: 'edge' };
        const { applied, errors } = writeSettings(updates);
        resetBudgetLedger();
        res.json({ success: true, enabled: !isMock, provider: updates.LLM_PROVIDER, testMode: !isMock, applied, errors });
      } catch (error: any) { res.status(500).json({ success: false, error: error.message }); }
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', ws => {
      const context: ConnectionContext = { ws, connectionId: `connection-${this.nextConnectionId++}`, session: null, authTimer: null };
      this.clients.add(context);
      context.authTimer = setTimeout(() => {
        if (!context.session) ws.close(4001, 'authentication required');
      }, this.authTimeoutMs);
      ws.on('message', raw => {
        const rawText = raw.toString();
        if (Buffer.byteLength(rawText, 'utf8') > 32_768) { this.sendError(context, 'invalid_message'); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(rawText); } catch { this.sendError(context, 'invalid_message'); return; }
        const command = decodeClientCommand(parsed);
        if (!command) { this.sendError(context, 'invalid_message'); return; }
        this.handleClientMessage(context, command);
      });
      ws.on('close', () => {
        if (context.authTimer) clearTimeout(context.authTimer);
        this.clients.delete(context);
        this.syncPresentationAvailability();
      });
      ws.on('error', () => { /* close 事件负责清理 */ });
    });
  }

  private handleClientMessage(context: ConnectionContext, command: ClientCommand): void {
    if (command.type === 'ping') { this.send(context, transportEvent('pong', {})); return; }
    if (command.type === 'authenticate') { this.authenticate(context, command.token); return; }
    if (!context.session) { this.sendError(context, 'authentication_required'); return; }
    const session = context.session;
    if (command.type === 'create_room') {
      const result = this.sessions.createRoom(session);
      if (result === 'created' || result === 'already_creator') {
        this.sendToSession(session, transportEvent('session_updated', {
          isHost: true,
          seatId: session.seatId,
          room: this.roomStateFor(session),
          capabilities: this.capabilities(session),
        }));
        this.syncPresentationAvailability();
        this.broadcastRoomState();
      } else {
        this.send(context, transportEvent('room_create_result', { success: false, reason: result }));
      }
      return;
    }
    if (command.type === 'close_room') {
      if (!session.isHost) { this.sendError(context, 'forbidden'); return; }
      if (this.gameController.getState().isRunning) { this.sendError(context, 'busy'); return; }
      const result = this.sessions.closeRoom(session);
      if (result === 'closed') {
        this.sendToSession(session, transportEvent('session_updated', {
          isHost: false,
          seatId: null,
          room: this.roomStateFor(session),
          capabilities: this.capabilities(session),
        }));
        this.syncPresentationAvailability();
        this.broadcastRoomState();
      } else {
        this.send(context, transportEvent('error', { reason: result }));
      }
      return;
    }
    if (command.type === 'human_input') {
      if (!session.seatId || session.gameId !== command.data.gameId) { this.send(context, transportEvent('human_input_result', { accepted: false, reason: 'not_owner' })); return; }
      const result = this.gameController.handleHumanInput(command.data.gameId, command.data.requestId, session.seatId, command.data.input);
      this.send(context, transportEvent('human_input_result', result as unknown as Record<string, unknown>));
      return;
    }
    if (command.type === 'speech_presented') {
      if (!session.isHost) { this.sendError(context, 'forbidden'); return; }
      if (session.gameId !== command.data.gameId) { this.sendError(context, 'wrong_game'); return; }
      this.gameController.handleSpeechPresented(command.data.gameId, command.data.sequence);
      return;
    }
    if (!session.isHost) { this.sendError(context, 'forbidden'); return; }
    switch (command.type) {
      case 'start_game': void this.startForSession(session, command.config, false); break;
      case 'restart_game': void this.startForSession(session, command.config, true); break;
      case 'pause_game': this.gameController.pauseGame(); break;
      case 'resume_game': this.gameController.resumeGame(); break;
      case 'cancel_game': this.gameController.cancelGame(); break;
    }
  }

  private authenticate(context: ConnectionContext, token: string): void {
    if (context.session) { this.sendError(context, 'invalid_message'); return; }
    const session = this.sessions.authenticate(token);
    if (!session) { this.sendError(context, 'invalid_token'); context.ws.close(4002, 'invalid token'); return; }
    context.session = session;
    if (context.authTimer) { clearTimeout(context.authTimer); context.authTimer = null; }
    const state = this.gameController.getState();
    const viewer = this.viewerFor(session);
    const privateSnapshot = session.seatId ? this.gameController.getSeatPrivateSnapshot(session.seatId) : null;
    const replay = state.isRunning ? null : this.getPublicReplay();
    const speechHistory = state.isRunning && state.gameId ? this.getActiveSpeechHistory(state.gameId) : [];
    this.send(context, transportEvent('authenticated', {
      sessionId: session.sessionId,
      isHost: session.isHost,
      seatId: session.seatId,
      room: this.roomStateFor(session),
      capabilities: this.capabilities(session),
      state: { ...state, humanCharacterName: null, players: projectPlayersForViewer(state.players, viewer) },
      privateSnapshot,
      pendingInput: privateSnapshot?.pendingInput ?? null,
      stateSequence: state.gameId ? this.eventBus.getLatestSequence(state.gameId) : 0,
      hasReplay: !!replay?.events.length,
      replayGameId: replay?.gameId ?? null,
      speechHistory,
      pendingPresentationSequence: this.gameController.getPendingPresentationSequence(),
    }));
    this.syncPresentationAvailability();
    if (replay?.events.length) {
      this.send(context, transportEvent('replay_start', { gameId: replay.gameId, count: replay.events.length }));
      for (const event of replay.events) this.send(context, event);
      this.send(context, transportEvent('replay_end', { gameId: replay.gameId }));
    }
  }

  private async startForSession(session: SessionRecord, config?: Record<string, unknown>, restart = false): Promise<void> {
    const initialize = (gameId: string, players: ReturnType<GameController['getPlayers']>) => {
      // start/restart 已被控制器接受且新引擎已初始化后，才清理旧局绑定。
      this.sessions.clearGame();
      const name = typeof config?.humanCharacterName === 'string' ? config.humanCharacterName : null;
      const seat = name ? players.find(player => player.name === name) : null;
      if (seat) this.sessions.bindSeat(session, gameId, seat.id);
      else this.sessions.bindGame(session, gameId);
      // 绑定发生在 game_start 投影之前；立即把服务端权威座位和新能力同步到同 token 的全部连接。
      this.sendToSession(session, transportEvent('session_updated', {
        seatId: session.seatId,
        room: this.roomStateFor(session),
        capabilities: this.capabilities(session),
      }));
    };
    try {
      const run = restart
        ? this.gameController.restartGame(config, initialize)
        : this.gameController.startGame(config, initialize);
      await run;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const reason: TransportReasonCode = message === 'GAME_BUSY' ? 'busy' : 'server_error';
      this.sendToSession(session, transportEvent('error', { reason, ...(reason === 'server_error' ? { message } : {}) }));
    }
  }

  private handleGameEvent(source: GameUIEvent): void {
    const publicReplay = projectEventForPublicReplay(source);
    if (publicReplay) this.eventLog.record(publicReplay);
    for (const context of this.clients) {
      if (!context.session) continue;
      const projected = projectEventForViewer(source, this.viewerFor(context.session));
      if (projected) this.send(context, projected);
    }
    if (source.type === 'game_end' || source.type === 'game_cancelled') this.sessions.clearGame(source.data.gameId);
  }

  private viewerFor(session: SessionRecord): ViewerContext {
    if (session.seatId && session.gameId === this.gameController.getState().gameId) {
      const player = this.gameController.getPlayers().find(candidate => candidate.id === session.seatId);
      return player?.faction ? { kind: 'player', seatId: session.seatId, faction: player.faction } : { kind: 'player', seatId: session.seatId };
    }
    const currentGameId = this.gameController.getState().gameId;
    return { kind: 'spectator', omniscient: !!(session.isHost && session.gameId && session.gameId === currentGameId) };
  }

  private capabilities(session: SessionRecord): TransportCapabilities {
    const pending = session.seatId ? this.gameController.getPendingHumanInput() : null;
    const state = this.gameController.getState();
    return {
      createRoom: !this.sessions.hasRoom(),
      closeRoom: session.isHost,
      startGame: session.isHost, pauseGame: session.isHost, resumeGame: session.isHost,
      cancelGame: session.isHost, restartGame: session.isHost,
      humanInput: !!(pending && pending.playerId === session.seatId && pending.gameId === session.gameId),
    };
  }

  private requestIp(req: express.Request): string {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  private ttsHttpStatus(reason: TTSErrorReason): number {
    switch (reason) {
      case 'authentication_required': return 401;
      case 'invalid_message': return 400;
      case 'tts_rate_limited': case 'tts_concurrency_limited': return 429;
      case 'tts_budget_exhausted': case 'tts_quota_exhausted': return 402;
      case 'tts_timeout': case 'tts_provider_unavailable': return 503;
    }
  }

  private getPublicReplay(): { gameId: string; events: GameUIEvent[] } | null {
    const replay = this.eventLog.loadLatestEvents();
    if (!replay) return null;
    const events: GameUIEvent[] = [];
    for (const source of replay.events) {
      try {
        const projected = projectEventForPublicReplay(source);
        if (!projected) continue;
        // 同时验证最终传输对象可序列化；单条坏日志不能阻断认证恢复。
        JSON.stringify(projected);
        events.push(projected);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[WebServer] 跳过无法投影的回放事件 ${source.type}: ${message}`);
      }
    }
    return { gameId: replay.gameId, events };
  }

  private sendError(context: ConnectionContext, reason: TransportReasonCode): void {
    this.send(context, transportEvent('error', { reason }));
  }
  private sendToSession(session: SessionRecord, event: ReturnType<typeof transportEvent>): void {
    for (const context of this.clients) if (context.session === session) this.send(context, event);
  }

  /** 活动局刷新/新观众进入时，仅补发公开发言历史；历史恢复不重播已完成的 TTS。 */
  private getActiveSpeechHistory(gameId: string): GameUIEvent[] {
    const speechTypes = new Set(['player_speak', 'sheriff_speech', 'sheriff_pk_speech', 'sheriff_final_speech']);
    return this.eventLog.loadEvents(gameId).filter(event => speechTypes.has(event.type));
  }

  private syncPresentationAvailability(): void {
    const available = [...this.clients].some(context =>
      !!context.session?.isHost && context.ws.readyState === WebSocket.OPEN
    );
    this.gameController.setPresentationClientAvailable(available);
  }
  private roomStateFor(session: SessionRecord): Record<string, unknown> {
    return {
      exists: this.sessions.hasRoom(),
      roomId: this.sessions.getRoomId(),
      isCreator: this.sessions.isRoomCreator(session),
    };
  }
  private broadcastRoomState(): void {
    for (const context of this.clients) {
      if (!context.session) continue;
      this.send(context, transportEvent('room_state', {
        ...this.roomStateFor(context.session),
        capabilities: this.capabilities(context.session),
      }));
    }
  }
  private send(context: ConnectionContext, event: object): void {
    if (context.ws.readyState === WebSocket.OPEN) context.ws.send(JSON.stringify(event));
  }

  /** 启动服务并返回实际端口；port=0 可用于集成测试。 */
  start(port = this.port): Promise<number> {
    if (this.server.listening) return Promise.resolve((this.server.address() as AddressInfo).port);
    this.port = port;
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(port, () => {
        this.server.off('error', onError);
        const actualPort = (this.server.address() as AddressInfo).port;
        console.log(`[WebServer] 服务已启动: http://localhost:${actualPort}`);
        resolve(actualPort);
      });
    });
  }

  /** 关闭连接、监听器与 HTTP 服务；可重复调用。 */
  async stop(): Promise<void> {
    this.unsubscribeEventBus?.();
    this.unsubscribeEventBus = null;
    for (const context of this.clients) {
      if (context.authTimer) clearTimeout(context.authTimer);
      context.ws.terminate();
    }
    this.clients.clear();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
    if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }

  async dispose(): Promise<void> { await this.stop(); }
}
