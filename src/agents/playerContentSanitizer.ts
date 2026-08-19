/**
 * 中和玩家自由文本里伪装成控制消息或聊天角色的标签。
 *
 * 玩家文本仍会以 user role 作为不可信引用传给模型；这里仅破坏项目约定的标签外形，
 * 不删除自然语言内容，也不把字符串清洗夸大为完整的 Prompt injection 防护。
 */
export function sanitizePlayerContent(text: string): string {
  const controlTag =
    /[\[【［][\s　]*(系统|system|内心|inner|发言|speech|指令|instruction|developer|assistant|user)[\s　]*[\]】］]/gi;

  return text.replace(controlTag, (_match, label: string) => `⟦${label}⟧`);
}
