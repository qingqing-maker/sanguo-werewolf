import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { GameCheckpoint } from '../game/GameEngine';
import { GameUIEvent } from '../game/GameEvents';
import { PhaseNode } from '../game/PhaseMachine';

export const MAX_CHECKPOINT_LENGTH = 512 * 1024;
const MAX_CHECKPOINT_JSON = 6 * 1024 * 1024;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const RESUMABLE_PHASES = new Set([PhaseNode.NIGHT, PhaseNode.DAWN, PhaseNode.DAY, PhaseNode.VOTE]);

export interface SavedGame {
  roomId?: string;
  checkpoint: GameCheckpoint;
  timeline: GameUIEvent[];
  sequence: number;
}

export const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createCheckpointCodec(key?: string): GameCheckpointCodec | undefined {
  const fallback = (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY)?.trim();
  const secret = key ?? (process.env.GAME_SAVE_KEY?.trim() || fallback);
  return secret ? new GameCheckpointCodec(secret, key === undefined ? fallback : undefined) : undefined;
}

export function isCheckpointToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_CHECKPOINT_LENGTH
    && /^v1\.[A-Za-z0-9_-]+$/.test(value);
}

/** 主持人的浏览器保存密文。只有同一服务的密钥和同一个会话令牌能打开它。 */
export class GameCheckpointCodec {
  private readonly keys: Buffer[];

  constructor(secret: string, fallbackSecret?: string) {
    this.keys = [...new Set([secret, fallbackSecret].filter((value): value is string => !!value))]
      .map(value => Buffer.from(hkdfSync('sha256', value, '', 'sanguo-werewolf/game-checkpoint/v1', 32)));
  }

  seal(game: SavedGame, tokenHash: string): string {
    const json = Buffer.from(JSON.stringify(game));
    if (json.length > MAX_CHECKPOINT_JSON) throw new Error('对局存档过大');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keys[0], nonce);
    cipher.setAAD(Buffer.from(tokenHash));
    const encrypted = Buffer.concat([cipher.update(deflateRawSync(json)), cipher.final()]);
    const token = `v1.${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
    if (token.length > MAX_CHECKPOINT_LENGTH) throw new Error('对局存档过大');
    return token;
  }

  open(token: string, tokenHash: string): SavedGame | null {
    if (!isCheckpointToken(token)) return null;
    const bytes = Buffer.from(token.slice(3), 'base64url');
    if (bytes.length <= NONCE_BYTES + TAG_BYTES || bytes.toString('base64url') !== token.slice(3)) return null;
    for (const key of this.keys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, NONCE_BYTES));
        decipher.setAAD(Buffer.from(tokenHash));
        decipher.setAuthTag(bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
        const compressed = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]);
        const saved = JSON.parse(inflateRawSync(compressed, { maxOutputLength: MAX_CHECKPOINT_JSON }).toString('utf8')) as SavedGame;
        const checkpoint = saved?.checkpoint;
        if (saved.roomId !== undefined && (typeof saved.roomId !== 'string' || !ROOM_ID_PATTERN.test(saved.roomId))) return null;
        if (!checkpoint || typeof checkpoint.gameId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(checkpoint.gameId)
          || !RESUMABLE_PHASES.has(checkpoint.nextPhase) || !checkpoint.config
          || !Array.isArray(checkpoint.state?.players) || !Array.isArray(checkpoint.agents)
          || checkpoint.state.players.length === 0 || checkpoint.state.players.length !== checkpoint.agents.length
          || !Number.isSafeInteger(saved.sequence) || saved.sequence < 1 || !Array.isArray(saved.timeline)) return null;
        return saved;
      } catch { /* 无效密文不能恢复对局。 */ }
    }
    return null;
  }
}
