/**
 * LLM JSON 输出的容错修复。
 *
 * 背景：vote / nightAction / witchDecide / decideYesNo / hunterShoot 全都依赖 chatJSON 拿结构化结果。
 * 即使 prompt 里写明"只输出纯 JSON"，模型仍会时不时输出 markdown 围栏、尾逗号、单引号、
 * Python 字面量（None/True）等非法 JSON。一次解析失败在业务层就退化成"随机选目标 / 弃票"，
 * 表现出来就是「AI 突然变蠢」——而且玩家无从判断这是策略问题还是解析故障。
 *
 * 这里把修复逻辑收敛成一个共享模块（原先只有 AnthropicProvider 内部有个私有实现，
 * 而实际在跑的 OpenAI 兼容路径只有一句 `content.match(/\{[\s\S]*\}/)`，
 * 最强的修复逻辑没用在真正跑的路径上）。
 *
 * 设计原则：**只做无损的语法层修复，绝不猜测语义**。
 * 不去猜 targetId 该填谁、不给缺失字段补默认值——那属于业务层兜底（BaseAgent 各决策点自己处理），
 * 在这里瞎补会把"解析失败"伪装成"模型正常返回"，让真实故障彻底隐形。
 */

/**
 * 尝试把模型输出修成合法 JSON 文本。
 * 纯字符串变换，不做 JSON.parse；调用方自己 parse 并处理失败。
 *
 * @param raw 模型原始输出
 * @returns 修复后的候选 JSON 文本（不保证一定合法）
 */
export function repairJsonText(raw: string): string {
  let value = raw.trim();

  // 1. 剥掉 markdown 代码围栏（```json ... ``` / ``` ... ```）。
  //    模型最常见的违规就是「明明让它只输出 JSON，它还是包了围栏」。
  value = value.replace(/^```(?:json|JSON)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // 2. 去掉 <think>/<reasoning> 等推理标签整段。
  //    某些模型（含 doubao 系）在 thinking 未完全关闭时会把思考过程混在正文前面。
  value = value.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();

  // 3. 截取最外层大括号区间，丢掉前后的自然语言解说（"好的，我的选择是：{...}希望有帮助"）。
  //    用 indexOf/lastIndexOf 而非贪婪正则，能同时切掉首尾两侧的噪声。
  const first = value.indexOf('{');
  const last = value.lastIndexOf('}');
  if (first >= 0 && last > first) value = value.slice(first, last + 1);

  // 4. 全角引号/冒号 → 半角。中文输入法惯性导致的高频错误，且 JSON.parse 完全不认。
  //    注意只替换结构性符号，不动字符串内容里的中文标点（顿号、句号等）。
  value = value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/：/g, ':')
    .replace(/，/g, ',');

  // 5. 去掉 // 行注释和 /* */ 块注释（模型偶尔会"贴心"加注释说明字段含义）。
  //    只在引号外生效，避免把 URL 里的 // 或正文里的 /* 误删——交给下面的 stripCommentsOutsideStrings。
  value = stripCommentsOutsideStrings(value);

  // 6. Python 风格字面量 → JSON。doubao/GLM 系偶发 None/True/False。
  //    用词边界 + 引号外判定，避免改坏字符串内容（如 reasoning: "他的表现是 None 级别的可疑"）。
  value = replaceOutsideStrings(value, /\bNone\b/g, 'null');
  value = replaceOutsideStrings(value, /\bTrue\b/g, 'true');
  value = replaceOutsideStrings(value, /\bFalse\b/g, 'false');

  // 7. 单引号包裹的键或值 → 双引号。
  //    只处理"整段被单引号包住"的规范形态，避免误伤值内部的英文缩写（it's）。
  value = value.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'(\s*[:,}\]])/g, '"$1"$2');
  value = value.replace(/([:,{[]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'/g, '$1"$2"');

  // 8. 补空字符串：`"reason": "` 后直接跟逗号/右括号（模型截断在半个字符串上）。
  //    JSON_MAX_TOKENS 截断时非常常见。
  value = value.replace(/:\s*"\s*,/g, ': "",');
  value = value.replace(/:\s*"\s*}/g, ': ""}');

  // 9. 未闭合的字符串：末尾缺右引号（被 max_tokens 硬截断）。
  //    统计引号奇偶，奇数说明有一个字符串没闭合，补一个。
  if (countUnescapedQuotes(value) % 2 === 1) value += '"';

  // 10. 补齐缺失的右大括号（同样是截断所致）。
  const openBraces = countOutsideStrings(value, '{');
  const closeBraces = countOutsideStrings(value, '}');
  if (openBraces > closeBraces) value += '}'.repeat(openBraces - closeBraces);

  // 11. 删尾逗号（`{"a":1,}` / `[1,2,]`）。必须放在补括号之后，
  //     否则先补出的 `}` 前面可能又留下一个尾逗号。
  value = value.replace(/,\s*([}\]])/g, '$1');

  return value.trim();
}

/**
 * 解析 LLM 的 JSON 输出：先直解，失败再修复后重解。
 *
 * @returns 成功时 `{ ok: true, value }`；失败时 `{ ok: false, error, repaired }`。
 *   刻意返回结果对象而不抛异常——调用方（Provider）需要拿到 repaired 文本写进错误信息里，
 *   便于定位到底是模型输出什么形状导致的失败。
 */
export function parseJsonLoose<T>(
  raw: string,
): { ok: true; value: T } | { ok: false; error: Error; repaired: string } {
  try {
    return finish<T>(JSON.parse(raw), raw);
  } catch {
    // 直解失败属于常态，不记日志，继续走修复。
  }

  const repaired = repairJsonText(raw);
  try {
    return finish<T>(JSON.parse(repaired), repaired);
  } catch (e: any) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)), repaired };
  }
}

