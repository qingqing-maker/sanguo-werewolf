/**
 * speechParser 离线单测。
 * 与仓库其他测试保持同风格：node:assert/strict + ts-node 直跑，不引第三方框架。
 *
 * 覆盖重点：
 *   1) 老 bug 场景：模型只输出内心分析、漏 [发言] 标签，绝不能把整段塞进 publicSpeech。
 *   2) 单侧标签场景（只有 [内心] / 只有 [发言]）。
 *   3) 完全无标签的分析型长文（华佗那次的截图形态）。
 *   4) 完全无标签的短口语（口语化对局台词）应保留为公开发言，不误当内心。
 *   5) 长度截断、标签残留清理、空发言兜底。
 */

import { strict as assert } from 'node:assert';
import {
  parseSpeechResponse,
  fallbackPublicSpeech,
  looksLikeInnerAnalysis,
} from './speechParser';

interface Case {
  name: string;
  run: () => void;
}

const cases: Case[] = [];
function test(name: string, run: () => void): void {
  cases.push({ name, run });
}

// —— 格式1：完整 [内心] + [发言] ——
test('format1: 完整 [内心][发言] 双段被正确拆分', () => {
  const raw = '[内心]我判断周瑜是狼。[发言]诸位，我认为周瑜有问题。';
  const r = parseSpeechResponse(raw);
  assert.equal(r.innerThoughts, '我判断周瑜是狼。');
  assert.equal(r.publicSpeech, '诸位，我认为周瑜有问题。');
});

test('format1: 全角【】括号也能匹配', () => {
  const raw = '【内心】老曹稳。【发言】我信曹操。';
  const r = parseSpeechResponse(raw);
  assert.equal(r.innerThoughts, '老曹稳。');
  assert.equal(r.publicSpeech, '我信曹操。');
});

// —— 格式2/3：XML 风 ——
test('format2: <think>/<speech> 双段被正确拆分', () => {
  const raw = '<think>周瑜可疑</think>\n<speech>我怀疑周瑜。</speech>';
  const r = parseSpeechResponse(raw);
  assert.equal(r.innerThoughts, '周瑜可疑');
  assert.equal(r.publicSpeech, '我怀疑周瑜。');
});

// —— 核心修复点 A：只有 [内心]，缺 [发言] ——
test('单侧标签: 只有 [内心] 时公开发言退回兜底文案，绝不把内心塞进公开发言', () => {
  const raw = '[内心]周瑜被三方质疑，我倾向投周瑜，值得投出去看看底牌。';
  const r = parseSpeechResponse(raw, { selfReference: '华佗' });
  assert.equal(r.innerThoughts.includes('倾向投周瑜'), true);
  // 关键断言：公开发言里不能出现"倾向投"这种内心分析词。
  assert.equal(r.publicSpeech.includes('倾向投'), false);
  assert.equal(r.publicSpeech.includes('看底牌'), false);
  assert.equal(r.publicSpeech, fallbackPublicSpeech('华佗'));
});

test('单侧标签: 只有 [发言] 时公开发言保留、内心留空', () => {
  const raw = '[发言]大家好，我先观望一下。';
  const r = parseSpeechResponse(raw);
  assert.equal(r.innerThoughts, '');
  assert.equal(r.publicSpeech, '大家好，我先观望一下。');
});

// —— 核心修复点 B：完全无标签的分析型内心 ——
test('无标签分析型: 华佗截图形态整段被判为内心，公开发言走兜底', () => {
  const raw =
    '周瑜被曹操、赵云、张飞三方同时质疑，而且他自己确实只砸人没立标尺。' +
    '华佗我观其面色，周瑜这状态确实有点站不住脚。' +
    '赵云跳了预言家说张飞是好人，但暂时不站队乱冲这话听着像在给自己留后路，可信度打个折扣。' +
    '曹操质疑有理，暂时可信。今天我倾向于投周瑜——被三方锤还没硬气的警长，值得投出去看看底牌。';
  const r = parseSpeechResponse(raw, { selfReference: '华佗' });

  // 内心里应保留原文的关键判断（做了长度截断也不影响开头断言）。
  assert.equal(r.innerThoughts.length > 0, true);
  assert.equal(r.innerThoughts.startsWith('周瑜被曹操'), true);

  // 关键断言：公开发言绝不能包含"我倾向"/"可信度"/"看底牌"/"立标尺"这类内心分析词。
  const leakedWords = ['倾向', '可信度', '看底牌', '立标尺', '留后路', '值得投'];
  for (const w of leakedWords) {
    assert.equal(
      r.publicSpeech.includes(w),
      false,
      `公开发言泄露了内心分析词: "${w}" → ${r.publicSpeech}`,
    );
  }
  assert.equal(r.publicSpeech, fallbackPublicSpeech('华佗'));
});

