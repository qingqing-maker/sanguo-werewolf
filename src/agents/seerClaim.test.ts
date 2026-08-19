/**
 * seerClaim 离线单测。
 * 与仓库其他测试保持同风格：node:assert/strict + ts-node 直跑，不引第三方框架。
 *
 * 覆盖重点：
 *   1) 第一人称自跳（通用代词 / 角色专属自称 / 名字自称）应识别为 true。
 *   2) 反向声明"预言家就是我"应识别为 true。
 *   3) 他人转述"赵云跳了预言家"绝不能误判成说话者自跳（核心防误伤场景）。
 *   4) 普通发言、否定语气不应误判。
 *   5) 验人结论抽取：多条结论、狼/好人、无结论。
 */

import { strict as assert } from 'node:assert';
import { detectSelfSeerClaim, extractSeerVerdicts } from './seerClaim';

interface Case {
  name: string;
  run: () => void;
}
const cases: Case[] = [];
function test(name: string, run: () => void): void {
  cases.push({ name, run });
}

// —— 第一人称自跳：通用代词 ——
test('通用代词"我是预言家"→ 自跳', () => {
  assert.equal(detectSelfSeerClaim('我是预言家，昨夜验人了。'), true);
});

test('通用代词"在下便是军师"→ 自跳', () => {
  assert.equal(detectSelfSeerClaim('在下便是军师。'), true);
});

test('"我跳预言家"→ 自跳', () => {
  assert.equal(detectSelfSeerClaim('废话不多说，我跳预言家。'), true);
});

test('"我要跳真预言家"→ 自跳（含"真的"修饰）', () => {
  assert.equal(detectSelfSeerClaim('我要跳真预言家，别被假的骗了。'), true);
});

// —— 反向声明 ——
test('反向声明"预言家就是我"→ 自跳', () => {
  assert.equal(detectSelfSeerClaim('这局的预言家就是我。'), true);
});

test('反向声明"军师乃吾"→ 自跳', () => {
  assert.equal(detectSelfSeerClaim('军师乃吾也。'), true);
});

// —— 角色专属自称：只对本人生效 ——
test('赵云自称"云乃预言家"→ 传入 selfRef=云 时识别为自跳', () => {
  assert.equal(detectSelfSeerClaim('云乃预言家，验的典韦是好人。', '云', '赵云'), true);
});

test('曹操自称"操是军师"→ 传入 selfRef=操 时识别为自跳', () => {
  assert.equal(detectSelfSeerClaim('操便是军师。', '操', '曹操'), true);
});

test('张飞按 name 自称"张飞就是预言家"→ 传入 selfName 时识别', () => {
  assert.equal(detectSelfSeerClaim('张飞就是预言家！', '俺老张', '张飞'), true);
});

test('未传角色自称时，"云乃预言家"不被通用词表命中', () => {
  // "云"不在通用代词表里，不传 selfRef 时不应命中（避免泛匹配）。
  assert.equal(detectSelfSeerClaim('云乃预言家。'), false);
});

// —— 核心防误伤：他人转述不算自跳 ——
test('他人转述"赵云跳了预言家"→ 说话者不是赵云，不误判为自跳', () => {
  // 说话者自称是"我"，但内容在转述赵云；不传赵云的自称，避免把"赵云"当第一人称。
  assert.equal(detectSelfSeerClaim('赵云跳了预言家，我信他。'), false);
});

test('转述句含被转述者自称"典韦称老夫是好人"→ 不误判（typo 场景保护）', () => {
  // 传入的是说话者自己（比如刘备）的自称，而非典韦的；"老夫"是典韦的自称，
  // 但这里说话者是刘备，不应命中。
  assert.equal(detectSelfSeerClaim('典韦虽跳预言家并称他验的我是好人。', '备', '刘备'), false);
});

// —— 普通发言不误判 ——
test('普通分析"我怀疑周瑜是狼"→ 非自跳', () => {
  assert.equal(detectSelfSeerClaim('我怀疑周瑜是狼。'), false);
});

test('空串 → 非自跳', () => {
  assert.equal(detectSelfSeerClaim(''), false);
});

// —— 验人结论抽取 ——
test('抽取单条验人结论"验了典韦是狼"', () => {
  assert.deepEqual(extractSeerVerdicts('我是预言家，验了典韦是狼。'), ['典韦=狼']);
});

test('抽取多条验人结论', () => {
  assert.deepEqual(
    extractSeerVerdicts('昨夜查刘备是好人，前夜验典韦是狼人。'),
    ['刘备=好人', '典韦=狼'],
  );
});

test('狼人归一化：查验结果"是狼人"记为狼', () => {
  assert.deepEqual(extractSeerVerdicts('验张飞是狼人'), ['张飞=狼']);
});

test('无验人结论 → 空数组', () => {
  assert.deepEqual(extractSeerVerdicts('我是预言家，昨夜没验人。'), []);
});

test('extractSeerVerdicts 可重复调用（无全局 lastIndex 污染）', () => {
  const text = '验典韦是狼';
  assert.deepEqual(extractSeerVerdicts(text), ['典韦=狼']);
  // 再调一次结果必须一致（若共享 /g 正则 lastIndex 会漏匹配）。
  assert.deepEqual(extractSeerVerdicts(text), ['典韦=狼']);
});

// —— 执行 ——
let passed = 0;
let failed = 0;
const failures: string[] = [];
for (const c of cases) {
  try {
    c.run();
    passed++;
    process.stdout.write(`  ✓ ${c.name}\n`);
  } catch (e: any) {
    failed++;
    failures.push(c.name);
    process.stdout.write(`  ✗ ${c.name}\n`);
    process.stdout.write(`      ${String(e?.message || e).split('\n')[0]}\n`);
  }
}
process.stdout.write(`\n=== seerClaim: ${passed} 通过，${failed} 失败 ===\n`);
if (failures.length > 0) {
  process.stdout.write('失败用例：\n');
  for (const f of failures) process.stdout.write(`  · ${f}\n`);
  process.exit(1);
}
