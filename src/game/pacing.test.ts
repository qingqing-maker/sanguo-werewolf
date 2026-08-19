import assert from 'node:assert/strict';
import { estimateSpeechBaseMs, readPacingScale, scalePacingMs } from './pacing';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

console.log('\n[节奏系数解析]');
check('默认值为正常速度 1', () => {
  assert.equal(readPacingScale({}), 1);
  assert.equal(readPacingScale({ PACING_SCALE: '' }), 1);
});
check('合法非负数被完整解析', () => {
  assert.equal(readPacingScale({ PACING_SCALE: '1' }), 1);
  assert.equal(readPacingScale({ PACING_SCALE: '0.5' }), 0.5);
  assert.equal(readPacingScale({ PACING_SCALE: '0' }), 0);
});
check('非法、无穷和负数回退为 1', () => {
  for (const value of ['abc', 'NaN', 'Infinity', '-1', '0.5oops']) {
    assert.equal(readPacingScale({ PACING_SCALE: value }), 1, value);
  }
});
check('FAST_MODE=1 覆盖任意 PACING_SCALE', () => {
  assert.equal(readPacingScale({ FAST_MODE: '1', PACING_SCALE: '3' }), 0);
});

console.log('\n[固定停顿缩放]');
check('PACING_SCALE=1 保持原时长', () => {
  const env = { PACING_SCALE: '1' };
  assert.equal(scalePacingMs(1000, env), 1000);
  assert.equal(scalePacingMs(800, env), 800);
  assert.equal(scalePacingMs(300, env), 300);
});
check('PACING_SCALE=0.5 将所有固定停顿减半', () => {
  const env = { PACING_SCALE: '0.5' };
  assert.equal(scalePacingMs(1000, env), 500);
  assert.equal(scalePacingMs(500, env), 250);
  assert.equal(scalePacingMs(800, env), 400);
  assert.equal(scalePacingMs(300, env), 150);
});
check('PACING_SCALE=0 与 FAST_MODE=1 都归零', () => {
  assert.equal(scalePacingMs(1000, { PACING_SCALE: '0' }), 0);
  assert.equal(scalePacingMs(1000, { PACING_SCALE: '9', FAST_MODE: '1' }), 0);
});
check('毫秒数使用 Math.round 四舍五入', () => {
  assert.equal(scalePacingMs(301, { PACING_SCALE: '0.5' }), 151);
});

console.log('\n[发言停顿单次缩放]');
check('短发言基础停顿下限为 1500ms', () => {
  assert.equal(estimateSpeechBaseMs('短句'), 1500);
});
check('空格不计入发言字数', () => {
  assert.equal(estimateSpeechBaseMs('短 句'), estimateSpeechBaseMs('短句'));
});
check('长发言基础停顿上限为 10000ms', () => {
  assert.equal(estimateSpeechBaseMs('长'.repeat(200)), 10000);
});
check('0.5 对短发言只缩放一次：1500ms -> 750ms', () => {
  const base = estimateSpeechBaseMs('短句');
  assert.equal(scalePacingMs(base, { PACING_SCALE: '0.5' }), 750);
});
check('0.5 对超长发言只缩放一次：10000ms -> 5000ms', () => {
  const base = estimateSpeechBaseMs('长'.repeat(200));
  assert.equal(scalePacingMs(base, { PACING_SCALE: '0.5' }), 5000);
});

console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
if (failed > 0) process.exit(1);
