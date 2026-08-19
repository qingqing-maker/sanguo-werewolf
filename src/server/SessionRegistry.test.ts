import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SessionRegistry } from './SessionRegistry';

function token(): string {
  return randomBytes(32).toString('base64url');
}

async function main(): Promise<void> {
  const registry = new SessionRegistry();
  const firstToken = token();
  const secondToken = token();
  assert.equal(SessionRegistry.isValidToken(firstToken), true);
  for (const invalid of ['', 'x'.repeat(42), 'x'.repeat(44), '含中文'.repeat(20), `${'x'.repeat(42)}=`]) {
    assert.equal(SessionRegistry.isValidToken(invalid), false);
  }

  const first = registry.authenticate(firstToken)!;
  assert.equal(first.isHost, false, '所有新会话一律是 guest');
  assert.strictEqual(registry.authenticate(firstToken), first, '同 token 应重连同一会话');
  const second = registry.authenticate(secondToken)!;
  assert.equal(second.isHost, false);
  assert.equal(registry.size, 2);
  assert.strictEqual(registry.findBearer(`Bearer ${firstToken}`), first);
  assert.equal(registry.findBearer(`bearer ${firstToken}`), null);
  assert.equal(registry.findBearer('Bearer invalid'), null);

  assert.equal(registry.hasRoom(), false);
  assert.equal(registry.createRoom(first), 'created');
  assert.equal(first.isHost, true, '房间创建者自动成为主持人');
  assert.equal(registry.isRoomCreator(first), true);
  assert.match(registry.getRoomId() || '', /^[0-9a-f-]{36}$/);
  assert.equal(registry.createRoom(first), 'already_creator', '同 session 重试应幂等');
  assert.equal(registry.createRoom(second), 'room_taken', '单实例同时只能有一个房间');
  assert.equal(second.isHost, false);
  const outsider = new SessionRegistry().authenticate(token())!;
  assert.equal(registry.createRoom(outsider), 'unknown_session');
  assert.equal(registry.closeRoom(second), 'not_owner');

  registry.bindGame(first, 'game-1');
  assert.deepEqual({ gameId: first.gameId, seatId: first.seatId }, { gameId: 'game-1', seatId: null });
  registry.bindSeat(first, 'game-1', 'player_3');
  assert.equal(first.seatId, 'player_3');
  registry.clearGame('other');
  assert.equal(first.seatId, 'player_3');
  registry.clearGame('game-1');
  assert.deepEqual({ gameId: first.gameId, seatId: first.seatId }, { gameId: null, seatId: null });

  assert.equal(registry.closeRoom(first), 'closed');
  assert.equal(first.isHost, false);
  assert.equal(registry.hasRoom(), false);
  assert.equal(registry.getRoomId(), null);
  assert.equal(registry.closeRoom(first), 'room_not_found');
  assert.equal(registry.createRoom(second), 'created', '旧房间关闭后下一位用户可以创建新房间');

  // 容量上限前惰性清理过期且未绑定游戏的 guest；房间创建者不清理。
  const bounded = new SessionRegistry({ maxSessions: 2, idleTtlMs: 1 });
  const boundedHost = bounded.authenticate(token())!;
  assert.equal(bounded.createRoom(boundedHost), 'created');
  const staleGuest = bounded.authenticate(token())!;
  staleGuest.lastAccessAt = Date.now() - 100;
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(bounded.authenticate(token()), '过期且未绑定游戏的 guest 应被回收');
  assert.equal(boundedHost.isHost, true);
  assert.equal(bounded.authenticate(token()), null, '达到容量上限时应拒绝新 session');

  // registry 与 session 都不应包含明文令牌。
  assert.equal(JSON.stringify(registry).includes(firstToken), false);
  assert.equal(JSON.stringify(first).includes(firstToken), false);
  console.log('SessionRegistry 离线测试通过');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