test('无标签分析型: 单命中"打算投"也应视为内心', () => {
  const raw = '我打算投典韦，理由是他今天票型很奇怪，第一轮就在带节奏。';
  const r = parseSpeechResponse(raw, { selfReference: '曹操' });
  assert.equal(r.publicSpeech.includes('打算投'), false);
  assert.equal(r.innerThoughts.includes('打算投典韦'), true);
});

// —— 核心修复点 C：无标签但明显是正常公开发言，不能误判 ——
test('无标签短口语: 正常对局台词应保留为公开发言', () => {
  const raw = '大家先别急，慢慢来。';
  const r = parseSpeechResponse(raw);
  assert.equal(r.publicSpeech, '大家先别急，慢慢来。');
  assert.equal(r.innerThoughts, '');
});

test('无标签中等长度且无分析词: 保留为公开发言', () => {
  const raw = '这个啊，我寻思周瑜今天说话有点飘，怎么讲呢，感觉不太对劲，但也说不准。';
  const r = parseSpeechResponse(raw);
  assert.equal(r.publicSpeech.length > 0, true);
  // 没有命中分析型关键词、长度也不到 120 字，应保留为公开发言。
  assert.equal(r.innerThoughts, '');
  assert.equal(r.publicSpeech.startsWith('这个啊'), true);
});

// —— 长度阈值兜底：无分析词但极长文本也要视为内心 ——
test('无标签超长文本(>=120字): 即使无分析关键词也走内心兜底，避免长内心泄露', () => {
  const raw = '这个问题我觉得非常复杂'.repeat(15); // 15 × 11 = 165 字
  const r = parseSpeechResponse(raw, { selfReference: '典韦' });
  assert.equal(raw.length >= 120, true);
  assert.equal(r.publicSpeech, fallbackPublicSpeech('典韦'));
  assert.equal(r.innerThoughts.length > 0, true);
});

// —— 标签残留清理 ——
test('残留 [/内心] [/发言] 标签会被清理干净', () => {
  const raw = '[内心]我怀疑周瑜。[/内心][发言]周瑜有问题。[/发言]';
  const r = parseSpeechResponse(raw);
  assert.equal(r.innerThoughts.includes('/内心'), false);
  assert.equal(r.publicSpeech.includes('/发言'), false);
  assert.equal(r.innerThoughts, '我怀疑周瑜。');
  assert.equal(r.publicSpeech, '周瑜有问题。');
});

test('残留 XML 标签会被清理', () => {
  const raw = '[内心]<foo>周瑜</foo>可疑。[发言]周瑜<bar/>有问题。';
  const r = parseSpeechResponse(raw);
  assert.equal(r.innerThoughts.includes('<foo>'), false);
  assert.equal(r.publicSpeech.includes('<bar'), false);
});

// —— 长度限制 ——
test('公开发言超过 publicMax 被截断并加省略号', () => {
  const raw = '[内心]a[发言]' + '哦'.repeat(400);
  const r = parseSpeechResponse(raw, { publicMax: 50 });
  assert.equal(r.publicSpeech.endsWith('…'), true);
  assert.equal(r.publicSpeech.length, 51);
});

test('内心超过 innerMax 被截断', () => {
  const raw = '[内心]' + '啊'.repeat(500) + '[发言]短发言。';
  const r = parseSpeechResponse(raw, { innerMax: 100 });
  assert.equal(r.innerThoughts.endsWith('…'), true);
  assert.equal(r.innerThoughts.length, 101);
});

// —— 空发言兜底 ——
test('清理后公开发言为空: 走兜底文案', () => {
  const raw = '[内心]a[发言]  ';
  const r = parseSpeechResponse(raw, { selfReference: '赵云' });
  assert.equal(r.publicSpeech, fallbackPublicSpeech('赵云'));
});

test('自称参数省略时使用"在下"', () => {
  const raw = '[内心]我打算投周瑜';
  const r = parseSpeechResponse(raw);
  assert.equal(r.publicSpeech.startsWith('在下'), true);
});

// —— looksLikeInnerAnalysis 直接测 ——
test('looksLikeInnerAnalysis: 命中分析词返回 true', () => {
  assert.equal(looksLikeInnerAnalysis('今天我倾向于投周瑜'), true);
  assert.equal(looksLikeInnerAnalysis('可信度打个折扣'), true);
  assert.equal(looksLikeInnerAnalysis('值得投出去看看底牌'), true);
  assert.equal(looksLikeInnerAnalysis('留后路的话就不太合理'), true);
});

test('looksLikeInnerAnalysis: 普通对局口语返回 false', () => {
  assert.equal(looksLikeInnerAnalysis('大家先别急，慢慢来'), false);
  assert.equal(looksLikeInnerAnalysis('周瑜你别急着开票'), false);
  assert.equal(looksLikeInnerAnalysis(''), false);
});

// —— 执行 ——
let passed = 0;
let failed = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`✓ ${c.name}`);
    passed++;
  } catch (e: any) {
    console.error(`✗ ${c.name}`);
    console.error(`  ${e?.message || e}`);
    failed++;
  }
}

console.log(`\nspeechParser: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
