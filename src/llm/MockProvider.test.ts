import * as assert from 'node:assert/strict';
import { MockProvider } from './MockProvider';
import { SeededRandomSource } from '../random';
import { ChatMessage } from '../types';

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error: any) {
    failed++;
    failures.push(name);
    process.stdout.write(`  ✗ ${name}\n      ${String(error?.message || error).split('\n')[0]}\n`);
  }
}

const wolfPrompt = '# 角色\n你是"曹操"（魏武帝），身份为【细作】，阵营为【🔴 狼人】。';

function message(content: string): ChatMessage[] {
  return [{ role: 'user', content }];
}

async function main(): Promise<void> {
  console.log('\n=== MockProvider 决策分类离线测试 ===\n');

  await check('夜间 reasoning schema 即使上下文含“投票”也走夜间随机选择', async () => {
    const provider = new MockProvider(new SeededRandomSource(123));
    const result = await provider.chatJSON<{ targetId: string; reasoning: string }>(
      wolfPrompt,
      message(
        '你的狼人同伴已完成投票。\n【首夜特殊指令】首夜零信息，随机选择。\n' +
        '可选目标：\n  · 候选-A(player_4)\n  · 候选-B(player_7)\n  · 候选-C(player_11)',
      ),
      '{"targetId": "player_X", "reasoning": "选择理由"}',
    );
    assert.ok(['player_4', 'player_7', 'player_11'].includes(result.targetId));
    assert.notEqual(result.targetId, 'player_0');
    assert.equal(typeof result.reasoning, 'string');
  });

  await check('投票 reason schema 仍走投票分支并返回 reason', async () => {
    const provider = new MockProvider(new SeededRandomSource(456));
    const result = await provider.chatJSON<{ targetId: string; reason: string }>(
      wolfPrompt,
      message('投票环节。可投票候选人：\n  · 刘备(player_4)\n  · 关羽(player_7)'),
      '{"targetId": "player_X", "reason": "一句话理由"}',
    );
    assert.ok(['player_4', 'player_7'].includes(result.targetId));
    assert.equal(typeof result.reason, 'string');
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) {
    console.error(`失败用例：${failures.join('、')}`);
    process.exitCode = 1;
  }
}

main();
