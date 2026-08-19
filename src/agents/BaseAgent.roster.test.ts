/**
 * 回归测试：speak/vote 发出的 prompt 必须携带**权威人数**与**完整狼队名单**。
 *
 * 背景：诸葛亮曾在一局里说「场上11人存活，狼队3人（我、貂蝉、典韦）」，实际是 12 人、4 狼——
 * 数字和名单同时错，还漏掉了司马懿。根因不是数据丢失（日志层始终正确），
 * 而是 prompt 只给「顿号分隔的姓名列表」，让模型自己数。novice 档记忆窗口只有 4 条，
 * 更容易把 12 个中文名数错。
 *
 * 修复策略：由代码用 `.length` 直接写死人数与狼队总数，并在 prompt 里明确声明
 * 「这是系统权威值，不要重数、不要改写」。本测试用捕获型 LLMProvider 把
 * BaseAgent.speak/vote 实际发出的最后一条 user message 抓出来，锁死上述断言。
 *
 * 不发起任何网络请求、不消耗任何 token。
 *
 * 运行：npm run test:roster
 */
import * as assert from 'node:assert/strict';
import {
  CharacterConfig,
  ChatMessage,
  Faction,
  GamePhase,
  GameState,
  Player,
  RoleType,
} from '../types';
import { BaseAgent } from './BaseAgent';
import { LLMProvider } from '../llm/LLMProvider';
import { ALL_ROLES } from '../roles/Role';

// ============ 测试脚手架 ============

let passed = 0;
let failed = 0;

