import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { RoomServer } from './RoomServer';

const token = () => randomBytes(32).toString('base64url');

async function connect(origin: string, value: string, roomId?: string, checkpoint?: string) {
  const url = new URL(origin.replace('http:', 'ws:'));
  if (roomId) url.searchParams.set('room', roomId);
  const socket = new WebSocket(url, { handshakeTimeout: 2_000 });
  const inbox: any[] = [];
  socket.on('message', data => inbox.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const send = (command: object) => socket.send(JSON.stringify(command));
  async function waitFor(type: string, test: (event: any) => boolean = () => true): Promise<any> {
    const find = () => inbox.find(event => event.type === type && test(event));
    if (find()) return find();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`等待 ${type} 超时`)); }, 5_000);
      const cleanup = () => { clearTimeout(timeout); socket.off('message', check); };
      const check = () => { const event = find(); if (event) { cleanup(); resolve(event); } };
      socket.on('message', check);
    });
  }
  send({ type: 'authenticate', token: value, ...(checkpoint ? { checkpoint } : {}) });
  const auth = (await waitFor('authenticated')).data;
  return { socket, inbox, auth, waitFor, send };
}

async function create(origin: string, value: string, checkpoint?: string) {
  const res = await fetch(`${origin}/api/rooms`, {
    method: 'POST', headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(checkpoint ? { checkpoint } : {}),
  });
  return { status: res.status, body: await res.json() as { roomId: string; reason?: string } };
}

async function main(): Promise<void> {
  process.env.LLM_PROVIDER = 'mock';
  process.env.FAST_MODE = '0';
  process.env.PACING_SCALE = '0.15';
  process.env.TTS_PROVIDER = 'edge';
  const logDirectory = mkdtempSync(path.join(tmpdir(), 'sanguo-room-test-'));
  const options = { checkpointKey: token(), maxRooms: 2, logDirectory };
  const server = new RoomServer(options);
  const fresh = new RoomServer(options);
  try {
    const origin = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`;
    const firstToken = token();
    const secondToken = token();
    const [first, second] = await Promise.all([create(origin, firstToken), create(origin, secondToken)]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.roomId, second.body.roomId);
    assert.equal((await create(origin, firstToken)).body.roomId, first.body.roomId);
    assert.equal((await create(origin, token())).body.reason, 'rooms_full');

    const hostA = await connect(origin, firstToken, first.body.roomId);
    const hostB = await connect(origin, secondToken, second.body.roomId);
    const guest = await connect(origin, firstToken, second.body.roomId);
    const lobby = await connect(origin, token());
    assert.equal(hostA.auth.isHost, true);
    assert.equal(hostB.auth.isHost, true);
    assert.equal(guest.auth.isHost, false, '房间 A 的主持人访问 B 只能观战');
    assert.equal(lobby.auth.room.exists, false);
    lobby.send({ type: 'create_room' });
    assert.equal((await lobby.waitFor('error')).data.reason, 'forbidden');

    hostA.send({ type: 'start_game', config: { humanCharacterName: '曹操' } });
    hostB.send({ type: 'start_game' });
    const [startA, startB] = await Promise.all([hostA.waitFor('game_start'), hostB.waitFor('game_start')]);
    assert.notEqual(startA.data.gameId, startB.data.gameId);
    const observed = await guest.waitFor('game_start');
    assert.equal(observed.data.gameId, startB.data.gameId);
    assert.ok(observed.data.players.every((player: any) => !player.roleType));
    assert.ok(!lobby.inbox.some(event => event.type === 'game_start'));
    const save = await hostA.waitFor('game_checkpoint');
    assert.equal(save.data.roomId, first.body.roomId);
    assert.ok(!hostB.inbox.some(event => event.data?.gameId === startA.data.gameId));
    assert.ok(!guest.inbox.some(event => event.type === 'game_checkpoint'));
    assert.equal((await create(origin, secondToken, save.data.value)).body.reason, 'invalid_checkpoint');

    guest.send({ type: 'pause_game' });
    assert.equal((await guest.waitFor('error')).data.reason, 'forbidden');
    hostA.send({ type: 'pause_game' });
    await hostA.waitFor('game_paused');
    const stateA = await (await fetch(`${origin}/api/game/state?room=${first.body.roomId}`)).json() as any;
    const stateB = await (await fetch(`${origin}/api/game/state?room=${second.body.roomId}`)).json() as any;
    assert.equal(stateA.paused, true);
    assert.equal(stateB.paused, false);
    assert.equal(stateB.gameId, startB.data.gameId);
    assert.ok(!hostB.inbox.some(event => event.type === 'game_paused'));
    const settings = await fetch(`${origin}/api/settings?room=${first.body.roomId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${firstToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { LLM_PROVIDER: 'volcengine' } }),
    });
    assert.equal(settings.status, 404);
    await server.stop();

    const restarted = `http://127.0.0.1:${await fresh.start(0, '127.0.0.1')}`;
    const missing = await connect(restarted, token(), first.body.roomId);
    assert.equal(missing.auth.room.exists, false);
    const allocated = await create(restarted, firstToken, save.data.value);
    assert.equal(allocated.body.roomId, first.body.roomId, '恢复后原观战链接继续有效');
    const restored = await connect(restarted, firstToken, allocated.body.roomId, save.data.value);
    assert.equal(restored.auth.checkpointStatus, 'restored');
    assert.equal(restored.auth.state.gameId, startA.data.gameId);
    assert.equal(restored.auth.state.paused, true);
    assert.equal(restored.auth.state.players.find((player: any) => player.id === restored.auth.seatId).name, '曹操');
    const invited = await connect(restarted, secondToken, first.body.roomId);
    assert.equal(invited.auth.state.gameId, startA.data.gameId);
    assert.equal(invited.auth.seatId, null);
    assert.ok(invited.auth.state.players.every((player: any) => !player.roleType));
    console.log('多房间集成测试通过：同时开局、权限和事件隔离、容量限制、原链接恢复和隐私投影。');
  } finally {
    await Promise.all([server.stop(), fresh.stop()]);
    rmSync(logDirectory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
