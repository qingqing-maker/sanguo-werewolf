import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { EventBus } from '../game/EventBus';
import { CURRENT_EVENT_SCHEMA_VERSION, GameUIEvent } from '../game/GameEvents';
import { Faction, RoleType } from '../types';
import { TTSService } from '../tts/TTSService';
import { ITTSProvider, TTSResult, TTSServiceError } from '../tts/TTSProvider';
import { WebServer } from './WebServer';
import { SessionRegistry } from './SessionRegistry';

function token(): string { return randomBytes(32).toString('base64url'); }
function onceMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('等待消息超时')), 2_000);
    ws.once('message', raw => { clearTimeout(timeout); resolve(JSON.parse(raw.toString())); });
  });
}
async function connect(port: number, value: string): Promise<{ ws: WebSocket; auth: any }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'authenticate', token: value }));
  return { ws, auth: await onceMessage(ws) };
}

function replayEvent(type: 'phase_change' | 'human_input_required' | 'player_speak', sequence: number): GameUIEvent {
  const gameId = 'replay-game';
  const base = { schemaVersion: CURRENT_EVENT_SCHEMA_VERSION, sequence, timestamp: sequence };
  if (type === 'phase_change') {
    return { ...base, type, data: { gameId, phase: 'day', round: 1 } } as GameUIEvent;
  }
  if (type === 'human_input_required') {
    return { ...base, type, data: { gameId, requestId: 'private-request', playerId: 'player_1', prompt: '私密', options: {} } } as GameUIEvent;
  }
  return {
    ...base,
    type,
    data: { gameId, playerId: 'player_1', playerName: '诸葛亮', title: '卧龙', innerThoughts: '私密心声', publicSpeech: '公开发言', round: 1 },
  } as GameUIEvent;
}

class FakeEventLog {
  loadCalls = 0;
  latest: { gameId: string; events: GameUIEvent[] } | null = null;
  activeEvents: GameUIEvent[] = [];
  record(): void {}
  loadEvents(gameId: string): GameUIEvent[] {
    return this.latest?.gameId === gameId ? [...this.latest.events] : [...this.activeEvents];
  }
  loadLatestEvents(): { gameId: string; events: GameUIEvent[] } | null {
    this.loadCalls++;
    return this.latest;
  }
}

async function collectMessagesUntil(ws: WebSocket, terminalType: string): Promise<any[]> {
  return await new Promise((resolve, reject) => {
    const messages: any[] = [];
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`等待 ${terminalType} 超时`)); }, 2_000);
    const onMessage = (raw: any) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === terminalType) { cleanup(); resolve(messages); }
    };
    const cleanup = () => { clearTimeout(timeout); ws.off('message', onMessage); };
    ws.on('message', onMessage);
  });
}

class FakeTTSProvider implements ITTSProvider {
  readonly name = 'offline-fake';
  calls = 0;
  isConfigured(): boolean { return true; }
  isAvailable(): boolean { return true; }
  isQuotaExhausted(): boolean { return false; }
  getQuotaReason(): string { return 'secret upstream quota detail'; }
  resetQuota(): void {}
  async synthesize(text: string, playerName: string): Promise<TTSResult> {
    this.calls++;
    return { audio: Buffer.from(`offline:${playerName}:${text}`), durationMs: 1 };
  }
}

