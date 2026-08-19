import * as assert from 'node:assert/strict';
import { MockProvider } from '../llm/MockProvider';
import { RoleRegistry } from '../roles/RoleRegistry';
import { RoleType } from '../types';
import { SeededRandomSource } from './SeededRandomSource';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  process.stdout.write(`  ✓ ${name}\n`);
}

async function main(): Promise<void> {
  process.stdout.write('\n=== RandomSource 测试 ===\n\n');

  await check('同 seed、同完整 path 输出一致', () => {
    const a = new SeededRandomSource(42).fork('game').fork('roles');
    const b = new SeededRandomSource(42).fork('game').fork('roles');
    assert.deepEqual([a.next(), a.next(), a.next()], [b.next(), b.next(), b.next()]);
  });

  await check('不同 path 隔离', () => {
    const root = new SeededRandomSource(42);
    assert.notDeepEqual(root.fork('a').next(), root.fork('b').next());
  });

  await check('创建或消费无关子流不影响目标子流', () => {
    const first = new SeededRandomSource(99);
    first.fork('noise').next();
    first.fork('noise-2');
    const targetA = first.fork('target');
    const targetB = new SeededRandomSource(99).fork('target');
    assert.deepEqual([targetA.next(), targetA.next()], [targetB.next(), targetB.next()]);
  });

  await check('next/int 范围与 int 参数校验', () => {
    const random = new SeededRandomSource(1);
    for (let i = 0; i < 1000; i++) {
      const n = random.next();
      assert.ok(n >= 0 && n < 1);
      const value = random.int(7);
      assert.ok(Number.isInteger(value) && value >= 0 && value < 7);
    }
    assert.throws(() => random.int(0), /正整数/);
    assert.throws(() => random.int(1.5), /正整数/);
  });

  await check('chance 边界与参数校验', () => {
    const random = new SeededRandomSource(1);
    assert.equal(random.chance(0), false);
    assert.equal(random.chance(1), true);
    assert.throws(() => random.chance(-0.1), /\[0, 1\]/);
    assert.throws(() => random.chance(1.1), /\[0, 1\]/);
  });

  await check('pick 空数组明确抛错', () => {
    assert.throws(() => new SeededRandomSource(1).pick([]), /空数组/);
  });

  await check('shuffle 不修改输入且固定 seed 一致', () => {
    const source = [1, 2, 3, 4, 5];
    const a = new SeededRandomSource(2024).shuffle(source);
    const b = new SeededRandomSource(2024).shuffle(source);
    assert.deepEqual(source, [1, 2, 3, 4, 5]);
    assert.deepEqual(a, b);
    assert.deepEqual(a, [2, 4, 1, 5, 3]);
  });

  await check('RoleRegistry 同 seed 一致', () => {
    const roles = [RoleType.WEREWOLF, RoleType.SEER, RoleType.WITCH, RoleType.VILLAGER];
    assert.deepEqual(
      RoleRegistry.shuffleRoles(roles, new SeededRandomSource(7)),
      RoleRegistry.shuffleRoles(roles, new SeededRandomSource(7)),
    );
  });

  await check('provider 额外消费不影响角色分配', () => {
    const rootA = new SeededRandomSource(77);
    rootA.fork('provider').next();
    rootA.fork('provider').fork('extra').next();
    const rolesA = RoleRegistry.shuffleRoles(RoleRegistry.getDefaultConfig().roles, rootA.fork('game').fork('roles'));
    const rootB = new SeededRandomSource(77);
    const rolesB = RoleRegistry.shuffleRoles(RoleRegistry.getDefaultConfig().roles, rootB.fork('game').fork('roles'));
    assert.deepEqual(rolesA, rolesB);
  });

  await check('MockProvider 同 seed同输入输出一致', async () => {
    const prompt = '你是"曹操"，身份为【细作】，阵营为【🔴 狼人】。你的同伴：刘备。';
    const messages = [{ role: 'user' as const, content: '白天辩论，请发表看法。' }];
    const a = await new MockProvider(new SeededRandomSource(123)).chat(prompt, messages);
    const b = await new MockProvider(new SeededRandomSource(123)).chat(prompt, messages);
    assert.equal(a, b);
  });

  process.stdout.write(`\n全部通过：${passed} 项\n`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