/**
 * 顶层形状校验：本项目所有决策点的 schema 都是**对象**
 * （`{targetId,...}` / `{action,...}` / `{decision,...}`）。
 *
 * 如果模型返回了数组、字符串、数字这类非对象 JSON，说明它已经跑偏了。此时必须判为失败、
 * 走重试，**不能**当成功返回——否则调用方读 `result.targetId` 拿到 undefined，
 * 会静默退化成"随机选目标"，表现为"AI 突然变蠢"且无从追溯。
 * null 同理（`JSON.parse('null')` 是合法 JSON 但没有任何字段）。
 */
function finish<T>(
  parsed: unknown,
  source: string,
): { ok: true; value: T } | { ok: false; error: Error; repaired: string } {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const shape = Array.isArray(parsed) ? '数组' : parsed === null ? 'null' : typeof parsed;
    return {
      ok: false,
      error: new Error(`期望 JSON 对象，实际是${shape}`),
      repaired: source,
    };
  }
  return { ok: true, value: parsed as T };
}

/** 统计未被反斜杠转义的双引号个数，用于判断字符串是否闭合。 */
function countUnescapedQuotes(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    // 往前数连续反斜杠：偶数个说明引号本身没被转义。
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) count++;
  }
  return count;
}

/** 统计出现在字符串字面量**之外**的某个字符的个数（用于配平大括号）。 */
function countOutsideStrings(text: string, char: string): number {
  let count = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && !isEscaped(text, i)) {
      inString = !inString;
      continue;
    }
    if (!inString && c === char) count++;
  }
  return count;
}

/** 只在字符串字面量之外做正则替换，避免改坏用户可见的 reasoning 正文。 */
function replaceOutsideStrings(text: string, pattern: RegExp, replacement: string): string {
  const segments: string[] = [];
  let inString = false;
  let buffer = '';

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && !isEscaped(text, i)) {
      // 段落切换：把攒下的内容按"是否在字符串内"决定要不要替换。
      segments.push(inString ? buffer : buffer.replace(pattern, replacement));
      buffer = '';
      inString = !inString;
      segments.push('"');
      continue;
    }
    buffer += c;
  }
  segments.push(inString ? buffer : buffer.replace(pattern, replacement));
  return segments.join('');
}

/** 去掉字符串字面量之外的 // 行注释与 /* *\/ 块注释。 */
function stripCommentsOutsideStrings(text: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '"' && !isEscaped(text, i)) {
      inString = !inString;
      out += c;
      continue;
    }

    if (!inString && c === '/' && text[i + 1] === '/') {
      // 行注释：跳到行尾（保留换行本身，维持原有结构）。
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }

    if (!inString && c === '/' && text[i + 1] === '*') {
      // 块注释：跳到 */ 之后。
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // 跳过收尾的 '/'
      continue;
    }

    out += c;
  }
  return out;
}

/** 判断 text[index] 是否被反斜杠转义。 */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let j = index - 1; j >= 0 && text[j] === '\\'; j--) backslashes++;
  return backslashes % 2 === 1;
}
