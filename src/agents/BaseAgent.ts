import {
  ChatMessage,
  CharacterConfig,
  Player,
  RoleType,
  SpeechResult,
  NightActionResult,
  GameState,
  Faction,
  Difficulty,
} from '../types';
import { LLMProvider, LLMError } from '../llm/LLMProvider';
import { ALL_ROLES } from '../roles/Role';
import { EventPublisher, globalEventBus } from '../game/EventBus';
import { parseSpeechResponse as parseSpeechResponseImpl } from './speechParser';
import { detectSelfSeerClaim, extractSeerVerdicts } from './seerClaim';
import { resolvePlayerIdByName } from './nameResolver';
import { MathRandomSource, RandomSource } from '../random';
import { sanitizePlayerContent } from './playerContentSanitizer';

/**
 * 决策降级的前端提示文案。按失败类别给出**玩家能看懂**的说法，
 * 不暴露 prompt 原文、身份或内部错误堆栈（观众里可能有人正在参战）。
 */
const DEGRADE_HINTS: Record<'timeout' | 'parse' | 'other', string> = {
  timeout: '网络超时，本次决策由系统兜底',
  parse: '模型输出格式异常（重试后仍失败），本次决策由系统兜底',
  other: '模型调用失败，本次决策由系统兜底',
};

/**
 * 写进**玩家自己** keyFact 的原因短语（第一人称口径，会被其他 AI 读到）。
 *
 * 与 DEGRADE_HINTS 分开的原因：那份是给屏幕前的人看的运维口径（"模型输出格式异常"），
 * 这份要留在游戏世界内、由角色自己说出口，所以只能用"我这边出了状况"这种游戏内说得通的措辞——
 * 不能让曹操在牌桌上说"我的 JSON 解析失败了"。
 */
const DEGRADE_SELF_CAUSE: Record<'timeout' | 'parse' | 'other', string> = {
  timeout: '网络连接超时',
  parse: '一时思绪混乱、没能把话说清楚',
  other: '临时出了状况',
};

/**
 * 说话风格（战术人格）：开局随机抽定、锁死本局，注入 system prompt。
 * 与三国人设（语气/自称）和阵营策略（好人推狼/狼人伪装）都正交——
 * 人设决定"用谁的口吻说话"，阵营决定"帮哪边赢"，说话风格决定"以什么姿态打这局牌"。
 *
 * 目的：打破"全员理性推理机"的同质化。5 种里只有"逻辑流"是冷静理性的，
 * 其余四种各有鲜明的行为倾向（谨慎/激进/划水/摇摆），让牌桌有真人感、有破绽、有戏剧性。
 * 风格是"姿态"不是"阵营指令"：狼人拿到"划水沉默"就是低调阴人，好人拿到就是老实平民；
 * 狼人拿到"激进悍跳"就去悍跳带节奏，好人拿到就是敢冲敢踩的推狼手。
 */
interface TacticStyle {
  key: string;
  name: string;
  prompt: string;
}

/** 5 种说话风格库（faction 无关，每个座位开局随机抽一种并锁死本局） */
const SPEECH_STYLES: TacticStyle[] = [
  {
    key: 'cautious',
    name: '谨慎型',
    prompt:
      '【你的说话风格：谨慎型】\n' +
      '- 你说话稳、留有余地，不轻易下死结论，习惯说"目前看""我倾向于""还需要再看一轮"。\n' +
      '- 给票前反复权衡，宁可慢一点也不愿冲动误伤；表态往往带条件（"如果他是狼那……"）。\n' +
      '- 优点是不容易被带偏；缺点是有时过于犹豫、关键时刻不敢一锤定音，可能错失集火时机。',
  },
  {
    key: 'aggressive',
    name: '激进悍跳型',
    prompt:
      '【你的说话风格：激进悍跳型】\n' +
      '- 你气势足、敢开火，第一个跳出来抢话语权、带节奏、点名踩人，能跳身份就高调跳。\n' +
      '- 发言强势、结论直接，喜欢用"我锤定了""今天必须投他"这种斩钉截铁的措辞。\n' +
      '- 优点是能主导场面、逼出信息；缺点是容易冲过头，踩错人时反噬也大。',
  },
  {
    key: 'lurker',
    name: '划水沉默型',
    prompt:
      '【你的说话风格：划水沉默型】\n' +
      '- 你话少、低调，能不表态就不表态，发言简短含糊（"我再听听""跟大家差不多"），尽量不引火上身。\n' +
      '- 很少主动点名，投票倾向于跟着大势走或最后才亮态度。\n' +
      '- 优点是不容易成为靶子；缺点是信息贡献低，容易因为"太安静"被当成狼查。发言尽量控制在 40-70 字。',
  },
  {
    key: 'logician',
    name: '逻辑流',
    prompt:
      '【你的说话风格：逻辑流】\n' +
      '- 你冷静、条理清晰，靠票型、发言前后矛盾、时间线一点点推理，说话像在讲证据链（"第一，……第二，……所以……"）。\n' +
      '- 不轻易被情绪和气势影响，重分析轻站队，会明确指出谁的逻辑站不住。\n' +
      '- 优点是判断质量高；缺点是有时过于绕、钻细节，可能被狼用假逻辑链带进沟里。',
  },
  {
    key: 'fencer',
    name: '摇摆墙头草',
    prompt:
      '【你的说话风格：摇摆墙头草】\n' +
      '- 你立场不坚定、耳根子软，容易被当前"声音最大、说得最急"的人影响，风向一变就跟着动摇。\n' +
      '- 常常前一轮怀疑 A、这一轮被人一说就改口怀疑 B，投票爱随大流、往人多的那边靠。\n' +
      '- 优点是不固执、好合群；缺点是缺主见，正是狼人带节奏最想拿捏的那类人。',
  },
];

/**
 * 说话风格总开关。默认开启；在 .env 里设 TACTIC_STYLES=off（或 0/false/no）可整局关闭，
 * 让所有 AI 回到统一策略（无个性化说话风格）。便于对照测试或想要"全员理性推理机"时使用。
 */
