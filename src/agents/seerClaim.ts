/**
 * 身份声明识别（纯函数，无状态，可离线单测）
 *
 * 背景：
 *   听牌时要识别「某人是否以第一人称跳了预言家/军师」，并把「验/查 XX 是 狼/好人」的
 *   结论抽出来挂进 keyFact。这套判定被三处复用：
 *     1) maybeRecordSeerClaim —— 听别人发言，给他人挂 keyFact；
 *     2) recordSelfSpeech —— 自己发言后给自己挂 pinned dossier。
 *   两处必须用同一套判定，否则会漂移成「别人记住你跳过了，你自己却忘了」（或反过来），
 *   长局遗言里狼人反口否认自跳、当场自曝。故抽成单一纯函数，杜绝正则各写一份。
 *
 * 关键陷阱（务必保留）：
 *   绝不能把「他人转述」当成本人自跳。"典韦虽跳预言家并称老夫是好人"这种句子里的
 *   "老夫"是被转述者的自称，若把 name/selfRef 当作泛第三人称匹配，就会把说话人误记成
 *   自跳预言家，假事实进 keyFacts 后被全场复读、雪球式扩散。因此只允许**第一人称**
 *   声明成立，角色专属自称（"云"/"亮"/"操"/"妾身"/"俺老张"…）只按 speakerId 查出的
 *   本人自称动态补进第一人称组，且只对该说话者生效。
 */

/** 通用第一人称词表（不含角色专属自称，后者由入参动态补充）。 */
const GENERIC_PRONOUNS = ['我', '吾', '本座', '老夫', '在下', '末将', '孤', '朕', '某', '愚'];

/** 转义正则元字符，避免自称/名字里含特殊符号时炸正则。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判断一段文本里说话者是否**以第一人称**声明自己是预言家/军师。
 *
 * 只判"是不是自跳"，不抽验人结果（那是 extractSeerVerdicts 的职责）。
 *
 * @param content 待判定的发言文本
 * @param selfRef 说话者的角色自称（如"云"/"亮"/"妾身"），按 speakerId 查出后传入
 * @param selfName 说话者的角色名（如"赵云"），与 selfRef 不同才追加
 */
export function detectSelfSeerClaim(content: string, selfRef?: string, selfName?: string): boolean {
  const speakerRefs: string[] = [];
  if (selfRef) speakerRefs.push(selfRef);
  if (selfName && selfName !== selfRef) speakerRefs.push(selfName);
  const pronounGroup = `(?:${[...GENERIC_PRONOUNS, ...speakerRefs].map(escapeRegExp).join('|')})`;
  const firstPersonClaim = new RegExp(
    `${pronounGroup}\\s*(?:是|就是|便是|乃是?|即|正是|才是|系|跳|要跳|自称|冒充|作为)\\s*(?:真的?)?\\s*(?:预言家|军师)`
  ).test(content);
  const reversedClaim = new RegExp(
    `(?:预言家|军师)\\s*(?:正|便|就)?\\s*(?:是|乃)\\s*${pronounGroup}`
  ).test(content);
  return firstPersonClaim || reversedClaim;
}

/**
 * 从发言里抽取"验/查 XX 是 狼/好人"的结论片段。
 *
 * @returns 形如 ["典韦=狼", "刘备=好人"] 的数组；无结论返回空数组。
 */
export function extractSeerVerdicts(content: string): string[] {
  // 每次调用重建正则，避免共享全局 /g 正则的 lastIndex 跨调用污染。
  const verdictRe = /(验|查)(了|验)?\s*([^\s，,。；;、！!？?]{1,6}?)\s*(是|为)?\s*(狼人?|好人)/g;
  const verdicts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = verdictRe.exec(content)) !== null) {
    verdicts.push(`${m[3]}=${/狼/.test(m[5]) ? '狼' : '好人'}`);
  }
  return verdicts;
}
