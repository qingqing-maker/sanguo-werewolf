import * as assert from 'node:assert/strict';
import { GameEngine } from '../game/GameEngine';
import { GameController } from './GameController';

interface DeferredEngine {
  engine: GameEngine;
  started: boolean;
  cancelled: boolean;
  resolve(): void;
}

interface AbortDrivenEngine {
  engine: GameEngine;
  started: boolean;
  cancelled: boolean;
  finished: boolean;
}

function createDeferredEngine(id: string): DeferredEngine {
  let resolveRun!: () => void;
  const run = new Promise<void>(resolve => { resolveRun = resolve; });
  const fake: any = {
    paused: false,
    started: false,
    cancelled: false,
    getGameId: () => id,
    getPlayers: () => [{ id: `${id}-seat`, name: '诸葛亮' }],
    getConfig: () => ({ aiDifficulty: 'standard', humanCharacterName: null }),
    getPhaseRound: () => ({ phase: 'night', round: 1 }),
    start(initialized?: (gameId: string, players: any[]) => void): Promise<void> {
      fake.started = true;
      initialized?.(id, fake.getPlayers());
      return run;
    },
    cancel(): void { fake.cancelled = true; },
    pause(): void { fake.paused = true; },
    resume(): void { fake.paused = false; },
  };
  return { engine: fake as GameEngine, get started() { return fake.started; }, get cancelled() { return fake.cancelled; }, resolve: resolveRun };
}

function createAbortDrivenEngine(id: string, events: string[]): AbortDrivenEngine {
  const abortController = new AbortController();
  const fake: any = {
    paused: false,
    started: false,
    cancelled: false,
    finished: false,
    getGameId: () => id,
    getPlayers: () => [{ id: `${id}-seat`, name: '诸葛亮' }],
    getConfig: () => ({ aiDifficulty: 'standard', humanCharacterName: null }),
    getPhaseRound: () => ({ phase: 'night', round: 1 }),
    async start(initialized?: (gameId: string, players: any[]) => void): Promise<void> {
      fake.started = true;
      events.push(`${id}:start`);
      initialized?.(id, fake.getPlayers());
      await new Promise<void>(resolve => {
        abortController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      fake.finished = true;
      events.push(`${id}:finish`);
    },
    cancel(): void {
      fake.cancelled = true;
      events.push(`${id}:cancel`);
      abortController.abort();
    },
    pause(): void { fake.paused = true; },
    resume(): void { fake.paused = false; },
  };
  return {
    engine: fake as GameEngine,
    get started() { return fake.started; },
    get cancelled() { return fake.cancelled; },
    get finished() { return fake.finished; },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function main(): Promise<void> {
  const engines: DeferredEngine[] = [];
  const controller = new GameController(() => {
    const deferred = createDeferredEngine(`game-${engines.length + 1}`);
    engines.push(deferred);
    return deferred.engine;
  });

  const first = controller.startGame();
  assert.equal(engines.length, 1);
  assert.equal(controller.getState().gameId, 'game-1');
  assert.throws(() => controller.startGame(), /GAME_BUSY/, '运行中 start 应同步稳定返回 busy');
  assert.equal(engines.length, 1, 'busy start 不得创建引擎');

  const restart = controller.restartGame();
  assert.equal(engines[0].cancelled, true, 'restart 应先取消旧局');
  assert.throws(() => controller.restartGame(), /GAME_BUSY/, '并发 restart 的第二个应立即 busy');
  assert.throws(() => controller.startGame(), /GAME_BUSY/, 'restart 等待旧局期间 start 也应 busy');
  assert.equal(engines.length, 1, '旧局退出前不得创建新局');

  engines[0].resolve();
  await first;
  await flushMicrotasks();
  assert.equal(engines.length, 2, '旧局退出后应创建新一代');
  assert.equal(controller.getState().gameId, 'game-2');
  assert.equal(controller.getState().isRunning, true, '旧代 finally 不得清理新局状态');
  assert.equal(engines[1].started, true);

  engines[1].resolve();
  await restart;
  assert.equal(controller.getState().isRunning, false);
  assert.equal(controller.getState().gameId, null);

  const events: string[] = [];
  const abortEngines: AbortDrivenEngine[] = [];
  const abortController = new GameController(() => {
    const engine = createAbortDrivenEngine(`abort-game-${abortEngines.length + 1}`, events);
    abortEngines.push(engine);
    return engine.engine;
  });

  const oldRun = abortController.startGame();
  assert.equal(abortEngines.length, 1);
  assert.equal(abortEngines[0].started, true);

  const abortRestart = abortController.restartGame();
  assert.equal(abortEngines[0].cancelled, true, 'restart 应通过 abort 取消旧局');
  assert.throws(() => abortController.restartGame(), /GAME_BUSY/, 'abort 退出期间第二个 restart 仍应同步 busy');
  assert.equal(abortEngines.length, 1, 'abort 驱动旧局结束前不得启动新局');

  await oldRun;
  await flushMicrotasks();
  assert.equal(abortEngines[0].finished, true, '旧局应在 abort 后自行结束，无需手工 resolve');
  assert.equal(abortEngines.length, 2);
  assert.deepEqual(events.slice(0, 3), [
    'abort-game-1:start',
    'abort-game-1:cancel',
    'abort-game-1:finish',
  ], 'restart 顺序应为 old cancel → old finish → new start');
  assert.equal(events[3], 'abort-game-2:start', '旧局真实结束后才应启动新局');
  assert.equal(abortController.getState().gameId, 'abort-game-2');
  assert.equal(abortController.getState().isRunning, true, '旧代 finally 不得清理新局');

  abortController.cancelGame();
  await abortRestart;
  assert.equal(abortController.getState().isRunning, false);
  assert.equal(abortController.getState().gameId, null);
  console.log('GameController 并发及 abort 驱动重开离线测试通过');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
