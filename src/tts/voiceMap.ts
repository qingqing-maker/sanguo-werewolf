/**
 * 三国人物 → 火山 TTS 音色映射。
 *
 * 音色 ID 来自方舟"音色管理"页。这里选用的是通用大模型 TTS(volcano_tts)常见的预置音色，
 * 若你的账号未开通某些音色，可在控制台替换为账号可用的。
 *
 * 音色命名一般是 zh_(male|female)_<voice_id>_<style>_<engine>
 * 常见风格：
 *   - conversation  日常对话
 *   - streaming     直播/激情
 *   - novel         小说朗读
 *
 * 参数：speedRatio 语速  pitchRatio 音调  （0.5-2.0，1.0 为标准）
 */

export interface VoiceProfile {
  voiceType: string;
  speedRatio: number;
  pitchRatio: number;
  /** 展示用的音色描述 */
  desc: string;
}

/**
 * 三国人物音色映射 —— 全部使用豆包语音合成 2.0 (uranus_bigtts) 家族音色。
 * 12 个角色 · 12 个完全不同的音色，各自匹配人设。
 */
export const CHARACTER_VOICES: Record<string, VoiceProfile> = {
  // ================ 蜀汉阵营 ================
  // 刘备：仁君，温厚但要有主公气度。用"渊博小叔"沉稳大气 + 稍慢
  '刘备':   { voiceType: 'zh_male_yuanboxiaoshu_uranus_bigtts',     speedRatio: 0.92, pitchRatio: 1.00, desc: '沉稳仁厚（渊博小叔）' },
  // 关羽：武圣，字字千钧。"擎苍"低沉威严 + 慢一点更压场
  '关羽':   { voiceType: 'zh_male_qingcang_uranus_bigtts',          speedRatio: 0.85, pitchRatio: 0.82, desc: '低沉威严（擎苍）' },
  // 张飞：燕人张翼德。"傲娇霸总"配快语速+低音调，表现张狂粗豪
  '张飞':   { voiceType: 'zh_male_aojiaobazong_uranus_bigtts',      speedRatio: 1.20, pitchRatio: 0.90, desc: '霸道张扬（傲娇霸总）' },
  // 诸葛亮：军师，儒雅智慧。"儒雅逸辰"最匹配
  '诸葛亮': { voiceType: 'zh_male_ruyayichen_uranus_bigtts',        speedRatio: 0.90, pitchRatio: 1.05, desc: '从容智慧（儒雅逸辰）' },
  // 赵云：常山赵子龙，正气凛然的青年将军。"阳光青年"中正明亮
  '赵云':   { voiceType: 'zh_male_yangguangqingnian_uranus_bigtts', speedRatio: 1.00, pitchRatio: 1.00, desc: '正气凛然（阳光青年）' },

  // ================ 曹魏阵营 ================
  // 曹操：奸雄，霸气深沉。"广告解说"最有气场感
  '曹操':   { voiceType: 'zh_male_guanggaojieshuo_uranus_bigtts',   speedRatio: 0.95, pitchRatio: 0.92, desc: '奸雄霸气（广告解说）' },
  // 司马懿：深谋老谋。"悬疑解说"阴沉神秘刚刚好
  '司马懿': { voiceType: 'zh_male_xuanyijieshuo_uranus_bigtts',     speedRatio: 0.85, pitchRatio: 0.85, desc: '深沉老谋（悬疑解说）' },
  // 典韦：曹操的猛将，"古之恶来"。"霸气青叔"粗豪中年
  '典韦':   { voiceType: 'zh_male_baqiqingshu_uranus_bigtts',       speedRatio: 1.10, pitchRatio: 0.78, desc: '粗豪勇猛（霸气青叔）' },

  // ================ 东吴阵营 ================
  // 周瑜：美周郎，风流才俊。"儒雅青年"最匹配
  '周瑜':   { voiceType: 'zh_male_ruyaqingnian_uranus_bigtts',      speedRatio: 1.05, pitchRatio: 1.10, desc: '风流儒雅（儒雅青年）' },
  // 吕布：飞将军，"人中吕布"骄狂。"磁性解说男声/Morgan"冷酷有气场
  '吕布':   { voiceType: 'zh_male_cixingjieshuonan_uranus_bigtts',  speedRatio: 1.15, pitchRatio: 0.88, desc: '霸道张扬（磁性解说男 Morgan）' },

  // ================ 特殊 ================
  // 华佗：神医，慈祥老者。"东方浩然"沉稳厚重的中年
  '华佗':   { voiceType: 'zh_male_dongfanghaoran_uranus_bigtts',    speedRatio: 0.85, pitchRatio: 1.02, desc: '慈祥沉稳（东方浩然）' },
  // 貂蝉：闭月，柔美佳人。"古风少御"最贴合
  '貂蝉':   { voiceType: 'zh_female_gufengshaoyu_uranus_bigtts',    speedRatio: 0.95, pitchRatio: 1.05, desc: '古风柔美（古风少御）' },
};

