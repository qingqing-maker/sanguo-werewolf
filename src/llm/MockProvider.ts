import { ChatMessage } from '../types';
import { LLMProvider, LLMRequestOptions } from './LLMProvider';
import { MathRandomSource, RandomSource } from '../random';

/**
 * Mock LLM Provider（半理性版）
 *
 * 目的：在不调用真实 LLM 的前提下，模拟一场"信息会流动、好人会跟预言家"的对局，
 * 用于批量跑局做规则平衡测试（狼/好胜率）。
 *
 * 它只能看到 systemPrompt + messages，因此所有"认知"都从这两处解析：
 *  - 自己的阵营/角色/名字/狼同伴 → 从 systemPrompt 解析；
 *  - 预言家自己的查验记录 → 从 speak/vote 注入的 seerHint 解析；
 *  - 别人公开的"验人结论" → 从 memory 里其他玩家的发言解析（预言家会在发言里公示）。
 *
 * 关键行为（半理性）：
 *  1. 预言家白天把查验结果编码进公开发言（【名字=狼】/【名字=好人】），信息因此进入全场记忆。
 *  2. 好人投票时：若记忆里存在"某候选人被验为狼"，则集火该人；否则在未被证清白的人里随机。
 *  3. 狼人投票：投一个非同伴的好人（随机），避免投同伴。
 *  4. 夜晚：狼优先刀已暴露的预言家，否则随机好人；预言家验未验过的人；守卫守已暴露预言家或随机。
 *  5. 女巫：首次可救则救；毒药只毒"已知狼"。
 */
export class MockProvider implements LLMProvider {
  private callCount = 0;
  /**
   * 好人阵营"读狼技能" p ∈ [0,1]：
   *   在没有预言家硬信息时，好人以概率 p 正确投出一个真狼（模拟 LLM 通过发言博弈识别狼的能力），
   *   以 (1-p) 概率退化为随机投票。
   * 狼阵营"夜刀精准度" q ∈ [0,1]：
   *   以概率 q 打出最优刀（精准刀已暴露的预言家），以 (1-q) 概率乱刀（随机好人）。
   *   这是模拟"高阶狼会集火神职、新手狼乱刀暴露"的连续旋钮。
   *
   * 分档校准的核心：低档要**同时**削弱好人读狼与狼的夜刀精准——只削一边会让胜率单向倾斜。
   * novice/standard/expert 三档各有一组默认值（下方 SKILL_BANDS），
   * 环境变量 GOOD_SKILL / WOLF_SKILL 若显式设置则覆盖对应档默认值（用于 sim 校准时逐格微调）。
   */
  private goodSkill: number;
  private wolfSkill: number;
  private readonly random: RandomSource;

  constructor(random: RandomSource = new MathRandomSource()) {
    this.random = random;
    const band = MockProvider.resolveSkillBand(process.env.AI_DIFFICULTY);
    this.goodSkill = process.env.GOOD_SKILL !== undefined ? Number(process.env.GOOD_SKILL) : band.good;
    this.wolfSkill = process.env.WOLF_SKILL !== undefined ? Number(process.env.WOLF_SKILL) : band.wolf;
  }

  /**
   * 三档技能默认值是 Mock 行为的工程参数，不代表真实模型或人类玩家的能力。
   * good = 好人采信预言家硬信息 / 无硬信息时读出真狼的概率（好人强度总阀门）；
   * wolf = 狼抱团冲票 + 夜刀精准命中已暴露预言家的概率（狼强度总阀门，抱团冲票是主杠杆）。
   *
   * 固定 seed=20260817、每档 100 局的当前基线中，好人胜率分别为
   * novice 48% / standard 36% / expert 51%，并不严格单调；expert 的逐票读狼命中率最高。
   * 这是因为两个阵营的技能参数和分档 prompt 会同时改变博弈结果。保留这些参数作为可重复基线，
   * 后续应使用多 seed 和受预算保护的少量真实 Provider 样本校准，不能依据单个 seed 过拟合调参。
   * 环境变量 GOOD_SKILL / WOLF_SKILL 若显式设置则覆盖对应档默认值（用于重新校准时逐格微调）。
   */
  private static resolveSkillBand(difficulty?: string): { good: number; wolf: number } {
    switch (difficulty) {
      case 'novice':
        return { good: 0.25, wolf: 0.55 };
      case 'expert':
        return { good: 0.30, wolf: 0.97 };
      case 'standard':
      default:
        return { good: 0.20, wolf: 0.85 };
    }
  }
  /**
   * 阵营真值预言机：name → isWolf。
   * MockProvider 是全场共享的单例，每个 agent 调用时都会带上自己的 systemPrompt（暴露自身阵营），
   * 因此累积观测即可在首日结束前得到完整阵营表。仅用于模拟"好人以技能 p 读出狼"，不改变任何游戏规则。
   */
  private factionOracle = new Map<string, boolean>();

