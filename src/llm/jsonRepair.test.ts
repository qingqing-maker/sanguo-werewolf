/**
 * jsonRepair 单测。纯字符串处理，不发起任何网络请求、不消耗任何 token。
 *
 * 运行：npm run test:json
 *
 * 用例全部来自真实观测或已知的 LM 输出畸形形态。每加一种畸形都应先在这里补一条用例，
 * 再去改 repairJsonText —— 否则修复规则会互相打架（典型：补全引号的规则误伤已经合法的 JSON）。
 */
import * as assert from 'node:assert/strict';
import { parseJsonLoose, repairJsonText } from './jsonRepair';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`      ${e.message.split('\n')[0]}`);
  }
}

/**
 * 断言 raw 能被解析成 expected（深比较）。
 * parseJsonLoose 返回结果对象而不抛异常，所以这里先断言 ok=true 再比较 value。
 */
function parsesTo(raw: string, expected: unknown): void {
  const actual = parseJsonLoose(raw);
  assert.equal(actual.ok, true, `期望解析成功，实际失败：${actual.ok ? '' : actual.error.message}`);
  assert.deepEqual((actual as { ok: true; value: unknown }).value, expected);
}

/** 断言 raw 无法被修复（返回 ok=false），不能悄悄产出脏数据。 */
function failsToParse(raw: string): void {
  const actual = parseJsonLoose(raw);
  assert.equal(
    actual.ok,
    false,
    `期望解析失败，实际成功并返回：${JSON.stringify((actual as { value?: unknown }).value)}`,
  );
}

console.log('\n=== jsonRepair 单测 ===\n');

console.log('[合法 JSON 必须原样通过（防止修复规则误伤）]');

check('标准 JSON', () => {
  parsesTo('{"targetId":"player_3","reason":"发言空泛"}', {
    targetId: 'player_3',
    reason: '发言空泛',
  });
});

check('含中文标点的字符串值不被破坏', () => {
  parsesTo('{"reason":"他说「再看看」，没给理由；很可疑。"}', {
    reason: '他说「再看看」，没给理由；很可疑。',
  });
});

check('值里含转义双引号', () => {
  parsesTo('{"reason":"他原话是\\"我弃票\\"，明显心虚"}', {
    reason: '他原话是"我弃票"，明显心虚',
  });
});

check('值里含逗号和大括号不被截断', () => {
  parsesTo('{"reason":"A、B、C 三人抱团，{注意} 票型"}', {
    reason: 'A、B、C 三人抱团，{注意} 票型',
  });
});

check('嵌套对象', () => {
  parsesTo('{"a":{"b":1},"c":2}', { a: { b: 1 }, c: 2 });
});

check('布尔与 null 保持原生类型', () => {
  parsesTo('{"ok":true,"bad":false,"x":null}', { ok: true, bad: false, x: null });
});

console.log('\n[markdown 围栏]');

check('```json 围栏', () => {
  parsesTo('```json\n{"action":"pass"}\n```', { action: 'pass' });
});

check('无语言标记的 ``` 围栏', () => {
  parsesTo('```\n{"action":"pass"}\n```', { action: 'pass' });
});

check('围栏 + 前后解说文字', () => {
  parsesTo('好的，我的决策如下：\n```json\n{"action":"poison","targetId":"player_5"}\n```\n希望有用。', {
    action: 'poison',
    targetId: 'player_5',
  });
});

console.log('\n[前后缀噪声]');

check('JSON 前有解说', () => {
  parsesTo('经过分析，我决定：{"targetId":"player_1"}', { targetId: 'player_1' });
});

check('JSON 后有解说', () => {
  parsesTo('{"targetId":"player_1"} —— 以上是我的选择。', { targetId: 'player_1' });
});

check('<think> 推理块残留', () => {
  parsesTo('<think>我觉得张飞可疑</think>{"targetId":"player_2","reason":"空泛"}', {
    targetId: 'player_2',
    reason: '空泛',
  });
});

console.log('\n[尾随逗号]');