class FakeController {
  state: any = { isRunning: false, paused: false, provider: 'mock', model: 'mock', gameId: null, phase: null, round: 0, players: [], aiDifficulty: 'standard', humanCharacterName: null };
  pending: any = null;
  busy = false;
  presentationAvailable = false;
  presented: Array<{ gameId: string; sequence: number }> = [];
  startGame(config: any, initialized?: (gameId: string, players: any[]) => void): Promise<void> {
    if (this.busy) throw new Error('GAME_BUSY');
    this.state = {
      ...this.state, isRunning: true, gameId: 'game-test', phase: 'night',
      players: [
        { id: 'player_1', name: config?.humanCharacterName || '诸葛亮', title: '卧龙', roleType: RoleType.SEER, faction: Faction.GOOD, isAlive: true },
        { id: 'player_2', name: '曹操', title: '奸雄', roleType: RoleType.WEREWOLF, faction: Faction.WOLF, isAlive: true },
      ],
    };
    initialized?.('game-test', this.state.players);
    return Promise.resolve();
  }
  getState(): any { return { ...this.state, players: this.state.players.map((p: any) => ({ ...p })) }; }
  getPlayers(): any[] { return this.state.players.map((p: any) => ({ ...p })); }
  getPendingHumanInput(): any { return this.pending && { ...this.pending, options: { ...this.pending.options } }; }
  getSeatPrivateSnapshot(seatId: string): any {
    const player = this.state.players.find((p: any) => p.id === seatId);
    return player ? { seatId, roleType: player.roleType, faction: player.faction, seerResults: [], pendingInput: this.pending?.playerId === seatId ? this.getPendingHumanInput() : null } : null;
  }
  handleHumanInput(gameId: string, requestId: string, seatId: string, input: any): any {
    if (!this.pending) return { accepted: false, reason: 'no_pending_input' };
    if (gameId !== this.pending.gameId) return { accepted: false, reason: 'wrong_game' };
    if (requestId !== this.pending.requestId) return { accepted: false, reason: 'wrong_request' };
    if (seatId !== this.pending.playerId) return { accepted: false, reason: 'wrong_seat' };
    this.pending = null;
    return { accepted: true, input };
  }
  setPresentationClientAvailable(available: boolean): void { this.presentationAvailable = available; }
  handleSpeechPresented(gameId: string, sequence: number): boolean {
    this.presented.push({ gameId, sequence });
    return true;
  }
  getPendingPresentationSequence(): number | null { return null; }
  pauseGame(): void { this.state.paused = true; }
  resumeGame(): void { this.state.paused = false; }
  cancelGame(): void { this.state.isRunning = false; }
}

