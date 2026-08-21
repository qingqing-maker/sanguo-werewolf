import * as assert from 'node:assert/strict';
import {
  DIFFICULTY_PROFILES,
  difficultyMemoryWindow,
  getDifficultyProfile,
  resolveDifficultyMisfireRate,
} from './difficultyProfile';

function main(): void {
  const light = DIFFICULTY_PROFILES.novice;
  const standard = DIFFICULTY_PROFILES.standard;
  const deep = DIFFICULTY_PROFILES.expert;

  assert.ok(light.strategyDepth < standard.strategyDepth && standard.strategyDepth < deep.strategyDepth);
  assert.ok(light.keyFactLimit < standard.keyFactLimit && standard.keyFactLimit < deep.keyFactLimit);
  assert.ok(light.dossierRounds < standard.dossierRounds && standard.dossierRounds < deep.dossierRounds);
  assert.ok(difficultyMemoryWindow('novice', 20) < difficultyMemoryWindow('standard', 20));
  assert.ok(difficultyMemoryWindow('standard', 20) < difficultyMemoryWindow('expert', 20));
  assert.ok(light.seerRepeatRate > standard.seerRepeatRate && standard.seerRepeatRate > deep.seerRepeatRate);
  assert.ok(light.guardRepeatRate > standard.guardRepeatRate && standard.guardRepeatRate > deep.guardRepeatRate);

  for (const profile of Object.values(DIFFICULTY_PROFILES)) {
    assert.equal(/保证|必胜|普通玩家水平|明显打不过/.test(`${profile.label}${profile.description}`), false);
  }
  assert.strictEqual(getDifficultyProfile(undefined), standard);

  const oldSeer = process.env.MISFIRE_SEER_REPEAT;
  process.env.MISFIRE_SEER_REPEAT = '0.33';
  assert.equal(resolveDifficultyMisfireRate('expert', 'seerRepeat'), 0.33, '显式 env 应覆盖档位默认值');
  if (oldSeer === undefined) delete process.env.MISFIRE_SEER_REPEAT;
  else process.env.MISFIRE_SEER_REPEAT = oldSeer;

  console.log('AI 思考强度配置离线测试通过');
}

main();