  private observeOracle(self: SelfInfo): void {
    if (self.name && self.name !== '未知') this.factionOracle.set(self.name, self.isWolf);
    for (const partner of self.partners) this.factionOracle.set(partner, true);
  }

  async chat(systemPrompt: string, messages: ChatMessage[], options?: LLMRequestOptions): Promise<string> {
    options?.signal?.throwIfAborted();
    this.callCount++;
    const self = parseSelf(systemPrompt);
    this.observeOracle(self);
    const lastMessage = messages[messages.length - 1]?.content || '';

    // 白天发言 / 竞选演说
    if (/\[内心\]|\[发言\]|白天辩论|竞选/.test(lastMessage)) {
      // 预言家：把查验记录公示进公开发言，让信息进入全场记忆
      const seerReveal = buildSeerReveal(lastMessage);
      if (seerReveal) {
        return `[内心]吾已查验，须尽快公示，助好人锁定狼人。\n[发言]我是军师（预言家）！${seerReveal}`;
      }
      const inner = this.generateInnerThoughts(self.name);
      const speech = this.generateSpeech(self.name);
      return `[内心]${inner}\n[发言]${speech}`;
    }
    if (lastMessage.includes('遗言')) {
      return this.generateLastWords(self.name);
    }
    return `[内心]${this.generateInnerThoughts(self.name)}\n[发言]${this.generateSpeech(self.name)}`;
  }