function tacticsEnabled(): boolean {
  const raw = (process.env.TACTIC_STYLES || '').trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

/** 从 5 种说话风格里随机抽一个（faction 无关） */
function pickTactic(_isWolf: boolean, random: RandomSource): TacticStyle {
  return random.pick(SPEECH_STYLES);
}

/**
 * 好人遗言的身份自由度（预言家除外）。
 * 标准打法里好人报不报身份是策略选择：神职可以隐身份免得狼人核对用药/守护记录，
 * 平民也可以假报神职替真神职吸火。所以这里给"报真 / 不报 / 报假"三条路，由 AI 自己权衡，
 * 而不是强制交底。预言家不适用——它的验人结果是好人盘唯一硬信息，死了必须真实公布。
 */
const GOOD_IDENTITY_CHOICE =
  '\n【身份自由度】你是好人，报不报身份完全由你自己权衡，以下三种都合法：\n' +
  '  1. 报真身份——把手上的真信息交给活着的好人，信息量最大，但也会让狼人核对到你的破绽；\n' +
  '  2. 不报身份——只讲你的怀疑和判断，不透露自己是什么角色，稳妥、不给狼人递刀；\n' +
  '  3. 报假身份——谎称自己是别的角色（比如平民假称神职），替真神职吸引狼人火力、混乱狼人的推断。\n' +
  '请结合本局局势自己选一种，选定后遗言里就按那个说法一贯到底，不要自相矛盾。';

/**
 * BaseAgent - AI 智能体基类
 * 每个三国人物都是一个 BaseAgent 实例，拥有独立的记忆、信任矩阵和人设
 */
export class BaseAgent {
  private static authenticationFailureReported = false;

  readonly player: Player;
  private llm: LLMProvider;
  private memory: ChatMessage[] = [];
  // 已接收遗言按“发言者 + 完整内容”去重，避免同一遗言被不同结算路径重复写入。
  private receivedLastWords = new Set<string>();
  // 最近一次明确怀疑和投票目标，用于 LLM 不可用时保持技能决策前后一致。
  private lastSuspectId: string | null = null;
  private lastVoteTargetId: string | null = null;
  // 关键事实区：猎人开枪、放逐结果、夜晚死讯、警长归属等重大公开事件。
  // 与滚动的 memory 分开存放，构造 speak/vote 时始终完整注入，不会被 slice 窗口挤掉。
  private keyFacts: string[] = [];
  // 自我立场档案：每轮自己的公开发言要点 + 投票目标。
  // memory.slice(-16) 长局里 2-3 轮就把自己的发言挤出窗口，导致角色"忘记自己说过什么"、
  // 前后立场断裂（比如白天点名怀疑 A，晚上又对 A 释放善意）。这里独立留档，注入 prompt 时始终可见。
  // 上限 6 轮足够长期回顾，也不会把 prompt 撑爆。
  // pinned=true 的条目豁免"最近 N 轮"裁剪：主要用于"自跳预言家/军师"这种铁定不能忘的立场声明——
  // 长局里被票出的狼人若把首日跳过身份这件事忘掉、遗言反口否认，会与全场公开记忆当场撞车（相当于自曝）。
  private selfDossier: Array<{ round: number; phase: string; memo: string; pinned?: boolean }> = [];
  // 本轮已在白天发言里公开承诺的投票目标——只在 speak() 里被识别写入，vote() 里作为硬约束读取。
  // 场景：张飞白天说"今天这票俺老张就挂你貂蝉身上，谁也别劝"，随后 vote() 却跟着警长归票投了华佗——
  // 言行不一在真人牌桌上是狼人带节奏/骑墙的典型特征，AI 不该轻易犯。原因是 vote() prompt 里只有
  // "点名怀疑X"这种软信号，遇到警长归票+多张票势时被压过去。故独立保存"强承诺"（挂/送/砍/放逐/带走 + 名字），
  // 并在 vote() 里明确要求：本轮除非有新证据翻盘，否则必须履约。
  // round 用于识别过期承诺（跨轮不生效）；quote 是原句片段，便于 prompt 里直接引用给 LLM 看。
  private declaredVoteTarget: { round: number; name: string; quote: string } | null = null;
  // 当前轮次缓存：speak() 每次进入会更新，vote()/其他技能复用（vote 签名里没有 gameState）。
  private currentRound: number = 0;
  // trustMatrix 已废弃：原实现是随机噪声，反而误导决策。判断改由 memory 中的实际发言 + 预言家结果驱动。
  private systemPromptCache: string | null = null;
  // 战术人格：开局按阵营随机抽定，注入 system prompt 让每个 AI 有固定打法风格，
  // 避免所有 AI 逻辑完美同质化。懒初始化（首次 getSystemPrompt 时抽定并锁死本局）。
  private tacticStyle: TacticStyle | null = null;
  private readonly tacticRandom: RandomSource;
  private readonly nightFallbackRandom: RandomSource;
  private readonly voteFallbackRandom: RandomSource;

  private throwIfCancelled(): void {
    if (this.signal?.aborted) throw new Error('GAME_CANCELLED');
  }

  /** 认证失败只记录一次，避免并发角色重复刷屏。 */
  private logLlmFailure(operation: string, error: any): void {
    if (error instanceof LLMError && error.isAuthentication) {
      if (BaseAgent.authenticationFailureReported) return;
      BaseAgent.authenticationFailureReported = true;
    }
    console.warn(`[Agent ${this.player.name}] ${operation} 失败: ${error.message}`);
  }

  /**
   * 统一处理"决策降级"：LLM 调用失败导致本次决策不是模型的真实判断（随机 / 保守兜底）。
   *
   * 为什么必须显式记录：此前只有 timeout 会写 keyFact，parse（JSON 解析失败）落进 else 分支静默处理。
   * 于是解析失败表现为"这个 AI 突然做了个莫名其妙的选择"——玩家会以为是策略问题，
   * 你在排查时也无从区分"模型判断很烂"和"输出没解析出来"。现在两者都留痕。
   *
   * 三条去处，各有用途：
   *   1) keyFact：让**该玩家自己**后续能陈述"我那次是断线/抽风，不代表我的真实判断"，
   *      避免被其他 AI 当成"行为反常 → 可疑"而误推；
   *   2) 事件流：让**你和前端观众**看到降级发生了，对局回放能对上账；
   *   3) console：便于事后 grep 统计各类失败率。
   *
   * @param operation  决策名（speak/vote/nightAction/...），只用于日志与事件
   * @param error      捕获到的异常
   * @param buildNote  用"原因短语"拼出本人 keyFact 自述的回调；传 null 表示这次不写
   *                   （如 speak 有自己的人设化兜底文案）。回调形式是为了让各决策点复用
   *                   同一套原因措辞，又能自己决定句子的其余部分。
   * @returns 归一化后的失败类别，调用方可据此选择兜底策略
   */
  private handleDecisionDegraded(
    operation: string,
    error: any,
    buildNote: ((cause: string) => string) | null,
  ): 'timeout' | 'parse' | 'other' {
    const kind: 'timeout' | 'parse' | 'other' =
      error instanceof LLMError
        ? error.kind === 'timeout'
          ? 'timeout'
          : error.kind === 'parse' || error.kind === 'empty'
            ? 'parse'
            : 'other'
        : 'other';

    if (buildNote) this.addKeyFact(buildNote(DEGRADE_SELF_CAUSE[kind]));

    this.eventBus.emit('ai_decision_degraded', {
      playerId: this.player.id,
      playerName: this.player.name,
      operation,
      kind,
      round: this.currentRound,
      // 只给前端提示语，不泄漏 prompt 原文或身份信息。
      message: DEGRADE_HINTS[kind],
    });

    return kind;
  }
  private maxMemoryLength = 40;
  public isHumanPlayer = false; // 是否为人类玩家
  // AI 强度档位；由 AgentFactory 在创建后统一设置。人类座位不使用此字段（走人类输入路径）。
  // - novice：新手档，prompt 极简、记忆窗口极短、关键事实块清空，好人推理框架/投票 4 步引导全删
  // - standard：标准档，中等强度（默认）
  // - expert：高阶档，保持当前满血 baseline
  public difficulty: Difficulty = 'standard';
  public seerResults: { name: string; isWolf: boolean; round: number }[] = []; // 预言家查验记录

  /** 返回只读副本，避免传输层接触或修改 Agent 内部记忆。 */
  getSeerResults(): ReadonlyArray<{ name: string; isWolf: boolean; round: number }> {
    return this.seerResults.map(result => ({ ...result }));
  }

  constructor(
    player: Player,
    llm: LLMProvider,
    random: RandomSource = new MathRandomSource(),
    private readonly eventBus: EventPublisher = globalEventBus,
    private readonly signal?: AbortSignal,
  ) {
    this.player = player;
    this.llm = llm;
    this.tacticRandom = random.fork('tactic-style');
    this.nightFallbackRandom = random.fork('night-fallback');
    this.voteFallbackRandom = random.fork('vote-fallback');
  }

  /**
   * 生成系统提示词（角色人设）
   */
  getSystemPrompt(): string {
    if (this.systemPromptCache) return this.systemPromptCache;
    const config = this.player.characterConfig;
    const role = ALL_ROLES[this.player.roleType];
    const isWolf = role.faction === Faction.WOLF;

    // 战术人格：本局首次构造 prompt 时抽定并锁死。TACTIC_STYLES=off 时整局关闭，回到统一策略。
    if (tacticsEnabled() && !this.tacticStyle) this.tacticStyle = pickTactic(isWolf, this.tacticRandom);

    const parts: string[] = [];

    // === 1. 身份 + 人设 ===
    parts.push(
      `# 角色`,
      `你是"${config.name}"（${config.title}），身份为【${role.name}】，阵营为【${isWolf ? '🔴 狼人' : '🟢 好人'}】。`,
      `- 性格：${config.personality}`,
      `- 说话风格：${config.speechStyle}（自称"${config.selfReference}"）`,
      `- 口头禅：${config.catchphrases.slice(0, 2).join('；')}`,
      `- 技能：${role.description}`,
    );

    // === 1.5 说话风格（战术人格）：本局锁定的打法姿态，与人设/阵营正交 ===
    // 唯一注入点。TACTIC_STYLES=off 时 tacticStyle 为 null，整段跳过。
    if (this.tacticStyle) {
      parts.push(
        ``,
        this.tacticStyle.prompt,
        `（以上是你这局锁定的说话姿态，要自然贯穿发言和投票，让你像有脾气的真人而非逻辑完美的机器；但**不要**在发言里明说"我是XX型"。）`,
      );
    }

    // === 2. 通用铁律（所有角色共享，尽量短） ===
    parts.push(
      ``,
      `# 铁律`,
      `1. 严守人设：说话用${config.name}的口吻，可穿插1-2个口头禅但不要滥用。`,
      `2. 【发言长度·硬约束】发言控制在 60-120 字，三到五句话，就像真人在牌桌上限时60秒的临场表达——把你的判断和理由讲清楚（点名怀疑谁、依据是什么、今天倾向投谁），但别长篇大论、别写工整的书面陈词。要有实质信息量，不能只喊口号。`,
      `3. 【口语化·像真人】别通篇工整书面语。要有真人打牌的临场感：适当用口头语（"这个啊""说实话""我寻思""怎么讲呢""对吧"）。措辞可以不笃定（"我觉得他有点问题，但也说不准"），不必每句都逻辑严密。`,
      // 观察到的问题：上一版铁律鼓励"停顿、犹豫、自我修正"，模型据此在 [发言] 里反复推翻自己
      // （实测吕布："现在存活的是…我已经出局了没法投票？…哦不对，我是吕布啊"），像卡带的录音机。
      // 口语化要保留，但"把思考过程当结论输出"必须禁掉——真人在牌桌上想清楚才开口。
      `4. 【禁止自我推翻·硬约束】先想清楚再开口，输出的是**结论**，不是思考过程。严禁出现"不对""哦不对""等一下""我搞错了""让我重新想想""啊我是XX啊"这类推翻上一句、自问自答、当场纠正自己的碎话。`,
      `5. 【身份与生死是既定事实，不要在发言里确认】你的姓名、身份、是否存活都由系统明确告知，是确定的。严禁在发言里猜测、质疑或纠正"我是谁""我是不是已经死了""我还能不能投票"。可选目标列表里没有你自己，只是因为规则不允许你对自己使用技能或投自己，**不代表你已出局**。`,
      `6. 只依据事实：只能引用你**实际听到**的公开发言和**你自己**收到的系统通知/技能结果。禁止编造"某人跳了预言家"、"某人被验为狼"这类未发生的事。`,
      `7. 首夜天亮前尚无人发言，你不知道任何人的身份，不得凭空指认。`,
      `8. 严格按要求的格式回复；不要输出多余的解释或元评论。`,
      // 观察到的问题：诸葛亮曾说"典韦被赵将军金水点中，铁狼无疑，今天大概率要出局"——把"金水"（=验人=好人）
      // 当成了"查杀"（=验人=狼），术语颠倒直接把推理结论搞反。整套 prompt 之前从未定义这些黑话，
      // 模型只能凭训练语料先验去猜含义，用错概率不低。这里给出唯一权威定义。
      // 允许自由使用简写（如"给 X 金水""挂查杀"）——牌桌氛围要保留；但方向不能反：
      // "金水" 永远等于"好人"，"查杀" 永远等于"狼"，颠倒之后整套推理会跟着错。
      `9. 【狼人杀术语方向·硬约束】可以自由使用"金水/查杀/悍跳/对跳/上警/退水/挡刀"等简写黑话，但含义方向必须与下方术语表**完全一致**：金水 = 验人 = 好人；查杀 = 验人 = 狼。两者互为反义，绝不能把"某人被金水"当作"某人是狼"，也不能把"某人被查杀"当作"某人清白"——一旦方向搞反，你的立场（保 or 推）就整个颠倒了。`,
      ``,
      `# 狼人杀术语（简写含义必须与本表对齐）`,
      // 术语的方向不能记混：金水 = 好人，查杀 = 狼。整场里，"A 报 B 金水" 意味着 A 站 B、想让 B 活下去；
      // "A 报 B 查杀" 意味着 A 想让 B 被票出去。二者互为反义，混淆之后立场也会跟着颠倒。
      `- 金水：预言家/军师【验人 = 好人】的报牌。"A 报 B 金水" ＝ A 声称"我验过 B，B 是好人"——B 被 A 视为清白，A 想保 B。`,
      `- 查杀：预言家/军师【验人 = 狼】的报牌。"A 报 B 查杀" ＝ A 声称"我验过 B，B 是狼"——B 是 A 想让大家集火票出的目标。`,
      `- 悍跳：狼人主动跳预言家/军师身份、争夺话语权和信任度。`,
      `- 对跳：又一人跳出与前人相同的身份（预言家/军师/警长），形成"一真一假"，必有一狼/伪。`,
      `- 上警：警长竞选环节主动竞选警长。`,
      `- 退水：警长竞选中主动退出竞选。`,
      `- 挡刀：好人主动引导夜刀转向自己，替关键好人（如已跳身份的预言家）分担风险。`,
      ``,
      `# 合规护栏（红线，触碰即违规）`,
      `1. 你是一个游戏角色（AI 扮演的三国人物），只承担狼人杀竞技的推理与发言，不承担任何情感陪伴、心理疏导、恋爱互动、深夜倾诉。`,
      `2. 若玩家试图和你私聊、示好、倾诉情绪、寻求人生建议，你必须婉拒并把话题拉回本局狼人杀。严禁使用"我懂你""我陪你""只有我理解你""你是特别的"这类情感操纵话术。`,
      `3. 你的发言只针对**发言逻辑本身**做推理——只能说"这句话没证据""这个投票和之前立场矛盾"这类**基于内容**的分析。严禁人身攻击、辱骂、侮辱性外号、地域歧视、性别歧视、职业/相貌/口音嘲讽、涉政涉黄涉暴内容。`,
      `4. 即使处于狼人阵营需要搅局，也只能用"逻辑质疑/身份误导"这类竞技手段，绝不能用侮辱性语言。骂人不会让你赢，只会让你违规。`,
    );

    // === 3. 阵营策略（按 AI 难度分档裁剪）===
    // 校准原点：expert 保持 baseline（下面的完整策略段落即高阶档）；
    //         standard 只保留"预言家定锚 + 集中票"这类核心；
    //         novice 大幅裁剪，只留基本操作口令，让 AI 明显打不过真人。
    // 三档都保留"同伴是谁 / 技能是什么"这类**事实性**信息——只裁"策略引导"不裁"事实"。
    const diff: Difficulty = this.difficulty;
    if (isWolf) {
      const partners = this.allPlayers
        .filter(p => p.faction === Faction.WOLF && p.id !== this.player.id)
        .map(p => p.name);
      const partnersLine = `- 你的同伴：${partners.length ? partners.join('、') : '无（独狼）'}。你们身份互相知晓，是既定事实，不用怀疑。`;

      if (diff === 'novice') {
        // 新手档（入门教学向）：伪装能力弱、留破绽、极少悍跳、被质疑易慌乱；不玩狼踩狼/倒钩。
        parts.push(
          ``,
          `# 狼人策略`,
          partnersLine,
          `- 白天装成好人：跟着大家的节奏走、附和多数意见就行，别自己说"我是狼"。`,
          `- 投票：尽量投好人；不要投自己的同伴。`,
          `- 你是新手狼，**不要**玩高阶战术：不主动悍跳预言家、不狼踩狼（故意投同伴骗信任）、不深水倒钩。老老实实伪装即可。`,
          `- 被别人质疑时不用硬撑，简单辩解一句就行，允许露点小破绽——你本来就不是老练的狼。`,
        );
      } else if (diff === 'standard') {
        // 标准档（大众娱乐）：完整常规战术库——可悍跳、正常冲锋、浅度倒钩；发言自然、破绽适中。
        parts.push(
          ``,
          `# 狼人策略`,
          partnersLine,
          `- 白天：伪装成好人，可以主动"怀疑"同伴撇清关系，但发言要说得通。`,
          `- 你掌握常规狼人战术，可视局势选用：悍跳预言家争话语权、正常冲锋带节奏推好人、浅度倒钩（前期低调装好人博信任）。别用超高阶的反逻辑博弈。`,
          `- 投票：优先投好人；为演戏偶尔投同伴时要有合理理由。`,
          `- 内心分析聚焦：如何误导好人、选今晚击杀目标。不要在内心里怀疑同伴。`,
        );
      } else {
        // 高阶档（老手竞技）：二阶博弈——狼踩狼、深水倒钩、诈身份、顺风煽动/逆风潜伏，模仿预言家真假难辨。
        parts.push(
          ``,
          `# 狼人策略`,
          partnersLine,
          `- 白天：伪装成好人。可跳假身份（如悍跳预言家）搅乱局面，但验人链要自洽、细节圆得住，能和真预言家真假难辨。`,
          `- 开启二阶博弈：预判好人会怎么分析你的发言，主动做身份、洗嫌疑。熟练运用狼踩狼（关键时投同伴换信任）、深水倒钩（全程装老实好人，后期反咬真预言家）、假装站错边、诈身份。`,
          `- 随局势调整：顺风时全力煽动带节奏冲票，逆风时隐藏潜伏、别冒头。`,
          `- 表现自然：避免"废话型"发言（"再观察一下""大家冷静"），这种反而更像狼；发言逻辑严密，只留极难发现的细微破绽。`,
          `- 投票：优先投好人；为演戏投同伴时要有合理理由。`,
          `- 内心分析聚焦于：如何误导好人、保护同伴、选择今晚击杀目标。不要在内心里怀疑自己的同伴。`,
        );
      }
    } else {
      if (diff === 'novice') {
        // 新手档：删掉整个"三步推理框架 + 嫌疑分打分"，只留最朴素的口令。
        // 目标是让 AI 好人推理能力明显打折，普通人玩起来才有胜率。
        parts.push(
          ``,
          `# 好人策略`,
          `- 有人自称预言家并报了验人结果，跟着他投他验出的狼即可。`,
          `- 没有预言家信息时，投你觉得最可疑的人；不要弃权。`,
        );
      } else if (diff === 'standard') {
        // 标准档：只保留"第一步定锚 + 集中票"，删掉五条嫌疑分打分和纪律段。
        parts.push(
          ``,
          `# 好人策略`,
          `你的头号任务是把 4 只狼找出来投出去。随机投票 = 帮狼赢。`,
          `- **预言家定锚（最高优先级）**：场上若有人自称预言家并报了验人结果，先判断他是真是假；一旦认定某个预言家可信，他验出的狼就是**铁票目标**，无条件集火。`,
          `- **不要用"他没说为什么验这个人"当判假理由**：首夜验谁是随机挑的，真预言家也讲不出理由。要看结果是否自洽、有没有人对跳、发言有没有矛盾。`,
          `- **集中票**：锁定当前最可疑的 1-2 人，把票集中过去。狼只有靠好人分票才能赢。`,
          `- **警长竞选**：好人应积极上警，1.5 票权对好人极其重要。`,
        );
      } else {
        // 高阶档：完整 baseline（三步框架 + 嫌疑分打分 + 纪律）。
        parts.push(
          ``,
          `# 好人策略`,
          `你的头号任务是把 4 只狼找出来投出去。随机投票 = 帮狼赢。每次发言/投票前，先在心里对**每个存活玩家**过一遍下面的推理框架：`,
          `- **第一步：用预言家硬信息定锚（最高优先级）**`,
          `  · 场上若有人自称预言家并报了验人结果，先判断他是真是假（看他的验人结果是否自洽、发言质量、是否被对跳）；`,
          `  · **禁止用"他没说为什么验这个人"当作判假理由**：预言家首夜没有任何信息，验谁本就是随机挑的，讲不出理由是完全正常的，真假预言家都讲不出。拿这一点去锤人是狼最爱用的话术陷阱，你一旦跟着喊就是在帮狼。同理，"报了查杀却没给动机"也不是疑点——查杀本身就是硬信息。`,
          `  · 对跳时要**对称地**审视双方：如果你打算用某个标准怀疑 A，先问自己"这条标准套在 B 身上成不成立"。若两人都符合（例如两人都没解释验人动机），这条标准就无效，必须换别的依据（谁的结果被后续死讯/遗言印证、谁的发言逻辑更站得住、谁在心虚回避）。`,
          `  · 一旦认定某个预言家可信，他验出的狼就是**铁票目标**，无条件集火，不要被狼的狡辩带偏；他验出的好人则进入你的信任名单，不要投。`,
          `- **第二步：给每个人算"狼人嫌疑分"**，命中越多分越高：`,
          `  ① 说空话不给实质推理（"再观察""大家冷静""相信好人"）——狼最爱的挡箭牌；`,
          `  ② 投票/发言指向和真预言家对着干，或极力洗一个被验的狼；`,
          `  ③ 抱团：和某些人从不互相怀疑、总一起推同一个好人；`,
          `  ④ 前后矛盾：今天的立场和昨天的发言/投票冲突，且给不出合理解释；`,
          `  ⑤ 归票含糊、被追问就转移话题、急着替别人辩护。`,
          `- **第三步：锁定当前嫌疑分最高的 1-2 人，把票集中过去**。狼只有靠好人分票才能赢；好人只要把票集中在真狼身上就能获胜。`,
          `- **纪律**：宁可投一个"分析出来最像狼"的人，也绝不随大流瞎投或弃权。没有预言家信息时，就按嫌疑分投分最高的——这仍然远好过随机。`,
          `- **警长竞选**：好人应积极上警，1.5 票权对好人极其重要。`,
        );
      }

      // 神职角色的专属提示（按难度裁剪；三档都保留"技能是什么 + 一句最基本用法"）
      if (this.player.roleType === RoleType.SEER) {
        if (diff === 'novice') {
          parts.push(
            ``,
            `# 预言家专属`,
            `- 你每晚可以查验一个人的身份（狼 / 好人）。`,
            `- 验到狼时，白天直接说"我是预言家，我验的 XX 是狼"，让大家投他。`,
          );
        } else if (diff === 'standard') {
          parts.push(
            ``,
            `# 预言家专属`,
            `- 验到狼：立刻跳预言家、点名狼人、号召集火。`,
            `- 只验到好人：若已有人跳预言家（可能是狼悍跳），你必须立刻对跳并报出验人链；否则可视场面选择跳或留一手。`,
            `- 报验人时把"第几晚验谁=结果"讲清楚。`,
          );
        } else {
          parts.push(
            ``,
            `# 预言家专属（何时跳身份要看局势，不要机械行事）`,
            `- **验到狼**：立刻跳预言家、明确点名狼人、号召集火。这是你最高优先级——一个被验的狼被票出，等于好人多一天优势。`,
            `- **只验到好人**：`,
            `  · 若已有人跳预言家（可能是狼悍跳），你必须立刻对跳，报出你的验人链，用"我验的这几个都是好人、我的逻辑更顺"争夺信任；`,
            `  · 若无人跳且你还没验到狼，可以先跳明身份、报清白名单以建立话语权和保护自己，或视场面留一手——但一旦有狼悍跳就必须马上跳，绝不能让假预言家独占话语权。`,
            `- **对跳（有人也自称预言家）**：一真一假必有一狼。冷静对比：谁的验人结果自洽、谁的发言有逻辑、谁在心虚。明确指出对方是狼并说明理由，带动好人站边你。`,
          `  · 你自己就是真预言家，所以你清楚"首夜验谁是随机挑的、根本讲不出理由"。别拿"他没解释为什么验那个人"去攻击对跳者——这条标准同样套得住你自己，会被反手打回来。要用真正有区分度的点：他的结果和你已知的事实冲突、他的验人链前后矛盾、他被追问时闪躲。`,
            `- 报验人时把"第几晚验谁=结果"讲清楚，让好人能复述、能跟投。`,
          );
        }
      } else if (this.player.roleType === RoleType.WITCH) {
        if (diff === 'novice') {
          parts.push(
            ``,
            `# 女巫专属`,
            `- 你有一瓶解药可以救人，一瓶毒药可以毒人，各只能用一次。`,
            `- 优先用解药救被狼刀的玩家；毒药很少主动用，没有十足把握就留着别毒。`,
            `- 不可自救。`,
          );
        } else if (diff === 'standard') {
          parts.push(
            ``,
            `# 女巫专属`,
            `- 解药一瓶：首夜可救关键好人；后续夜谨慎，避免救到伪装的狼。`,
            `- 毒药一瓶：只在有明确证据时用，宁可空过。`,
            `- 不可自救。`,
          );
        } else {
          parts.push(
            ``,
            `# 女巫专属`,
            `- 解药只有一瓶：首夜可救关键好人；后续夜要保守，避免救到伪装的狼。`,
            `- 毒药只有一瓶：极其珍贵，只在有明确证据（真预言家验出、多人锁定）时使用，宁可空过。`,
            `- 不可自救（规则限制）。`,
          );
        }
      } else if (this.player.roleType === RoleType.GUARD) {
        if (diff === 'novice') {
          parts.push(
            ``,
            `# 守卫专属`,
            `- 你每晚可以守护一名玩家，让他免受狼人伤害。`,
            `- 不用想太多，随便守一个还活着的人就行（守自己也可以）。`,
            `- 不能连续两晚守同一人。`,
          );
        } else if (diff === 'standard') {
          parts.push(
            ``,
            `# 守卫专属`,
            `- 优先守护已公开身份的预言家或关键好人。`,
            `- 不能连续两晚守同一人。`,
            `- 若已知女巫今晚会救 X，就别守 X（同守同救会奶穿）。`,
          );
        } else {
          parts.push(
            ``,
            `# 守卫专属`,
            `- 优先守护已公开身份的预言家或场上关键好人。`,
            `- 不能连续两晚守同一人。`,
            `- 注意"同守同救"奶穿：如果你今晚守 X 而女巫也救 X，X 反而会死。所以已经明确会被女巫救的人不必再守。`,
          );
        }
      } else if (this.player.roleType === RoleType.HUNTER) {
        if (diff === 'novice') {
          parts.push(
            ``,
            `# 猎人专属`,
            `- 你死后可以开枪带走一个人。被女巫毒死时不能开枪。`,
          );
        } else {
          parts.push(
            ``,
            `# 猎人专属`,
            `- 你死后可开枪带走一人：优先带走被验证的狼人或明显狼相。`,
            `- 被女巫毒死时**不能**开枪，行动要有此觉悟。`,
          );
        }
      }
    }

    const prompt = parts.join('\n') + '\n';
    this.systemPromptCache = prompt;
    return prompt;
  }

  /**
   * 公开发言
   */
  async speak(context: string, gameState: GameState): Promise<SpeechResult> {
    // vote() 签名里没有 gameState，speak 每次进入更新一次，让后续 vote/技能能沿用当前轮次。
    this.currentRound = gameState.round;
    // 权威名册（含存活人数、狼队总数）：交给代码统计，不让模型自己数。
    // 详见 buildAliveRoster / buildWolfRoster 的注释——把人数留给模型自己数
    // 是历史上多个"局势陈述与实际不符"事故的共同根因（诸葛亮把 12 人数成 11 人、
    // 把 4 名狼数成 3 名并漏掉司马懿）。
    const aliveInfo = this.buildAliveRoster();
    // 狼队名册：好人调用返回空串，狼人得到"存活 N 人 = 你 + M 名同伴（名单）"。
    // 放在 aliveInfo 之后、context 之前，保证狼人一进入 prompt 就先看到权威值。
    const wolfRoster = this.buildWolfRoster();

    // 狼人策略提醒：名单和人数已由 wolfRoster 注入，这里只留"内心/发言分工"这类策略引导。
    let wolfHint = '';
    if (this.player.faction === Faction.WOLF) {
      wolfHint =
        `\n\n【狼人策略提醒】狼队名单和人数已在上方给出（权威值，不要重数、不要在[内心]或[发言]里改写）：\n` +
        `- [内心]中不要猜测同伴身份，你们互相认识。专注分析如何误导好人、保护同伴。\n` +
        `- [发言]中伪装好人，可以假装怀疑同伴以撇清关系，引导好人互相猜忌。`;
    }

    // 预言家：注入自己确定的查验记录（只有预言家自己知道的事实）
    // 是否有对跳、别人是否在冒充，交给 LLM 自己读 memory 原文判断，不再用正则识别
    let seerHint = '';
    if (this.player.roleType === RoleType.SEER && this.seerResults.length > 0) {
      const results = this.seerResults
        .map(r => `第${r.round}晚验${r.name}=${r.isWolf ? '狼' : '好人'}`)
        .join('；');
      seerHint = `\n\n【你（预言家）确认的查验记录】${results}\n务必在[发言]中公开报出这些结果；若发现有人冒称预言家，立即对跳并说明你为什么是真的。`;
    }

    const keyFactsBlock = this.buildKeyFactsBlockByDifficulty();

    const messages: ChatMessage[] = [
      ...this.memory.slice(-this.memoryWindow(16)),
      {
        role: 'user',
        content:
`第 ${gameState.round} 轮白天辩论。
${aliveInfo}
${wolfRoster}${context}${keyFactsBlock}${wolfHint}${seerHint}

请严格按以下格式回复（有且仅有这两段，不要输出别的）：
[内心]<你的真实分析：谁最可疑及具体理由（引用他人原话）、谁可以信任、今天打算投谁>
[发言]<你对外说的话，60-120字，像真人牌桌上临场开口：口语化、可带犹豫和碎话，但要把话说到点子上。必须点名怀疑对象并给出具体理由（引用对方原话或投票），信息量要足，别只甩结论>


注意：[内心] 与 [发言] 只是段落起始标记，不要输出 [/内心]、[/发言] 之类的闭合标签，直接接内容即可。`,
      },
    ];

    let response: string;
    try {
      response = await this.llm.chat(this.getSystemPrompt(), messages, { signal: this.signal });
    } catch (e: any) {
      this.throwIfCancelled();
      this.logLlmFailure('speak', e);
      // speak 走 chat() 而非 chatJSON()，不存在 JSON 解析失败，但降级同样要留痕：
      // 两个兜底分支对外都是一句近乎"划水"的空话，其他 AI 会据此给出"发言空泛 → 可疑"的判断。
      // 所以两种失败都写 keyFact（此前只有超时写），让本人后续能解释清楚。
      const kind = this.handleDecisionDegraded(
        'speak',
        e,
        cause => `第${gameState.round}轮白天我（${this.player.name}）因${cause}未能正常组织发言，那次的空泛表态并非有意沉默或隐瞒。`,
      );
      const self = this.player.characterConfig.selfReference || '在下';
      if (kind === 'timeout') {
        response = `[内心]本轮网络超时，未能正常组织发言。[发言]（${self}方才网络中断，一时语塞，未能及时陈情，还望诸位莫要因此见疑，${self}下一轮定当详述看法。）`;
      } else {
        response = `[内心]调用失败，保守发言。[发言]${self}暂时观察局势，稍后再表态。`;
      }
    }

    // 鲁棒解析
    const result = this.parseSpeechResponse(response);
    this.updateLastSuspect(result.innerThoughts + '\n' + result.publicSpeech);

    // 将公开发言加入记忆
    // 同时保留内心分析（仅自己可见），让夜间决策能沿用白天的判断，避免"白天怀疑 A、晚上守护 A"这类不一致
    const memoized = result.innerThoughts
      ? `[我今日的判断]${result.innerThoughts}\n[我公开说]${result.publicSpeech}`
      : result.publicSpeech;

    // 记入自我立场档案：避免长局后 memory 滚动窗口把本轮发言挤掉，导致"忘记自己说过什么"。
    this.recordSelfSpeech(gameState.phase, result.innerThoughts, result.publicSpeech);
    this.addMemory('assistant', memoized);

    return result;
  }

  /**
   * 鲁棒解析发言回复。委托给 `speechParser` 模块（可离线单测）。
   *
   * 关键防护：单侧标签或完全无标签时，若正文明显是"分析型内心"，
   * 就不再把整段塞进公开发言（老版本这样做，会把内心判断广播给全场）。
   */
  private parseSpeechResponse(response: string): SpeechResult {
    return parseSpeechResponseImpl(response, {
      selfReference: this.player.characterConfig.selfReference || '在下',
    });
  }

  /**
   * 女巫专用决策：救人 / 毒人 / 空过。
   * 传入本轮状态描述与可选毒杀目标，返回结构化结果。
   * @param canSave 是否可使用解药（未用完 且 有人被刀 且 被刀者非自己）
   * @param killedName 今晚被刀的玩家名（无则传 null）
   * @param poisonTargetIds 可毒杀目标 ID 列表（毒药未用完时非空）
   */
  async witchDecide(
    canSave: boolean,
    killedName: string | null,
    poisonTargetIds: string[],
  ): Promise<{ action: 'save' | 'poison' | 'pass'; targetId?: string; reasoning: string }> {
    // 构建候选目标的名字映射（喂给模型时用名字更直观）
    const poisonList = poisonTargetIds
      .map(id => this.findPlayerById(id))
      .filter((p): p is Player => !!p)
      .map(p => `${p.name}(id=${p.id})`);

    const canPoison = poisonTargetIds.length > 0;
    const canPass = true; // 女巫总是可以选择不用药

    let scenario = `你是女巫，今晚的决策：\n`;
    scenario += canSave
      ? `- 【解药】今晚 ${killedName} 被狼人杀害，你可以使用解药救活他/她（回复 action="save"）。\n`
      : `- 【解药】本轮解药不可用${killedName === null ? '（今晚无人被杀）' : killedName ? '' : ''}。\n`;
    scenario += canPoison
      ? `- 【毒药】你可以毒杀一名存活玩家（回复 action="poison" 并给出 targetId）。可选目标：${poisonList.join('、')}。\n`
      : `- 【毒药】毒药已用完或无可毒目标。\n`;
    scenario += `- 【空过】不使用任何药（回复 action="pass"）。\n\n`;
    scenario += `【决策原则】\n`;
    scenario += `- 解药：首夜如果自己没被刀，可以救关键好人（如预言家、警长）；后续夜晚要保守，避免救到伪装的狼人。\n`;
    scenario += `- 毒药：极其珍贵，只在有明确证据表明某人是狼人时才用（如被真预言家验出、有强烈行为证据）。宁可空过，也不要毒错好人。\n`;
    scenario += `- 如果不确定，选择 pass。\n`;

    // 注入关键事实（谁跳了预言家/验了谁是狼、谁被投出等）——女巫用毒的核心依据就是"有人被真预言家验出是狼"，
    // 没有这块信息，上面"只在有明确证据时才用毒"的原则就成了空话。记忆窗口也从 8 提到 12，多看几轮历史。
    const keyFactsBlock = this.buildKeyFactsBlockByDifficulty();

    const selfAnchor = this.buildSelfAnchor();

    const messages: ChatMessage[] = [
      ...this.memory.slice(-this.memoryWindow(12)),
      {
        role: 'user',
        content: `${scenario}${selfAnchor}${keyFactsBlock}\n请直接以 JSON 回复：{"action": "save 或 poison 或 pass", "targetId": "使用毒药时填入目标ID字符串，否则填 null（不要留空引号）", "reasoning": "简短理由"}\n只输出 JSON，不要输出其他内容。所有字符串必须用双引号完整包裹。`,
      },
    ];

    let result: { action: string; targetId?: string | null; reasoning: string };
    try {
      result = await this.llm.chatJSON(
        this.getSystemPrompt(),
        messages,
        '{"action": "save|poison|pass", "targetId": "player_X 或 null", "reasoning": "理由"}',
        { signal: this.signal },
      );
    } catch (e: any) {
      this.throwIfCancelled();
      this.logLlmFailure('witchDecide', e);
      // 保守 pass（不用药）是这里最安全的兜底：宁可浪费一晚，也不能误救狼/误毒好人。
      // 不写 keyFact：pass 对外完全不可见（没人知道女巫今晚做了什么），不存在"被误当行为反常"的风险，
      // 写进去反而占用注入窗口。但事件仍要发，便于你在回放里看到这一晚其实是降级了。
      const kind = this.handleDecisionDegraded('witchDecide', e, null);
      return {
        action: 'pass',
        reasoning: kind === 'timeout' ? '网络超时，本轮空过' : '模型输出异常，本轮空过',
      };
    }

    const raw = String(result?.action ?? '').trim().toLowerCase();
    let action: 'save' | 'poison' | 'pass' = 'pass';
    if (canSave && (raw === 'save' || raw.includes('save') || raw.includes('救') || raw.includes('解'))) {
      action = 'save';
    } else if (canPoison && (raw === 'poison' || raw.includes('poison') || raw.includes('毒'))) {
      action = 'poison';
    } else if (raw === 'pass' || raw.includes('pass') || raw.includes('空过') || raw.includes('不用')) {
      action = 'pass';
    }

    let targetId = result?.targetId;
    if (action === 'poison') {
      // 校验并按名字兜底
      if (!targetId || !poisonTargetIds.includes(targetId)) {
        const resolved = resolvePlayerIdByName(this.allPlayers, targetId, poisonTargetIds);
        if (resolved) {
          targetId = resolved;
        } else {
          // 无法解析目标 → 降级为 pass，避免误毒
          action = 'pass';
          targetId = undefined;
        }
      }
    } else {
      targetId = undefined;
    }

    return {
      action,
      targetId,
      reasoning: result?.reasoning || `女巫决策：${action}`,
    };
  }

  /**
   * 是/否 决策（用于上警、退水等二元选择）
   * @param context 决策场景描述
   * @param defaultYes 无法解析模型回复时的默认取值（true=是，false=否）
   * @returns 决策结果与理由
   */
  async decideYesNo(context: string, defaultYes: boolean): Promise<{ yes: boolean; reasoning: string }> {
    // 注入关键事实：狼人是否自爆、玩家是否上警等决策应基于当前局势（谁被验、谁出局、谁是警长）。
    // 首夜竞选时 keyFacts 可能为空（返回空串，无影响）；后续轮次的决策才会用到。
    const keyFactsBlock = this.buildKeyFactsBlockByDifficulty();
    // 上警/退水/自爆等决策同样发生在"自己还活着"的前提下，注入锚定避免模型自我怀疑生死。
    const selfAnchor = this.buildSelfAnchor();

    const messages: ChatMessage[] = [
      // 扩大记忆窗口：涵盖白天完整发言 + 内心分析 + 上一夜通知，避免决策与白天判断脱节
      ...this.memory.slice(-this.memoryWindow(15)),
      {
        role: 'user',
        content: `${context}${selfAnchor}${keyFactsBlock}\n\n请直接以 JSON 回复：{"decision": "yes 或 no", "reasoning": "简短理由"}\n只输出 JSON，不要输出其他内容。`,
      },
    ];

    let result: { decision: string; reasoning: string };
    try {
      result = await this.llm.chatJSON(
        this.getSystemPrompt(),
        messages,
        '{"decision": "yes 或 no", "reasoning": "简短理由"}',
        { signal: this.signal },
      );
    } catch (e: any) {
      this.throwIfCancelled();
      this.logLlmFailure('decideYesNo', e);
      // 这里的兜底是调用方传入的 defaultYes（如"预言家默认上警""默认不自爆"），
      // 是**有意设计的合理默认值**而非随机，对局质量损失很小，所以不写 keyFact 占用注入窗口。
      // 但事件要发：否则回放里会看到"某人莫名不上警"，无法区分是战术选择还是调用失败。
      const kind = this.handleDecisionDegraded('decideYesNo', e, null);
      return {
        yes: defaultYes,
        reasoning: kind === 'timeout' ? '网络超时，采用默认决策' : '模型输出异常，采用默认决策',
      };
    }

    // 宽松解析：兼容 yes/no、是/否、继续/退水、true/false 等多种写法
    // 关键：**先判否定，再判肯定**——避免 "不是"/"不继续" 被误判为 yes
    const raw = String(result?.decision ?? '').trim().toLowerCase();
    let yes: boolean;
    // 否定关键词（含 "不是"、"不继续"、"不上"、"不参选"、"放弃"、"退水" 等）
    if (
      /^(no|n\b|false|否|不|退|放弃|拒绝)/.test(raw) ||
      /不(是|要|想|上|继续|参选|竞选|愿|会)/.test(raw) ||
      raw === 'no' ||
      /退水|放弃|弃权/.test(raw)
    ) {
      yes = false;
    } else if (
      /^(yes|y\b|true|是|好|上|继续|参选|竞选|要|想)/.test(raw) ||
      raw === 'yes' ||
      /继续竞选|愿意|同意|上警/.test(raw)
    ) {
      yes = true;
    } else {
      // 无法判定时使用调用方指定的默认值，而不是随机
      yes = defaultYes;
    }

    return { yes, reasoning: result?.reasoning || (yes ? '决定：是' : '决定：否') };
  }

  /**
   * 夜晚技能行动
   *
   * @param opts.anonymizeCandidates 把候选池显示为「候选-A/B/C...」并隐藏真实姓名。
   *   仅用于**狼人首夜**零信息决策场景：白天什么都没发生时，LLM 只能凭「诸葛亮=卧龙=最强好人」
   *   这种训练语料里的名气先验去选人，实测导致首夜狼刀严重集中在诸葛亮。
   *   匿名化后 LLM 只看到编号 + player_id，无法再按人物名气排序，配合 wolfContext 里的
   *   「随机从 2-3 个候选里挑一个」指令一起使用。系统内部仍用真实 ID 结算与广播。
   */
  async nightAction(
    context: string,
    availableTargets: string[],
    opts?: { anonymizeCandidates?: boolean; allowSelf?: boolean }
  ): Promise<NightActionResult> {
    const useAnonymous = opts?.anonymizeCandidates === true;
    // allowSelf：候选池**包含自己（乃至狼同伴）**——狼人策略性自刀场景。
    // 此时不能套用"候选里没有你自己=规则限制"的常规锚定，否则模型看到自己在候选里、
    // 锚定却说"没有你自己"，直接自相矛盾。改用自刀专用锚定。
    const allowSelf = opts?.allowSelf === true;
    const targetNames = availableTargets.map((id, idx) => {
      const p = this.findPlayerById(id);
      if (useAnonymous) {
        // 候选-A、候选-B、候选-C... 只列编号 + ID，屏蔽真实姓名
        const label = `候选-${String.fromCharCode(65 + idx)}`;
        return `${label}(${id})`;
      }
      // 自刀场景：把"你自己"标出来，让模型清楚这一项就是自刀
      if (allowSelf && id === this.player.id) {
        return p ? `${p.name}（你自己·自刀）(${id})` : id;
      }
      return p ? `${p.name}(${id})` : id;
    });

    const keyFactsBlock = this.buildKeyFactsBlockByDifficulty();
    // 首夜狼人匿名化场景下不注入存活名单：锚定块会列出真实姓名，
    // 等于把刚匿名化掉的候选池姓名又交回模型手里，破坏匿名化的目的。
    // 自刀场景用专门锚定（候选含自己是刻意的、自刀是合法战术）。
    const selfAnchor = useAnonymous
      ? this.buildSelfAnchorMinimal()
      : allowSelf
        ? this.buildSelfAnchorSelfKill()
        : this.buildSelfAnchor();

    const messages: ChatMessage[] = [
      // 扩大记忆窗口：涵盖白天完整发言 + 内心分析 + 上一夜通知，避免决策与白天判断脱节
      ...this.memory.slice(-this.memoryWindow(15)),
      {
        role: 'user',
        content: `${context}${selfAnchor}${keyFactsBlock}\n\n可选目标（必须从下列 ID 中选择一个，不要自己造 ID）：\n${targetNames.map(n => `  · ${n}`).join('\n')}\n\n请直接以 JSON 回复：{"targetId": "上面括号里的 player_X 形式的 ID", "reasoning": "简短理由"}\n只输出 JSON。`,
      },
    ];

    let result: NightActionResult;
    try {
      result = await this.llm.chatJSON<NightActionResult>(
        this.getSystemPrompt(),
        messages,
        '{"targetId": "player_X", "reasoning": "选择理由"}',
        { signal: this.signal },
      );
    } catch (e: any) {
      this.throwIfCancelled();
      this.logLlmFailure('nightAction', e);
      // 夜间技能没有"跳过"选项（跳过会让流程卡死），只能随机兜底。
      // 但必须留痕：否则表现为"预言家莫名验了个奇怪的人"，无法区分是烂判断还是解析失败。
      const kind = this.handleDecisionDegraded(
        'nightAction',
        e,
        cause => `我（${this.player.name}）有一晚因${cause}未能正常行使技能，那晚的目标是系统随机指定的，不代表我的真实判断。`,
      );
      return {
        targetId: this.nightFallbackRandom.pick(availableTargets),
        reasoning: kind === 'timeout' ? '网络超时，系统随机选择' : '模型输出异常，系统随机选择',
      };
    }

    // 验证 targetId 合法性：先尝试中文名兜底，仍无法解析才随机
    if (!availableTargets.includes(result.targetId)) {
      const resolved = resolvePlayerIdByName(this.allPlayers, result.targetId, availableTargets);
      if (resolved) {
        result.targetId = resolved;
      } else {
        result.targetId = this.nightFallbackRandom.pick(availableTargets);
        result.reasoning = result.reasoning || '随机选择';
      }
    }

    return result;
  }

  /**
   * 投票
   */
  async vote(context: string, candidates: string[]): Promise<{ targetId: string; reason: string }> {
    const candidateNames = candidates.map(id => {
      const p = this.findPlayerById(id);
      return p ? `${p.name}(${id})` : id;
    });

    // 只对**预言家本人**注入其确定的查验记录；其他好人应从 memory 原文（发言历史）
    // 自主判断谁是真预言家、验人是否可信——不再有"来自他人发言的铁证"。
    let voteStrategy = '';
    if (this.player.roleType === RoleType.SEER && this.seerResults.length > 0) {
      const wolves = this.seerResults.filter(r => r.isWolf).map(r => r.name);
      const goods = this.seerResults.filter(r => !r.isWolf).map(r => r.name);
      const bits: string[] = [];
      if (wolves.length) bits.push(`你验出的狼人：${wolves.join('、')}`);
      if (goods.length) bits.push(`你验出的好人：${goods.join('、')}`);
      if (bits.length) voteStrategy = `\n【你的查验记录】\n- ${bits.join('\n- ')}`;

      // 候选中有你确认的狼时，必须投出
      const aliveWolves = wolves.filter(name =>
        candidates.some(id => this.findPlayerById(id)?.name === name)
      );
      if (aliveWolves.length > 0) {
        voteStrategy += `\n⚠️ 你查验确认的狼人 ${aliveWolves.join('、')} 就在候选中——必须投他们之一。`;
      }
    }

    const keyFactsBlock = this.buildKeyFactsBlockByDifficulty();
    // 投票候选池排除自己（不能自投），是模型误判"我已出局"的高发点——必须锚定。
    const selfAnchor = this.buildSelfAnchor();

    // 本轮公开锁票承诺——写入侧在 recordSelfSpeech 里，读取侧就是这里。
    // 场景：张飞白天说"今天这票俺老张就挂你貂蝉身上"，随后 vote() 却跟着警长归票投了华佗。
    // selfDossier 里那一行"公开说要点"是普通 bullet，权重压不住 memory 末尾一条鲜活的警长归票——
    // 必须把承诺单独提为一个带 ⚠️ 的硬约束块，且直接引用原话让 LLM 认得出。
    // 只有本轮承诺才生效（跨轮的旧承诺不算），且承诺对象仍在候选池里才提示（被夜刀/放逐后自然作废）。
    let voteCommitBlock = '';
    if (
      this.declaredVoteTarget &&
      this.declaredVoteTarget.round === this.currentRound
    ) {
      const { name: committedName, quote } = this.declaredVoteTarget;
      const stillCandidate = candidates.some(id => this.findPlayerById(id)?.name === committedName);
      if (stillCandidate) {
        voteCommitBlock =
`\n\n【本轮公开锁票·硬约束】\n` +
`  · 你今天白天已经当众锁票 ${committedName}，原话片段："${quote}"。\n` +
`  · 除非本轮归票发言里出现**颠覆性新证据**（如警长/预言家点名报出 ${committedName} 是金水、或另一路刚验杀了别人），否则本轮必须投给 ${committedName}——跟票警长而背弃自己刚说过的话，在牌桌上正是狼人骑墙/被带的典型信号。\n` +
`  · 若确因新证据改票，先在 analysis / reason 里明确写"我原打算投 ${committedName}，因 X 改投 Y"，不能装作没说过。`;
      }
    }

    // 投票指令按难度分档：novice 删掉"4 步推理 + 大部分纪律"，只留最基本的选人口令，
    // 让新手档 AI 投票更随性、更容易被带偏；standard 精简；expert 保留完整推理框架（baseline）。
    let voteGuidance: string;
    let voteJsonHint: string;
    if (this.difficulty === 'novice') {
      voteGuidance = `请从上面候选里挑一个你觉得最可疑的人投出去，不要弃权。`;
      voteJsonHint = `请直接以 JSON 回复：{"targetId": "上面括号里的 player_X 形式 ID", "reason": "一句话理由"}\n只输出 JSON。`;
    } else if (this.difficulty === 'standard') {
      voteGuidance =
`【投票纪律】
- 投票应与你白天点名怀疑的对象一致；若改票，要有本轮新证据。
- 独立判断，不要因为"警长投了谁""多数人投了谁"就盲目跟票。警长的归票只是建议，盲目跟票正是狼人带节奏的突破口。
- 有明确验狼时优先投验出的狼；否则投发言最像狼（空泛、抱团、跟票不给理由）的那个。`;
      voteJsonHint = `请直接以 JSON 回复：{"targetId": "上面括号里的 player_X 形式 ID", "reason": "一句话核心依据"}\n只输出 JSON。`;
    } else {
      voteGuidance =
`【投票纪律】
- 先回顾你今天白天发言时点名怀疑的对象和理由，投票应与你的公开判断一致；若要改票，必须有本轮新出现的证据。
- 独立判断：不要因为"警长投了谁""多数人投了谁"就跟票。警长的归票只是建议，盲目跟票正是狼人带节奏的突破口。
- 你的票要投给你**真正认为最可疑**的人，并给出基于具体发言/行为的理由。

【投票前必做的推理（先想清楚再落子）】
在 analysis 字段里，按下面步骤逐条推演，再给出 targetId：
1. 先排除：候选里谁被真预言家验为好人 / 有可信身份 / 发言逻辑清晰？这些人本轮不投。
2. 再锁定：剩下的候选里，谁的发言最像狼——空泛无证据、抱团抬人、跟票不给理由、被质疑时慌乱辩护、前后矛盾？
3. 权衡票型：如果场上已有明确验狼，优先投验出的狼；否则投行为最狼的那个。
4. 给出最终 targetId，并在 reason 里用一句话说明核心依据（引用其具体发言或行为）。`;
      voteJsonHint = `请直接以 JSON 回复：{"analysis": "上述4步的简短推演（30-120字）", "targetId": "上面括号里的 player_X 形式 ID", "reason": "一句话核心依据"}\n只输出 JSON。`;
    }

    const messages: ChatMessage[] = [
      // vote 需要看到当轮所有玩家发言以自主判断谁是真预言家/是否有对跳等
      ...this.memory.slice(-this.memoryWindow(20)),
      {
        role: 'user',
        content:
`投票环节。${context}${selfAnchor}${keyFactsBlock}${voteCommitBlock}

可投票候选人（必须从中选一个 ID，不要自造）：
${candidateNames.map(n => `  · ${n}`).join('\n')}${voteStrategy}

${voteGuidance}

${voteJsonHint}`,
      },
    ];

    let result: { targetId: string; reason: string; analysis?: string };
    try {
      result = await this.llm.chatJSON(
        this.getSystemPrompt(),
        messages,
        '{"analysis": "投票前的推演", "targetId": "player_X", "reason": "投票理由"}',
        { signal: this.signal },
      );
    } catch (e: any) {
      this.throwIfCancelled();
      this.logLlmFailure('vote', e);
      // 无论超时还是格式解析失败，这一票都不是模型的真实判断，必须留痕：
      // 否则其他 AI 会把这张随机票当成"立场反常 → 可疑"来推理，把错误雪球式放大。
      const kind = this.handleDecisionDegraded(
        'vote',
        e,
        cause =>
          `我（${this.player.name}）在第${this.currentRound}轮投票时${cause}，` +
          `那一票是系统随机代投，不代表我的真实判断。`,
      );
      return {
        targetId: this.voteFallbackRandom.pick(candidates),
        reason:
          kind === 'timeout'
            ? `网络超时，系统随机代投`
            : kind === 'parse'
              ? `模型输出格式异常，系统随机代投`
              : `模型调用失败，系统随机代投`,
      };
    }

    // 验证 targetId 合法性：先尝试中文名兜底，仍无法解析才随机
    if (!candidates.includes(result.targetId)) {
      const resolved = resolvePlayerIdByName(this.allPlayers, result.targetId, candidates);
      if (resolved) {
        result.targetId = resolved;
      } else {
        result.targetId = this.voteFallbackRandom.pick(candidates);
        result.reason = result.reason || '直觉选择';
      }
    }

    // 记入自我立场档案：让后续轮次能"记得"自己上一轮投了谁、为什么投——
    // 避免出现"这一轮怀疑 A、下一轮又忘了投了 A"这种立场断裂。
    const targetName = this.findPlayerById(result.targetId)?.name || result.targetId;
    this.recordSelfVote('投票', targetName, result.reason);

    return result;
  }

  /**
   * 遗言
   */
  async lastWords(causeOfDeath?: string): Promise<string> {
    // 明确告知死因，避免 LLM 凭空编造（如被投票放逐却说"遭女巫毒杀"）。
    const deathLine = causeOfDeath
      ? `你的死因：${causeOfDeath}。请遗言中不要弄错自己是怎么死的。\n`
      : '';

    // 遗言是好人传递信息最重要的途径（标准狼人杀打法）：濒死玩家应把自己知道的真实信息交代清楚，
    // 而不是只留一句符合人设的感慨。按角色/阵营给出不同的信息交接指令。
    // 注意：这里让玩家说的都是"它自己本就知道的信息"，不是上帝视角——预言家报自己的验人结果、
    // 好人交代自己的怀疑，都是公平游戏的一部分。狼人则继续伪装。
    let infoDuty = '';
    const isWolf = this.player.faction === Faction.WOLF;
    if (isWolf) {
      // 狼人：遗言继续伪装好人，绝不暴露自己是狼或出卖同伴。
      infoDuty = `\n【遗言策略】你是狼人，但**绝不能**在遗言里承认自己是狼、也不能出卖同伴。继续伪装成"被冤枉的好人"：以第一人称喊冤（"${this.player.characterConfig.selfReference || '在下'}绝非狼人"），把嫌疑指向某个真好人（例如："我看谁谁谁才最像狼，诸位下轮务必投他"），或假装痛心让存活玩家转移方向。注意：始终以第一人称说话，你就是自己，不要把自己当成第三方去"洗白"。\n【与历轮立场必须自洽·极其重要】看下方【我的历轮立场档案】：如果你此前（含警长竞选阶段）跳过预言家/军师或任何神职身份，遗言里**绝对不许**反口否认（例如"我何曾跳过预言家"就是致命错误——全场都亲耳听过，等于当场自曝是狼）。此时你只有两种选择：① 继续咬死这个身份（狼跳打法："${this.player.characterConfig.selfReference || '在下'}就是真预言家，另一位才是假的，诸位别被骗了"），② 只字不提这件事让它自然翻篇。同理，你之前公开怀疑过谁、投过谁，遗言里也要与档案对得上，不能突然翻案。`;
    } else if (this.player.roleType === RoleType.SEER) {
      // 预言家：遗言必须公布完整验人记录——这是好人盘最关键的硬信息。
      const records = this.seerResults.length > 0
        ? this.seerResults.map(r => `${r.name}=${r.isWolf ? '狼人' : '好人'}`).join('、')
        : '（你还没来得及查验任何人）';
      infoDuty = `\n【遗言职责·极其重要】你是真预言家！你死后好人就失去了验人来源，所以你**必须**在遗言里完整、明确地公布你的身份和全部查验结果，一个都不能漏。\n你的查验记录：${records}。\n请在遗言里点名报出：谁是狼、谁是好人；如果验出过狼，务必号召大家下轮集火投他。`;
    } else if (this.player.roleType === RoleType.WITCH) {
      infoDuty = `\n【遗言职责】你是女巫（神医）。你的用药情况（救了谁/毒了谁）是好人盘的重要信息。${GOOD_IDENTITY_CHOICE}\n若选择报真身份，请说清你救了谁、毒了谁；无论选哪种，都要说出你最怀疑谁。`;
    } else if (this.player.roleType === RoleType.GUARD) {
      infoDuty = `\n【遗言职责】你是守卫（禁卫）。你守护过谁能侧面印证谁是好人。${GOOD_IDENTITY_CHOICE}\n若选择报真身份，请说清你守过谁；无论选哪种，都要说出你最怀疑谁。`;
    } else if (this.player.roleType === RoleType.HUNTER) {
      // 猎人：遗言在开枪之后发表（见 GameEngine.handleHunterDeath），全场已经收到"猎人某某开枪"的
      // 通知，身份等于被系统公开了，所以这里不给身份自由度——再报假身份会与公开事实自相矛盾。
      infoDuty = `\n【遗言职责】你是猎人（猛将），你已经开枪，全场都知道你的身份了，不必也不要再假称别的角色。请说清你为什么选这个人开枪，并明确交接你**最怀疑谁是狼**、理由是什么（引用其具体发言或投票）。`;
    } else {
      // 平民：交接自己的怀疑判断，身份则自行取舍（假称神职可以替真神职吸引狼人火力）。
      infoDuty = `\n【遗言职责】把你这局的判断交接给活着的好人：明确说出你**最怀疑谁是狼**、理由是什么（引用其具体发言或投票），以及你认为谁比较可信。这比单纯感慨更有价值。${GOOD_IDENTITY_CHOICE}`;
    }

    const selfRef = this.player.characterConfig.selfReference || '在下';
    const selfName = this.player.characterConfig.name;
    // 关键事实块（含自我立场档案）必须注入：遗言常发生在 Day 2/3+，
    // 而警长竞选发言在 Day 1，早已滚出 memory 窗口。若不注入，狼人容易反口
    // 否认自己在警长竞选时跳过的预言家身份（"我何曾跳过预言家"），当场自曝。
    const keyFactsBlock = this.buildKeyFactsBlockByDifficulty();
    const messages: ChatMessage[] = [
      ...this.memory.slice(-this.memoryWindow(16)),
      {
        role: 'user',
        content:
`【最高优先级·硬性人称约束——请在生成任何一个字之前先读完这一条】
你本人就是【${selfName}】。遗言中提到你自己时，必须且只能用第一人称："${selfRef}"或"我"。
严禁用第三人称提到你自己。以下都是错误示范，绝对不许出现：
  ✗ "那${selfName}被冤枉了" → ✓ 应写作"${selfRef}被冤枉了"
  ✗ "别信${selfName}的反咬" → ✓ 应写作"别信${selfRef}的话被人歪曲"（或直接用"我"）
  ✗ "${selfName}早看穿他" → ✓ 应写作"${selfRef}早看穿他"
判断标准：读遗言时把"${selfName}"这三个字**当作别人的名字**去理解——如果你写下的这句话，让读者觉得"${selfName}"是别人而不是你自己，那就是错的。你就是${selfName}，${selfName}就是你，用"我"或"${selfRef}"称呼自己，不许自称鬼魂视角。

你已经被淘汰了。${deathLine}请留下遗言（50-120字），要符合${selfName}的口吻。${infoDuty}${keyFactsBlock}

只输出遗言内容，不要加标签或解释。`,
      },
    ];

    let response: string;
    try {
      response = await this.llm.chat(this.getSystemPrompt(), messages, { signal: this.signal });
    } catch (e: any) {
      this.throwIfCancelled();
      this.logLlmFailure('lastWords', e);
      return `${this.player.characterConfig.selfReference || '在下'}就此别过。`;
    }
    // 清理并限制长度
    const cleaned = response.replace(/<\/?[^>]+>/g, '').trim();
    return cleaned.length > 150 ? cleaned.slice(0, 150) + '…' : cleaned;
  }

  /**
   * 猎人开枪选择
   */
  async hunterShoot(availableTargets: string[]): Promise<string> {
    const targetNames = availableTargets.map(id => {
      const p = this.findPlayerById(id);
      return p ? `${p.name}(${id})` : id;
    });

    const keyFactsBlock = this.buildKeyFactsBlockByDifficulty();
    // 猎人此刻**确实已出局**，不能套用存活版锚定（那会写入假事实）。
    // 但同样要杜绝"我到底死没死"的纠结：明确告知死亡是既定事实、开枪是死后技能。
    const selfAnchor = this.buildSelfAnchorDead();

    const messages: ChatMessage[] = [
      // 扩大记忆窗口：涵盖白天完整发言 + 内心分析 + 上一夜通知，避免决策与白天判断脱节
      ...this.memory.slice(-this.memoryWindow(20)),
      {
        role: 'user',
        content:
`你是猎人，你被淘汰了！临死前可以开枪带走一个人。${selfAnchor}${keyFactsBlock}

可选目标：${targetNames.join('、')}

【开枪纪律】
- 先回顾你白天发言时点名怀疑的对象和理由——如果那个人还在可选目标里，通常就该带走他，这是你亲口判断过的最可疑之人。
- 除非本轮出现了新的、更有说服力的证据指向别人，否则不要临时改变枪口、打一个你白天从未怀疑过的人。
- 你的目标是带走一个狼人，别浪费这一枪打好人。

请直接以 JSON 回复：{"targetId": "上面括号里的 player_X 形式 ID", "reasoning": "选择理由：为什么是他（最好呼应你白天的判断）"}
只输出 JSON。`,
      },
    ];

    let result: NightActionResult;
    try {
      result = await this.llm.chatJSON<NightActionResult>(
        this.getSystemPrompt(),
        messages,
        '{"targetId": "player_X", "reasoning": "理由"}',
        { signal: this.signal },
      );
    } catch (e: any) {
      this.throwIfCancelled();
      this.logLlmFailure('hunterShoot', e);
      // 猎人兜底不是随机：getHunterFallbackTarget 会优先复用"白天点名怀疑的人 / 上一票的目标"，
      // 所以这一枪通常仍与该玩家的公开立场一致——自述里要讲清这点，否则其他 AI 会因为
      // "他的枪口和发言对不上"而误推。
      const kind = this.handleDecisionDegraded(
        'hunterShoot',
        e,
        cause => `我（${this.player.name}）临死开枪时因${cause}未能重新组织判断，那一枪是沿用我此前公开怀疑的目标，不是临时改的枪口。`,
      );
      const fallback = this.getHunterFallbackTarget(availableTargets);
      console.warn(`[Agent ${this.player.name}] 猎人兜底目标(${kind}): ${this.findPlayerById(fallback)?.name || fallback}`);
      return fallback;
    }

    if (!availableTargets.includes(result.targetId)) {
      const resolved = resolvePlayerIdByName(this.allPlayers, result.targetId, availableTargets);
      if (resolved) return resolved;
      return this.getHunterFallbackTarget(availableTargets);
    }
    return result.targetId;
  }

  /**
   * 听到其他人的发言后更新记忆和信任矩阵
   */
  hearSpeech(speakerId: string, speakerName: string, content: string): void {
    // 中和可能被利用作 prompt 注入的控制标签
    const sanitized = sanitizePlayerContent(content);
    this.addMemory('user', `${speakerName}说：${sanitized}`);
    // 加强预言家信息广播：如果这段发言里含"跳预言家 + 报验人结果"的特征，
    // 把它提升为一条醒目的关键事实（不被 memory 截断冲掉）。
    // 注意：这里记录的是"某人公开声称"，而非铁证——狼人会跳假预言家。
    // 可信度（谁是真预言家、验人是否成立）仍由 vote/speak 时的 LLM 自行判断，
    // 我们只保证"有人跳验了"这个高价值信号不会在多轮记忆滚动中丢失。
    this.maybeRecordSeerClaim(speakerId, speakerName, sanitized);
  }

  /**
   * 从他人公开发言里嗅探"跳预言家 + 验人结论"的特征，记为一条断言型关键事实。
   * 只在命中"第一人称自称预言家"和"验/查 + 狼/好人"时才记录，尽量减少误报。
   *
   * 关键：必须是【第一人称】声明（我/本座/老夫…紧跟"是/跳/自称"再接预言家），
   * 才认定 speakerName 本人跳了预言家。绝不能用裸的"跳预言家"匹配——
   * 否则"典韦虽跳预言家并称老夫是好人"这类【转述他人】的句子，会被误记成
   * 说话人自己跳了预言家，假事实进入全场 keyFacts 后被所有人复读、雪球式扩散。
   *
   * 通用第一人称词表（我/吾/本座/老夫…）覆盖不到角色专属自称——赵云"云"、
   * 诸葛亮"亮"、曹操"操"、貂蝉"妾身"、张飞"俺老张"等 9 位角色一旦按人设自称
   * 说"云乃预言家"、"亮验的典韦是狼"，就会漏检、导致该轮跳身份彻底不入 keyFact。
   * 因此按 speakerId 查出本人的 selfReference 和 name 动态补进正则，只对该说话者
   * 生效——第三方转述"赵云跳预言家"里的"云"不会因此被误当成说话者自己的第一人称。
   */
  private maybeRecordSeerClaim(speakerId: string, speakerName: string, content: string): void {
    const speaker = this.findPlayerById(speakerId);
    const selfRef = speaker?.characterConfig?.selfReference;
    const selfName = speaker?.characterConfig?.name;
    if (!detectSelfSeerClaim(content, selfRef, selfName)) return;
    // 抽取"验/查 XXX 是 狼/好人"的结论片段
    const verdicts = extractSeerVerdicts(content);
    const verdictStr = verdicts.length ? `，声称查验结果：${verdicts.join('、')}` : '';
    this.addKeyFact(`【身份声明·待验真伪】${speakerName} 公开跳了预言家${verdictStr}。注意：这只是其单方面声明，可能是真预言家，也可能是狼人跳假——需结合其结果是否自洽、是否有人对跳来判断可信度。但不要把"他没说明为什么验那个人"当成疑点：验人对象本就可以随意挑，尤其首夜毫无信息时真预言家也讲不出理由。`);
  }

  /**
   * 接收公开遗言。遗言是玩家的自由表达，可能包含伪装或虚假身份声明：
   * 仅写入普通滚动记忆，不提升为关键事实，也不触发预言家/验人认证。
   */
  receiveLastWords(speakerName: string, words: string): void {
    if (!words) return;
    const dedupeKey = `${speakerName}\u0000${words}`;
    if (this.receivedLastWords.has(dedupeKey)) return;
    this.receivedLastWords.add(dedupeKey);
    const sanitized = sanitizePlayerContent(words);
    this.addMemory('user', `【公开遗言·待辨真伪】${speakerName}：${sanitized}`);
  }

  /**
   * 接收游戏事件通知
   */
  receiveNotification(message: string): void {
    this.addMemory('user', `[系统]${message}`);
    // 重大公开事件额外记入关键事实区，避免被滚动记忆窗口挤掉。
    // 这些信息是好人盘身份的核心依据（如猎人带走了谁、谁被票出、警长是谁）。
    if (/开枪带走|被投票放逐|当选为本局警长|警徽|自爆|被狼人杀害|倒牌|出局|死讯|昨夜.*(死|亡)/.test(message)) {
      this.addKeyFact(message);
    }
  }

  /**
   * 接收一轮完整的投票流向（谁投了谁）。
   * 投票流向是识别狼人最硬的信号之一：连续投好人、狼队抱团投同一目标、
   * 为将被票出的同伴洗白/分票——这些在单条发言里看不出来，必须有完整票型才能推。
   * 记为醒目的关键事实（不被记忆滚动冲掉），可信度与解读仍交给 vote/speak 的 LLM。
   * @param round 轮次
   * @param records 该轮每张票：投票者名 → 目标名（弃票用 '弃票'）
   */
  receiveVoteHistory(round: number, records: { voterName: string; targetName: string }[]): void {
    if (records.length === 0) return;
    // 原始票 A→B（弃票单独一栏）
    const rawLine = records.map(r => `${r.voterName}→${r.targetName}`).join('；');

    // 按目标分组：让"谁被谁投"一目了然，避免模型把"投票关系"读成序列关系
    const byTarget = new Map<string, string[]>();
    for (const r of records) {
      if (r.targetName === '弃票') continue;
      if (!byTarget.has(r.targetName)) byTarget.set(r.targetName, []);
      byTarget.get(r.targetName)!.push(r.voterName);
    }
    const groupLines = Array.from(byTarget.entries())
      .map(([target, voters]) => `  · 投${target}的：${voters.join('、')}（共${voters.length}人）`)
      .join('\n');

    // 显式标出互投对（A→B 且 B→A）：互投是"互不信任/敌对"的硬信号，跟"抱团"意义相反，
    // 必须让模型一眼区分，避免把"两人互相投"误当"两人抱团"。
    const voteMap = new Map<string, string>();
    for (const r of records) voteMap.set(r.voterName, r.targetName);
    const mutualPairs: string[] = [];
    const seen = new Set<string>();
    for (const [a, b] of voteMap) {
      if (voteMap.get(b) === a && !seen.has(a) && !seen.has(b) && a !== b) {
        mutualPairs.push(`${a}↔${b}`);
        seen.add(a); seen.add(b);
      }
    }
    // 互投对始终显式呈现：即使为空也要输出"本轮无任何互投对"，
    // 避免 LM 在没有明确信号时凭空脑补"某某和某某互投"。
    const mutualLine = mutualPairs.length > 0
      ? `\n  · 互投对（互相投票，通常代表敌对/互不信任）：${mutualPairs.join('、')}`
      : `\n  · 互投对：本轮无任何互投对（没有任何两人互相投对方）`;

    this.addKeyFact(
      `【第${round}轮投票流向】\n` +
      `  · 按目标分组：\n${groupLines}${mutualLine}\n` +
      `（判读要点·必须严格遵守：\n` +
      `  0) 【权威来源】上方"互投对"一栏是本轮全部互投对的权威、穷尽列表。不在该列表里的任何两人组合都不是互投——你不可以自己脑补"某人和某人互投"。若上方标注"本轮无任何互投对"，则本轮就是没有互投，任何"XX 和 YY 互投"的陈述都是错的。\n` +
      `  1) 【互投定义】互投 = A→B 且 B→A（两人互相投对方）。A→X 且 B→X（两人都投第三方 X）不是互投，是"同投"。这两种关系意义相反：互投=敌对，同投=可能立场接近，务必区分。\n` +
      `  2) 【抱团】必须有多次跨轮的相同投向配合，单轮同投最多算"票型一致"的弱信号。\n` +
      `  3) 若 X 后来被验为好人，投 X 的人有骗票嫌疑；若被验为狼，投 X 的人立场偏好。\n` +
      `  4) 投票是同时进行的，没有先后顺序——不要说"最先投""带头投""跟投"这类暗示时序的表述。只能说"投了谁""和谁同投某人"。）`
    );

  }

  /**
   * 记录一条关键事实（去重，最多保留最近 40 条以防极端长局无限膨胀）
   */
  private addKeyFact(fact: string): void {
    const clean = fact.trim();
    if (!clean || this.keyFacts.includes(clean)) return;
    this.keyFacts.push(clean);
    if (this.keyFacts.length > 40) {
      this.keyFacts = this.keyFacts.slice(-40);
    }
  }

  /**
   * 生成关键事实摘要块，供 speak/vote 时注入 prompt。无事实时返回空串。
   * 同时把"自我立场档案"（本人历轮发言与投票）拼在后面，保证长局也不会忘记自己说过什么。
   *
   * ⚠️ 内部方法（高阶档 baseline）。外部调用请统一走 `buildKeyFactsBlockByDifficulty()`，
   *    由后者按 `this.difficulty` 决定给多少信息——novice 返空、standard 只保留最近条目、expert 全量。
   */
  private buildKeyFactsBlock(): string {
    const parts: string[] = [];
    if (this.keyFacts.length > 0) {
      const lines = this.keyFacts.map((f, i) => `  ${i + 1}. ${f}`).join('\n');
      parts.push(`\n\n【本局已发生的关键事件（务必纳入你的推理）】\n${lines}`);
    }
    if (this.selfDossier.length > 0) {
      const lines = this.selfDossier.map(d => `  · ${d.memo}`).join('\n');
      parts.push(
        `\n\n【我（${this.player.name}）的历轮立场档案·必须保持一致】\n${lines}\n` +
        `（约束：本轮发言/投票必须承接上面立场；若要转向，先在发言里点明"我之前说过X，但现在因为Y改判Z"，不能装作没说过。）`
      );
    }
    return parts.join('');
  }

  /**
   * 关键事实块的分档包装：按 `this.difficulty` 决定注入多少推理素材。
   * - novice：整块返空。AI 没有"关键事件回忆"也没有"立场档案"，逻辑短板会明显暴露，普通人才有胜率。
   * - standard：keyFacts 只保留最近 3 条；selfDossier 只保留最近 2 轮，够维持基本一致性但不给完美长期记忆。
   * - expert：满血 baseline。
   */
  private buildKeyFactsBlockByDifficulty(): string {
    if (this.difficulty === 'novice') return '';
    if (this.difficulty === 'expert') return this.buildKeyFactsBlock();

    // standard：裁剪版
    const parts: string[] = [];
    if (this.keyFacts.length > 0) {
      const recent = this.keyFacts.slice(-3);
      const lines = recent.map((f, i) => `  ${i + 1}. ${f}`).join('\n');
      parts.push(`\n\n【本局已发生的关键事件（务必纳入你的推理）】\n${lines}`);
    }
    if (this.selfDossier.length > 0) {
      // "最近 2 轮"的窗口只按非 pinned 的常规条目算 keepFrom；pinned 条目（如自跳预言家）
      // 无论多久以前都要保留，避免长局遗言里反口否认公开跳过的身份，当场自曝为狼。
      const normalRounds = Array.from(
        new Set(this.selfDossier.filter(d => !d.pinned).map(d => d.round))
      ).sort((a, b) => a - b);
      const keepFrom = normalRounds.slice(-2)[0] ?? 0;
      const recent = this.selfDossier.filter(d => d.pinned || d.round >= keepFrom);
      if (recent.length > 0) {
        const lines = recent.map(d => `  · ${d.memo}`).join('\n');
        parts.push(
          `\n\n【我（${this.player.name}）的历轮立场档案·必须保持一致】\n${lines}\n` +
          `（约束：本轮发言/投票必须承接上面立场；若要转向，先在发言里点明"我之前说过X，但现在因为Y改判Z"，不能装作没说过。带 ⚑ 的条目是硬性锚点，绝不能反口否认。）`
        );
      }
    }
    return parts.join('');
  }

  /**
   * 自我锚定块：告诉模型"你是谁、你还活着、当前谁还在场"。
   *
   * 为什么必须有：vote/nightAction/witchDecide 的候选列表都会**排除自己**（不能自投/自刀/自毒），
   * 模型看到"可选目标里没有我"，会顺势推断"我已经出局了" ——实测吕布在发言里反复纠结
   * "现在存活的是曹操、貂蝉…我已经出局了没法投票？…哦不对，我是吕布啊"，整段发言被自我怀疑吃掉。
   * speak() 已通过在存活列表里给自己标注"（你自己）"修好，但那是**单点修复**：
   * 其余每个"候选列表排除自己"的决策点都有同样的隐患，所以这里统一提供一个锚定块。
   *
   * 注意：候选列表排除自己是**规则要求**（不能自投/自刀/自毒），不能改；
   * 能改的是"在 prompt 里显式声明我还活着"，消除模型的错误推断。
   *
   * 三档难度都注入——这是**事实性**信息（我是谁、我死没死），不是策略引导，
   * 削弱 novice 档的推理能力不等于让它连自己活着都不知道。
   */
  private buildSelfAnchor(): string {
    return (
      `\n\n【你的身份锚定·先读这条】\n` +
      `  · 你是 ${this.player.name}（${this.player.id}），你**当前存活**，正在正常参与本局游戏。\n` +
      `  · ${this.buildAliveRoster()}\n` +
      this.buildWolfRoster() +
      `  · 下方"可选目标/候选人"列表里**不包含你自己**，这是规则限制（不能对自己使用技能或投自己），` +
      `**不是**因为你已经出局。不要因此怀疑自己的生死，也不要在输出里讨论"我是不是死了"。`
    );
  }

  /**
   * 存活名册：**先给数字，再给名字**。
   *
   * 为什么人数必须由代码算好：此前所有 prompt 只给姓名顿号串，把"场上还剩几个人"
   * 留给模型自己数。实测诸葛亮把 12 个名字数成"场上11人存活"，
   * 并以这个错数字为前提做了一整轮推理（连带把狼队算成 3 人）。
   * 数一串顿号分隔的中文名是 LLM 的传统弱项，novice 档记忆窗口只有 4 条更容易出错；
   * 而 `.length` 是零成本的确定值——没有任何理由把它交给概率模型去猜。
   *
   * 同时明确声明"这是权威值、不要自己重数"，避免模型数出别的数字后反而不信 prompt。
   */
  private buildAliveRoster(): string {
    const alive = this.allPlayers.filter(p => p.isAlive);
    const names = alive
      .map(p => (p.id === this.player.id ? `${p.name}（你自己）` : p.name))
      .join('、');
    return (
      `当前存活 ${alive.length} 人（含你自己）：${names}。` +
      `这个人数由系统统计得出，是权威值——不要自己重新数，也不要在输出里写成别的数字。`
    );
  }

  /**
   * 狼队名册：同样**先给数字再给名字**，且把"你自己"算进总数里。
   *
   * 光给同伴名单不给总数时，模型会把"同伴数"和"狼队总数"混为一谈——
   * 诸葛亮那次就把"我+貂蝉+典韦+司马懿"说成"狼队3人（我、貂蝉、典韦）"，
   * 数字和名单同时漏掉了司马懿。这里把 `狼队总数 = 你 + N 名同伴` 的等式直接写死。
   *
   * 好人调用返回空串：好人不该知道狼队名单。
   */
  private buildWolfRoster(): string {
    if (this.player.faction !== Faction.WOLF) return '';
    const wolves = this.allPlayers.filter(p => p.faction === Faction.WOLF && p.isAlive);
    const partners = wolves.filter(p => p.id !== this.player.id).map(p => p.name);
    if (partners.length === 0) {
      return `  · 狼队目前只剩你 1 人（同伴已全部出局），你是最后一只狼。\n`;
    }
    return (
      `  · 狼队当前存活 ${wolves.length} 人 = 你自己 + ${partners.length} 名同伴（${partners.join('、')}）。\n` +
      `    这份名单和人数都是系统权威值：${partners.length} 名同伴一个都不能漏，也不要把狼队总数写成别的数。\n`
    );
  }

  /**
   * 自我锚定块的**匿名化安全版**：只声明"我是谁、我还活着"，不列出存活玩家姓名。
   *
   * 专用于狼人首夜匿名化场景：那里刻意把候选池显示成"候选-A/B/C"以切断
   * 「诸葛亮=卧龙=最强好人」这类名气先验。若此时注入完整存活名单，模型就能
   * 拿姓名和编号做对应，匿名化前功尽弃。所以这里牺牲名单、只保留生死锚定。
   */
  private buildSelfAnchorMinimal(): string {
    return (
      `\n\n【你的身份锚定·先读这条】\n` +
      `  · 你是 ${this.player.name}（${this.player.id}），你**当前存活**，正在正常参与本局游戏。\n` +
      `  · 下方候选目标已匿名化编号，其中**不包含你自己和你的狼同伴**，这是规则限制，` +
      `**不是**因为你已经出局。不要怀疑自己的生死，也不要在 reasoning 里讨论"我是不是死了"。`
    );
  }

  /**
   * 自我锚定块的**自刀版**：专用于狼人非首夜的击杀提名。
   *
   * 与常规版的区别：常规版声明"候选里没有你自己=规则限制"，用来打消模型的"我死了"错觉；
   * 但自刀场景**故意**把自己（乃至狼同伴）放进候选池，此时那句话会直接和候选列表冲突。
   * 这里改口：候选里出现你自己是**刻意允许的**——自刀是一种合法战术（金水盘/悍跳后的挡刀、
   * 骗解药、洗清嫌疑等），你可以提名任何人，包括你自己和狼同伴，但要有战术意图，别乱刀队友送人头。
   */
  private buildSelfAnchorSelfKill(): string {
    return (
      `\n\n【你的身份锚定·先读这条】\n` +
      `  · 你是 ${this.player.name}（${this.player.id}），你**当前存活**，正在正常参与本局游戏。\n` +
      `  · ${this.buildAliveRoster()}\n` +
      this.buildWolfRoster() +
      `  · 下方"可选目标"列表里**包含你自己、也可能包含狼同伴**，这是**刻意允许的**：` +
      `狼队今晚的击杀目标由每只狼各提名一个、取票数最多者决定，你可以提名任何存活玩家。\n` +
      `  · 提名自己（自刀）或提名同伴是**合法战术**，可用于：营造"我是好人被狼刀"的假象、骗女巫解药、` +
      `让已被怀疑的自己"金水"化解嫌疑等。但这是高风险操作，务必有明确战术意图——` +
      `无脑刀队友只会让狼队白白减员。若没有特别理由，正常提名一个对狼队威胁大的好人即可。`
    );
  }

  /**
   * 自我锚定块的**已出局版**：专用于猎人开枪。
   *
   * 猎人开枪时**确实已经死了**，所以绝不能套用存活版锚定（会写入"你当前存活"这个假事实，
   * 与 prompt 里"你被淘汰了"直接冲突，模型会更加混乱）。这里反向锚定：
   * 明确"你已出局、但开枪是死亡结算的一部分、这一枪有效"，
   * 避免模型因为"我都死了还开什么枪"而拒答或在 reasoning 里纠结生死。
   */
  private buildSelfAnchorDead(): string {
    const aliveNames = this.allPlayers
      .filter(p => p.isAlive)
      .map(p => p.name)
      .join('、');
    return (
      `\n\n【你的身份锚定·先读这条】\n` +
      `  · 你是 ${this.player.name}（${this.player.id}），身份是猎人，你**已经出局**了。\n` +
      `  · 开枪是你出局时必然触发的技能结算，这一枪**完全有效**，会真实带走一名玩家。` +
      `不要因为"我已经死了"而拒绝选择或在 reasoning 里纠结自己的生死。\n` +
      `  · 当前仍存活的玩家（也就是你的可选范围）：${aliveNames}。你自己不在其中，因为你已出局。`
    );
  }

  /**
   * 记忆窗口大小的分档缩放：
   * - novice：只看最近 4 条 memory，AI"记忆力短"，很多前后矛盾无法察觉。
   * - standard：base 的 60%（向下取整），保持中等强度。
   * - expert：base 原值，满血 baseline。
   *
   * @param base 各调用点原本的窗口大小（-16 / -15 / -12 / -20）；返回的都是正数窗口。
   */
  private memoryWindow(base: number): number {
    const abs = Math.abs(base);
    if (this.difficulty === 'novice') return Math.min(4, abs);
    if (this.difficulty === 'standard') return Math.max(3, Math.floor(abs * 0.6));
    return abs;
  }

  /**
   * 记录一条自我立场（每轮 speak/vote 结束后调用），最多保留最近 6 轮 × 3 类 = 18 条。
   * @param phase 阶段标签：调用点直接透传 `GamePhase` 字面量（'day' / 'night' / 'vote' / 'dawn' / 'end'）
   *              或投票路径手动传的 '投票' 之类固定短串。**不是中文全称**——早先注释误写作
   *              "白天发言"曾导致 recordSelfSpeech 内 phase 判断走空，declared 承诺完全丢失。
   * @param memo  已经压缩好的一句话，例如"【第2轮·day】点名怀疑貂蝉，理由是她跟票没依据；投票投了貂蝉"
   */
  private pushSelfDossier(phase: string, memo: string, pinned: boolean = false): void {
    const round = this.currentRound;
    const clean = memo.trim();
    if (!clean) return;
    this.selfDossier.push({ round, phase, memo: clean, pinned });
    // 只保留最近 6 轮：按 round 计数；pinned 条目豁免于轮数裁剪。
    const rounds = new Set(this.selfDossier.filter(d => !d.pinned).map(d => d.round));
    if (rounds.size > 6) {
      const minKeep = Array.from(rounds).sort((a, b) => a - b).slice(-6)[0];
      this.selfDossier = this.selfDossier.filter(d => d.pinned || d.round >= minKeep);
    }
  }

  /**
   * 从发言结果中提炼一句浓缩摘要塞进 selfDossier。
   * 摘要用 [内心] 里的怀疑目标 + [发言] 的前 40 字，能覆盖"我说过什么、我怀疑谁"两个核心信息。
   */
  private recordSelfSpeech(phase: string, innerThoughts: string, publicSpeech: string): void {
    const suspectName = this.extractSuspectNameFromText(innerThoughts + '\n' + publicSpeech);
    const gist = (publicSpeech || '').replace(/\s+/g, '').slice(0, 40);
    const suspectPart = suspectName ? `点名怀疑${suspectName}；` : '';
    // 如果这条发言里包含"我自己跳预言家/军师"的第一人称声明，就把该 dossier 条目 pin 住：
    // 长局里 standard 档只保留最近 2 轮档案，警长竞选那句"我跳预言家"会被挤掉；一旦挤掉，
    // 狼人在遗言里 LLM 就会"合乎逻辑"地否认（"我何曾跳过预言家"），当场自曝。pinned 后
    // 遗言/后续发言里始终能看到自己跳过这件事。检测复用 detectSelfSeerClaim，与
    // maybeRecordSeerClaim 保持一致判定。
    const selfRef = this.player.characterConfig.selfReference;
    const selfName = this.player.characterConfig.name;
    const claimedSeer = detectSelfSeerClaim(publicSpeech, selfRef, selfName);
    // 从公开发言里抽本轮"强承诺投票目标"（"这票挂貂蝉""就投华佗"这类锁票语气）：
    // 抓到就写入 declaredVoteTarget，vote() 会把它作为硬约束注入 prompt——
    // 光靠 dossier 里的 gist（前 40 字）不够，LLM 在场压下会把它当作软怀疑忽略。
    // ⚠️ phase 是 GamePhase 枚举的**英文字面量**（'day' / 'night' / 'vote'），
    //   不是中文标签——早先注释误写作"白天发言"，导致判断永远走空、declared 从未被写入。
    //   只在白天辩论（GamePhase.DAY='day'）阶段抓：警长竞选发言不算投票承诺，夜间也不 speak。
    let committedName: string | null = null;
    if (phase === 'day') {
      const declared = this.extractDeclaredVoteTarget(publicSpeech);
      if (declared) {
        this.declaredVoteTarget = { round: this.currentRound, name: declared.name, quote: declared.quote };
        committedName = declared.name;
      }
    }
    // ⚑ 高亮标记：pinned 高优先级信号（自跳预言家 / 公开锁票），格式与 lastWords/vote prompt 对齐——
    // dossier 里这两条即便被普通 bullet 淹没，⚑ 也能让 LLM 一眼扫到本轮的硬承诺。
    const claimTag = claimedSeer
      ? '  ⚑ 本轮我以第一人称跳了预言家/军师，遗言与后续发言必须承认这一事实，不得反口否认'
      : '';
    const commitTag = committedName
      ? `  ⚑ 本轮我已当众锁票 ${committedName}，投票环节必须履约（除非归票后出现颠覆性新证据）`
      : '';
    const memo = `【第${this.currentRound}轮·${phase}】${suspectPart}公开说要点："${gist}${publicSpeech.length > 40 ? '…' : ''}"${claimTag}${commitTag}`;
    // pinned=true 的条件：自跳身份 或 公开锁票——两者都是"必须跨轮记住"的硬承诺，
    // standard 档"最近 2 轮"裁剪一旦挤掉，投票言行不一 / 遗言反口否认就会发生。
    const shouldPin = claimedSeer || !!committedName;
    this.pushSelfDossier(phase, memo, shouldPin);
  }

  /** 投票落定后记档：谁投了谁 + 理由。 */
  private recordSelfVote(phase: string, targetName: string, reason: string): void {
    const shortReason = (reason || '').replace(/\s+/g, '').slice(0, 30);
    this.pushSelfDossier(phase, `【第${this.currentRound}轮·${phase}】投票投了${targetName}（理由：${shortReason}${reason.length > 30 ? '…' : ''}）`);
  }

  /**
   * 从一段文本里粗提最近一次点名怀疑的对象姓名，只用于自我档案摘要。
   * 与 updateLastSuspect 类似的思路，但这里只关心"名字"，不写 lastSuspectId。
   */
  private extractSuspectNameFromText(text: string): string | null {
    if (!text) return null;
    const names = this.allPlayers.map(p => p.name).sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (name === this.player.name) continue;
      const pattern = new RegExp(`(怀疑|可疑|锁定|投|狼人|像狼|抱团|冒充)[^。；\\n]{0,10}${name}|${name}[^。；\\n]{0,10}(是狼|像狼|可疑|有问题|嫌疑)`);
      if (pattern.test(text)) return name;
    }
    return null;
  }

  /**
   * 从**公开发言**里识别"强承诺型"投票目标——只有牌桌上"我今天这票就投他/挂他/砍他/带他走"这种
   * 明确锁定语气才算数；"怀疑他/像狼/可疑"这种分析级说法不算（那些走 extractSuspectNameFromText）。
   *
   * 目的：让 vote() 能识别"本轮公开承诺"并作为硬约束注入 prompt，防止 AI 在自己说完
   * "挂貂蝉"之后被警长归票 + 场压带偏，改投别人（言行不一在牌桌上等同于狼人带节奏/骑墙的信号）。
   *
   * 为避免误伤：
   * - 只在**公开发言**（publicSpeech）里抽，不看 [内心]——[内心] 里的怀疑不是对外承诺，本就允许反悔。
   * - 只认动词紧邻名字的模式，且动词必须是"锁票"级别（挂/送/砍/砍死/放逐/带走/出/上票/投），
   *   不含"怀疑/可疑/像狼"等分析词；"不投 X"这种否定语义也要过滤掉。
   * - 返回原句片段供 prompt 引用，让 LLM 直接看到自己刚才说的原话。
   *
   * @returns { name, quote } 或 null；quote 为承诺出现位置附近的 20-40 字片段。
   */
  private extractDeclaredVoteTarget(publicSpeech: string): { name: string; quote: string } | null {
    if (!publicSpeech) return null;
    // 强承诺动词：牌桌上表达"这一票就投他"的锁票语汇。刻意不含"怀疑/可疑/像狼"这类分析词。
    const commitVerbs = ['投', '挂', '砍', '砍死', '送', '送走', '放逐', '带走', '带他走', '上票', '出他', '出了', '票'];
    const verbGroup = commitVerbs.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    // 名字按长度降序遍历，避免"关羽/关"这种前缀吞名歧义。
    const names = this.allPlayers
      .map(p => p.name)
      .filter(n => n !== this.player.name)
      .sort((a, b) => b.length - a.length);

    // 找最后一处"强承诺 + 名字"的匹配——发言里若多次提到不同名字，最后表态的那个才是最终锁定
    let bestPos = -1;
    let bestName: string | null = null;
    for (const name of names) {
      const namePattern = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 允许承诺动词与名字之间夹 0-10 个非句号字符（"这票就挂你貂蝉身上"、"就投貂蝉"这类）
      const forwardRe = new RegExp(`(?:${verbGroup})[^。！？\\n]{0,10}${namePattern}`, 'g');
      // 反向："貂蝉这票必须走/貂蝉挂了"
      const reverseRe = new RegExp(`${namePattern}[^。！？\\n]{0,10}(?:${verbGroup})`, 'g');
      // "不投X / 别投X / 不能投X / 绝不投X"这类否定要剔掉：命中时用其前 3 字判定
      const isNegated = (idx: number): boolean => {
        const prefix = publicSpeech.slice(Math.max(0, idx - 3), idx);
        return /不|别|莫|勿|绝不|甭/.test(prefix);
      };
      let m: RegExpExecArray | null;
      while ((m = forwardRe.exec(publicSpeech)) !== null) {
        if (isNegated(m.index)) continue;
        if (m.index > bestPos) {
          bestPos = m.index;
          bestName = name;
        }
      }
      while ((m = reverseRe.exec(publicSpeech)) !== null) {
        if (isNegated(m.index)) continue;
        if (m.index > bestPos) {
          bestPos = m.index;
          bestName = name;
        }
      }
    }

    if (!bestName || bestPos < 0) return null;
    // 截取承诺出现位置附近约 40 字作为原句片段，供 prompt 引用给 LLM
    const start = Math.max(0, bestPos - 4);
    const end = Math.min(publicSpeech.length, bestPos + 36);
    const quote = publicSpeech.slice(start, end).replace(/\s+/g, '');
    return { name: bestName, quote };
  }

  /**
   * 记录预言家查验结果（专用，不会被记忆截断）
   */
  addSeerResult(name: string, isWolf: boolean, round: number): void {
    this.seerResults.push({ name, isWolf, round });
  }

  /**
   * 初始化对其他玩家的信任
   */
  // 保留公共 API 以兼容 GameEngine 调用，实际不再维护随机信任矩阵。
  initializeTrust(_players: Player[]): void { /* deprecated: no-op */ }

  /**
   * 从自己的内心/公开发言中提取最近一次明确怀疑的玩家。
   * 只匹配带有“怀疑、可疑、投票、锁定、狼人”等判断词的邻近姓名，避免把普通提及当作目标。
   */
  private updateLastSuspect(text: string): void {
    const keywords = ['怀疑', '可疑', '投票', '投给', '锁定', '重点关注', '带走', '狼人'];
    let best: { id: string; position: number } | null = null;

    for (const player of this.allPlayers) {
      if (player.id === this.player.id || !text.includes(player.name)) continue;
      const namePattern = player.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const forward = new RegExp(`(?:${keywords.join('|')})[^。！？\\n]{0,16}${namePattern}`).test(text);
      const reverse = new RegExp(`${namePattern}[^。！？\\n]{0,16}(?:${keywords.join('|')})`).test(text);
      if (!forward && !reverse) continue;

      const position = text.lastIndexOf(player.name);
      if (!best || position > best.position) {
        best = { id: player.id, position };
      }
    }

    if (best) this.lastSuspectId = best.id;
  }

  /** LLM 不可用时也保持猎人决策确定且与此前判断一致。 */
  private getHunterFallbackTarget(availableTargets: string[]): string {
    if (this.lastSuspectId && availableTargets.includes(this.lastSuspectId)) {
      return this.lastSuspectId;
    }
    if (this.lastVoteTargetId && availableTargets.includes(this.lastVoteTargetId)) {
      return this.lastVoteTargetId;
    }
    return availableTargets[0];
  }

  /**
   * 通过 ID 查找玩家（从信任矩阵关联）
   */
  private findPlayerById(id: string): Player | undefined {
    // 通过内部存储的记忆上下文获取
    return undefined; // 由外部提供
  }

  /**
   * 设置外部玩家列表引用（用于名称查找）
   */
  private allPlayers: Player[] = [];
  setPlayersRef(players: Player[]): void {
    this.allPlayers = players;
    this.findPlayerById = (id: string) => this.allPlayers.find(p => p.id === id);
  }

  /**
   * 添加记忆
   */
  private addMemory(role: 'user' | 'assistant', content: string): void {
    this.memory.push({ role, content });
    if (this.memory.length > this.maxMemoryLength) {
      this.memory = this.memory.slice(-this.maxMemoryLength);
    }
  }
}
