import {
  CURRENT_EVENT_SCHEMA_VERSION,
  EventPlayerSnapshot,
  GameEventData,
  GameEventPayloadMap,
  GameEventType,
  GameUIEvent,
  isGameEventType,
} from '../game/GameEvents';
import { Faction } from '../types';

/** 传输层当前支持的共享 UI 视角。operator 默认也不能读取座位私密信息。 */
export type ViewerContext =
  | { kind: 'spectator'; omniscient: true }
  | { kind: 'spectator'; omniscient: false }
  | { kind: 'player'; seatId: string; faction?: Faction }
  | { kind: 'operator' };

export type EventVisibilityClass = 'public' | 'spectator-only' | 'owner-only';

/** 事件声明必须穷尽；GameEventPayloadMap 新增成员而未补策略时会编译失败。 */
export const EVENT_POLICIES = {
  game_start: 'public', game_paused: 'public', game_resumed: 'public', game_cancelled: 'public',
  human_input_required: 'owner-only', wolf_partners_private: 'owner-only', phase_change: 'public',
  night_action_start: 'spectator-only', night_action_done: 'spectator-only', seer_result_private: 'owner-only',
  dawn_result: 'public', player_speak: 'public', sheriff_final_speech: 'public',
  sheriff_election_start: 'public', sheriff_election_end: 'public', sheriff_elected: 'public',
  wolf_explode: 'public', sheriff_speech: 'public', sheriff_withdraw: 'public', sheriff_vote: 'public',
  sheriff_vote_result: 'public', sheriff_pk_speech: 'public', sheriff_transfer: 'public',
  vote_pk_start: 'public', vote_tie: 'public', player_vote: 'public', vote_result: 'public',
  player_eliminated: 'public', player_last_words: 'public', hunter_shoot: 'public', game_end: 'public',
  ai_decision_degraded: 'public', provider_fallback: 'public', llm_alert: 'public',
} satisfies Record<GameEventType, EventVisibilityClass>;

const PUBLIC_AI_OPERATIONS = new Set(['speak', 'vote', 'sheriffSpeech', 'sheriffVote', 'decision']);

function seesOmniscient(viewer: ViewerContext): boolean {
  return viewer.kind === 'operator' || (viewer.kind === 'spectator' && viewer.omniscient);
}

function isOwner(viewer: ViewerContext, seatId: string): boolean {
  return viewer.kind === 'player' && viewer.seatId === seatId;
}

function withGameId<T extends object>(data: T, gameId: string | undefined): T & { gameId?: string } {
  return gameId === undefined ? data : { ...data, gameId };
}

function event<K extends GameEventType>(source: GameUIEvent, type: K, data: GameEventPayloadMap[K]): GameUIEvent {
  return {
    type,
    data: withGameId(data, source.data.gameId) as GameEventData<K>,
    schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
    sequence: source.sequence,
    timestamp: source.timestamp,
  } as GameUIEvent;
}

function projectStartPlayer(player: EventPlayerSnapshot, viewer: ViewerContext): Partial<EventPlayerSnapshot> {
  const base = { id: player.id, name: player.name, title: player.title, isAlive: player.isAlive };
  if (seesOmniscient(viewer)) {
    return { ...base, roleType: player.roleType, faction: player.faction, ...(player.wolfPartners ? { wolfPartners: [...player.wolfPartners] } : {}) };
  }
  if (viewer.kind === 'player' && player.id === viewer.seatId) {
    return {
      ...base,
      roleType: player.roleType,
      faction: player.faction,
      ...(player.faction === Faction.WOLF && player.wolfPartners ? { wolfPartners: [...player.wolfPartners] } : {}),
    };
  }
  return base;
}

/**
 * 投影 GameController 玩家列表。保留非身份展示字段，但始终返回新对象；受限视角删除
 * 其他座位的 roleType/faction/wolfPartners，避免 HTTP/握手状态绕过事件策略。
 */
export function projectPlayersForViewer<T extends Record<string, unknown>>(players: readonly T[], viewer: ViewerContext): T[] {
  return players.map(player => {
    const copy: Record<string, unknown> = { ...player };
    const id = typeof player.id === 'string' ? player.id : '';
    const wolfPartners = player['wolfPartners'];
    if (seesOmniscient(viewer)) {
      if (Array.isArray(wolfPartners)) copy['wolfPartners'] = [...wolfPartners];
      return copy as T;
    }
    if (viewer.kind === 'player' && id === viewer.seatId) {
      if (player.faction !== Faction.WOLF) delete copy['wolfPartners'];
      else if (Array.isArray(wolfPartners)) copy['wolfPartners'] = [...wolfPartners];
      return copy as T;
    }
    delete copy.roleType;
    delete copy.faction;
    delete copy.wolfPartners;
    return copy as T;
  });
}