  async chatJSON<T>(systemPrompt: string, messages: ChatMessage[], jsonSchema: string, options?: LLMRequestOptions): Promise<T> {
    options?.signal?.throwIfAborted();
    this.callCount++;
    const self = parseSelf(systemPrompt);
    this.observeOracle(self);
    const lastMessage = messages[messages.length - 1]?.content || '';
    const schema = jsonSchema || '';
    // 汇总全部记忆里"别人说过的话"，用于提取公开的验狼信息
    const memoryText = messages.map(m => m.content).join('\n');

    // decideYesNo：竞选/退水等是非题
    if (/\bdecision\b/.test(schema) || /decision/.test(lastMessage)) {
      // 退水场景默认继续竞选（no=退水 → 给 yes）；上警场景预言家/狼上，其余多数上
      return { decision: 'yes', reasoning: `${self.name}参与` } as T;
    }

    // witchDecide：救/毒/空过
    if (/\baction\b/.test(schema) || /save\|poison\|pass/.test(schema)) {
      return this.decideWitch(lastMessage, memoryText) as T;
    }

    // 投票（schema 精确包含 reason；reasoning 属于夜间行动/猎人，不能被历史消息里的“投票”误分类）
    const isVoteSchema = /["']reason["']/.test(schema) && !/["']reasoning["']/.test(schema);
    if (isVoteSchema || (/投票环节/.test(lastMessage) && !/夜间行动|击杀目标|首夜特殊指令/.test(lastMessage))) {
      const target = this.decideVote(self, lastMessage, memoryText);
      return { targetId: target, reason: `${self.name}依据场上信息做出选择。` } as T;
    }

    // 夜晚行动 / 猎人开枪（schema：targetId + reasoning）
    const target = this.decideNightAction(self, lastMessage, memoryText);
    return { targetId: target, reasoning: `${self.name}做出选择。` } as T;
  }

  // ─────────────────────────────────────────────
  // 决策核心
  // ─────────────────────────────────────────────

  /** 投票决策 */
  private decideVote(self: SelfInfo, message: string, memory: string): string {
    const candidates = extractCandidates(message);
    if (candidates.length === 0) return 'player_0';

    if (self.isWolf) {
      // 狼人：投一个非同伴、非自己的好人
      const pool = candidates.filter(c => !self.partners.includes(c.name) && c.name !== self.name);
      const pick = pool.length > 0 ? pool : candidates;
      // 抱团冲票（wolfSkill 的主杠杆）：以概率 q 全狼集火同一个好人——
      // 确定性地选 id 最小的好人候选，所有狼都会收敛到同一目标，票集中→好人被票出。
      // 以 (1-q) 概率各自乱投，票分散、浪费。这是狼在真实局最核心的赢法，
      // 也是让 expert 档狼强到能压平好人推理优势的关键（只靠夜刀精准远不够）。
      if (this.wolfSkill > 0 && this.random.chance(this.wolfSkill)) {
        // 集火只冲"非狼"候选（避免误冲同伴）；剩下的按 id 升序确定性收敛到同一人。
        const focusPool = pick.filter(c => this.factionOracle.get(c.name) !== true);
        const target = focusPool.length > 0 ? focusPool : pick;
        // 确定性收敛：按 id 升序取第一个，所有狼一致 → 抱团。
        const sorted = [...target].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return sorted[0].id;
      }
      return this.randPick(pick).id;
    }

    // 好人：预言家硬信息（公示的验狼）——但**不再无条件**集火。
    // 以 goodSkill 概率采信并跟票，以 (1-goodSkill) 概率"不信/被狼话术带偏"，退化到下面的自主判断。
    // 这一步是让 goodSkill 成为好人强度总阀门的关键：此前无条件集火使这条链权重压过旋钮，
    // 导致 goodSkill 压到 0.3 好人仍 70%（旋钮被架空）。加了采信概率后，低档好人会怀疑真预言家、跟错票。
    const knownWolves = extractKnownWolves(memory, message, self);
    const wolfCand = candidates.filter(c => knownWolves.has(c.name) && c.name !== self.name);
    if (wolfCand.length > 0 && (this.goodSkill >= 1 || this.random.chance(this.goodSkill))) {
      return this.randPick(wolfCand).id;
    }

    // 无硬信息：以技能 p 正确读出一个真狼（模拟 LLM 通过发言博弈识别狼的能力）
    if (this.goodSkill > 0 && this.random.chance(this.goodSkill)) {
      const realWolfCand = candidates.filter(
        c => c.name !== self.name && this.factionOracle.get(c.name) === true,
      );
      if (realWolfCand.length > 0) {
        return this.randPick(realWolfCand).id;
      }
    }

    // 退化为随机：在"未被证清白 + 非自己"里随机
    const knownGoods = extractKnownGoods(memory);
    let pool = candidates.filter(c => c.name !== self.name && !knownGoods.has(c.name));
    if (pool.length === 0) pool = candidates.filter(c => c.name !== self.name);
    if (pool.length === 0) pool = candidates;
    return this.randPick(pool).id;
  }

  /** 夜晚行动决策（狼刀 / 预言家验人 / 守卫守护 / 猎人开枪） */
  private decideNightAction(self: SelfInfo, message: string, memory: string): string {
    const candidates = extractCandidates(message);
    if (candidates.length === 0) return 'player_0';

    // 猎人开枪：打已知狼，否则随机
    if (/你是猎人|开枪带走/.test(message)) {
      const knownWolves = extractKnownWolves(memory, message, self);
      const wolfCand = candidates.filter(c => knownWolves.has(c.name));
      return wolfCand.length > 0 ? this.randPick(wolfCand).id : this.randPick(candidates).id;
    }

    // 狼人夜刀：以 wolfSkill 概率精准刀已暴露的预言家，否则乱刀（模拟低档狼不会集火神职）
    if (self.isWolf && !/查验|守护/.test(message)) {
      const seerName = extractRevealedSeer(memory);
      if (seerName && this.random.chance(this.wolfSkill)) {
        const seerCand = candidates.find(c => c.name === seerName);
        if (seerCand) return seerCand.id;
      }
      // 否则随机刀一个好人（候选已是非狼）
      return this.randPick(candidates).id;
    }

    // 预言家验人：验没验过的人
    if (/查验/.test(message)) {
      const checked = extractCheckedNames(message);
      const pool = candidates.filter(c => !checked.has(c.name) && c.name !== self.name);
      return pool.length > 0 ? this.randPick(pool).id : this.randPick(candidates).id;
    }

    // 守卫守护：守已暴露的预言家，否则随机
    if (/守护/.test(message)) {
      const seerName = extractRevealedSeer(memory);
      if (seerName) {
        const seerCand = candidates.find(c => c.name === seerName);
        if (seerCand) return seerCand.id;
      }
      return this.randPick(candidates).id;
    }

    return this.randPick(candidates).id;
  }

  /** 女巫决策：救/毒/空过 */
  private decideWitch(message: string, memory: string): { action: string; targetId?: string; reasoning: string } {
    const poisonUsable = /毒药\S*可用/.test(message);
    const canSave = /解药\S*可用/.test(message) && /被狼人杀害/.test(message);

    // 毒药：只毒"已知狼"（来自预言家公示），且毒药可用
    if (poisonUsable) {
      const targets = extractPoisonTargets(message);
      const knownWolves = extractKnownWolves(memory, message, { name: '', isWolf: false, roleName: '', partners: [] });
      const wolfTarget = targets.find(t => knownWolves.has(t.name));
      if (wolfTarget) {
        return { action: 'poison', targetId: wolfTarget.id, reasoning: '毒杀已确认的狼人' };
      }
    }

    // 解药：有人被刀且可救 → 救（保护关键好人）
    if (canSave) {
      return { action: 'save', reasoning: '首要救回被刀好人' };
    }

    return { action: 'pass', reasoning: '无明确目标，空过' };
  }

  // ─────────────────────────────────────────────
  // 文案生成（发言/内心/遗言）
  // ─────────────────────────────────────────────

  private generateInnerThoughts(name: string): string {
    const thoughts = [
      `此局面甚为微妙，吾需谨慎行事。`,
      `观其言行，似有破绽。待吾细细推敲。`,
      `众人之中，必有奸细。吾当暗中观察。`,
      `形势不利于吾方，需设法扭转乾坤。`,
      `此人发言前后矛盾，甚为可疑。`,
    ];
    return `【${name}内心】${thoughts[this.callCount % thoughts.length]}`;
  }

  private generateSpeech(name: string): string {
    const speeches: Record<string, string[]> = {
      '曹操': [
        '宁教我负天下人，休教天下人负我！诸位，今日之局，吾已看透七八分。',
        '哈哈哈！尔等若以为操是细作，不妨一试。只怕投错了人，悔之晚矣。',
        '操观此人言辞闪烁，必有隐情。诸位以为如何？',
      ],
      '诸葛亮': [
        '亮夜观天象，已知端倪。诸位且听亮一言。',
        '此人之言，前后矛盾。亮以为，其中必有蹊跷。',
        '兵者，诡道也。狼人善于伪装，吾等不可轻信表面。',
      ],
      '张飞': [
        '俺老张看不惯这些弯弯绕绕！谁是坏人就直说！',
        '你这厮！鬼鬼祟祟的，莫不是细作？！',
        '哼！俺张翼德可不怕你！有种就站出来！',
      ],
      '华佗': [
        '老夫悬壶济世，但今日需先辨明正邪。',
        '观此人面色，气息紊乱，似有所隐瞒。',
        '救人一命胜造七级浮屠，但若是奸人，老夫可无药可救。',
      ],
      '典韦': [
        '末将誓死护卫主公！谁敢造次？',
        '吾只管护人，推理之事，请诸位高人决断。',
        '此人形迹可疑，末将提议将其驱逐！',
      ],
    };
    const characterSpeeches = speeches[name] || [
      `在下${name}，观局势变化，认为此轮应当谨慎行事。`,
      `诸位，在下以为需从发言中寻找破绽。`,
      `在下附议，此人确有可疑之处。`,
    ];
    return characterSpeeches[this.callCount % characterSpeeches.length];
  }

  private generateLastWords(name: string): string {
    const lastWords: Record<string, string> = {
      '曹操': '哼，你们会后悔的。天下英雄，唯操与…算了。',
      '诸葛亮': '出师未捷身先死，长使英雄泪满襟。望诸位明辨是非。',
      '张飞': '你们这些鼠辈！！害了俺老张！！',
      '华佗': '唉…老夫去矣。望诸位好自为之。',
      '典韦': '末将…未能护住…主公…',
    };
    return lastWords[name] || `${name}含恨离去。`;
  }
  private randPick<T>(items: readonly T[]): T {
    return this.random.pick(items);
  }
}

// ─────────────────────────────────────────────
// 解析辅助函数
// ─────────────────────────────────────────────

interface SelfInfo {
  name: string;
  isWolf: boolean;
  roleName: string;
  partners: string[];
}

/** 从 systemPrompt 解析自己的身份 */
function parseSelf(systemPrompt: string): SelfInfo {
  const nameMatch = systemPrompt.match(/你是"(.+?)"/);
  const name = nameMatch ? nameMatch[1] : '未知';
  const isWolf = /阵营为【🔴 狼人】/.test(systemPrompt) || /身份为【细作/.test(systemPrompt);
  const roleMatch = systemPrompt.match(/身份为【(.+?)】/);
  const roleName = roleMatch ? roleMatch[1] : '';
  let partners: string[] = [];
  const pm = systemPrompt.match(/你的同伴：(.+?)。/);
  if (pm && !/无（独狼）/.test(pm[1])) {
    partners = pm[1].split(/[、,，]/).map(s => s.trim()).filter(Boolean);
  }
  return { name, isWolf, roleName, partners };
}

/**
 * 从 vote/nightAction 消息里提取候选 {name, id}。
 * 兼容两种格式：
 *   · 曹操(player_1)
 *   曹操(player_1)、张飞(player_3)
 */
function extractCandidates(message: string): { name: string; id: string }[] {
  const out: { name: string; id: string }[] = [];
  const seen = new Set<string>();
  const re = /([^\s、,，·()【】]+?)\((player_\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const name = m[1].trim();
    const id = m[2];
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ name, id });
    }
  }
  return out;
}

