import * as assert from 'node:assert/strict';
import {
  CURRENT_EVENT_SCHEMA_VERSION,
  GameEventData,
  GameEventType,
  GameUIEvent,
} from '../game/GameEvents';
import { Faction, RoleType } from '../types';
import {
  EVENT_POLICIES,
  projectEventForPublicReplay,
  projectEventForViewer,
  projectPlayersForViewer,
  shouldRecordForPublicReplay,
  ViewerContext,
} from './EventVisibility';

function makeEvent<K extends GameEventType>(type: K, data: GameEventData<K>, sequence = 1): GameUIEvent {
  return { type, data, schemaVersion: CURRENT_EVENT_SCHEMA_VERSION, sequence, timestamp: 123 } as GameUIEvent;
}

const viewers = {
  omniscient: { kind: 'spectator', omniscient: true },
  restricted: { kind: 'spectator', omniscient: false },
  ownerGood: { kind: 'player', seatId: 'seer', faction: Faction.GOOD },
  otherGood: { kind: 'player', seatId: 'good', faction: Faction.GOOD },
  ownerWolf: { kind: 'player', seatId: 'wolf', faction: Faction.WOLF },
  otherWolf: { kind: 'player', seatId: 'wolf2', faction: Faction.WOLF },
  operator: { kind: 'operator' },
} satisfies Record<string, ViewerContext>;

function data(event: GameUIEvent | null): Record<string, unknown> {
  assert.ok(event);
  return event.data as Record<string, unknown>;
}

