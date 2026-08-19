import { GameEngine, HumanInputResult, PendingHumanInputSnapshot, SeatPrivateSnapshot } from '../game/GameEngine';
import { RoleRegistry } from '../roles/RoleRegistry';
import { createLLMProvider } from '../llm/ProviderFactory';
import { GameConfig, Difficulty } from '../types';
import { EventPublisher, globalEventBus } from '../game/EventBus';

export type GameEngineFactory = (config: GameConfig) => GameEngine;

/** 游戏流程控制器；所有开局/重开操作均通过单一活动代次串行。 */
export class GameController {
  private engine: GameEngine | null = null;
  private isRunning = false;
  private currentGameId: string | null = null;
  private generation = 0;
  private activeRun: Promise<void> | null = null;
  private restartPending = false;

  private readonly engineFactory: GameEngineFactory;
  private readonly eventBus: EventPublisher;

  constructor(engineFactory?: GameEngineFactory, eventBus: EventPublisher = globalEventBus) {
    this.eventBus = eventBus;
    this.engineFactory = engineFactory ?? (config => {
      const llm = createLLMProvider(undefined, false, { eventBus });
      return new GameEngine(config, llm, { eventBus });
    });
  }

  /** 启动新局；已有启动、运行或重开操作时明确拒绝，不做隐式取消。 */
  startGame(config?: Partial<GameConfig>, onInitialized?: (gameId: string, players: ReturnType<GameEngine['getPlayers']>) => void): Promise<void> {
    if (this.restartPending || this.activeRun || this.isRunning) throw new Error('GAME_BUSY');
    return this.beginGame(config, onInitialized);
  }

  /** 安全重开：同步占位，先取消并等待旧引擎真实退出，再创建下一代。 */
  restartGame(config?: Partial<GameConfig>, onInitialized?: (gameId: string, players: ReturnType<GameEngine['getPlayers']>) => void): Promise<void> {
    if (this.restartPending) throw new Error('GAME_BUSY');
    this.restartPending = true;
    const previous = this.activeRun;
    if (this.engine && this.currentGameId) {
      this.eventBus.runWithGameId(this.currentGameId, () => this.engine!.cancel());
    }
    return (async () => {
      try {
        if (previous) await previous;
        return this.beginGame(config, onInitialized, true);
      } finally {
        this.restartPending = false;
      }
    })();
  }

  private beginGame(config?: Partial<GameConfig>, onInitialized?: (gameId: string, players: ReturnType<GameEngine['getPlayers']>) => void, restartReserved = false): Promise<void> {
    if ((!restartReserved && this.restartPending) || this.activeRun || this.isRunning) return Promise.reject(new Error('GAME_BUSY'));
    const gameConfig = config ? { ...RoleRegistry.getDefaultConfig(), ...config } : RoleRegistry.getDefaultConfig();
    const engine = this.engineFactory(gameConfig);
    const generation = ++this.generation;
    this.engine = engine;
    this.currentGameId = engine.getGameId();
    this.isRunning = true;

    const run = engine.start(onInitialized).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== 'GAME_CANCELLED') console.error('[GameController] 游戏错误:', message);
    }).finally(() => {
      if (this.generation === generation && this.engine === engine) {
        this.isRunning = false;
        this.engine = null;
        this.currentGameId = null;
        this.activeRun = null;
      }
    });
    this.activeRun = run;
    return run;
  }

  pauseGame(): void {
    if (this.engine && this.isRunning && this.currentGameId) {
      this.eventBus.runWithGameId(this.currentGameId, () => this.engine!.pause());
    }
  }
  resumeGame(): void {
    if (this.engine && this.isRunning && this.currentGameId) {
      this.eventBus.runWithGameId(this.currentGameId, () => this.engine!.resume());
    }
  }
  cancelGame(): void {
    if (this.engine && this.currentGameId) {
      this.eventBus.runWithGameId(this.currentGameId, () => this.engine!.cancel());
    }
  }

  handleHumanInput(gameId: string, requestId: string, seatId: string, input: Record<string, unknown>): HumanInputResult {
    if (!this.engine || !this.isRunning) return { accepted: false, reason: 'no_pending_input' };
    return this.engine.receiveHumanInput(gameId, requestId, seatId, input);
  }

  getPendingHumanInput(): PendingHumanInputSnapshot | null { return this.engine?.getPendingHumanInput() ?? null; }
  getSeatPrivateSnapshot(seatId: string): SeatPrivateSnapshot | null { return this.engine?.getSeatPrivateSnapshot(seatId) ?? null; }

  joinGame(playerId: string): { success: boolean; message: string } {
    if (!this.engine || !this.isRunning) return { success: false, message: '游戏尚未开始' };
    return this.engine.setHumanPlayer(playerId)
      ? { success: true, message: `已接管角色 ${playerId}` }
      : { success: false, message: `角色 ${playerId} 不存在` };
  }

  leaveGame(playerId: string): { success: boolean; message: string } {
    if (!this.engine || !this.isRunning) return { success: false, message: '游戏尚未开始' };
    return this.engine.removeHumanPlayer(playerId)
      ? { success: true, message: `AI 已重新接管 ${playerId}` }
      : { success: false, message: `角色 ${playerId} 不存在` };
  }

  getHumanPlayerId(): string | null {
    if (!this.engine || !this.isRunning) return null;
    return this.engine.getHumanPlayerId();
  }

  getPlayers(): any[] {
    if (!this.engine || !this.isRunning) return [];
    return this.engine.getPlayers();
  }

  getState(): {
    isRunning: boolean; paused: boolean; provider: string; model: string;
    gameId: string | null; players: any[]; phase: string | null; round: number;
    aiDifficulty: Difficulty; humanCharacterName: string | null;
  } {
    const cfg = this.engine?.getConfig();
    const progress = this.engine?.getPhaseRound() ?? { phase: null, round: 0 };
    return {
      isRunning: this.isRunning,
      paused: this.engine?.paused || false,
      provider: process.env.LLM_PROVIDER || 'mock',
      model: process.env.LLM_MODEL_ID || 'mock',
      gameId: this.currentGameId,
      phase: progress.phase,
      round: progress.round,
      players: this.getPlayers(),
      aiDifficulty: cfg?.aiDifficulty ?? 'standard',
      humanCharacterName: cfg?.humanCharacterName ?? null,
    };
  }
}