/** 女巫毒药可选目标（格式：可毒杀目标：名字(id)、名字(id)） */
function extractPoisonTargets(message: string): { name: string; id: string }[] {
  return extractCandidates(message);
}

/**
 * 预言家把查验记录编码进公开发言。
 * seerHint 格式：【你（预言家）确认的查验记录】第X晚验张飞=狼；第Y晚验赵云=好人
 * 返回："【张飞=狼】【赵云=好人】，请投出张飞！" 供公开发言；无记录返回 null。
 */
function buildSeerReveal(message: string): string | null {
  const hintMatch = message.match(/确认的查验记录】(.+?)(?:\n|$)/);
  // 也兼容 vote 注入格式：你验出的狼人：X；你验出的好人：Y
  let entries: { name: string; isWolf: boolean }[] = [];
  if (hintMatch) {
    const seg = hintMatch[1];
    const re = /验(.+?)=(狼|好人)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg)) !== null) {
      entries.push({ name: m[1].trim(), isWolf: m[2] === '狼' });
    }
  }
  if (entries.length === 0) return null;
  const markers = entries.map(e => `【${e.name}=${e.isWolf ? '狼' : '好人'}】`).join('');
  const wolves = entries.filter(e => e.isWolf).map(e => e.name);
  const tail = wolves.length > 0 ? `请大家投出狼人：${wolves.join('、')}！` : '目前所验皆为好人，继续观察。';
  return `我的查验结果：${markers}。${tail}`;
}