function report(line: string): void {
  process.stdout.write(line + '\n');
}

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    report(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    report(`  ✗ ${name}`);
    report(`      ${String(e?.message || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

/**
 * 捕获 chat/chatJSON 最后一次调用的 messages。
 * chat 返回一段合法的 speak 格式；chatJSON 返回任意合法 JSON 由调用方自己解析。
 */
class CaptureProvider implements LLMProvider {
  lastMessages: ChatMessage[] = [];
  lastSystem = '';
  chatReply = '[内心]测试内心[发言]测试发言';
  jsonReply: any = { targetId: 'player_1', reason: '测试' };

  async chat(system: string, messages: ChatMessage[]): Promise<string> {
    this.lastSystem = system;
    this.lastMessages = messages;
    return this.chatReply;
  }

  async chatJSON<T>(system: string, messages: ChatMessage[]): Promise<T> {
    this.lastSystem = system;
    this.lastMessages = messages;
    return this.jsonReply as T;
  }
}

function makeCharacter(name: string): CharacterConfig {
  return {
    name,
    title: `${name}的称号`,
    personality: '测试性格',
    speechStyle: '测试风格',
    selfReference: '我',
    traits: { aggression: 5, logic: 5, deception: 5, charisma: 5, loyalty: 5 } as any,
    catchphrases: ['测试口头禅'],
  };
}

/** 12 人局，4 狼；狼队名字用日志里的真名以确保回归“漏掉司马懿”的场景。 */
const NAMES = ['诸葛亮', '貂蝉', '典韦', '司马懿', '张飞', '曹操', '关羽', '吕布', '华佗', '赵云', '周瑜', '刘备'];
const ROLES: RoleType[] = [
  RoleType.WEREWOLF, RoleType.WEREWOLF, RoleType.WEREWOLF, RoleType.WEREWOLF,
  RoleType.SEER, RoleType.WITCH, RoleType.HUNTER, RoleType.GUARD,
  RoleType.VILLAGER, RoleType.VILLAGER, RoleType.VILLAGER, RoleType.VILLAGER,
];

interface Setup {
  players: Player[];
  agents: BaseAgent[];
  state: GameState;
  provider: CaptureProvider;
  byName: (name: string) => { player: Player; agent: BaseAgent };
}

function setup(): Setup {
  const provider = new CaptureProvider();
  const players: Player[] = NAMES.map((name, i) => ({
    id: `player_${i}`,
    name,
    roleType: ROLES[i],
    faction: ALL_ROLES[ROLES[i]].faction,
    isAlive: true,
    characterConfig: makeCharacter(name),
  }));
  const agents = players.map(pl => new BaseAgent(pl, provider));
  for (const a of agents) a.setPlayersRef(players);

  const state: GameState = {
    phase: GamePhase.DAY,
    round: 1,
    players,
    events: [],
    nightActions: [],
    eliminatedTonight: [],
    witchSaveUsed: false,
    witchPoisonUsed: false,
    lastGuardTarget: null,
    sheriffId: null,
  };

  const byName = (name: string) => {
    const idx = players.findIndex(p => p.name === name);
    if (idx < 0) throw new Error(`no player named ${name}`);
    return { player: players[idx], agent: agents[idx] };
  };

  return { players, agents, state, provider, byName };
}

/** 抓 chat/chatJSON 最后一条 user message 内容。 */
function lastUserContent(provider: CaptureProvider): string {
  const msgs = provider.lastMessages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return msgs[i].content;
  }
  throw new Error('捕获到的 messages 里没有 user 消息');
}

// ============ 用例 ============

async function main(): Promise<void> {
  // 关掉战术人格，避免抽风影响 prompt 结构（本测试只关心权威名册）。
  process.env.TACTIC_STYLES = 'off';

  report('\n[speak 请求必须携带权威人数和狼队完整名单]');

  await test('狼人诸葛亮：存活人数写死为 12，且不出现"11人"', async () => {
    const s = setup();
    const { agent } = s.byName('诸葛亮');
    agent.difficulty = 'novice'; // 现场事故就是 novice 档
    await agent.speak('测试上下文', s.state);
    const prompt = lastUserContent(s.provider);
    assert.match(prompt, /当前存活\s*12\s*人/, 'prompt 里必须写死 12 人');
    assert.doesNotMatch(prompt, /场上?\s*11\s*人存活/, '不能出现 11 人这种旧数据');
    assert.match(prompt, /权威值.*不要自己重新数|不要在输出里写成别的数字/, '必须声明权威值');
  });

  await test('狼人诸葛亮：狼队总数=4，同伴数=3，且司马懿在名单里', async () => {
    const s = setup();
    const { agent } = s.byName('诸葛亮');
    agent.difficulty = 'novice';
    await agent.speak('测试上下文', s.state);
    const prompt = lastUserContent(s.provider);
    // 狼队总数 = 你自己 + 3 名同伴
    assert.match(prompt, /狼队当前存活\s*4\s*人/, '狼队总数必须是 4');
    assert.match(prompt, /3\s*名同伴/, '同伴数必须是 3');
    // 三名同伴的名字都要在
    for (const partner of ['貂蝉', '典韦', '司马懿']) {
      assert.ok(prompt.includes(partner), `同伴名单必须包含 ${partner}`);
    }
  });

  await test('好人张飞：不得看到狼队名单', async () => {
    const s = setup();
    const { agent } = s.byName('张飞'); // 预言家
    await agent.speak('测试上下文', s.state);
    const prompt = lastUserContent(s.provider);
    assert.doesNotMatch(prompt, /狼队当前存活/, '好人 prompt 不能出现狼队总数');
    assert.doesNotMatch(prompt, /名同伴/, '好人 prompt 不能出现同伴名单');
    // 但存活人数还是要有
    assert.match(prompt, /当前存活\s*12\s*人/, '好人一样要看到权威人数');
  });

  await test('有玩家死亡后：人数自动降到 11，不写死为 12', async () => {
    const s = setup();
    // 让赵云出局
    const zhao = s.byName('赵云');
    zhao.player.isAlive = false;
    const { agent } = s.byName('诸葛亮');
    await agent.speak('测试上下文', s.state);
    const prompt = lastUserContent(s.provider);
    assert.match(prompt, /当前存活\s*11\s*人/, '死一人后应为 11 人');
    assert.ok(!prompt.includes('赵云'), '死者不能出现在存活名单里');
  });

  await test('狼人同伴死亡：狼队总数与同伴数同步下调', async () => {
    const s = setup();
    // 貂蝉出局
    const diaochan = s.byName('貂蝉');
    diaochan.player.isAlive = false;
    const { agent } = s.byName('诸葛亮');
    await agent.speak('测试上下文', s.state);
    const prompt = lastUserContent(s.provider);
    assert.match(prompt, /狼队当前存活\s*3\s*人/, '狼队应剩 3 人');
    assert.match(prompt, /2\s*名同伴/, '同伴应剩 2 人');
    assert.ok(!prompt.includes('貂蝉'), '死掉的貂蝉不能再出现在同伴列表里');
    // 剩下的同伴还在
    for (const partner of ['典韦', '司马懿']) {
      assert.ok(prompt.includes(partner), `活着的同伴 ${partner} 仍要在名单里`);
    }
  });

  await test('狼人自己是最后一只狼：明确写"最后一只狼"', async () => {
    const s = setup();
    // 除了诸葛亮，其他三只狼都死
    for (const name of ['貂蝉', '典韦', '司马懿']) {
      s.byName(name).player.isAlive = false;
    }
    const { agent } = s.byName('诸葛亮');
    await agent.speak('测试上下文', s.state);
    const prompt = lastUserContent(s.provider);
    assert.match(prompt, /只剩你\s*1\s*人|最后一只狼/, '独狼场景要明确说明');
  });

  report('\n[vote 请求同样携带自我锚定 + 狼队名册]');

  await test('vote 请求：狼人看到狼队总数和同伴名单', async () => {
    const s = setup();
    const { agent } = s.byName('诸葛亮');
    // 候选人排除自己（规则要求）
    const candidates = s.players.filter(p => p.id !== agent.player.id).map(p => p.id);
    s.provider.jsonReply = { targetId: candidates[0], reason: '测试', analysis: '测试' };
    await agent.vote('投票上下文', candidates);
    const prompt = lastUserContent(s.provider);
    assert.match(prompt, /当前存活\s*12\s*人/, 'vote 也应看到权威人数');
    assert.match(prompt, /狼队当前存活\s*4\s*人/, 'vote 也应看到狼队总数');
    for (const partner of ['貂蝉', '典韦', '司马懿']) {
      assert.ok(prompt.includes(partner), `vote 时同伴名单必须包含 ${partner}`);
    }
  });

  await test('vote 请求：好人不看狼队名册', async () => {
    const s = setup();
    const { agent } = s.byName('张飞');
    const candidates = s.players.filter(p => p.id !== agent.player.id).map(p => p.id);
    s.provider.jsonReply = { targetId: candidates[0], reason: '测试', analysis: '测试' };
    await agent.vote('投票上下文', candidates);
    const prompt = lastUserContent(s.provider);
    assert.doesNotMatch(prompt, /狼队当前存活/, '好人 vote 不能看到狼队总数');
    assert.doesNotMatch(prompt, /名同伴/, '好人 vote 不能看到同伴名单');
  });

  report(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