async function main(): Promise<void> {
  const eventBus = new EventBus();
  const controller = new FakeController();
  const eventLog = new FakeEventLog();
  const ttsProvider = new FakeTTSProvider();
  const ttsService = new TTSService({ provider: ttsProvider, sessionRequestLimit: 1, ipRequestLimit: 100 });
  const server = new WebServer({ port: 0, controller: controller as any, eventLog: eventLog as any, authTimeoutMs: 500,
    ttsService, eventBus });
  const port = await server.start(0);
  const hostToken = token();
  const guestToken = token();
  const host = await connect(port, hostToken);
  const sameHost = await connect(port, hostToken);
  const guest = await connect(port, guestToken);
  assert.equal(host.auth.type, 'authenticated');
  assert.equal(host.auth.data.isHost, false);
  assert.equal(host.auth.data.room.exists, false);
  assert.equal(host.auth.data.capabilities.createRoom, true);
  assert.equal(sameHost.auth.data.sessionId, host.auth.data.sessionId, '同 token 多连接共享会话');
  assert.equal(guest.auth.data.isHost, false);

  const hostRoomMessages = collectMessagesUntil(host.ws, 'room_state');
  const sameHostRoomMessages = collectMessagesUntil(sameHost.ws, 'room_state');
  const guestRoomMessages = collectMessagesUntil(guest.ws, 'room_state');
  host.ws.send(JSON.stringify({ type: 'create_room' }));
  for (const messages of [await hostRoomMessages, await sameHostRoomMessages]) {
    assert.deepEqual(messages.map(message => message.type), ['session_updated', 'room_state']);
    assert.equal(messages[0].data.isHost, true);
    assert.equal(messages[0].data.capabilities.startGame, true);
    assert.equal(messages[1].data.isCreator, true);
  }
  const guestRoomState = (await guestRoomMessages)[0];
  assert.equal(guestRoomState.data.exists, true);
  assert.equal(guestRoomState.data.isCreator, false);
  assert.equal(guestRoomState.data.capabilities.createRoom, false);

  guest.ws.send(JSON.stringify({ type: 'pause_game' }));
  assert.equal((await onceMessage(guest.ws)).data.reason, 'forbidden');
  const hostUpdated = onceMessage(host.ws);
  const sameHostUpdated = onceMessage(sameHost.ws);
  host.ws.send(JSON.stringify({ type: 'start_game', config: { humanCharacterName: '诸葛亮' } }));
  assert.equal((await hostUpdated).data.seatId, 'player_1', '发起连接应收到服务端权威座位');
  assert.equal((await sameHostUpdated).data.seatId, 'player_1', '同 token 连接应同步服务端权威座位');
  assert.equal(controller.presentationAvailable, true, '主持人连接后应启用浏览器发言回执');

  guest.ws.send(JSON.stringify({ type: 'speech_presented', data: { gameId: 'game-test', sequence: 7 } }));
  assert.equal((await onceMessage(guest.ws)).data.reason, 'forbidden', '非主持人不得伪造播放完成回执');
  host.ws.send(JSON.stringify({ type: 'speech_presented', data: { gameId: 'game-test', sequence: 7 } }));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(controller.presented.at(-1), { gameId: 'game-test', sequence: 7 });

  controller.pending = { gameId: 'game-test', requestId: 'request-1', playerId: 'player_1', prompt: '请选择', options: { targets: ['player_2'] } };
  const hostPrivate = onceMessage(host.ws);
  const samePrivate = onceMessage(sameHost.ws);
  eventBus.runWithGameId('game-test', async () => eventBus.emit('human_input_required', { requestId: 'request-1', playerId: 'player_1', prompt: '请选择', options: { targets: ['player_2'] } }));
  const firstPrivate = await hostPrivate;
  const secondPrivate = await samePrivate;
  assert.equal(firstPrivate.type, 'human_input_required');
  assert.equal(firstPrivate.sequence, 1);
  assert.equal(secondPrivate.type, 'human_input_required', '同 token 双连接均可看 owner 私密事件');
  assert.equal(secondPrivate.sequence, firstPrivate.sequence, '同一源事件对不同连接必须保留相同 sequence');

  guest.ws.send(JSON.stringify({ type: 'human_input', data: { gameId: 'game-test', requestId: 'request-1', input: { targetId: 'player_2' } } }));
  assert.equal((await onceMessage(guest.ws)).data.accepted, false);
  assert.ok(controller.pending, '伪造输入不得消费 pending');
  host.ws.send(JSON.stringify({ type: 'human_input', data: { gameId: 'game-test', requestId: 'request-1', input: { targetId: 'player_2' } } }));
  assert.equal((await onceMessage(host.ws)).data.accepted, true);
  sameHost.ws.send(JSON.stringify({ type: 'human_input', data: { gameId: 'game-test', requestId: 'request-1', input: { targetId: 'player_2' } } }));
  assert.equal((await onceMessage(sameHost.ws)).data.accepted, false, '第二次输入应 stale');

  controller.pending = { gameId: 'game-test', requestId: 'request-2', playerId: 'player_1', prompt: '恢复', options: {} };
  host.ws.close();
  const reconnected = await connect(port, hostToken);
  assert.equal(reconnected.auth.data.pendingInput.requestId, 'request-2', '重连应恢复 pending');
  assert.equal(reconnected.auth.data.stateSequence, 1, '重连快照应携带当前局最新权威 sequence');

  // 活动局即使有磁盘历史也不得读取或发送 replay。
  eventLog.latest = { gameId: 'replay-game', events: [replayEvent('phase_change', 1)] };
  const loadCallsBeforeRunningAuth = eventLog.loadCalls;
  const runningReconnect = await connect(port, token());
  assert.equal(runningReconnect.auth.data.hasReplay, false);
  assert.equal(eventLog.loadCalls, loadCallsBeforeRunningAuth, '活动局认证不得读取公共历史');

  const stateResponse = await fetch(`http://127.0.0.1:${port}/api/game/state`);
  const state = await stateResponse.json() as any;
  assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
  assert.equal(state.players[0].roleType, undefined, '匿名 HTTP 不得泄露身份');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/game/pause`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/settings`)).status, 401, '云端设置不得匿名读取');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/game/pause`, { method: 'POST', headers: { Authorization: `Bearer ${guestToken}` } })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/game/pause`, { method: 'POST', headers: { Authorization: `Bearer ${hostToken}` } })).status, 200);

  const ttsAnonymousStatus = await fetch(`http://127.0.0.1:${port}/api/tts/status`);
  assert.equal(ttsAnonymousStatus.status, 401);
  assert.equal(ttsAnonymousStatus.headers.get('cache-control'), 'no-store');
  const ttsStatusResponse = await fetch(`http://127.0.0.1:${port}/api/tts/status`, { headers: { Authorization: `Bearer ${guestToken}` } });
  const ttsStatus = await ttsStatusResponse.json() as any;
  assert.equal(ttsStatusResponse.status, 200);
  assert.equal(ttsStatusResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(ttsStatus, { enabled: true, provider: 'offline-fake', configured: true, quotaExhausted: false });
  assert.equal(JSON.stringify(ttsStatus).includes('secret upstream'), false, 'status 不得泄露 quotaReason');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) })).status, 401);
  const ttsOk = await fetch(`http://127.0.0.1:${port}/api/tts`, {
    method: 'POST', headers: { Authorization: `Bearer ${guestToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '你好', playerName: '诸葛亮' }),
  });
  assert.equal(ttsOk.status, 200);
  assert.equal(ttsOk.headers.get('cache-control'), 'no-store');
  assert.equal(Buffer.from(await ttsOk.arrayBuffer()).toString(), 'offline:诸葛亮:你好');
  assert.equal(ttsProvider.calls, 1, '集成测试只调用注入的离线 provider');
  const ttsLimited = await fetch(`http://127.0.0.1:${port}/api/tts`, {
    method: 'POST', headers: { Authorization: `Bearer ${guestToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '再次' }),
  });
  assert.equal(ttsLimited.status, 429);
  assert.equal(ttsLimited.headers.get('retry-after'), '60');
  assert.deepEqual(await ttsLimited.json(), { success: false, reason: 'tts_rate_limited' });

  const stableMappings: Array<[string, number]> = [['invalid_message', 400], ['tts_concurrency_limited', 429], ['tts_budget_exhausted', 402], ['tts_quota_exhausted', 402], ['tts_timeout', 503], ['tts_provider_unavailable', 503]];
  for (const [reason, expectedStatus] of stableMappings) {
    const mapped = new TTSService({ provider: ttsProvider });
    (mapped as any).synthesize = async () => { throw new TTSServiceError(reason as any, 'internal provider message', reason === 'tts_concurrency_limited' ? 7 : undefined); };
    (server as any).ttsService = mapped;
    const response = await fetch(`http://127.0.0.1:${port}/api/tts`, {
      method: 'POST', headers: { Authorization: `Bearer ${hostToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'mapping' }),
    });
    assert.equal(response.status, expectedStatus, reason);
    assert.deepEqual(await response.json(), { success: false, reason });
    assert.equal(response.headers.get('retry-after'), reason === 'tts_concurrency_limited' ? '7' : null);
  }
  (server as any).ttsService = ttsService;

  controller.busy = true;
  const previousState = controller.getState();
  const busyStart = await fetch(`http://127.0.0.1:${port}/api/game/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hostToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { humanCharacterName: '诸葛亮' } }),
  });
  assert.equal(busyStart.status, 409, 'HTTP start busy 应准确返回冲突状态');
  assert.deepEqual(await busyStart.json(), { success: false, reason: 'busy' });
  assert.deepEqual(controller.getState(), previousState, 'busy start 不得清理或改写当前游戏');

  const sessionBeforeBusy = reconnected.auth.data.sessionId;
  const afterBusy = await connect(port, hostToken);
  assert.equal(afterBusy.auth.data.sessionId, sessionBeforeBusy);
  assert.equal(afterBusy.auth.data.seatId, 'player_1', 'WebSocket busy start 不得提前 clearGame');
  const busyError = onceMessage(afterBusy.ws);
  afterBusy.ws.send(JSON.stringify({ type: 'start_game', config: { humanCharacterName: '诸葛亮' } }));
  assert.equal((await busyError).data.reason, 'busy');

  for (const ws of [sameHost.ws, guest.ws, reconnected.ws, runningReconnect.ws, afterBusy.ws]) ws.close();
  await server.stop();
  // stop 已退订，之后派发不应触发已关闭连接或抛错。
  eventBus.emit('game_paused', {});
  assert.equal(CURRENT_EVENT_SCHEMA_VERSION, 1);

  // 空闲服务器：真实 WebSocket 必须按 authenticated → replay_start → 公共事件 → replay_end 发送。
  const replayBus = new EventBus();
  const replayController = new FakeController();
  replayController.state.isRunning = false;
  replayController.state.gameId = null;
  const replayLog = new FakeEventLog();
  replayLog.latest = {
    gameId: 'replay-game',
    events: [
      replayEvent('phase_change', 1),
      replayEvent('human_input_required', 2),
      replayEvent('player_speak', 3),
    ],
  };
  const replayServer = new WebServer({
    port: 0, controller: replayController as any, eventLog: replayLog as any,
    authTimeoutMs: 500,
    ttsService, eventBus: replayBus,
  });
  const replayPort = await replayServer.start(0);
  const replayWs = new WebSocket(`ws://127.0.0.1:${replayPort}`);
  await new Promise<void>((resolve, reject) => { replayWs.once('open', resolve); replayWs.once('error', reject); });
  const replayTranscript = collectMessagesUntil(replayWs, 'replay_end');
  replayWs.send(JSON.stringify({ type: 'authenticate', token: token() }));
  const transcript = await replayTranscript;
  assert.deepEqual(transcript.map(message => message.type), [
    'authenticated', 'replay_start', 'phase_change', 'player_speak', 'replay_end',
  ]);
  assert.equal(transcript[0].data.hasReplay, true);
  assert.equal(transcript[0].data.replayGameId, 'replay-game');
  assert.equal(transcript[1].data.count, 2, 'count 必须等于过滤后的公共事件数');
  assert.deepEqual(transcript.slice(2, -1).map(message => message.sequence), [1, 3], '过滤私密事件允许 sequence 有空洞但顺序必须保持');
  assert.equal(JSON.stringify(transcript).includes('私密心声'), false, '公共回放不得包含内心信息');
  replayWs.close();
  await replayServer.stop();

  // SessionRegistry 容量拒绝：先发稳定 invalid_token，再以 4002 终止。
  const limitedSessions = new SessionRegistry({ maxSessions: 1, idleTtlMs: 0 });
  limitedSessions.authenticate(token());
  const rejectServer = new WebServer({
    port: 0, controller: new FakeController() as any, eventLog: new FakeEventLog() as any,
    authTimeoutMs: 500, sessionRegistry: limitedSessions,
    ttsService, eventBus: new EventBus(),
  });
  const rejectPort = await rejectServer.start(0);
  const rejectedWs = new WebSocket(`ws://127.0.0.1:${rejectPort}`);
  await new Promise<void>((resolve, reject) => { rejectedWs.once('open', resolve); rejectedWs.once('error', reject); });
  const rejectedMessage = onceMessage(rejectedWs);
  const rejectedClose = new Promise<number>((resolve) => rejectedWs.once('close', code => resolve(code)));
  rejectedWs.send(JSON.stringify({ type: 'authenticate', token: token() }));
  assert.equal((await rejectedMessage).data.reason, 'invalid_token');
  assert.equal(await rejectedClose, 4002);
  await rejectServer.stop();

  console.log('WebServer WebSocket/HTTP 集成测试通过');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