check('对象尾逗号', () => {
  parsesTo('{"a":1,"b":2,}', { a: 1, b: 2 });
});

check('数组尾逗号', () => {
  parsesTo('{"xs":[1,2,3,]}', { xs: [1, 2, 3] });
});

check('尾逗号 + 换行缩进', () => {
  parsesTo('{\n  "a": 1,\n  "b": 2,\n}', { a: 1, b: 2 });
});

console.log('\n[空值畸形（女巫 targetId 常见）]');

check('半开引号 + 逗号：": ," → 空串', () => {
  parsesTo('{"action":"pass","targetId":",\n"reason":"空过"}'.replace(',\n', '" ,'), {
    action: 'pass',
    targetId: '',
    reason: '空过',
  });
});

check('半开引号收尾：": }" → 空串', () => {
  parsesTo('{"action":"pass","targetId":" }', { action: 'pass', targetId: '' });
});

console.log('\n[Python 字面量]');

check('None → null', () => {
  parsesTo('{"targetId":None}', { targetId: null });
});

check('True/False → true/false', () => {
  parsesTo('{"ok":True,"bad":False}', { ok: true, bad: false });
});

check('字符串里的 None 不被改写', () => {
  parsesTo('{"reason":"他说 None 都不可信"}', { reason: '他说 None 都不可信' });
});

check('字符串里的 True 不被改写', () => {
  parsesTo('{"reason":"True 与否要看票型"}', { reason: 'True 与否要看票型' });
});

console.log('\n[注释]');

check('// 行注释', () => {
  parsesTo('{\n  "a": 1, // 这是理由\n  "b": 2\n}', { a: 1, b: 2 });
});

check('/* 块注释 */', () => {
  parsesTo('{"a":1,/* 忽略我 */"b":2}', { a: 1, b: 2 });
});

check('字符串里的 // 不被当注释（URL 形态）', () => {
  parsesTo('{"reason":"见 http://example.com 的说法"}', {
    reason: '见 http://example.com 的说法',
  });
});

console.log('\n[全角引号]');

check('全角双引号包裹键值', () => {
  parsesTo('{“action”:“pass”}', { action: 'pass' });
});

check('全角引号混用半角', () => {
  parsesTo('{"action":“pass”}', { action: 'pass' });
});

console.log('\n[真实畸形组合]');

check('围栏 + 尾逗号 + None', () => {
  parsesTo('```json\n{\n  "action": "pass",\n  "targetId": None,\n  "reasoning": "不确定",\n}\n```', {
    action: 'pass',
    targetId: null,
    reasoning: '不确定',
  });
});

check('解说 + 围栏 + 注释 + 尾逗号', () => {
  parsesTo(
    '我的选择：\n```json\n{\n  "targetId": "player_7", // 最可疑\n  "reason": "跟票不给理由",\n}\n```',
    { targetId: 'player_7', reason: '跟票不给理由' },
  );
});

console.log('\n[真正无法修复时必须抛错，不能返回脏数据]');

check('纯自然语言 → 抛错', () => {
  failsToParse('我觉得应该投张飞，因为他发言很空泛。');
});

check('空字符串 → 抛错', () => {
  failsToParse('');
});

check('只有空白 → 抛错', () => {
  failsToParse('   \n  ');
});

check('残缺到无法补全 → 抛错', () => {
  failsToParse('{"targetId');
});

check('JSON 数组顶层（非对象）→ 抛错', () => {
  // 所有决策点的 schema 都是对象；顶层数组说明模型跑偏了，应走重试而非硬解析。
  failsToParse('[1,2,3]');
});

console.log('\n[repairJsonText 幂等性]');

check('对合法 JSON 修复两次结果一致', () => {
  const raw = '{"targetId":"player_1","reason":"抱团"}';
  const once = repairJsonText(raw);
  const twice = repairJsonText(once);
  assert.equal(once, twice);
  assert.deepEqual(JSON.parse(twice), { targetId: 'player_1', reason: '抱团' });
});

console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===\n`);

if (failed > 0) {
  process.exit(1);
}
