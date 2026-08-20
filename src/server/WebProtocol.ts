import { CURRENT_EVENT_SCHEMA_VERSION } from '../game/GameEvents';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_INPUT_JSON = 16_384;

export type ClientCommand =
  | { type: 'authenticate'; token: string }
  | { type: 'create_room' | 'close_room' }
  | { type: 'ping' }
  | { type: 'start_game'; config?: Record<string, unknown> }
  | { type: 'pause_game' | 'resume_game' | 'cancel_game' }
  | { type: 'restart_game'; config?: Record<string, unknown> }
  | { type: 'speech_presented'; data: { gameId: string; sequence: number } }
  | { type: 'human_input'; data: { gameId: string; requestId: string; input: Record<string, unknown> } };

export type TransportReasonCode =
  | 'authentication_required' | 'invalid_message' | 'invalid_token' | 'forbidden'
  | 'not_running' | 'not_owner' | 'no_pending_input' | 'wrong_game'
  | 'wrong_request' | 'wrong_seat' | 'invalid_input' | 'stale_request' | 'busy'
  | 'room_taken' | 'room_not_found' | 'server_error';

export interface TransportCapabilities {
  createRoom: boolean;
  closeRoom: boolean;
  startGame: boolean;
  pauseGame: boolean;
  resumeGame: boolean;
  cancelGame: boolean;
  restartGame: boolean;
  humanInput: boolean;
}

export interface TransportEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  data: T;
  schemaVersion: typeof CURRENT_EVENT_SCHEMA_VERSION;
  timestamp: number;
}

export function transportEvent<T extends Record<string, unknown>>(type: string, data: T): TransportEvent<T> {
  return { type, data, schemaVersion: CURRENT_EVENT_SCHEMA_VERSION, timestamp: Date.now() };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key)) && keys.every(key => allowed.includes(key));
}

function validConfig(value: unknown): value is Record<string, unknown> {
  if (value === undefined) return true;
  if (!isPlainObject(value) || !exactKeys(value, ['playerCount', 'roles', 'maxRounds', 'enableInnerThoughts', 'humanCharacterName', 'aiDifficulty'])) return false;
  if (value.humanCharacterName !== undefined && (typeof value.humanCharacterName !== 'string' || value.humanCharacterName.length > 64)) return false;
  if (value.aiDifficulty !== undefined && !['novice', 'standard', 'expert'].includes(String(value.aiDifficulty))) return false;
  if (value.roles !== undefined && (!Array.isArray(value.roles) || value.roles.length > 32 || value.roles.some(role => typeof role !== 'string' || role.length > 32))) return false;
  for (const key of ['playerCount', 'maxRounds'] as const) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > 100)) return false;
  }
  if (value.enableInnerThoughts !== undefined && typeof value.enableInnerThoughts !== 'boolean') return false;
  return true;
}

export function decodeGameConfig(value: unknown): Record<string, unknown> | null {
  return validConfig(value) ? (value === undefined ? {} : { ...value }) : null;
}

/** 严格解码客户端命令；未知字段、原型对象及过长输入默认拒绝。 */
export function decodeClientCommand(value: unknown): ClientCommand | null {
  if (!isPlainObject(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'authenticate':
      return exactKeys(value, ['type', 'token'], ['type', 'token']) && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.token)
        ? { type: 'authenticate', token: value.token } : null;
    case 'create_room': case 'close_room':
      return exactKeys(value, ['type'], ['type']) ? { type: value.type } : null;
    case 'ping':
      return exactKeys(value, ['type'], ['type']) ? { type: 'ping' } : null;
    case 'pause_game': case 'resume_game': case 'cancel_game':
      return exactKeys(value, ['type'], ['type']) ? { type: value.type } : null;
    case 'start_game': case 'restart_game': {
      if (!exactKeys(value, ['type', 'config'], ['type'])) return null;
      const config = decodeGameConfig(value.config);
      return config === null ? null : { type: value.type, ...(value.config === undefined ? {} : { config }) };
    }
    case 'human_input': {
      if (!exactKeys(value, ['type', 'data'], ['type', 'data']) || !isPlainObject(value.data)) return null;
      const data = value.data;
      if (!exactKeys(data, ['gameId', 'requestId', 'input'], ['gameId', 'requestId', 'input'])) return null;
      if (typeof data.gameId !== 'string' || !ID_PATTERN.test(data.gameId) || typeof data.requestId !== 'string' || !ID_PATTERN.test(data.requestId)) return null;
      if (!isPlainObject(data.input)) return null;
      try { if (JSON.stringify(data.input).length > MAX_INPUT_JSON) return null; } catch { return null; }
      return { type: 'human_input', data: { gameId: data.gameId, requestId: data.requestId, input: { ...data.input } } };
    }
    case 'speech_presented': {
      if (!exactKeys(value, ['type', 'data'], ['type', 'data']) || !isPlainObject(value.data)) return null;
      const data = value.data;
      if (!exactKeys(data, ['gameId', 'sequence'], ['gameId', 'sequence'])) return null;
      if (typeof data.gameId !== 'string' || !ID_PATTERN.test(data.gameId)) return null;
      if (!Number.isSafeInteger(data.sequence) || Number(data.sequence) <= 0) return null;
      return { type: 'speech_presented', data: { gameId: data.gameId, sequence: Number(data.sequence) } };
    }
    default:
      return null;
  }
}
