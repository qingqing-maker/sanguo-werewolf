import * as assert from 'node:assert/strict';
import { decodeClientCommand, transportEvent } from './WebProtocol';

async function main(): Promise<void> {
  const token = 'A'.repeat(43);
  assert.deepEqual(decodeClientCommand({ type: 'authenticate', token }), { type: 'authenticate', token });
  assert.deepEqual(decodeClientCommand({ type: 'create_room' }), { type: 'create_room' });
  assert.deepEqual(decodeClientCommand({ type: 'close_room' }), { type: 'close_room' });
  assert.deepEqual(decodeClientCommand({ type: 'ping' }), { type: 'ping' });
  assert.deepEqual(decodeClientCommand({ type: 'pause_game' }), { type: 'pause_game' });
  assert.deepEqual(decodeClientCommand({ type: 'speech_presented', data: { gameId: 'game_1', sequence: 7 } }), {
    type: 'speech_presented', data: { gameId: 'game_1', sequence: 7 },
  });
  assert.deepEqual(decodeClientCommand({ type: 'start_game', config: { humanCharacterName: '诸葛亮', aiDifficulty: 'novice' } }), {
    type: 'start_game', config: { humanCharacterName: '诸葛亮', aiDifficulty: 'novice' },
  });
  assert.deepEqual(decodeClientCommand({ type: 'human_input', data: { gameId: 'game_1', requestId: 'req-1', input: { targetId: 'player_2' } } }), {
    type: 'human_input', data: { gameId: 'game_1', requestId: 'req-1', input: { targetId: 'player_2' } },
  });

  const invalid = [
    null, [], { type: 'authenticate', token: 'short' }, { type: 'ping', extra: true },
    { type: 'create_room', extra: true }, { type: 'close_room', extra: true },
    { type: 'join_game', playerId: 'player_1' }, { type: 'start_game', config: { operator: true } },
    { type: 'human_input', data: { gameId: '../bad', requestId: 'r', input: {} } },
    { type: 'human_input', data: { gameId: 'g', requestId: 'r', input: [], seatId: 'forged' } },
    { type: 'human_input', data: { gameId: 'g', requestId: 'r', input: { text: 'x'.repeat(17_000) } } },
    { type: 'speech_presented', data: { gameId: '../bad', sequence: 1 } },
    { type: 'speech_presented', data: { gameId: 'g', sequence: 0 } },
    { type: 'speech_presented', data: { gameId: 'g', sequence: 1, playerId: 'forged' } },
  ];
  for (const value of invalid) assert.equal(decodeClientCommand(value), null, JSON.stringify(value)?.slice(0, 100));
  const event = transportEvent('pong', {});
  assert.equal(event.schemaVersion, 1);
  assert.equal(typeof event.timestamp, 'number');
  console.log('WebProtocol 离线测试通过');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
