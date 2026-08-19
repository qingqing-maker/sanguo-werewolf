'use strict';

const assert = require('node:assert/strict');
const { createEventSequenceGuard, isValidSequence } = require('./event-sequence.js');

function event(gameId, sequence) {
  return { type: 'phase_change', data: { gameId, phase: 'night', round: 1 }, sequence };
}

const guard = createEventSequenceGuard();
assert.equal(guard.shouldProcess(event('game-a', 1)), true);
assert.equal(guard.shouldProcess(event('game-a', 1)), false, '重复 sequence 必须拒绝');
assert.equal(guard.shouldProcess(event('game-a', 0)), false, '非法 sequence 必须拒绝');
assert.equal(guard.shouldProcess(event('game-a', 3)), true);
assert.equal(guard.shouldProcess(event('game-a', 2)), false, '倒序 sequence 必须拒绝');
assert.equal(guard.shouldProcess(event('game-b', 1)), true, '不同 gameId 使用独立 cursor');
assert.equal(guard.shouldProcess({ type: 'phase_change', data: { gameId: 'legacy' } }), true, 'legacy 可播放');
assert.equal(guard.getCursor('legacy'), 0, 'legacy 不应伪造 cursor');
assert.equal(guard.shouldProcess({ type: 'phase_change', data: {}, sequence: 1 }), false, '带 sequence 的业务事件必须有 gameId');
assert.equal(guard.shouldProcess({ type: 'authenticated', data: {}, sequence: -1 }), true, 'transport 不参与 sequence');
assert.equal(guard.shouldProcess({ type: 'room_state', data: {}, sequence: -1 }), true, 'room transport 不参与 sequence');
assert.equal(guard.shouldProcess({ type: 'llm_alert', data: {}, sequence: 1 }), true, '无 gameId 的进程级 LLM 告警仍需展示');

assert.equal(guard.seed('game-live', 8), true);
assert.equal(guard.shouldProcess(event('game-live', 8)), false, '活动局 stateSequence 应预置 cursor');
assert.equal(guard.shouldProcess(event('game-live', 9)), true);

guard.seed('game-replay', 50);
guard.resetGame('game-replay');
for (const sequence of [1, 2, 3]) assert.equal(guard.shouldProcess(event('game-replay', sequence)), true);
assert.equal(guard.getCursor('game-replay'), 3, '历史 replay 应从头全量重建 cursor');

for (const value of [undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(isValidSequence(value), false);
}
assert.equal(isValidSequence(1), true);

console.log('前端事件 sequence 离线测试通过');
