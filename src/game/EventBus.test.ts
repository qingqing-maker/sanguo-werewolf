import * as assert from 'node:assert/strict';
import { EventBus } from './EventBus';
import { CURRENT_EVENT_SCHEMA_VERSION, GameUIEvent } from './GameEvents';
import { LLMCircuitBreaker } from '../llm/LLMCircuitBreaker';

async function main(): Promise<void> {
  const bus = new EventBus();
  const all: GameUIEvent[] = [];
  let specificCalls = 0;

  bus.on('phase_change', event => {
    specificCalls++;
    assert.equal(event.data.phase, 'night');
    assert.equal(event.data.round, 2);
  });
  bus.onAll(event => all.push(event));

  await bus.runWithGameId('game-event-bus', async () => {
    bus.emit('phase_change', { phase: 'night', round: 2 });
  });

  assert.equal(specificCalls, 1, '特定订阅应同步调用一次');
  assert.equal(all.length, 1, '全局订阅应收到事件');
  assert.equal(all[0].schemaVersion, CURRENT_EVENT_SCHEMA_VERSION);
  assert.equal(all[0].data.gameId, 'game-event-bus');
  assert.equal(all[0].sequence, 1);
  assert.equal(bus.getLatestSequence('game-event-bus'), 1);
  assert.equal(typeof all[0].timestamp, 'number');

  const calls: string[] = [];
  let unsubscribeSecond = () => {};
  const unsubscribeFirst = bus.on('game_paused', () => {
    calls.push('first');
    unsubscribeSecond();
  });
  unsubscribeSecond = bus.on('game_paused', () => calls.push('second'));
  const unsubscribeAll = bus.onAll(event => {
    if (event.type === 'game_paused') calls.push('all');
  });
  bus.emit('game_paused', {});
  assert.deepEqual(calls, ['first', 'second', 'all'], '同次派发应使用订阅快照');
  calls.length = 0;
  bus.emit('game_paused', {});
  assert.deepEqual(calls, ['first', 'all'], '退订应从后续派发生效');
  unsubscribeFirst();
  unsubscribeFirst();
  unsubscribeSecond();
  unsubscribeAll();
  unsubscribeAll();
  calls.length = 0;
  bus.emit('game_paused', {});
  assert.deepEqual(calls, [], '退订函数应幂等');

  const allBeforeClear = all.length;
  bus.clear();
  bus.emit('game_paused', {});
  assert.equal(all.length, allBeforeClear, 'clear 后不应再调用旧订阅');

  // AsyncLocalStorage 必须按实例隔离：A 的上下文不能给 B 自动补 gameId。
  const busA = new EventBus();
  const busB = new EventBus();
  const eventsA: GameUIEvent[] = [];
  const eventsB: GameUIEvent[] = [];
  busA.onAll(event => eventsA.push(event));
  busB.onAll(event => eventsB.push(event));
  await busA.runWithGameId('game-a', async () => {
    busA.emit('game_paused', {});
    busB.emit('game_paused', {});
    await busB.runWithGameId('game-b', async () => busB.emit('game_resumed', {}));
    busA.emit('game_resumed', {});
  });
  assert.deepEqual(eventsA.map(event => event.data.gameId), ['game-a', 'game-a']);
  assert.deepEqual(eventsA.map(event => event.sequence), [1, 2]);
  assert.deepEqual(eventsB.map(event => event.data.gameId), [undefined, 'game-b']);
  assert.equal(eventsB[1].sequence, 1);

  const nested = new EventBus();
  const nestedOrder: Array<[string, number]> = [];
  nested.on('game_paused', () => nested.emit('game_resumed', {}));
  nested.onAll(event => nestedOrder.push([event.type, event.sequence]));
  await nested.runWithGameId('nested-game', async () => nested.emit('game_paused', {}));
  assert.deepEqual(nestedOrder, [['game_paused', 1], ['game_resumed', 2]], '重入 emit 应按 sequence FIFO 派发');

  // 关键 LLM 告警源也必须使用构造时注入的 bus，而非兼容全局实例。
  const breakerEventsA: GameUIEvent[] = [];
  const breakerEventsB: GameUIEvent[] = [];
  busA.on('llm_alert', event => breakerEventsA.push(event));
  busB.on('llm_alert', event => breakerEventsB.push(event));
  new LLMCircuitBreaker(busA, {} as any).trip('offline-test', 'authentication');
  assert.equal(breakerEventsA.length, 1);
  assert.equal(breakerEventsB.length, 0);

  console.log('EventBus 离线测试通过');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
