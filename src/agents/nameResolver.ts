/**
 * 中文名 → 玩家 ID 解析（纯函数，无状态，可离线单测）
 *
 * 背景：
 *   LLM 被要求返回 `player_x` 形式的 ID，但偶尔会直接吐中文名（"张飞"）、或把名字
 *   夹在一句话里（"我投张飞"）。原来这段「精确名或子串名 → ID」的兜底逻辑在
 *   witchDecide / nightAction / vote / hunterShoot 四处各内联了一遍，正则/条件极易漂移。
 *   抽成单一纯函数后，四处共用同一判定，也能离线钉死"张飞→player_x"这类匹配。
 *
 * 匹配语义（与原内联逻辑保持一致）：
 *   raw === p.name  ——  精确等于某玩家名；或
 *   raw.includes(p.name)  ——  raw 里包含某玩家名（"我投张飞" 含 "张飞"）。
 *   命中后还要求该玩家 id 落在 validIds 白名单内（存活/合法候选），否则视为未解析。
 */

/** 参与名字匹配所需的最小玩家形状。传 Player[] 也兼容（结构子类型）。 */
export interface NameIdPair {
  id: string;
  name: string;
}

/**
 * 把一个可能是中文名（或含中文名的短语）的原始值解析成合法玩家 ID。
 *
 * @param players   全部玩家（提供 name→id 映射）
 * @param raw       LLM 返回的原始 targetId，可能是 player_x、中文名或含名短语
 * @param validIds  合法目标白名单（存活/候选）。命中玩家的 id 必须在其中才算解析成功。
 * @returns 解析出的合法 ID；无法解析返回 undefined。
 */
export function resolvePlayerIdByName(
  players: NameIdPair[],
  raw: string | undefined | null,
  validIds: readonly string[],
): string | undefined {
  if (!raw) return undefined;
  // raw 已经是合法 ID：直接返回，省去按名匹配。
  if (validIds.includes(raw)) return raw;
  const matched = players.find(p => raw === p.name || raw.includes(p.name));
  if (matched && validIds.includes(matched.id)) return matched.id;
  return undefined;
}
