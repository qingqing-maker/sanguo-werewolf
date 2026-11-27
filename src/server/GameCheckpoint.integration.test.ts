import * as assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { PhaseNode } from '../game/PhaseMachine';
import { EventLog } from './EventLog';
import { GameCheckpointCodec } from './GameCheckpointCodec';
import { WebServer } from './WebServer';

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: any[] = [];
  ws.on('message', raw => inbox.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws,
    inbox,
    send(message: Record<string, unknown>) { ws.send(JSON.stringify(message)); },
    async waitFor(type: string, predicate: (message: any) => boolean = () => true): Promise<any> {
      const find = () => inbox.find(message => message.type === type && predicate(message));
      return find() ?? await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); ws.off('message', check); };
        const check = () => {
          const message = find();
          if (message) { cleanup(); resolve(message); }
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`等待 ${type} 超时`)); }, 8_000);
        ws.on('message', check);
      });
    },
  };
}

async function main(): Promise<void> {
  process.env.LLM_PROVIDER = 'mock';
  process.env.FAST_MODE = '1';
  process.env.TTS_PROVIDER = 'edge';
  const directory = mkdtempSync(path.join(tmpdir(), 'sanguo-checkpoint-'));
  const key = randomBytes(32).toString('base64');
  const ownerToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(ownerToken).digest('hex');
  const codec = new GameCheckpointCodec(key);
  // 两个独立服务使用不同日志目录，新服务只能从浏览器提交的存档恢复原局。
  const old = new WebServer({ checkpointKey: key, eventLog: new EventLog(path.join(directory, 'old')), controlCooldownMs: 0 });
  const fresh = new WebServer({ checkpointKey: key, eventLog: new EventLog(path.join(directory, 'new')), controlCooldownMs: 0 });

  try {
    const oldPort = await old.start(0, '127.0.0.1');
    const owner = await connect(oldPort);
    const spectator = await connect(oldPort);
    owner.send({ type: 'authenticate', token: ownerToken });
    spectator.send({ type: 'authenticate', token: randomBytes(32).toString('base64url') });
    await Promise.all([owner.waitFor('authenticated'), spectator.waitFor('authenticated')]);
    owner.send({ type: 'create_room' });
    await owner.waitFor('session_updated', message => message.data.isHost);

    owner.ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'human_input_required') return;
      const { gameId, requestId, options } = message.data;
      const input = Array.isArray(options.targets) ? { targetId: options.targets[0] }
        : options.type === 'confirm' ? { choice: options.options[0] }
          : { speech: '请各位依规则商议。' };
      owner.send({ type: 'human_input', data: { gameId, requestId, input } });
    });
    owner.send({ type: 'start_game', config: { humanCharacterName: '曹操' } });
    const checkpointMessage = await owner.waitFor('game_checkpoint', message =>
      codec.open(message.data.value, tokenHash)?.checkpoint.nextPhase === PhaseNode.DAWN,
    );
    const saved = codec.open(checkpointMessage.data.value, tokenHash)!;
    assert.equal(checkpointMessage.data.phase, 'dawn');
    assert.equal(checkpointMessage.data.round, 1);
    assert.ok(checkpointMessage.data.savedAt > 0);
    assert.equal(saved.checkpoint.state.round, 1);
    assert.ok(saved.checkpoint.state.nightActions.length > 0, '存档保留已完成的夜间行动');
    assert.ok(saved.checkpoint.agents.some(agent => agent.memory.length > 0), '存档保留 Agent 的私密记忆');
    assert.equal(spectator.inbox.some(message => message.type === 'game_checkpoint'), false);
    owner.send({ type: 'cancel_game' });
    await owner.waitFor('game_cancelled');
    await old.stop();

    const port = await fresh.start(0, '127.0.0.1');
    const wrongOwner = await connect(port);
    wrongOwner.send({ type: 'authenticate', token: randomBytes(32).toString('base64url'), checkpoint: checkpointMessage.data.value });
    const denied = await wrongOwner.waitFor('authenticated');
    assert.equal(denied.data.checkpointStatus, 'invalid');
    assert.equal(denied.data.room.exists, false);

    const lobby = await connect(port);
    lobby.send({ type: 'authenticate', token: ownerToken, checkpoint: checkpointMessage.data.value, deferCheckpoint: true });
    const available = (await lobby.waitFor('authenticated')).data;
    assert.equal(available.checkpointStatus, 'available');
    assert.equal(available.state.isRunning, false);
    assert.equal(available.room.exists, false);

    const restored = await connect(port);
    restored.send({ type: 'authenticate', token: ownerToken, checkpoint: checkpointMessage.data.value });
    const auth = (await restored.waitFor('authenticated')).data;
    assert.equal(auth.checkpointStatus, 'restored');
    assert.equal(auth.state.gameId, saved.checkpoint.gameId);
    assert.equal(auth.state.paused, true);
    assert.equal(auth.state.round, 1);
    assert.equal(auth.isHost, true);
    assert.equal(auth.state.players.find((player: any) => player.name === '曹操').id, auth.seatId);
    assert.deepEqual(auth.publicTimeline, saved.timeline, '恢复时既保留旧历史，也不会把已完成阶段再执行一次');
    assert.equal(auth.stateSequence, saved.sequence);

    restored.send({ type: 'resume_game' });
    const phase = await restored.waitFor('phase_change');
    assert.equal(phase.data.phase, 'dawn');
    assert.ok(phase.sequence > saved.sequence);
    restored.send({ type: 'cancel_game' });
    await restored.waitFor('game_cancelled');

    const repeat = await connect(port);
    repeat.send({ type: 'authenticate', token: ownerToken, checkpoint: checkpointMessage.data.value });
    const ended = await repeat.waitFor('authenticated');
    assert.equal(ended.data.checkpointStatus, 'ended');
    assert.equal(ended.data.state.isRunning, false);
    console.log('对局存档集成测试通过：阶段恢复、角色和主持权限、历史序号、跨会话拒绝和终局清理。');
  } finally {
    await Promise.all([old.stop(), fresh.stop()]);
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
