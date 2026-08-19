/**
 * 白天发言解析（纯函数，无状态，可离线单测）
 *
 * 背景：
 *   `speak()` 调用 LLM 生成 `[内心]……[发言]……` 双段。模型偶尔会：
 *   1) 只输出 [内心] 漏掉 [发言]（或反过来）；
 *   2) 完全不打标签，把大段"分析型内心"直接甩出来。
 *
 *   老版本的 else 兜底一律把整段当 publicSpeech，导致内心分析（"我倾向投周瑜"）
 *   通过 `player_speak.publicSpeech` 广播到前端气泡，其他 AI 也会 `hearSpeech` 到
 *   这段分析，等于把自己的判断底牌直接摊给所有玩家。截图中的华佗即是这个 bug。
 *
 * 修复策略：
 *   - 显式格式匹配保持原样（format1/2/3/4）。
 *   - 若仅匹配到"内心"侧标签、缺"发言"侧 → 内心保留，公开发言退回兜底文案。
 *   - 若完全无标签，用启发式判断是否属于"分析型内心文"：
 *       · 命中分析用语（"我倾向"/"打个折扣"/"留后路"/"值得投"…）或
 *       · 长度 ≥ 120 字（人类临场发言 60-120 字，超长几乎必然是内心分析）
 *     → 归到 innerThoughts，publicSpeech 走兜底文案。
 *     否则保持"整段作为公开发言"（短文本、口语化，不像内心）。
 *
 *   优先安全（不泄露内心）：宁可让公开发言变成一句"再听听诸位意见"的空话
 *   ——其他 AI 顶多判该玩家"发言空泛"，代价远小于泄露真实投票倾向。
 */

/** 与 types/index.ts 中 SpeechResult 保持字段兼容。 */
export interface ParsedSpeech {
  innerThoughts: string;
  publicSpeech: string;
}

export interface ParseSpeechOptions {
  /** 角色自称，用于兜底文案。缺省"在下"。 */
  selfReference?: string;
  /** 公开发言字符上限。默认 300。 */
  publicMax?: number;
  /** 内心字符上限。默认 400。 */
  innerMax?: number;
}

/** 分析型内心的显式关键词。命中任一即认为该段属于内心分析。 */
const INNER_ANALYSIS_MARKERS: RegExp[] = [
  /我倾向(?:于)?投/,          // "今天我倾向投周瑜"
  /打算投/,                    // "我打算投 X"
  /准备投/,
  /(?:我)?打个折扣/,          // "可信度打个折扣"
  /可信度/,
  /留(?:个|了|着)?后路/,       // "给自己留后路"
  /值得投(?:出去)?/,
  /看(?:看)?底牌/,
  /立标尺/,                    // 狼人杀术语，几乎只在分析里出现
  /没(?:硬气|开票|带节奏)/,
  /(?:锤|冲|站队)(?:得|了|过)/,
  /(?:我)?(?:观|判断|认为|觉得)其/, // "我观其面色""判断其身份"
];

/** 兜底文案：模型没给出可展示的公开发言时用。 */
export function fallbackPublicSpeech(selfReference: string): string {
  return `${selfReference}再听听诸位的意见，稍后再详说看法。`;
}

/** 清理标签残留（<xxx>、[内心]、[/发言]、【发言】等）。 */
function stripTagFragments(s: string): string {
  return s
    .replace(/<\/?[^>]+>/g, '')
    .replace(/[\[【［]\s*\/?\s*(?:内心|发言|think|speech|我今日的判断|我公开说)\s*[\]】］]/g, '')
    .trim();
}

/** 命中足够多的分析型关键词即视为"分析型内心"。 */
export function looksLikeInnerAnalysis(text: string): boolean {
  if (!text) return false;
  let hits = 0;
  for (const re of INNER_ANALYSIS_MARKERS) {
    if (re.test(text)) {
      hits++;
      if (hits >= 1) break;
    }
  }
  // 单一强特征即命中（这些词几乎不会在正常对外发言里出现）。
  // 长度阈值单独判断，保留给"无关键词但明显偏长"的场景。
  return hits >= 1;
}