/** 默认音色（未匹配时的兜底） */
export const DEFAULT_VOICE: VoiceProfile = {
  voiceType: 'zh_male_m191_uranus_bigtts',
  speedRatio: 1.0,
  pitchRatio: 1.0,
  desc: '标准男声',
};

/** 根据角色名（可能带前后缀或字号）拿音色。找不到就返回默认。 */
export function getVoiceForCharacter(name: string): VoiceProfile {
  if (!name) return DEFAULT_VOICE;
  for (const [key, profile] of Object.entries(CHARACTER_VOICES)) {
    if (name.includes(key)) return profile;
  }
  return DEFAULT_VOICE;
}

// ============================================================================
// 微软 Edge TTS 音色映射
// ----------------------------------------------------------------------------
// Edge 免费接口的普通话男声仅 4 个（Yunjian 激昂 / Yunxi 阳光青年 /
// Yunxia 少年 / Yunyang 专业沉稳），男性角色靠 rate(语速)/pitch(音调) 拉开差异，
// 并引入台湾腔(YunJhe)、香港粤语腔(WanLung)增加音色变化。
// rate/pitch 使用 SSML 相对百分比字符串（如 '+15%' / '-10%'）。
// ============================================================================

export interface EdgeVoiceProfile {
  /** Edge 音色 ShortName，如 'zh-CN-YunyangNeural' */
  voice: string;
  /** 语速相对值，如 '+15%' / '-8%' */
  rate: string;
  /** 音调相对值，如 '-10%' / '+6%' */
  pitch: string;
  /** 展示用的音色描述 */
  desc: string;
}

export const EDGE_CHARACTER_VOICES: Record<string, EdgeVoiceProfile> = {
  // ================ 蜀汉阵营 ================
  '刘备':   { voice: 'zh-CN-YunyangNeural',  rate: '-8%',  pitch: '-8%',  desc: '沉稳仁厚' },
  '关羽':   { voice: 'zh-HK-WanLungNeural',  rate: '-10%', pitch: '-12%', desc: '低沉威严（港腔）' },
  '张飞':   { voice: 'zh-CN-YunjianNeural',  rate: '+15%', pitch: '-10%', desc: '激昂粗豪' },
  '诸葛亮': { voice: 'zh-TW-YunJheNeural',   rate: '-8%',  pitch: '+2%',  desc: '从容儒雅（台腔）' },
  '赵云':   { voice: 'zh-CN-YunxiNeural',    rate: '+2%',  pitch: '+2%',  desc: '正气青年' },

  // ================ 曹魏阵营 ================
  '曹操':   { voice: 'zh-CN-YunyangNeural',  rate: '-2%',  pitch: '-4%',  desc: '奸雄霸气' },
  '司马懿': { voice: 'zh-TW-YunJheNeural',   rate: '-12%', pitch: '-8%',  desc: '深沉老谋（台腔）' },
  '典韦':   { voice: 'zh-CN-YunjianNeural',  rate: '+8%',  pitch: '-16%', desc: '粗豪勇猛' },

  // ================ 东吴阵营 ================
  '周瑜':   { voice: 'zh-CN-YunxiNeural',    rate: '+6%',  pitch: '+12%', desc: '风流儒雅' },
  '吕布':   { voice: 'zh-CN-YunjianNeural',  rate: '+10%', pitch: '-2%',  desc: '骄狂霸道' },

  // ================ 特殊 ================
  '华佗':   { voice: 'zh-CN-YunyangNeural',  rate: '-15%', pitch: '-12%', desc: '慈祥老者' },
  '貂蝉':   { voice: 'zh-CN-XiaoxiaoNeural', rate: '-5%',  pitch: '+6%',  desc: '古风柔美' },
};

/** Edge 默认音色（未匹配时的兜底） */
export const EDGE_DEFAULT_VOICE: EdgeVoiceProfile = {
  voice: 'zh-CN-YunxiNeural',
  rate: '+0%',
  pitch: '+0%',
  desc: '标准青年男声',
};

/** 根据角色名拿 Edge 音色。找不到就返回默认。 */
export function getEdgeVoiceForCharacter(name: string): EdgeVoiceProfile {
  if (!name) return EDGE_DEFAULT_VOICE;
  for (const [key, profile] of Object.entries(EDGE_CHARACTER_VOICES)) {
    if (name.includes(key)) return profile;
  }
  return EDGE_DEFAULT_VOICE;
}
