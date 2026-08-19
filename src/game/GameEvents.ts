import type { Faction, GameConfig, RoleType } from '../types';
import type { LLMErrorKind, ProviderFallbackEventData } from '../llm/LLMProvider';

/** 当前 UI 事件协议版本。 */
export const CURRENT_EVENT_SCHEMA_VERSION = 1 as const;

export interface EventPlayerSnapshot {
  id: string;
  name: string;
  title: string;
  roleType: RoleType;
  faction: Faction;
  isAlive: boolean;
  wolfPartners?: string[];
}

interface NamedPlayer {
  id: string;
  name: string;
}

interface SpeechPayload {
  playerId: string;
  playerName: string;
  speech: string;
}

/** EventBus 当前实际发布的全部事件及其业务载荷。 */
export interface GameEventPayloadMap {
  game_start: { players: EventPlayerSnapshot[]; config: GameConfig };
  game_paused: Record<string, never>;
  game_resumed: Record<string, never>;
  game_cancelled: Record<string, never>;
  human_input_required: { requestId: string; playerId: string; prompt: string; options: Record<string, unknown> };
  wolf_partners_private: { wolfId: string; wolfName: string; partners: string[] };
  phase_change: { phase: 'night' | 'dawn' | 'sheriff_election' | 'day' | 'vote'; round: number };
  night_action_start: { playerId: string; playerName: string; roleName: string };
  night_action_done: { playerId: string; playerName: string; roleName: string; targetName: string | null; reasoning: string };
  seer_result_private: { seerId: string; targetName: string; isWolf: boolean; round: number };
  dawn_result: {
    deaths: Array<{ id: string; name: string; roleType?: RoleType; faction?: Faction }>;
    isPeacefulNight: boolean;
  };
  player_speak: {
    playerId: string;
    playerName: string;
    title: string;
    innerThoughts: string;
    publicSpeech: string;
    round: number;
  };
  sheriff_final_speech: {
    sheriffId: string;
    sheriffName: string;
    innerThoughts: string;
    speech: string;
    round: number;
  };
  sheriff_election_start: { candidates: NamedPlayer[]; voters: NamedPlayer[] };
  sheriff_election_end: { result: 'no_candidates' | 'wolf_explode' | 'all_withdrawn' | 'tie_lost' };
  sheriff_elected: { sheriffId: string; sheriffName: string; votes: number };
  wolf_explode: { playerId: string; playerName: string };
  sheriff_speech: SpeechPayload;
  sheriff_withdraw: { playerId: string; playerName: string };
  sheriff_vote: { voterId: string; voterName: string; targetId: string; targetName: string };
  sheriff_vote_result: { tally: Array<{ name: string; votes: number }> };
  sheriff_pk_speech: SpeechPayload;
  sheriff_transfer: { fromId: string; fromName: string; toId: string; toName: string };
  vote_pk_start: { tiedIds: string[] };
  vote_tie: { message: string };
  player_vote: { voterId: string; voterName: string; targetId: string; targetName: string; reason: string };
  vote_result: { tally: Record<string, number>; isPK: boolean };
  player_eliminated: {
    playerId: string;
    playerName: string;
    title: string;
    roleType: RoleType;
    faction: Faction;
    lastWords: string;
    voteCount: number;
  };
  player_last_words: { playerId: string; playerName: string; words: string };
  hunter_shoot: {
    hunterId: string;
    hunterName: string;
    targetId: string;
    targetName: string;
    targetRoleType: RoleType;
    targetFaction: Faction;
  };
  game_end: { winner: Faction; reason: string; players: EventPlayerSnapshot[] };
  ai_decision_degraded: {
    playerId: string;
    playerName: string;
    operation: string;
    kind: 'timeout' | 'parse' | 'other';
    round: number;
    message: string;
  };
  provider_fallback: ProviderFallbackEventData;
  llm_alert: { level: 'error'; kind: LLMErrorKind; reason: string };
}

export type GameEventType = keyof GameEventPayloadMap;
export type GameEventData<K extends GameEventType> = GameEventPayloadMap[K] & { gameId?: string };

export type GameEventOfType<K extends GameEventType> = {
  [P in K]: {
    type: P;
    data: GameEventData<P>;
    schemaVersion: typeof CURRENT_EVENT_SCHEMA_VERSION;
    /** 对局内严格递增的业务事件序号；传输层消息不参与编号。 */
    sequence: number;
    timestamp: number;
  }
}[K];

/** 可按 type 判别并自动收窄 data 的 UI 事件联合。 */
export type GameUIEvent = GameEventOfType<GameEventType>;

const GAME_EVENT_TYPES: ReadonlySet<string> = new Set<GameEventType>([
  'game_start', 'game_paused', 'game_resumed', 'game_cancelled', 'human_input_required',
  'wolf_partners_private', 'phase_change', 'night_action_start', 'night_action_done',
  'seer_result_private', 'dawn_result', 'player_speak', 'sheriff_final_speech',
  'sheriff_election_start', 'sheriff_election_end', 'sheriff_elected', 'wolf_explode',
  'sheriff_speech', 'sheriff_withdraw', 'sheriff_vote', 'sheriff_vote_result',
  'sheriff_pk_speech', 'sheriff_transfer', 'vote_pk_start', 'vote_tie', 'player_vote',
  'vote_result', 'player_eliminated', 'player_last_words', 'hunter_shoot', 'game_end',
  'ai_decision_degraded', 'provider_fallback', 'llm_alert',
]);

export function isGameEventType(value: unknown): value is GameEventType {
  return typeof value === 'string' && GAME_EVENT_TYPES.has(value);
}