/**
 * 从全场记忆里提取"被公开验为狼"的名字集合。
 * 来源：
 *  - 其他预言家公示：发言里含 【名字=狼】
 *  - 自己（预言家）被注入的 vote 记录：你验出的狼人：X / ⚠️ 你查验确认的狼人 X
 */
function extractKnownWolves(memory: string, ownMessage: string, self: SelfInfo): Set<string> {
  const wolves = new Set<string>();
  const combined = memory + '\n' + ownMessage;
  // 公示标记 【名字=狼】
  const re = /【([^【】=]+?)=狼】/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(combined)) !== null) {
    wolves.add(m[1].trim());
  }
  // 预言家本人注入
  const own = ownMessage.match(/你验出的狼人：(.+?)(?:\n|$)/);
  if (own) own[1].split(/[、,，]/).forEach(s => { const t = s.trim(); if (t) wolves.add(t); });
  const confirm = ownMessage.match(/你查验确认的狼人\s*(.+?)\s*就在候选/);
  if (confirm) confirm[1].split(/[、,，]/).forEach(s => { const t = s.trim(); if (t) wolves.add(t); });
  return wolves;
}

/** 从记忆里提取"被公开验为好人"的名字集合 */
function extractKnownGoods(memory: string): Set<string> {
  const goods = new Set<string>();
  const re = /【([^【】=]+?)=好人】/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(memory)) !== null) {
    goods.add(m[1].trim());
  }
  return goods;
}

/** 从记忆里找出已暴露身份的预言家名字（发言里自称"我是军师/预言家"） */
function extractRevealedSeer(memory: string): string | null {
  // 记忆行格式：名字说：我是军师（预言家）！...
  const re = /([^\s：:]+?)说：[^\n]*我是军师/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(memory)) !== null) {
    last = m[1].trim();
  }
  return last;
}

/** 预言家 nightAction 消息里已验过的名字（避免重复验人） */
function extractCheckedNames(message: string): Set<string> {
  const checked = new Set<string>();
  const seg = message.match(/已验记录[^】]*】(.+?)(?:\n|$)/);
  if (seg) {
    const re = /([^\s；;、,，=]+?)=(?:狼|好人)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(seg[1])) !== null) {
      checked.add(m[1].trim());
    }
  }
  return checked;
}
