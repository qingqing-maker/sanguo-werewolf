import * as assert from 'node:assert/strict';
import { BaseAgent } from '../agents/BaseAgent';
import { CaoCaoConfig } from '../agents/characters/CaoCao';
import { LLMProvider, LLMRequestOptions } from '../llm/LLMProvider';
import { MockProvider } from '../llm/MockProvider';
import { RoleRegistry } from '../roles/RoleRegistry';
import { ChatMessage, Faction, GamePhase, GameState, Player, RoleType } from '../types';
import { GameEngine } from './GameEngine';
import { EventBus } from './EventBus';

class AbortableProvider implements LLMProvider {
  readonly chatStarted = deferred<void>();
  readonly chatJSONStarted = deferred<void>();

  chat(_system: string, _messages: ChatMessage[], options?: LLMRequestOptions): Promise<string> {
    this.chatStarted.resolve();
    return this.waitForAbort(options?.signal);
  }

  chatJSON<T>(_system: string, _messages: ChatMessage[], _schema: string, options?: LLMRequestOptions): Promise<T> {
    this.chatJSONStarted.resolve();
    return this.waitForAbort(options?.signal);
  }

  private waitForAbort<T>(signal?: AbortSignal): Promise<T> {
    assert.ok(signal, '调用必须收到本局 AbortSignal');
    return new Promise<T>((_resolve, reject) => {
      const rejectCancelled = () => reject(signal.reason ?? new Error('aborted'));
      if (signal.aborted) rejectCancelled();
      else signal.addEventListener('abort', rejectCancelled, { once: true });
    });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function testPlayer(): Player {
  return {
    id: 'player_0',
    name: CaoCaoConfig.name,
    roleType: RoleType.VILLAGER,
    faction: Faction.GOOD,
    isAlive: true,
    characterConfig: CaoCaoConfig,
  };
}

function testState(player: Player): GameState {
  return {
    phase: GamePhase.DAY,
    round: 1,
    players: [player],
    events: [],
    nightActions: [],
    eliminatedTonight: [],
    witchSaveUsed: false,
    witchPoisonUsed: false,
    lastGuardTarget: null,
    sheriffId: null,
  };
}

async function main(): Promise<void> {
  const eventBus = new EventBus();
  const engine = new GameEngine(RoleRegistry.getDefaultConfig(), new MockProvider(), { idFactory: () => 'pending-game', eventBus });
  const events: any[] = [];
  const unsubscribe = eventBus.on('human_input_required', event => events.push(event));
  const waiting = engine.waitForHumanInput('player_1', '请选择', { targets: ['player_2'] });
  assert.equal(events.length, 1, 'pending 应先登记再同步 emit');
  const pending = engine.getPendingHumanInput()!;
  assert.equal(pending.requestId, events[0].data.requestId);
  pending.options.targets = [];
  assert.deepEqual(engine.getPendingHumanInput()!.options, { targets: ['player_2'] }, 'getter 应深拷贝');
  assert.deepEqual(engine.receiveHumanInput('other', pending.requestId, 'player_1', {}), { accepted: false, reason: 'wrong_game' });
  assert.deepEqual(engine.receiveHumanInput('pending-game', 'stale', 'player_1', {}), { accepted: false, reason: 'wrong_request' });
  assert.deepEqual(engine.receiveHumanInput('pending-game', pending.requestId, 'player_2', {}), { accepted: false, reason: 'wrong_seat' });
  assert.deepEqual(engine.receiveHumanInput('pending-game', pending.requestId, 'player_1', { targetId: 'player_2' }), { accepted: true });
  assert.deepEqual(await waiting, { targetId: 'player_2' });
  assert.deepEqual(engine.receiveHumanInput('pending-game', pending.requestId, 'player_1', {}), { accepted: false, reason: 'no_pending_input' });

  const cancelled = engine.waitForHumanInput('player_1', '取消测试', {});
  engine.cancel();
  await assert.rejects(cancelled, /GAME_CANCELLED/);
  assert.equal(engine.getPendingHumanInput(), null);

  let resumedEvents = 0;
  const unsubscribeResumed = eventBus.on('game_resumed', () => { resumedEvents++; });
  const pausedEngine = new GameEngine(RoleRegistry.getDefaultConfig(), new MockProvider(), { idFactory: () => 'paused-game', eventBus });
  pausedEngine.pause();
  pausedEngine.cancel();
  assert.equal(pausedEngine.paused, false, '取消暂停局应解除内部暂停');
  assert.equal(resumedEvents, 0, '取消暂停局不得发布语义错误的 game_resumed');
  unsubscribeResumed();
  unsubscribe();

  const agentEventBus = new EventBus();
  let degradedEvents = 0;
  agentEventBus.on('ai_decision_degraded', () => { degradedEvents++; });
  const player = testPlayer();
  const state = testState(player);

  const chatProvider = new AbortableProvider();
  const chatController = new AbortController();
  const chatAgent = new BaseAgent(player, chatProvider, undefined, agentEventBus, chatController.signal);
  chatAgent.setPlayersRef([player]);
  const speaking = chatAgent.speak('取消测试', state);
  await chatProvider.chatStarted.promise;
  chatController.abort();
  await assert.rejects(speaking, /GAME_CANCELLED/);

  const jsonProvider = new AbortableProvider();
  const jsonController = new AbortController();
  const jsonAgent = new BaseAgent(player, jsonProvider, undefined, agentEventBus, jsonController.signal);
  jsonAgent.setPlayersRef([player]);
  const deciding = jsonAgent.decideYesNo('取消测试', true);
  await jsonProvider.chatJSONStarted.promise;
  jsonController.abort();
  await assert.rejects(deciding, /GAME_CANCELLED/);
  assert.equal(degradedEvents, 0, '主动取消不得发布 ai_decision_degraded');

  const preCancelled = new AbortController();
  preCancelled.abort();
  await assert.rejects(
    new MockProvider().chat('', [], { signal: preCancelled.signal }),
    error => error === preCancelled.signal.reason,
    'MockProvider 应在生成业务结果前拒绝预取消请求',
  );

  const previousFastMode = process.env.FAST_MODE;
  process.env.FAST_MODE = '1';
  try {
    // 顶层必须以本局取消状态为权威，即使底层泄漏的不是 GAME_CANCELLED 文案。
    const rawEvents = new EventBus();
    let rawCancelledEvents = 0;
    rawEvents.on('game_cancelled', () => { rawCancelledEvents++; });
    const rawEngine = new GameEngine(RoleRegistry.getDefaultConfig(), new MockProvider(), {
      idFactory: () => 'raw-cancel-game',
      eventBus: rawEvents,
    });
    let rejectLoop!: (error: Error) => void;
    (rawEngine as any).gameLoop = () => new Promise<void>((_resolve, reject) => { rejectLoop = reject; });
    const rawRunning = rawEngine.start();
    await Promise.resolve();
    rawEngine.cancel();
    rejectLoop(new Error('SDK arbitrary failure after caller cancel'));
    await rawRunning;
    assert.equal(rawCancelledEvents, 1, '顶层应按本局 signal 识别任意形状的取消异常');

    const provider = new AbortableProvider();
    const engineEvents = new EventBus();
    let cancelledEvents = 0;
    let engineDegradedEvents = 0;
    engineEvents.on('game_cancelled', () => { cancelledEvents++; });
    engineEvents.on('ai_decision_degraded', () => { engineDegradedEvents++; });
    const runningEngine = new GameEngine(RoleRegistry.getDefaultConfig(), provider, {
      idFactory: () => 'llm-cancel-game',
      eventBus: engineEvents,
    });
    const running = runningEngine.start();
    await provider.chatJSONStarted.promise;
    runningEngine.cancel();
    await running;
    assert.equal(cancelledEvents, 1, '运行中取消应恰好发布一次 game_cancelled');
    assert.equal(engineDegradedEvents, 0, '引擎主动取消不得触发 AI 业务降级');
  } finally {
    if (previousFastMode === undefined) delete process.env.FAST_MODE;
    else process.env.FAST_MODE = previousFastMode;
  }

  console.log('GameEngine pending input 与 LLM 取消离线测试通过');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