/** 未知运行时 type 默认拒绝；每个已知事件均按批准字段重新构造。 */
export function projectEventForViewer(input: GameUIEvent, viewer: ViewerContext): GameUIEvent | null {
  const rawType: unknown = (input as { type?: unknown }).type;
  if (!isGameEventType(rawType)) return null;
  const source = input as GameUIEvent;

  switch (source.type) {
    case 'human_input_required': {
      const d = source.data;
      return isOwner(viewer, d.playerId) ? event(source, source.type, { requestId: d.requestId, playerId: d.playerId, prompt: d.prompt, options: { ...d.options } }) : null;
    }
    case 'wolf_partners_private': {
      const d = source.data;
      return isOwner(viewer, d.wolfId) ? event(source, source.type, { wolfId: d.wolfId, wolfName: d.wolfName, partners: [...d.partners] }) : null;
    }
    case 'seer_result_private': {
      const d = source.data;
      return isOwner(viewer, d.seerId) ? event(source, source.type, { seerId: d.seerId, targetName: d.targetName, isWolf: d.isWolf, round: d.round }) : null;
    }
    case 'night_action_start': {
      if (!seesOmniscient(viewer)) return null;
      const d = source.data;
      return event(source, source.type, { playerId: d.playerId, playerName: d.playerName, roleName: d.roleName });
    }
    case 'night_action_done': {
      if (!seesOmniscient(viewer)) return null;
      const d = source.data;
      return event(source, source.type, { playerId: d.playerId, playerName: d.playerName, roleName: d.roleName, targetName: d.targetName, reasoning: d.reasoning });
    }
    case 'game_start': {
      const d = source.data;
      return event(source, source.type, { players: d.players.map(p => projectStartPlayer(p, viewer)) as EventPlayerSnapshot[], config: { ...d.config, roles: [...d.config.roles] } });
    }
    case 'game_paused': return event(source, source.type, {});
    case 'game_resumed': return event(source, source.type, {});
    case 'game_cancelled': return event(source, source.type, {});
    case 'phase_change': { const d = source.data; return event(source, source.type, { phase: d.phase, round: d.round }); }
    case 'dawn_result': {
      const d = source.data;
      const deaths = d.deaths.map(dead => seesOmniscient(viewer)
        ? { id: dead.id, name: dead.name, ...(dead.roleType ? { roleType: dead.roleType } : {}), ...(dead.faction ? { faction: dead.faction } : {}) }
        : { id: dead.id, name: dead.name });
      return event(source, source.type, { deaths, isPeacefulNight: d.isPeacefulNight });
    }
    case 'player_speak': {
      const d = source.data;
      const publicData = { playerId: d.playerId, playerName: d.playerName, title: d.title, publicSpeech: d.publicSpeech, round: d.round };
      return event(source, source.type, (seesOmniscient(viewer) || isOwner(viewer, d.playerId)
        ? { ...publicData, innerThoughts: d.innerThoughts }
        : publicData) as GameEventPayloadMap['player_speak']);
    }
    case 'sheriff_final_speech': {
      const d = source.data;
      const publicData = { sheriffId: d.sheriffId, sheriffName: d.sheriffName, speech: d.speech, round: d.round };
      return event(source, source.type, (seesOmniscient(viewer) || isOwner(viewer, d.sheriffId)
        ? { ...publicData, innerThoughts: d.innerThoughts }
        : publicData) as GameEventPayloadMap['sheriff_final_speech']);
    }
    case 'sheriff_election_start': { const d = source.data; return event(source, source.type, { candidates: d.candidates.map(p => ({ id: p.id, name: p.name })), voters: d.voters.map(p => ({ id: p.id, name: p.name })) }); }
    case 'sheriff_election_end': return event(source, source.type, { result: source.data.result });
    case 'sheriff_elected': { const d = source.data; return event(source, source.type, { sheriffId: d.sheriffId, sheriffName: d.sheriffName, votes: d.votes }); }
    case 'wolf_explode': { const d = source.data; return event(source, source.type, { playerId: d.playerId, playerName: d.playerName }); }
    case 'sheriff_speech': { const d = source.data; return event(source, source.type, { playerId: d.playerId, playerName: d.playerName, speech: d.speech }); }
    case 'sheriff_withdraw': { const d = source.data; return event(source, source.type, { playerId: d.playerId, playerName: d.playerName }); }
    case 'sheriff_vote': { const d = source.data; return event(source, source.type, { voterId: d.voterId, voterName: d.voterName, targetId: d.targetId, targetName: d.targetName }); }
    case 'sheriff_vote_result': return event(source, source.type, { tally: source.data.tally.map(x => ({ name: x.name, votes: x.votes })) });
    case 'sheriff_pk_speech': { const d = source.data; return event(source, source.type, { playerId: d.playerId, playerName: d.playerName, speech: d.speech }); }
    case 'sheriff_transfer': { const d = source.data; return event(source, source.type, { fromId: d.fromId, fromName: d.fromName, toId: d.toId, toName: d.toName }); }
    case 'vote_pk_start': return event(source, source.type, { tiedIds: [...source.data.tiedIds] });
    case 'vote_tie': return event(source, source.type, { message: source.data.message });
    case 'player_vote': { const d = source.data; return event(source, source.type, { voterId: d.voterId, voterName: d.voterName, targetId: d.targetId, targetName: d.targetName, reason: d.reason }); }
    case 'vote_result': return event(source, source.type, { tally: { ...source.data.tally }, isPK: source.data.isPK });
    case 'player_eliminated': {
      const d = source.data;
      if (seesOmniscient(viewer)) return event(source, source.type, { playerId: d.playerId, playerName: d.playerName, title: d.title, roleType: d.roleType, faction: d.faction, lastWords: d.lastWords, voteCount: d.voteCount });
      return event(source, source.type, { playerId: d.playerId, playerName: d.playerName, title: d.title, lastWords: d.lastWords, voteCount: d.voteCount } as GameEventPayloadMap['player_eliminated']);
    }
    case 'player_last_words': { const d = source.data; return event(source, source.type, { playerId: d.playerId, playerName: d.playerName, words: d.words }); }
    case 'hunter_shoot': {
      const d = source.data;
      if (seesOmniscient(viewer)) return event(source, source.type, { hunterId: d.hunterId, hunterName: d.hunterName, targetId: d.targetId, targetName: d.targetName, targetRoleType: d.targetRoleType, targetFaction: d.targetFaction });
      return event(source, source.type, { hunterId: d.hunterId, hunterName: d.hunterName, targetId: d.targetId, targetName: d.targetName } as GameEventPayloadMap['hunter_shoot']);
    }
    case 'game_end': {
      const d = source.data;
      return event(source, source.type, { winner: d.winner, reason: d.reason, players: d.players.map(p => ({ id: p.id, name: p.name, title: p.title, roleType: p.roleType, faction: p.faction, isAlive: p.isAlive, ...(p.wolfPartners ? { wolfPartners: [...p.wolfPartners] } : {}) })) });
    }
    case 'ai_decision_degraded': {
      const d = source.data;
      const operation = isOwner(viewer, d.playerId) || PUBLIC_AI_OPERATIONS.has(d.operation) ? d.operation : 'decision';
      return event(source, source.type, { playerId: d.playerId, playerName: d.playerName, operation, kind: d.kind, round: d.round, message: d.message });
    }
    case 'provider_fallback': {
      const d = source.data;
      return event(source, source.type, { reason: d.reason, from: d.from, to: d.to, operation: d.operation, ...(d.kind ? { kind: d.kind } : {}), at: d.at });
    }
    case 'llm_alert': {
      const d = source.data;
      return event(source, source.type, { level: d.level, kind: d.kind, reason: viewer.kind === 'operator' ? d.reason : 'LLM 服务暂时不可用' });
    }
  }
}

/** 公共回放仅记录受限观众可见的公共事件；owner/spectator-only 均不落盘。 */
export function shouldRecordForPublicReplay(eventValue: GameUIEvent): boolean {
  const type: unknown = (eventValue as { type?: unknown }).type;
  return isGameEventType(type) && EVENT_POLICIES[type] === 'public';
}

/** 生成可安全持久化的公共投影；调用方无需自行组合策略。 */
export function projectEventForPublicReplay(eventValue: GameUIEvent): GameUIEvent | null {
  return shouldRecordForPublicReplay(eventValue)
    ? projectEventForViewer(eventValue, { kind: 'spectator', omniscient: false })
    : null;
}