/**
 * 解析发言响应。永远返回可展示的 innerThoughts / publicSpeech（不抛错）。
 */
export function parseSpeechResponse(response: string, opts: ParseSpeechOptions = {}): ParsedSpeech {
  const selfRef = opts.selfReference || '在下';
  const publicMax = opts.publicMax ?? 300;
  const innerMax = opts.innerMax ?? 400;

  let innerThoughts = '';
  let publicSpeech = '';

  // 与旧实现一致的四种显式格式：
  const format1Think = response.match(/[\[【［]\s*内心\s*[\]】］]([\s\S]*?)(?=[\[【［]\s*发言\s*[\]】］]|$)/);
  const format1Speech = response.match(/[\[【［]\s*发言\s*[\]】］]([\s\S]*?)$/);
  const format2Think = response.match(/<think>([\s\S]*?)<\/think>/);
  const format2Speech = response.match(/<speech>([\s\S]*?)<\/speech>/);
  const format3Think = response.match(/<th?t?h?ink>([\s\S]*?)<\/th?t?h?ink>/);
  const format3Speech = response.match(/<speech[^>]*>([\s\S]*?)(?:<\/speech>|$)/);
  // 裸词兜底：模型漏方括号，写"内心 ... 发言 ..."。
  // 只以行首或带冒号的"发言"作为分隔，避免误切内心正文里的"典韦发言空泛"。
  const format4 = response.match(/^[\s\S]*?内心\s*[:：]?\s*([\s\S]*?)(?:[\r\n]\s*发言\s*[:：]?|发言\s*[:：])\s*([\s\S]*)$/);

  // ——— 双段完整匹配（最理想的情况）———
  if (format1Think && format1Speech) {
    innerThoughts = format1Think[1].trim();
    publicSpeech = format1Speech[1].trim();
  } else if (format2Think && format2Speech) {
    innerThoughts = format2Think[1].trim();
    publicSpeech = format2Speech[1].trim();
  } else if (format3Think && format3Speech) {
    innerThoughts = format3Think[1].trim();
    publicSpeech = format3Speech[1].trim();
  } else if (format4) {
    innerThoughts = format4[1].trim();
    publicSpeech = format4[2].trim();
  } else {
    // ——— 单段/无标签的降级路径（本次修复重点）———
    // 只有"内心"侧被匹配到 → 内心保留、公开发言退兜底，绝不把内心塞进公开发言。
    if (format1Think) {
      innerThoughts = format1Think[1].trim();
      publicSpeech = fallbackPublicSpeech(selfRef);
    } else if (format2Think) {
      innerThoughts = format2Think[1].trim();
      publicSpeech = fallbackPublicSpeech(selfRef);
    } else if (format3Think) {
      innerThoughts = format3Think[1].trim();
      publicSpeech = fallbackPublicSpeech(selfRef);
    }
    // 只有"发言"侧 → 公开发言保留，内心留空即可（不存在泄露风险）。
    else if (format1Speech) {
      publicSpeech = format1Speech[1].trim();
    } else if (format2Speech) {
      publicSpeech = format2Speech[1].trim();
    }
    // 完全无标签：启发式判断是否为"分析型内心"。
    else {
      const raw = response.trim();
      const looksAnalytic = looksLikeInnerAnalysis(raw) || raw.length >= 120;
      if (looksAnalytic) {
        innerThoughts = raw;
        publicSpeech = fallbackPublicSpeech(selfRef);
      } else {
        publicSpeech = raw;
      }
    }
  }

  publicSpeech = stripTagFragments(publicSpeech);
  innerThoughts = stripTagFragments(innerThoughts);

  if (publicSpeech.length > publicMax) publicSpeech = publicSpeech.slice(0, publicMax) + '…';
  if (innerThoughts.length > innerMax) innerThoughts = innerThoughts.slice(0, innerMax) + '…';

  // 清理后若公开发言为空/太短，走兜底文案，避免前端出现空气泡。
  if (publicSpeech.length < 2) {
    publicSpeech = fallbackPublicSpeech(selfRef);
  }

  return { innerThoughts, publicSpeech };
}