async function main(): Promise<void> {
  assert.equal(Object.keys(EVENT_POLICIES).length, 34, '策略表应覆盖当前全部事件');

  const seerPrivate = makeEvent('seer_result_private', { seerId: 'seer', targetName: '狼', isWolf: true, round: 1 });
  for (const [name, viewer] of Object.entries(viewers)) {
    assert.equal(projectEventForViewer(seerPrivate, viewer) !== null, name === 'ownerGood', `seer private matrix: ${name}`);
  }
  const wolfPrivate = makeEvent('wolf_partners_private', { wolfId: 'wolf', wolfName: '狼一', partners: ['狼二'] });
  for (const [name, viewer] of Object.entries(viewers)) {
    assert.equal(projectEventForViewer(wolfPrivate, viewer) !== null, name === 'ownerWolf', `wolf private matrix: ${name}`);
  }
  const humanInput = makeEvent('human_input_required', { requestId: 'request-1', playerId: 'seer', prompt: '请选择', options: { targets: ['wolf'] } });
  assert.ok(projectEventForViewer(humanInput, viewers.ownerGood));
  assert.equal(projectEventForViewer(humanInput, viewers.operator), null, 'operator 安全默认不看 owner-private');

  const night = makeEvent('night_action_done', { playerId: 'seer', playerName: '军师', roleName: '预言家', targetName: '狼', reasoning: '验他' });
  assert.ok(projectEventForViewer(night, viewers.omniscient));
  assert.ok(projectEventForViewer(night, viewers.operator));
  assert.equal(projectEventForViewer(night, viewers.restricted), null);
  assert.equal(projectEventForViewer(night, viewers.ownerGood), null);

  const players = [
    { id: 'seer', name: '军师', title: '卧龙', roleType: RoleType.SEER, faction: Faction.GOOD, isAlive: true, wolfPartners: ['secret'] },
    { id: 'wolf', name: '狼一', title: '奸雄', roleType: RoleType.WEREWOLF, faction: Faction.WOLF, isAlive: true, wolfPartners: ['wolf2'] },
  ];
  const start = makeEvent('game_start', { players, config: { playerCount: 2, roles: [RoleType.SEER, RoleType.WEREWOLF], maxRounds: 3, enableInnerThoughts: true } });
  const restrictedPlayers = data(projectEventForViewer(start, viewers.restricted)).players as Array<Record<string, unknown>>;
  assert.equal(restrictedPlayers[0].roleType, undefined);
  assert.equal(restrictedPlayers[1].wolfPartners, undefined);
  const goodPlayers = data(projectEventForViewer(start, viewers.ownerGood)).players as Array<Record<string, unknown>>;
  assert.equal(goodPlayers[0].roleType, RoleType.SEER);
  assert.equal(goodPlayers[0].wolfPartners, undefined, '非狼本人不能保留伪造/意外 wolfPartners');
  assert.equal(goodPlayers[1].roleType, undefined);
  const wolfPlayers = data(projectEventForViewer(start, viewers.ownerWolf)).players as Array<Record<string, unknown>>;
  assert.deepEqual(wolfPlayers[1].wolfPartners, ['wolf2']);
  assert.equal((data(projectEventForViewer(start, viewers.operator)).players as any[])[0].roleType, RoleType.SEER);

  const eliminated = makeEvent('player_eliminated', { playerId: 'wolf', playerName: '狼一', title: '奸雄', roleType: RoleType.WEREWOLF, faction: Faction.WOLF, lastWords: '遗言', voteCount: 5 });
  assert.equal(data(projectEventForViewer(eliminated, viewers.restricted)).roleType, undefined);
  assert.equal(data(projectEventForViewer(eliminated, viewers.ownerGood)).faction, undefined);
  assert.equal(data(projectEventForViewer(eliminated, viewers.operator)).roleType, RoleType.WEREWOLF);
  const dawn = makeEvent('dawn_result', { deaths: [{ id: 'wolf', name: '狼一', roleType: RoleType.WEREWOLF, faction: Faction.WOLF }], isPeacefulNight: false });
  assert.equal((data(projectEventForViewer(dawn, viewers.ownerGood)).deaths as any[])[0].roleType, undefined);
  const shot = makeEvent('hunter_shoot', { hunterId: 'hunter', hunterName: '猎人', targetId: 'wolf', targetName: '狼一', targetRoleType: RoleType.WEREWOLF, targetFaction: Faction.WOLF });
  assert.equal(data(projectEventForViewer(shot, viewers.restricted)).targetRoleType, undefined);

  const speech = makeEvent('player_speak', { playerId: 'seer', playerName: '军师', title: '卧龙', innerThoughts: '秘密', publicSpeech: '公开', round: 1 });
  assert.equal(data(projectEventForViewer(speech, viewers.ownerGood)).innerThoughts, '秘密');
  assert.equal(data(projectEventForViewer(speech, viewers.otherGood)).innerThoughts, undefined);
  assert.equal(data(projectEventForViewer(speech, viewers.restricted)).innerThoughts, undefined);
  assert.equal(data(projectEventForViewer(speech, viewers.operator)).innerThoughts, '秘密');
  const finalSpeech = makeEvent('sheriff_final_speech', { sheriffId: 'seer', sheriffName: '军师', innerThoughts: '秘密', speech: '公开', round: 1 });
  assert.equal(data(projectEventForViewer(finalSpeech, viewers.otherGood)).innerThoughts, undefined);

  const degraded = makeEvent('ai_decision_degraded', { playerId: 'seer', playerName: '军师', operation: 'secretNewOperation', kind: 'other', round: 1, message: 'fallback' });
  assert.equal(data(projectEventForViewer(degraded, viewers.ownerGood)).operation, 'secretNewOperation');
  assert.equal(data(projectEventForViewer(degraded, viewers.otherGood)).operation, 'decision');
  const publicOperation = makeEvent('ai_decision_degraded', { playerId: 'seer', playerName: '军师', operation: 'vote', kind: 'other', round: 1, message: 'fallback' });
  assert.equal(data(projectEventForViewer(publicOperation, viewers.restricted)).operation, 'vote');

  const alert = makeEvent('llm_alert', { level: 'error', kind: 'authentication', reason: 'api-key=secret' });
  assert.equal(data(projectEventForViewer(alert, viewers.operator)).reason, 'api-key=secret');
  assert.equal(data(projectEventForViewer(alert, viewers.omniscient)).reason, 'LLM 服务暂时不可用');
  const fallback = makeEvent('provider_fallback', { reason: 'timeout', from: 'real', to: 'mock', operation: 'chat', kind: 'timeout', at: 'now' }) as GameUIEvent;
  (fallback.data as any).secretProbe = 'must-not-pass';
  assert.equal(data(projectEventForViewer(fallback, viewers.operator)).secretProbe, undefined, '敏感 payload 必须白名单复制');

  const original = JSON.parse(JSON.stringify(start));
  const projectedStart = projectEventForViewer(start, viewers.ownerWolf)!;
  (projectedStart.data as any).players[1].wolfPartners.push('mutated');
  assert.deepEqual(start, original, '投影不得 mutate 输入或共享嵌套数组');
  assert.equal(projectEventForViewer({ ...alert, type: 'future_secret' } as any, viewers.operator), null, '未知事件运行时默认拒绝');

  const ended = makeEvent('game_end', { winner: Faction.GOOD, reason: '狼全灭', players });
  for (const viewer of Object.values(viewers)) {
    assert.equal((data(projectEventForViewer(ended, viewer)).players as any[])[1].roleType, RoleType.WEREWOLF, '终局完整揭示');
  }

  assert.equal(shouldRecordForPublicReplay(seerPrivate), false);
  assert.equal(projectEventForPublicReplay(seerPrivate), null);
  assert.equal(shouldRecordForPublicReplay(night), false);
  const replaySpeech = projectEventForPublicReplay(speech);
  assert.ok(replaySpeech);
  assert.deepEqual(replaySpeech, projectEventForViewer(speech, viewers.restricted), '实时与回放使用同一投影结果');
  assert.equal(replaySpeech.sequence, speech.sequence, '所有视角投影必须保留顶层 sequence');
  assert.equal(data(replaySpeech).innerThoughts, undefined);

  const statePlayers = projectPlayersForViewer(players as any[], viewers.ownerGood);
  assert.equal((statePlayers[0] as any).roleType, RoleType.SEER);
  assert.equal((statePlayers[1] as any).roleType, undefined);
  assert.notEqual(statePlayers[0], players[0]);

  console.log('EventVisibility 矩阵测试通过');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
