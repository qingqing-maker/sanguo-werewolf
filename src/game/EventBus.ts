/**
 * EventBus - 游戏事件总线
 * 发布/订阅模式，解耦游戏引擎与 UI 层
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  GameEventOfType,
  GameEventPayloadMap,
  GameEventType,
  GameUIEvent,
} from './GameEvents';

export type { GameUIEvent } from './GameEvents';

export type EventHandler<K extends GameEventType> = (event: GameEventOfType<K>) => void;
export type AnyEventHandler = (event: GameUIEvent) => void;

/** 生产核心依赖的最小发布接口。 */
export interface EventPublisher {
  runWithGameId<T>(gameId: string, fn: () => T): T;
  emit<K extends GameEventType>(type: K, data: GameEventPayloadMap[K]): void;
  getLatestSequence(gameId: string): number;
}

/** Web/日志/测试依赖的订阅接口。 */
export interface EventSubscriber {
  on<K extends GameEventType>(eventType: K, handler: EventHandler<K>): () => void;
  onAll(handler: AnyEventHandler): () => void;
}

export type GameEventBus = EventPublisher & EventSubscriber;

export class EventBus implements GameEventBus {
  private readonly gameContext = new AsyncLocalStorage<string>();
  private handlers = new Map<GameEventType, AnyEventHandler[]>();
  private allHandlers: AnyEventHandler[] = [];
  private readonly latestSequenceByGame = new Map<string, number>();
  private unscopedSequence = 0;
  private dispatching = false;
  private readonly dispatchQueue: GameUIEvent[] = [];

  /** 在指定游戏局次的同步或异步上下文中发布事件。 */
  runWithGameId<T>(gameId: string, fn: () => T): T {
    return this.gameContext.run(gameId, fn);
  }

  getLatestSequence(gameId: string): number {
    return this.latestSequenceByGame.get(gameId) ?? 0;
  }

  /** 订阅特定类型的事件，返回幂等退订函数。 */
  on<K extends GameEventType>(eventType: K, handler: EventHandler<K>): () => void {
    const wrapped = handler as AnyEventHandler;
    const existing = this.handlers.get(eventType) || [];
    existing.push(wrapped);
    this.handlers.set(eventType, existing);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.handlers.get(eventType);
      if (!current) return;
      const next = current.filter(candidate => candidate !== wrapped);
      if (next.length === 0) this.handlers.delete(eventType);
      else this.handlers.set(eventType, next);
    };
  }

  /** 订阅所有事件（用于 WebSocket 广播），返回幂等退订函数。 */
  onAll(handler: AnyEventHandler): () => void {
    this.allHandlers.push(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.allHandlers = this.allHandlers.filter(candidate => candidate !== handler);
    };
  }

  /** 发布事件，并统一注入协议版本、时间戳、对局 sequence 和异步上下文中的 gameId。 */
  emit<K extends GameEventType>(type: K, data: GameEventPayloadMap[K]): void {
    const gameId = this.gameContext.getStore();
    const sequence = gameId ? this.getLatestSequence(gameId) + 1 : ++this.unscopedSequence;
    if (gameId) this.latestSequenceByGame.set(gameId, sequence);
    const event = {
      type,
      data: gameId ? { ...data, gameId } : data,
      schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
      sequence,
      timestamp: Date.now(),
    } as GameEventOfType<K>;

    this.dispatchQueue.push(event as GameUIEvent);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.dispatchQueue.length > 0) {
        const current = this.dispatchQueue.shift()!;
        // 快照保证退订只影响后续派发，不改变本次已经捕获的遍历。
        const handlers = [...(this.handlers.get(current.type) || [])];
        const allHandlers = [...this.allHandlers];
        for (const handler of handlers) handler(current);
        for (const handler of allHandlers) handler(current);
      }
    } finally {
      this.dispatching = false;
    }
  }

  /** 移除所有订阅。 */
  clear(): void {
    this.handlers.clear();
    this.allHandlers = [];
  }
}

// 全局单例
export const globalEventBus = new EventBus();
