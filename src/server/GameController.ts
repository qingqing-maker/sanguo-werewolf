import { GameCheckpoint, GameEngine, HumanInputResult, PendingHumanInputSnapshot, SeatPrivateSnapshot } from '../game/GameEngine';
import { RoleRegistry } from '../roles/RoleRegistry';
import { createLLMProvider, getConfiguredModelName, getConfiguredProviderName } from '../llm/ProviderFactory';
import type { LLMErrorKind } from '../llm/LLMProvider';
import { GameConfig, Difficulty } from '../types';
import { EventPublisher, globalEventBus } from '../game/EventBus';

export type GameEngineFactory = (config: GameConfig) => GameEngine;
type OnInitialized = Parameters<GameEngine['start']>[0];

/** 游戏流程控制器；所有开局/重开操作均通过单一活动代次串行。 */
export class GameController {
  private engine: GameEngine | null = null;
  private activeModel: { provider: string; model: string } | null = null;
  private isRunning = false;
  private currentGameId: string | null = null;
  private generation = 0;
  private activeRun: Promise<void> | null = null;
  private restartPending = false;
  private presentationClientAvailable = false;

  private readonly engineFactory: GameEngineFactory;
  private readonly eventBus: EventPublisher;

  constructor(
    engineFactory?: GameEngineFactory,
    eventBus: EventPublisher = globalEventBus,
    private readonly onPhaseBoundary?: (checkpoint: GameCheckpoint) => void,
  ) {
    this.eventBus = eventBus;
    this.engineFactory = engineFactory ?? (config => this.createEngine(config));
  }

  private createEngine(config: GameConfig, gameId?: string): GameEngine {
    const providerName = getConfiguredProviderName();
    const createModel = () => createLLMProvider(providerName, false, { eventBus: this.eventBus, disableFallback: true });
    return new GameEngine(config, createModel(), {
      eventBus: this.eventBus,
      presentationAckEnabled: true,
      onPhaseBoundary: this.onPhaseBoundary,
      idFactory: gameId ? () => gameId : undefined,
      retryModel: providerName === 'mock' ? undefined : createModel,
    });
  }

  restoreGame(checkpoint: GameCheckpoint, onInitialized?: OnInitialized): Promise<void> {
    if (this.restartPending || this.activeRun || this.isRunning) throw new Error('GAME_BUSY');
    return this.runEngine(this.createEngine(checkpoint.config, checkpoint.gameId), onInitialized, checkpoint);
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
    return this.runEngine(this.engineFactory(gameConfig), onInitialized);
  }

  private runEngine(engine: GameEngine, onInitialized?: OnInitialized, checkpoint?: GameCheckpoint): Promise<void> {
    const provider = getConfiguredProviderName();
    const model = getConfiguredModelName(provider);
    const generation = ++this.generation;
    this.engine = engine;
    this.activeModel = { provider, model };
    this.engine.setPresentationClientAvailable(this.presentationClientAvailable);
    this.currentGameId = engine.getGameId();
    this.isRunning = true;

    const run = engine.start(onInitialized, checkpoint).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== 'GAME_CANCELLED') console.error('[GameController] 游戏错误:', message);
    }).finally(() => {
      if (this.generation === generation && this.engine === engine) {
        this.isRunning = false;
        this.engine = null;
        this.activeModel = null;
        this.currentGameId = null;
        this.activeRun = null;
      }
    });
    this.activeRun = run;
    return run;
  }

  pauseGame(reason?: 'host_away'): void {
    if (this.engine && this.isRunning && this.currentGameId) {
      this.eventBus.runWithGameId(this.currentGameId, () => this.engine!.pause(reason));
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

  async stopGame(): Promise<void> {
    const running = this.activeRun;
    this.cancelGame();
    await running;
  }

  handleHumanInput(gameId: string, requestId: string, seatId: string, input: Record<string, unknown>): HumanInputResult {
    if (!this.engine || !this.isRunning) return { accepted: false, reason: 'no_pending_input' };
    return this.engine.receiveHumanInput(gameId, requestId, seatId, input);
  }

  setPresentationClientAvailable(available: boolean): void {
    this.presentationClientAvailable = available;
    this.engine?.setPresentationClientAvailable(available);
  }

  handleSpeechPresented(gameId: string, sequence: number): boolean {
    if (!this.engine || !this.isRunning) return false;
    return this.engine.receiveSpeechPresented(gameId, sequence);
  }

  getPendingPresentationSequence(): number | null {
    return this.engine?.getPendingPresentationSequence() ?? null;
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
    isRunning: boolean; paused: boolean; provider: string; model: string; modelFailure: LLMErrorKind | null;
    gameId: string | null; players: any[]; phase: string | null; round: number;
    aiDifficulty: Difficulty; humanCharacterName: string | null;
  } {
    const cfg = this.engine?.getConfig();
    const progress = this.engine?.getPhaseRound() ?? { phase: null, round: 0 };
    const provider = this.activeModel?.provider ?? getConfiguredProviderName();
    return {
      isRunning: this.isRunning,
      paused: this.engine?.paused || false,
      modelFailure: this.engine?.modelFailure ?? null,
      provider,
      model: this.activeModel?.model ?? getConfiguredModelName(provider),
      gameId: this.currentGameId,
      phase: progress.phase,
      round: progress.round,
      players: this.getPlayers(),
      aiDifficulty: cfg?.aiDifficulty ?? 'standard',
      humanCharacterName: cfg?.humanCharacterName ?? null,
    };
  }
}
