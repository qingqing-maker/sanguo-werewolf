/**
 * 三国狼人杀 - 前端客户端
 * 支持暂停/继续/重启/人类玩家操作
 */

let ws = null;
let gameStarted = false;
let gamePaused = false;
let players = [];
let currentGameId = null;
// 是否为断线重连（区分首次打开页面 vs 掉线后自动重连）。
let isReconnect = false;
// 是否已就"当前这次断开"记过一条日志。服务器长时间不可用时每 3 秒重连失败一次，
// 用它把"连接断开"日志去重为一条，避免刷屏；onopen 记一条恢复提示后复位。
let hasLoggedDisconnect = false;
// 回放模式：服务器重启后前端重连时，把历史事件流重放一遍恢复"看到哪了"。
// 回放期间静音 TTS（否则会把整局语音重播一遍），且不真正驱动游戏控制状态。
let replaying = false;
// 所有业务事件必须在任何 UI/TTS/状态副作用前按 gameId+sequence 过闸。
// transport 消息不参与；legacy 无 sequence 仍可播放，但无法保证去重。
const eventSequenceGuard = EventSequence.createEventSequenceGuard();
// 参战模式：欲加入时选定的人物名（发给后端 start_game.humanCharacterName）；观战模式为 null。
let humanCharacterName = null;
// 人类自己座位的 id。参战模式下开局时从 game_start 里带 roleType 的那个座位识别出来；观战模式为 null。
let mySeatId = null;
let sessionToken = localStorage.getItem('sanguo-session-token');
if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken || '')) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  sessionToken = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('sanguo-session-token', sessionToken);
}
let authenticated = false;
let capabilities = {};
let roomState = { exists: false, roomId: null, isCreator: false };
let pendingHumanRequest = null;
let reconnectTimer = null;
let connectionGeneration = 0;
let reconnectDelayMs = 1000;
let reconnectStopped = false;
// 当前 socket generation 是否已应用过权威 authenticated 快照。防止重复握手再次清空/重建 UI。
let authenticatedGeneration = 0;
// AI 强度档位：novice / standard / expert。随 start_game / restart_game 的 config 发给后端。
// 观战与参战两条路径都会读取这个值，默认 standard。
let aiDifficulty = 'standard';

// 难度选项的一句话说明，切换 radio 时更新提示文案。
const AI_DIFFICULTY_HINTS = {
  novice: '新手：AI 会明显降智，逻辑短板多，适合新手上手',
  standard: '标准：接近普通玩家水平',
  expert: '高阶：AI 满血推理，老手来挑战',
};

// 顶栏"当前局"标签文案：把后端难度枚举映射成中文局名。
const AI_DIFFICULTY_BADGE = {
  novice: '🌱 新人局',
  standard: '⚔️ 标准局',
  expert: '🔥 高阶局',
};

// 根据本局难度刷新顶栏标签。缺失/非法值默认 standard，避免空白。
function updateDifficultyBadge(difficulty) {
  const badge = document.getElementById('difficultyBadge');
  if (!badge) return;
  const diff = AI_DIFFICULTY_BADGE[difficulty] ? difficulty : 'standard';
  badge.textContent = AI_DIFFICULTY_BADGE[diff];
  badge.className = `difficulty-badge ${diff}`;
  badge.title = AI_DIFFICULTY_HINTS[diff] || '';
  badge.style.display = '';
}

// radio 切换回调（挂在 window 上供 index.html 内联 onchange 调用）。
function setAiDifficulty(value) {
  if (value !== 'novice' && value !== 'standard' && value !== 'expert') return;
  aiDifficulty = value;
  const hint = document.getElementById('difficultyHint');
  if (hint) hint.textContent = AI_DIFFICULTY_HINTS[value];
}

// 全部 12 个可选人物（与后端 AgentFactory 的 ALL_CHARACTERS 对应）。
const ALL_CHARACTER_NAMES = ['曹操', '诸葛亮', '张飞', '华佗', '典韦', '刘备', '司马懿', '关羽', '周瑜', '吕布', '貂蝉', '赵云'];

// ====== TTS 语音模块 ======
let ttsEnabled = true;
let ttsQueue = [];
let ttsSpeaking = false;
let voicesLoaded = false;
let maleVoice = null;
let femaleVoice = null;
// 后端 TTS 是否可用（火山方舟 TTS 已配置）。启动时探测一次
let backendTtsAvailable = false;
// 当前正在播放的 audio 元素（用于 toggleTts 关闭时立即停）
let currentAudio = null;

/**
 * TTS 代次（epoch）令牌。每次"作废所有待播语音"（换局/重开/静音/回放）都自增。
 *
 * 为什么单靠清空 ttsQueue 不够：processQueue() 里有 `await fetch('/api/tts')`，
 * 合成一句要几百毫秒。若用户在这期间点了"再来一局"，stopPendingTts() 清空队列并置
 * ttsSpeaking=false，但**那个已经飞在半空的 fetch 无从取消**——它 resolve 后照样
 * new Audio().play()，上一局的语音就漏进了新一局。清队列只能拦住"还没开始"的，
 * 拦不住"正在路上"的。
 *
 * 解法：每个异步任务进入时捕获当时的 epoch，在每个 await 之后比对。
 * 一旦不相等说明这一句已属于上一代，立即丢弃且**不再驱动队列**（否则会把新一局的队列
 * 提前拉起来，产生两条并发的消费链）。
 */
let ttsEpoch = 0;

// 认证后探测后端 TTS；Bearer 绑定当前服务端会话。
async function refreshBackendTtsStatus() {
  if (!authenticated) return;
  try {
    const r = await fetch('/api/tts/status', { headers: { Authorization: `Bearer ${sessionToken}` }, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    backendTtsAvailable = r.ok && !!j.enabled;
    if (j.quotaExhausted) notifyTtsQuotaExhausted();
    console.log('[TTS] 后端 TTS:', backendTtsAvailable ? `已启用（${j.provider || 'provider'}）` : '不可用（回退到浏览器 TTS）');
  } catch (e) {
    backendTtsAvailable = false;
  }
}

// 初始化语音列表
function initVoices() {
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return;
  voicesLoaded = true;

  // 中文语音筛选
  const cnVoices = voices.filter(v => v.lang.includes('zh') || v.lang.includes('CN'));

  // 尝试找到男声和女声
  // Windows 常见: Microsoft Kangkang(男), Microsoft Yaoyao(女), Microsoft Huihui(女)
  // Edge/Chrome: Microsoft Yunxi(男), Microsoft Xiaoxiao(女)
  femaleVoice = cnVoices.find(v =>
    /xiaoxiao|yaoyao|huihui|female|女/i.test(v.name)
  ) || cnVoices.find(v => /xiao/i.test(v.name));

  maleVoice = cnVoices.find(v =>
    /kangkang|yunxi|yunyang|male|男/i.test(v.name)
  ) || cnVoices.find(v => /yun/i.test(v.name));

  // 如果只找到一种，退而求其次
  if (!maleVoice && !femaleVoice && cnVoices.length > 0) {
    maleVoice = cnVoices[0];
    femaleVoice = cnVoices.length > 1 ? cnVoices[1] : cnVoices[0];
  } else if (!maleVoice) {
    maleVoice = femaleVoice;
  } else if (!femaleVoice) {
    femaleVoice = maleVoice;
  }

  console.log('[TTS] 男声:', maleVoice?.name, '| 女声:', femaleVoice?.name);
}

// 监听语音加载
if (window.speechSynthesis) {
  speechSynthesis.onvoiceschanged = initVoices;
  initVoices();
}

// 角色语音参数：gender 区分男女声, pitch 音调, rate 语速
const characterVoiceMap = {
  '曹操': { gender: 'male', pitch: 0.8, rate: 0.95 },    // 沉稳霸气，低沉缓慢
  '刘备': { gender: 'male', pitch: 1.1, rate: 0.85 },    // 温和仁厚，轻柔慢速
  '关羽': { gender: 'male', pitch: 0.5, rate: 0.8 },     // 极低沉威严
  '张飞': { gender: 'male', pitch: 0.4, rate: 1.4 },     // 最低沉+快速=粗犷急躁
  '诸葛亮': { gender: 'male', pitch: 1.2, rate: 0.75 },  // 偏高+很慢=从容智慧
  '周瑜': { gender: 'male', pitch: 1.4, rate: 1.0 },     // 较高清亮=儒雅
  '司马懿': { gender: 'male', pitch: 0.6, rate: 0.7 },   // 低沉+很慢=深沉老谋
  '吕布': { gender: 'male', pitch: 0.5, rate: 1.2 },     // 低沉+快=霸道勇猛
  '赵云': { gender: 'male', pitch: 1.0, rate: 1.0 },     // 正直标准
  '华佗': { gender: 'male', pitch: 1.3, rate: 0.8 },     // 偏高+慢=温和慈祥老者
  '貂蝉': { gender: 'female', pitch: 1.5, rate: 0.9 },   // 女声+高音=柔美婉转
  '典韦': { gender: 'male', pitch: 0.3, rate: 1.3 },     // 最粗犷有力
};

function getVoiceParams(playerName) {
  for (const [name, params] of Object.entries(characterVoiceMap)) {
    if (playerName.includes(name)) return params;
  }
  return { gender: 'male', pitch: 1.0, rate: 1.0 };
}

// 额度耗尽只提示一次，避免刷屏
let ttsQuotaNotified = false;
function notifyTtsQuotaExhausted() {
  if (ttsQuotaNotified) return;
  ttsQuotaNotified = true;
  console.warn('[TTS] 后端语音额度已耗尽，后续已自动切换为浏览器语音');
  try { addLog('后端语音额度已耗尽，已切换为浏览器语音', 'system'); } catch {}
}

function speakText(text, playerName, showMessage) {
  const display = typeof showMessage === 'function' ? showMessage : () => {};
  if (!ttsEnabled) {
    display();
    return;
  }
  // 回放历史事件时静音：只恢复文字记录，不把整局语音重播一遍。
  if (replaying) {
    display();
    return;
  }
  // 若后端 TTS 不可用，且浏览器也没有 speechSynthesis，直接跳过
  if (!backendTtsAvailable && !window.speechSynthesis) {
    display();
    return;
  }
  // 打上当前代次戳：这句话属于"第 ttsEpoch 代"。换局/静音会递增代次，
  // 届时这条即便还在队列里或正卡在 fetch 途中，也会被识别为过期并丢弃。
  // showMessage 也随语音排队：只有轮到这句话朗读时才把文字插入页面，
  // 因而下一名角色不会在上一名角色尚未读完时提前出现。
  ttsQueue.push({ text, playerName, epoch: ttsEpoch, showMessage: display });
  processQueue();
}

async function processQueue() {
  if (ttsSpeaking || ttsQueue.length === 0) return;
  ttsSpeaking = true;
  const { text, playerName, epoch, showMessage } = ttsQueue.shift();

  // 入队时的代次已经过期（换局/静音/回放）→ 整句丢弃。
  // 注意要把 ttsSpeaking 复位，否则队列会永久卡死在"有人在说话"的状态。
  if (epoch !== ttsEpoch) {
    ttsSpeaking = false;
    return;
  }

  // 当前角色的文字与语音同时开始；下一条文字要等 nextTurn() 才会显示。
  showMessage();

  // 只有仍属当代时才驱动下一句。跨代驱动会让上一局的消费链把新一局的队列提前拉起来，
  // 形成两条并发链路（表现为语音重叠、顺序错乱）。
  const nextTurn = () => {
    if (epoch !== ttsEpoch) return;
    ttsSpeaking = false;
    currentAudio = null;
    processQueue();
  };

  // 优先：后端火山方舟 TTS
  if (backendTtsAvailable) {
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ text, playerName }),
      });
      // fetch 往返期间用户可能已经换局：此时这段音频属于上一局，丢弃。
      if (epoch !== ttsEpoch) return;
      if (!resp.ok) {
        const info = await resp.json().catch(() => ({}));
        if (epoch !== ttsEpoch) return;
        const permanentReasons = new Set(['tts_budget_exhausted', 'tts_quota_exhausted', 'tts_provider_unavailable']);
        const transientReasons = new Set(['tts_rate_limited', 'tts_concurrency_limited', 'tts_timeout']);
        if (permanentReasons.has(info.reason)) {
          backendTtsAvailable = false;
          if (info.reason === 'tts_quota_exhausted' || info.reason === 'tts_budget_exhausted') notifyTtsQuotaExhausted();
        } else if (!transientReasons.has(info.reason)) {
          console.warn('[TTS] 未知后端错误，当前语句回退:', info.reason || resp.status);
        }
        browserSpeak(text, playerName, epoch, nextTurn);
        return;
      }
      const blob = await resp.blob();
      // 读 body 也是异步的，再校验一次。
      if (epoch !== ttsEpoch) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      audio.addEventListener('ended', () => { URL.revokeObjectURL(url); nextTurn(); });
      audio.addEventListener('error', () => {
        URL.revokeObjectURL(url);
        if (epoch !== ttsEpoch) return;
        console.warn('[TTS] 音频播放失败，回退浏览器 TTS');
        browserSpeak(text, playerName, epoch, nextTurn);
      });
      await audio.play().catch(() => {
        URL.revokeObjectURL(url);
        if (epoch !== ttsEpoch) return;
        console.warn('[TTS] 音频 play 被拒（可能未交互），回退');
        browserSpeak(text, playerName, epoch, nextTurn);
      });
      // play() 成功后仍可能已换局（await 之后）：立刻停掉，别让上一局的声音漏出来。
      if (epoch !== ttsEpoch) {
        try { audio.pause(); audio.src = ''; } catch {}
        URL.revokeObjectURL(url);
      }
      return;
    } catch (e) {
      if (epoch !== ttsEpoch) return;
      console.warn('[TTS] 后端合成失败，回退浏览器 TTS:', e.message);
      // 落到浏览器 TTS
    }
  }

  // 回退：浏览器 speechSynthesis
  browserSpeak(text, playerName, epoch, nextTurn);
}

function browserSpeak(text, playerName, epoch, done) {
  if (epoch !== ttsEpoch) return;
  if (!window.speechSynthesis) { done(); return; }
  if (!voicesLoaded) initVoices();
  const params = getVoiceParams(playerName);
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.pitch = params.pitch;
  utterance.rate = params.rate;
  utterance.volume = 1.0;
  const voice = params.gender === 'female' ? femaleVoice : maleVoice;
  if (voice) utterance.voice = voice;
  // speechSynthesis.cancel() 会触发 onend/onerror；跨代时不驱动队列（done 内部也有兜底校验）。
  utterance.onend = done;
  utterance.onerror = done;
  speechSynthesis.speak(utterance);
}

// ====== WebSocket 连接 ======
function clearPendingHumanInput() {
  pendingHumanRequest = null;
  const panel = document.getElementById('humanInputPanel');
  const options = document.getElementById('inputOptions');
  if (panel) panel.style.display = 'none';
  if (options) options.textContent = '';
}

function scheduleReconnect(generation) {
  if (reconnectStopped || generation !== connectionGeneration || reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(Math.round(reconnectDelayMs * 1.8), 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (generation === connectionGeneration) connectWebSocket();
  }, delay);
}

function connectWebSocket() {
  const generation = ++connectionGeneration;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}`);
  ws = socket;

  socket.onopen = () => {
    if (generation !== connectionGeneration || socket !== ws) return;
    reconnectDelayMs = 1000;
    authenticated = false;
    socket.send(JSON.stringify({ type: 'authenticate', token: sessionToken }));
    if (!hasLoggedDisconnect) {
      addLog('已连接到服务器', 'system');
    }
  };

  socket.onclose = (event) => {
    if (generation !== connectionGeneration || socket !== ws) return;
    authenticated = false;
    clearPendingHumanInput();
    isReconnect = true;
    if (event.code === 4002) {
      reconnectStopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      addLog('会话令牌无效，请清除站点数据后刷新页面', 'system');
      return;
    }
    if (!hasLoggedDisconnect) {
      addLog('连接断开，正在自动重连...', 'system');
      hasLoggedDisconnect = true;
    }
    scheduleReconnect(generation);
  };

  socket.onerror = () => {};

  socket.onmessage = (event) => {
    if (generation !== connectionGeneration || socket !== ws) return;
    try {
      const msg = JSON.parse(event.data);
      handleEvent(msg);
    } catch (e) {
      console.error('解析错误:', e);
    }
  };
}

window.addEventListener('beforeunload', () => {
  reconnectStopped = true;
  connectionGeneration++;
  if (reconnectTimer) clearTimeout(reconnectTimer);
});

// ====== 事件处理 ======
function handleEvent(msg) {
  // 无版本的历史消息按 v1 处理；未来协议由新版前端接管，当前客户端静默忽略。
  const schemaVersion = msg.schemaVersion ?? 1;
  if (schemaVersion !== 1) return;

  // 去重和 fail-closed 校验必须早于日志、TTS、DOM 和状态变更。
  if (!eventSequenceGuard.shouldProcess(msg)) return;

  // 回放控制事件不带 gameId，需在过滤器之前处理。
  if (msg.type === 'replay_start') {
    clearPendingHumanInput();
    onReplayStart(msg.data);
    return;
  }
  if (msg.type === 'replay_end') {
    onReplayEnd(msg.data);
    return;
  }
  // LLM 熔断告警不带 gameId，需在过滤器之前处理。弹 Toast 让玩家知道 AI 为何停止响应。
  if (msg.type === 'llm_alert') {
    onLlmAlert(msg.data);
    return;
  }

  const eventGameId = msg.data?.gameId;
  // 旧局的异步请求返回后，丢弃它们，避免旧对白混入新局。
  // 返回欢迎页后 currentGameId 为 null，此时也必须忽略旧局的延迟事件。
  // 回放期间 currentGameId 已被设为回放局的 ID，所以历史事件能正常通过。
  if (eventGameId && msg.type !== 'game_start' && eventGameId !== currentGameId) {
    return;
  }

  switch (msg.type) {
    case 'authenticated': {
      // authenticated 是当前协议唯一权威握手；同一 socket generation 的重复消息必须幂等忽略。
      if (authenticatedGeneration === connectionGeneration) break;
      authenticatedGeneration = connectionGeneration;
      const wasReconnect = isReconnect;
      const believedGameRunning = gameStarted;
      if (wasReconnect && hasLoggedDisconnect) {
        addLog('已重新连接到服务器', 'system');
        hasLoggedDisconnect = false;
      }
      authenticated = true;
      void refreshBackendTtsStatus();
      mySeatId = msg.data.seatId || null;
      capabilities = msg.data.capabilities || {};
      roomState = msg.data.room || roomState;
      document.body.classList.toggle('human-mode', !!mySeatId);
      const state = msg.data.state || null;
      const serverRunning = !!state?.isRunning;
      const hasReplay = !!msg.data.hasReplay;
      if (state) {
        document.getElementById('modelInfo').textContent = `模型: ${state.model}`;
        // 活动局 cursor 先推进到权威值；replay_start 会重置历史局 cursor，从头重建。
        eventSequenceGuard.seed(state.gameId, msg.data.stateSequence);
        if (serverRunning) {
          restoreRunningGame(state);
        } else if (wasReconnect && believedGameRunning && !hasReplay) {
          onServerLostGame();
        } else if (!hasReplay) {
          currentGameId = state.gameId || null;
        }
        // hasReplay=true 时不改写当前历史状态，等待紧随其后的 replay_start 接管。
      }
      if (msg.data.pendingInput && serverRunning) showHumanInputPanel(msg.data.pendingInput);
      updateControlButtons();
      isReconnect = false;
      break;
    }
    case 'session_updated':
      mySeatId = msg.data.seatId || null;
      capabilities = msg.data.capabilities || capabilities;
      roomState = msg.data.room || roomState;
      document.body.classList.toggle('human-mode', !!mySeatId);
      updateControlButtons();
      break;
    case 'room_state':
      roomState = {
        exists: !!msg.data.exists,
        roomId: msg.data.roomId || null,
        isCreator: !!msg.data.isCreator,
      };
      capabilities = msg.data.capabilities || capabilities;
      updateControlButtons();
      break;
    case 'room_create_result':
      addLog(`创建房间失败: ${msg.data.reason || 'room_taken'}`, 'system');
      updateControlButtons();
      break;
    case 'connected':
      // 旧服务端兼容 transport：当前协议以 authenticated 为唯一权威快照。
      // connected 只能显示消息，绝不能再次驱动恢复/丢局判断或清空 UI。
      if (msg.data?.message) addLog(msg.data.message, 'system');
      break;
    case 'game_start':
      onGameStart(msg.data);
      break;
    case 'phase_change':
      onPhaseChange(msg.data);
      break;
    case 'night_action_start':
      onNightAction(msg.data);
      break;
    case 'night_action_done':
      onNightActionDone(msg.data);
      break;
    case 'dawn_result':
      onDawnResult(msg.data);
      break;
    case 'sheriff_election_start':
      onSheriffElectionStart(msg.data);
      break;
    case 'sheriff_speech':
      onSheriffSpeech(msg.data);
      break;
    case 'sheriff_withdraw':
      onSheriffWithdraw(msg.data);
      break;
    case 'sheriff_vote':
      onSheriffVote(msg.data);
      break;
    case 'sheriff_vote_result':
      onSheriffVoteResult(msg.data);
      break;
    case 'sheriff_elected':
      onSheriffElected(msg.data);
      break;
    case 'sheriff_election_end':
      onSheriffElectionEnd(msg.data);
      break;
    case 'sheriff_pk_speech':
      onSheriffPkSpeech(msg.data);
      break;
    case 'wolf_explode':
      onWolfExplode(msg.data);
      break;
    case 'sheriff_transfer':
      onSheriffTransfer(msg.data);
      break;
    case 'player_speak':
      onPlayerSpeak(msg.data);
      break;
    case 'sheriff_final_speech':
      onSheriffFinalSpeech(msg.data);
      break;
    case 'player_vote':
      onPlayerVote(msg.data);
      break;
    case 'vote_result':
      onVoteResult(msg.data);
      break;
    case 'vote_pk_start':
      addSystemMessage('⚖️ 投票平局，进入 PK 复投');
      addLog('进入 PK 复投', 'vote');
      break;
    case 'vote_tie':
      addSystemMessage('⚖️ ' + msg.data.message);
      addLog('投票平局', 'vote');
      break;
    case 'ai_decision_degraded':
      // AI 决策降级（超时 / 模型输出格式异常）：这一次的选择是系统兜底的，不是 AI 的真实判断。
      // 刻意只写右侧事件日志、不进中间对话区：对话区是读发言的地方，插技术提示会打断沉浸感，
      // 而且降级可能连片发生（多个 AI 同时超时）会把对话刷没。addLog 用 textContent，天然免疫注入。
      onAiDecisionDegraded(msg.data);
      break;
    case 'provider_fallback':
      // Provider fallback：主 Provider 抛了错，被 FallbackLLMProvider 转到 Mock 处理这次调用。
      // 语义比 ai_decision_degraded 更严重——那是"随机兜底"，这是"这次决策由 Mock 做的"。
      // 顶部要有持续可见的 badge，让玩家/观众知道当前批次里已经有 Mock 参与。
      onProviderFallback(msg.data);
      break;
    case 'seer_result_private':
      // 人类扮演预言家时，服务端仅对本座位放行的私密事件：立刻把查验结果显示给玩家。
      // 座位门控由服务端 EventVisibility 策略完成，前端无需重复判断。
      addSystemMessage(`🔮 你查验了 ${msg.data.targetName}：${msg.data.isWolf ? '🐺 狼人' : '😇 好人'}`);
      break;
    case 'wolf_partners_private':
      // 人类扮演狼人时，服务端仅对本座位放行的同伴信息：局初一次性告知同伴身份。
      addSystemMessage(`🐺 你的狼人同伴：${msg.data.partners.join('、') || '（无，你是独狼）'}`);
      break;
    case 'player_eliminated':
      onPlayerEliminated(msg.data);
      break;
    case 'player_last_words':
      onPlayerLastWords(msg.data);
      break;
    case 'hunter_shoot':
      onHunterShoot(msg.data);
      break;
    case 'game_end':
      clearPendingHumanInput();
      onGameEnd(msg.data);
      break;
    case 'game_paused':
      gamePaused = true;
      updateControlButtons();
      addLog('游戏已暂停', 'system');
      addSystemMessage('⏸ 游戏已暂停');
      break;
    case 'game_resumed':
      gamePaused = false;
      updateControlButtons();
      addLog('游戏已继续', 'system');
      break;
    case 'game_cancelled':
      clearPendingHumanInput();
      currentGameId = null;
      gameStarted = false;
      gamePaused = false;
      updateControlButtons();
      addLog('游戏已终止', 'system');
      addSystemMessage('🛑 游戏已终止');
      {
        const btnStart = document.getElementById('btnStart');
        if (btnStart) btnStart.disabled = false;
      }
      break;
    case 'human_input_required':
      showHumanInputPanel(msg.data);
      break;
    case 'human_input_result':
      if (msg.data.accepted) {
        clearPendingHumanInput();
      } else {
        addLog(`输入未接受: ${msg.data.reason || 'stale_request'}`, 'system');
      }
      break;
    case 'error':
      addLog(`错误: ${msg.data.message || msg.data.reason}`, 'system');
      break;
  }
}

// ====== 游戏控制 ======
function clearGameDialogue() {
  const dialogueArea = document.getElementById('dialogueArea');
  if (!dialogueArea) return;
  for (const child of Array.from(dialogueArea.children)) {
    if (child.id !== 'welcomePanel') child.remove();
  }
}

function enterGameView() {
  clearGameDialogue();
  const welcomePanel = document.getElementById('welcomePanel');
  if (welcomePanel) welcomePanel.style.display = 'none';
}

/**
 * 彻底停止并作废当前所有 TTS 活动。
 *
 * 关键是 `ttsEpoch++`：光清 ttsQueue 是不够的。processQueue 里 `await fetch('/api/tts')`
 * 往返可能有几百毫秒，这期间用户点了"再来一局"——那个已经飞在半空的请求返回后，
 * 照样会 new Audio().play()，于是上一局的语音漏进新一局（实测就是这个现象）。
 * 递增代次后，所有在途回调在每个 await 边界都会发现 epoch 不匹配而自行退出。
 */
function stopPendingTts(showQueuedMessages = false) {
  ttsEpoch++;
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.src = ''; } catch {}
    currentAudio = null;
  }
  if (window.speechSynthesis) speechSynthesis.cancel();
  // 用户只是切到静音时，不能把已经收到但尚未轮到显示的发言一起丢掉。
  // 先按原顺序补显示，再清空语音队列；换局/回放则不传此参数，旧局内容直接作废。
  if (showQueuedMessages) {
    for (const item of ttsQueue) {
      try { item.showMessage?.(); } catch (e) { console.error('显示排队发言失败:', e); }
    }
  }
  ttsQueue = [];
  ttsSpeaking = false;
}

// 游戏结束后的“再来一局”只恢复待开始页面；用户重新选择模式后才发送 start_game。
function resetToWelcome() {
  gameStarted = false;
  gamePaused = false;
  players = [];
  currentGameId = null;
  humanCharacterName = null;
  mySeatId = null;
  replaying = false;
  clearPendingHumanInput();

  stopPendingTts();
  document.body.classList.remove('human-mode');
  clearGameDialogue();

  // 回到欢迎页时收起顶栏的"当前局"标签，下一局 game_start 再按新难度显示。
  const diffBadge = document.getElementById('difficultyBadge');
  if (diffBadge) diffBadge.style.display = 'none';

  // 上一局若有 Mock 兜底 badge，回欢迎页时一并清掉，下一局重新计数。
  resetProviderFallbackBadge();

  const welcomePanel = document.getElementById('welcomePanel');
  if (welcomePanel) welcomePanel.style.removeProperty('display');
  const modeSelect = document.getElementById('modeSelect');
  if (modeSelect) modeSelect.style.display = roomState.isCreator ? 'flex' : 'none';
  const characterPicker = document.getElementById('characterPicker');
  if (characterPicker) characterPicker.style.display = 'none';
  const characterGrid = document.getElementById('characterGrid');
  if (characterGrid) characterGrid.innerHTML = '';

  // 难度选择器随欢迎页一并复原：勾选回当前 aiDifficulty，并同步提示文案。
  const diffRadio = document.querySelector(`input[name="aiDifficulty"][value="${aiDifficulty}"]`);
  if (diffRadio) diffRadio.checked = true;
  setAiDifficulty(aiDifficulty);

  const btnStart = document.getElementById('btnStart');
  if (btnStart) btnStart.disabled = false;
  const btnJoin = document.getElementById('btnJoin');
  if (btnJoin) btnJoin.disabled = false;

  const phaseBadge = document.getElementById('phaseBadge');
  if (phaseBadge) {
    phaseBadge.textContent = '等待开始';
    phaseBadge.className = 'phase-badge';
  }
  const roundInfo = document.getElementById('roundInfo');
  if (roundInfo) roundInfo.textContent = '';
  const controlBtns = document.getElementById('controlBtns');
  if (controlBtns) controlBtns.style.display = 'none';
  const btnPause = document.getElementById('btnPause');
  if (btnPause) btnPause.style.display = '';
  const btnResume = document.getElementById('btnResume');
  if (btnResume) btnResume.style.display = 'none';
  const btnRestart = document.getElementById('btnRestart');
  if (btnRestart) btnRestart.style.display = '';

  const playerList = document.getElementById('playerList');
  if (playerList) playerList.innerHTML = '<div class="empty-state">等待游戏开始...</div>';
  const humanInputPanel = document.getElementById('humanInputPanel');
  if (humanInputPanel) humanInputPanel.style.display = 'none';
  const inputOptions = document.getElementById('inputOptions');
  if (inputOptions) inputOptions.innerHTML = '';
  const humanTextInput = document.getElementById('humanTextInput');
  if (humanTextInput) humanTextInput.value = '';

  const restartButton = document.getElementById('restartFloatBtn');
  if (restartButton) restartButton.remove();
  closeModal();
  updateControlButtons();

  const eventLog = document.getElementById('eventLog');
  if (eventLog) {
    const status = ws && ws.readyState === WebSocket.OPEN ? '已连接到服务器' : '等待连接服务器...';
    eventLog.innerHTML = `<div class="log-entry log-system">${status}</div>`;
  }
}

// 观战模式：全 AI，不带 humanCharacterName。
function startGame() {
  clearPendingHumanInput();
  if (ws && ws.readyState === WebSocket.OPEN) {
    humanCharacterName = null;
    mySeatId = null;
    // 观战模式也带上 AI 强度档位，让全 AI 局也能选难度。
    ws.send(JSON.stringify({ type: 'start_game', config: { aiDifficulty } }));
    addLog('正在启动游戏...', 'system');
    const btnStart = document.getElementById('btnStart');
    if (btnStart) btnStart.disabled = true;
  }
}

// 参战模式：把选定人物名并入 config，后端据此强制该人物入局并标记为人类座位。
function startGameAsPlayer(name) {
  clearPendingHumanInput();
  if (ws && ws.readyState === WebSocket.OPEN) {
    humanCharacterName = name;
    mySeatId = null; // 座位 id 要等 game_start 才知道（后端随机分配 player_i）
    ws.send(JSON.stringify({ type: 'start_game', config: { humanCharacterName: name, aiDifficulty } }));
    addLog(`正在以「${name}」身份加入游戏...`, 'system');
    const btn = document.getElementById('btnStart');
    if (btn) btn.disabled = true;
  }
}

function showCharacterPicker() {
  document.getElementById('modeSelect').style.display = 'none';
  const picker = document.getElementById('characterPicker');
  picker.style.display = 'block';
  const grid = document.getElementById('characterGrid');
  grid.innerHTML = '';
  for (const name of ALL_CHARACTER_NAMES) {
    const btn = document.createElement('button');
    btn.className = 'character-choice';
    btn.innerHTML = `<span class="cc-emoji">${getCharacterEmoji(name)}</span><span class="cc-name">${name}</span>`;
    btn.onclick = () => startGameAsPlayer(name);
    grid.appendChild(btn);
  }
}

function hideCharacterPicker() {
  document.getElementById('characterPicker').style.display = 'none';
  document.getElementById('modeSelect').style.display = 'flex';
}

function pauseGame() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'pause_game' }));
  }
}

function resumeGame() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resume_game' }));
  }
}

// 顶栏"再来一局"：停掉当前对局并回欢迎页，让玩家重新选难度和模式。
// 与之前的"重开"（直接用当前档立刻开新局）的区别：现在需要经过欢迎页重选，
// 因为玩家常常在游戏中途想换个档位试试，直接原地重开就没有选档的入口。
// 结束页那颗按钮也走同一套 resetToWelcome，两处入口语义统一。
function restartGame() {
  // 对局进行中给一次确认，避免误点丢掉正在跑的局；对局已结束时直接回欢迎页。
  if (gameStarted && !confirm('确定要结束当前对局并回到选局页面吗？当前进度会作废。')) {
    return;
  }
  // 关键：作废上一局的语音（含在途 fetch）。stopPendingTts 在 resetToWelcome 里也会调，
  // 这里提前调一次是为了先把 currentAudio 掐掉，避免确认弹窗期间还在播上一句。
  stopPendingTts();
  // 告诉后端停掉当前引擎；不发 restart_game（那是"立即用同档开新局"，与本按钮语义相反）。
  if (ws && ws.readyState === WebSocket.OPEN && gameStarted) {
    ws.send(JSON.stringify({ type: 'cancel_game' }));
  }
  currentGameId = null;
  resetToWelcome();
  addLog('已结束当前对局，请重新选择难度和模式', 'system');
}

function toggleTts() {
  ttsEnabled = !ttsEnabled;
  const btn = document.getElementById('btnTts');
  if (ttsEnabled) {
    btn.textContent = '🔊 语音';
  } else {
    btn.textContent = '🔇 静音';
    // 停止当前朗读并作废在途请求。必须走 stopPendingTts（含 epoch 自增）：
    // 否则点静音时正在 fetch 的那句，返回后仍会播出来——听起来就是"按了静音还在响"。
    stopPendingTts(true);
  }
}

// ====== 设置面板 ======
// 打开设置面板：从后端拉取当前 .env 白名单配置并填充表单。
async function openSettings() {
  const modal = document.getElementById('settingsModal');
  const msg = document.getElementById('settingsMsg');
  msg.textContent = '';
  msg.className = 'settings-msg';
  try {
    const r = await fetch('/api/settings', {
      headers: { Authorization: `Bearer ${sessionToken}` },
      cache: 'no-store',
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || '读取设置失败');
    const s = j.settings || {};
    // 每个键是 { value, masked }；这里都是非敏感键，直接取 value。
    document.getElementById('setModelId').value = s.LLM_MODEL_ID?.value || '';
    document.getElementById('setTokenBudget').value = s.LLM_TOKEN_BUDGET?.value || '';
    document.getElementById('setCallBudget').value = s.LLM_CALL_BUDGET?.value || '';
    document.getElementById('setFallbackStrategy').value = s.LLM_FALLBACK_STRATEGY?.value || 'none';
    document.getElementById('setLlmTimeout').value = s.LLM_TIMEOUT_MS?.value || '';
    document.getElementById('setPacing').value = s.PACING_SCALE?.value || '';
    document.getElementById('setFastMode').checked = s.FAST_MODE?.value === '1';
    document.getElementById('setPort').value = s.PORT?.value || '';
    // 初始化模式 label + 按钮文案：让用户打开设置就能看到当前是测试还是正常
    const provider = (s.LLM_PROVIDER?.value || '').toLowerCase();
    updateModeUI(provider === 'mock', provider);
    modal.style.display = 'flex';
  } catch (e) {
    modal.style.display = 'flex';
    setSettingsMsg(`读取设置失败：${e.message}`, 'error');
  }
}

function closeSettings() {
  document.getElementById('settingsModal').style.display = 'none';
}

// 一键切换测试模式：mock+FAST_MODE=1 与真实模型之间来回切换。
// 后端会更新 .env、同步 process.env、重置预算账本单例。
// 下一次点"重开"就用新的 provider（GameController 在 startGame() 时会 createLLMProvider() 重读）。
async function toggleTestMode() {
  const btn = document.getElementById('btnToggleTestMode');
  const label = document.getElementById('currentModeLabel');
  const originalBtnText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '切换中...'; }
  setSettingsMsg('切换中...', '');
  try {
    const r = await fetch('/api/settings/test-mode', { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` } });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || '切换失败');
    // 更新 UI 反映最新模式
    updateModeUI(j.enabled, j.provider);
    const modeName = j.enabled ? '测试模式（mock + 极速）' : `正常模式（${j.provider}）`;
    setSettingsMsg(`✓ 已切换到 ${modeName}。下一次"再来一局"时生效。`, 'ok');
  } catch (e) {
    setSettingsMsg(`切换失败：${e.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = originalBtnText; }
    // 失败时把 label 还原
    if (label) label.textContent = '未知';
  }
}

// 根据当前模式刷新按钮和状态标签
function updateModeUI(isTestMode, provider) {
  const label = document.getElementById('currentModeLabel');
  const btn = document.getElementById('btnToggleTestMode');
  if (label) {
    if (isTestMode) {
      label.textContent = '测试模式（mock + 极速）';
      label.className = 'mode-label mode-test';
    } else {
      label.textContent = `正常模式（${provider || '真实 LLM'}）`;
      label.className = 'mode-label mode-real';
    }
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = isTestMode ? '切回正常模式' : '切换到测试模式';
  }
}

function setSettingsMsg(text, kind) {
  const msg = document.getElementById('settingsMsg');
  msg.textContent = text;
  msg.className = 'settings-msg' + (kind ? ` settings-msg-${kind}` : '');
}

// 保存设置：收集表单值 → POST /api/settings → 展示生效说明（立即/下一局/需重启）。
async function saveSettings() {
  const settings = {
    LLM_MODEL_ID: document.getElementById('setModelId').value.trim(),
    LLM_TOKEN_BUDGET: document.getElementById('setTokenBudget').value.trim(),
    LLM_CALL_BUDGET: document.getElementById('setCallBudget').value.trim(),
    LLM_FALLBACK_STRATEGY: document.getElementById('setFallbackStrategy').value,
    LLM_TIMEOUT_MS: document.getElementById('setLlmTimeout').value.trim(),
    PACING_SCALE: document.getElementById('setPacing').value.trim(),
    FAST_MODE: document.getElementById('setFastMode').checked ? '1' : '0',
    PORT: document.getElementById('setPort').value.trim(),
  };
  setSettingsMsg('保存中...', '');
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ settings }),
    });
    const j = await r.json();
    if (!j.success) {
      const errs = j.errors ? Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join('；') : (j.error || '保存失败');
      setSettingsMsg(`保存失败 — ${errs}`, 'error');
      return;
    }
    // 组装生效说明
    const parts = [];
    const eff = j.effect || {};
    if (eff.immediate && eff.immediate.length) parts.push(`已立即生效：${eff.immediate.join('、')}`);
    if (eff.nextGame && eff.nextGame.length) parts.push(`下一局生效：${eff.nextGame.join('、')}`);
    if (eff.restart && eff.restart.length) parts.push(`需重启服务：${eff.restart.join('、')}`);
    const warnPart = j.errors && Object.keys(j.errors).length
      ? `（部分项被拒：${Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join('；')}）`
      : '';
    setSettingsMsg(`✓ 已保存。${parts.join('；')}${warnPart}`, 'ok');
  } catch (e) {
    setSettingsMsg(`保存失败：${e.message}`, 'error');
  }
}

function createRoom() {
  if (ws && ws.readyState === WebSocket.OPEN && authenticated && capabilities.createRoom) {
    ws.send(JSON.stringify({ type: 'create_room' }));
    addLog('正在创建单实例房间...', 'system');
  }
}

function closeRoom() {
  if (ws && ws.readyState === WebSocket.OPEN && authenticated && capabilities.closeRoom) {
    if (!confirm('确定关闭当前房间并释放主持权吗？')) return;
    ws.send(JSON.stringify({ type: 'close_room' }));
  }
}

function updateRoomControls() {
  const createBtn = document.getElementById('btnCreateRoom');
  const closeBtn = document.getElementById('btnCloseRoom');
  const status = document.getElementById('roomStatus');
  const modeSelect = document.getElementById('modeSelect');
  const settingsBtn = document.getElementById('btnSettings');

  if (createBtn) {
    createBtn.style.display = authenticated && !roomState.exists ? 'inline-flex' : 'none';
    createBtn.disabled = !authenticated || !capabilities.createRoom;
  }
  if (closeBtn) {
    closeBtn.style.display = authenticated && roomState.isCreator && !gameStarted ? 'inline-flex' : 'none';
    closeBtn.disabled = !capabilities.closeRoom;
  }
  if (modeSelect && !gameStarted) modeSelect.style.display = roomState.isCreator ? 'flex' : 'none';
  if (settingsBtn) settingsBtn.style.display = roomState.isCreator ? 'inline-flex' : 'none';
  if (status) {
    if (!authenticated) status.textContent = '正在连接服务器…';
    else if (!roomState.exists) status.textContent = '当前没有房间。创建后你会自动成为主持人。';
    else if (roomState.isCreator) status.textContent = '你创建了当前房间，并自动成为主持人。';
    else status.textContent = '当前已有房间，你可以观战；控制权属于房间创建者。';
  }
}

function updateControlButtons() {
  const startBtn = document.getElementById('btnStart');
  if (startBtn) startBtn.disabled = !authenticated || !capabilities.startGame || gameStarted;
  const joinBtn = document.getElementById('btnJoin');
  if (joinBtn) joinBtn.disabled = !authenticated || !capabilities.startGame || gameStarted;
  const pauseBtn = document.getElementById('btnPause');
  const resumeBtn = document.getElementById('btnResume');
  if (pauseBtn) pauseBtn.disabled = !capabilities.pauseGame;
  if (resumeBtn) resumeBtn.disabled = !capabilities.resumeGame;
  if (gamePaused) {
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = 'inline-flex';
  } else {
    pauseBtn.style.display = 'inline-flex';
    resumeBtn.style.display = 'none';
  }
  updateRoomControls();
}

// ====== 人类玩家输入 ======
function showHumanInputPanel(data) {
  const panel = document.getElementById('humanInputPanel');
  const prompt = document.getElementById('inputPrompt');
  const options = document.getElementById('inputOptions');
  const textArea = document.getElementById('inputTextArea');

  // 座位门控必须早于任何状态写入；错误座位/观众消息不得污染 pendingHumanRequest。
  if (!mySeatId || (data.playerId && data.playerId !== mySeatId)) return;

  pendingHumanRequest = { gameId: data.gameId || currentGameId, requestId: data.requestId };
  prompt.textContent = data.prompt;
  options.innerHTML = '';
  textArea.style.display = 'none';

  const opts = data.options || {};

  // 目标选择：targets（夜间行动/投票/警徽继承）或 candidates（历史遗留字段，后端未用）。
  // 两者都渲染成「按人物名的目标按钮」，点击回传 { targetId }。
  const targetIds = opts.targets || opts.candidates;
  if (targetIds) {
    for (const id of targetIds) {
      const player = players.find(p => p.id === id);
      // 弃票等特殊值（如 'abstain'）没有对应玩家，直接显示原值。
      const label = player ? player.name : (id === 'abstain' ? '弃票' : id);
      const btn = document.createElement('button');
      btn.className = 'btn-option';
      btn.textContent = label;
      btn.onclick = () => submitHumanChoice(id);
      options.appendChild(btn);
    }
  } else if (opts.type === 'confirm') {
    // 二元确认（上警/自爆/退水）：把 options.options 的标签原样渲染为按钮，
    // 回传 { choice: 标签 }，与后端 input.choice === '标签' 的判断对齐。
    for (const label of (opts.options || ['确认', '取消'])) {
      const btn = document.createElement('button');
      btn.className = 'btn-option';
      btn.textContent = label;
      btn.onclick = () => submitHumanConfirm(label);
      options.appendChild(btn);
    }
  } else if (opts.type === 'speech' || opts.context) {
    // 自由发言（白天/竞选/PK/警长归票）：显示文本框，回传 { speech }。
    textArea.style.display = 'flex';
    // 遗言场景允许留空跳过：额外给一个「保持沉默」按钮，回传空 speech。
    // 普通发言（allowEmpty 缺省）不渲染此按钮，避免玩家空过正常发言。
    if (opts.allowEmpty) {
      const btn = document.createElement('button');
      btn.className = 'btn-option';
      btn.textContent = '保持沉默（不留遗言）';
      btn.onclick = () => submitHumanText(true);
      options.appendChild(btn);
    }
  }

  panel.style.display = 'flex';
}

function submitHumanChoice(targetId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'human_input',
      data: { ...pendingHumanRequest, input: { targetId, reasoning: '人类玩家选择', reason: '人类玩家选择' } }
    }));
    // 等待服务端确认。
  }
}

// 二元确认回传：后端各站点读 input.choice 与选项标签做精确比较（如 '自爆'、'退水'、'上警'）。
function submitHumanConfirm(choice) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'human_input',
      data: { ...pendingHumanRequest, input: { choice } }
    }));
    // 等待服务端确认。
  }
}

// allowEmpty=true 时（遗言「保持沉默」按钮）允许提交空串，让后端把遗言当留空跳过；
// 缺省仍要求非空，避免普通发言被空过导致卡住。
function submitHumanText(allowEmpty) {
  const input = document.getElementById('humanTextInput');
  const text = input.value.trim();
  if (ws && ws.readyState === WebSocket.OPEN && (allowEmpty || text)) {
    ws.send(JSON.stringify({
      type: 'human_input',
      data: { ...pendingHumanRequest, input: { speech: text } }
    }));
    input.value = '';
    document.getElementById('humanInputPanel').style.display = 'none';
  }
}

// ====== 游戏事件处理 ======
// ====== 断线/重启后的历史回放 ======
// 服务器重启后，进行中的对局内存状态会丢失。后端把最近一局的事件流存了盘，
// 新客户端连上时按序补发，这里把它们当普通事件走一遍渲染流程，恢复"看到哪了"。
// 回放期间静音 TTS（replaying=true），并显示横幅告知这是历史记录、非直播。
function onReplayStart(data) {
  // 回放必须从头扫描历史来重建 cursor，不能沿用握手或此前实时流留下的进度。
  eventSequenceGuard.resetGame(data.gameId);
  // replaying=true 只能拦住"还没入队"的新语音（speakText 开头就 return）。
  // 已经在途的那一句（await fetch 中）不受它约束，必须靠 epoch 作废，
  // 否则回放开始时会突然冒出一句上一局的语音。
  stopPendingTts();
  replaying = true;
  // 让被 gameId 过滤器放行：把当前局设为回放局的 ID
  currentGameId = data.gameId || null;
  gameStarted = true;
  enterGameView();
  addSystemMessage(`📜 正在回放上一局记录（服务器已重启，这是历史对局，非实时）…`);
  addLog(`回放历史对局（${data.count} 条事件）`, 'system');
}

function onReplayEnd(data) {
  replaying = false;
  // 历史事件可能止于中途而没有 game_end；回放结束本身就是“该局不再活动”的权威边界。
  gameStarted = false;
  gamePaused = false;
  currentGameId = null;
  // 说清"为什么不能续"，否则玩家看完回放会以为是 bug。
  // 事件日志只记录了"对外可见的结果"（谁发言了、谁被投出），
  // 而每个 AI 的记忆、心证、女巫药剂状态、预言家验人记录都在后端内存里，随进程一起没了。
  addSystemMessage(
    `📜 历史回放结束。这是磁盘上的事件记录，不是直播。<br>` +
    `该局在服务器重启时已中断且<strong>无法续接</strong>——回放只能恢复"看到过什么"，` +
    `但每个 AI 的记忆与推理状态存在后端内存里，随进程一起丢失了。点右上角的「🔄 再来一局」可开新的一局。`
  );
  addLog('回放结束（该局无法续接）', 'system');
  // 回放的是已中断的局，不能继续，允许直接开新局
  const btnStart = document.getElementById('btnStart');
  if (btnStart) btnStart.disabled = false;
  updateControlButtons();
}

// 断线重连后发现服务器已无进行中的对局、也没有可回放的历史（例如服务器重启且日志被清）。
// 前端此前以为自己在游戏中（gameStarted=true），需明确告知玩家：对局已丢失，请重开。
function onServerLostGame() {
  gameStarted = false;
  gamePaused = false;
  currentGameId = null;
  addSystemMessage(`⚠️ 与服务器重连成功，但服务器上的对局已不存在（可能服务器重启过）。请点右上角的「🔄 再来一局」重新开始。`);
  addLog('服务器无进行中对局，需重开', 'system');
  const btnStart = document.getElementById('btnStart');
  if (btnStart) btnStart.disabled = false;
  updateControlButtons();
}

/**
 * 断线/刷新重连后，服务器仍在跑同一局。用握手里的 state 重建前端现场：
 * 进游戏视图、渲染角色列表，并恢复难度标签和控制按钮。
 *
 * 为什么必须有：`game_start` 事件在开局时已发过一次，之后不会再发。刷新页面
 * 会把游戏视图状态清零，如果只靠后续实时事件恢复视图，前端会一直卡在欢迎页、
 * 左侧空白。座位身份只采用 authenticated 消息中的服务端权威 seatId。
 */
function restoreRunningGame(state) {
  if (!state || !Array.isArray(state.players) || state.players.length === 0) return;

  currentGameId = state.gameId || null;
  gameStarted = true;
  gamePaused = !!state.paused;
  players = state.players;

  // 顶栏难度标签：后端 getState() 已带 aiDifficulty，缺失兜底 standard。
  updateDifficultyBadge(state.aiDifficulty);

  // mySeatId 已由 authenticated 消息设置；状态恢复不得根据角色名或身份字段猜测、覆盖座位。
  document.body.classList.toggle('human-mode', !!mySeatId);

  enterGameView();
  renderPlayerList(state.players);

  // 顶栏阶段/轮次：后端下发时才带 round/phase，缺失就等下一个 phase_change 事件覆盖。
  if (state.round) {
    const roundInfo = document.getElementById('roundInfo');
    if (roundInfo) roundInfo.textContent = `第 ${state.round} 轮`;
  }
  if (state.phase) {
    const badge = document.getElementById('phaseBadge');
    if (badge) {
      badge.className = 'phase-badge';
      const map = { night: ['🌙 黑夜', 'night'], dawn: ['🌅 天亮', ''], day: ['☀️ 白天', 'day'], vote: ['🗳️ 投票', 'vote'] };
      const [text, cls] = map[state.phase] || ['', ''];
      if (text) badge.textContent = text;
      if (cls) badge.classList.add(cls);
    }
  }

  // 恢复控制按钮组（暂停/继续/重开/语音）。按暂停状态切换暂停/继续可见性。
  const controlBtns = document.getElementById('controlBtns');
  if (controlBtns) controlBtns.style.display = 'flex';
  const btnPause = document.getElementById('btnPause');
  const btnResume = document.getElementById('btnResume');
  const btnRestart = document.getElementById('btnRestart');
  if (btnPause) btnPause.style.display = gamePaused ? 'none' : '';
  if (btnResume) btnResume.style.display = gamePaused ? '' : 'none';
  if (btnRestart) btnRestart.style.display = '';
  const btnStart = document.getElementById('btnStart');
  if (btnStart) btnStart.disabled = true;

  addSystemMessage('🔄 已重新连接服务器，恢复当前对局。');
}

function onGameStart(data) {
  // 兜底作废上一局的语音。game_start 是所有开局路径的必经点（观战/参战/再来一局/
  // 回放后开新局），在这里清一次可以覆盖任何漏调 stopPendingTts 的入口——
  // 包括"后端自行开新局"这种不经过任何前端按钮的情况。
  stopPendingTts();
  currentGameId = data.gameId || null;
  gameStarted = true;
  gamePaused = false;
  players = data.players;

  // 顶栏显示本局 AI 强度（新人/标准/高阶）。难度随 game_start 的 config 下发，
  // 每局可变，故在这里读而非连接握手。缺失时 updateDifficultyBadge 兜底为标准。
  updateDifficultyBadge(data.config && data.config.aiDifficulty);

  // 新局开始就清掉上局遗留的 Mock 兜底计数与 badge，避免上一局的 fallback 数字被误当成本局的。
  resetProviderFallbackBadge();

  // 座位身份只由 authenticated 消息中的服务端绑定决定；game_start 不得自行推断或清空。
  document.body.classList.toggle('human-mode', !!mySeatId);

  enterGameView();

  renderPlayerList(data.players);
  document.getElementById('controlBtns').style.display = 'flex';
  // 新局开始时恢复被 onGameEnd 隐藏的三个按钮。
  document.getElementById('btnPause').style.display = '';
  document.getElementById('btnResume').style.display = 'none'; // 初始为暂停可用状态
  document.getElementById('btnRestart').style.display = '';
  const btnStart = document.getElementById('btnStart');
  if (btnStart) btnStart.disabled = true;

  if (mySeatId) {
    const me = data.players.find(p => p.id === mySeatId);
    const roleNames = { werewolf:'细作（狼人）', seer:'军师（预言家）', witch:'神医（女巫）', hunter:'猛将（猎人）', guard:'禁卫（守卫）', villager:'平民' };
    const roleLabel = roleNames[me.roleType] || me.roleType;
    addSystemMessage(`⚔️ 游戏开始！你扮演 ${me.name}，身份是【${roleLabel}】。`);
    // 人类若是狼，game_start 会带上狼队友名单（服务端遮罩层保留了自己座位的私有字段）。
    if (me.wolfPartners && me.wolfPartners.length > 0) {
      addSystemMessage(`🐺 你的狼人同伴：${me.wolfPartners.join('、')}。白天注意互相掩护。`);
    }
  } else {
    addSystemMessage('⚔️ 游戏开始！十二位英雄齐聚，暗藏四名细作...');
  }
  // 降级 toast 去重集合按局清空：否则第二局起同类降级不再提示（上一局已"见过"）。
  // 放在 game_start 而非 resetToWelcome：所有开局路径（新开/参战/重开）都必经这里。
  degradeSeen.clear();
  addLog('游戏开始', 'system');
}

function onPhaseChange(data) {
  const badge = document.getElementById('phaseBadge');
  const roundInfo = document.getElementById('roundInfo');

  badge.className = 'phase-badge';

  switch (data.phase) {
    case 'night':
      badge.textContent = '🌙 黑夜';
      badge.classList.add('night');
      addSystemMessage(`🌙 第 ${data.round} 轮 - 黑夜降临`, 'night');
      addLog(`第 ${data.round} 轮 - 黑夜`, 'night');
      showPhaseTransition('🌙 夜幕降临', 'night');
      break;
    case 'dawn':
      badge.textContent = '🌅 天亮';
      break;
    case 'day':
      badge.textContent = '☀️ 白天';
      badge.classList.add('day');
      addSystemMessage(`☀️ 第 ${data.round} 轮 - 白天辩论`);
      addLog(`第 ${data.round} 轮 - 白天`, 'speech');
      showPhaseTransition('☀️ 天亮了', 'day');
      break;
    case 'vote':
      badge.textContent = '🗳️ 投票';
      badge.classList.add('vote');
      addSystemMessage('🗳️ 投票环节');
      addLog('投票环节', 'vote');
      break;
  }

  roundInfo.textContent = `第 ${data.round} 轮`;
}

function onNightAction(data) {
  addLog(`${data.playerName}(${data.roleName})行动中...`, 'night');
}

function onNightActionDone(data) {
  let actionText = `${data.playerName} → ${data.targetName}`;
  // 女巫显示使用的药品类型
  if (data.reasoning === '使用解药') {
    actionText = `${data.playerName} 💊解药 → ${data.targetName}`;
  } else if (data.reasoning === '使用毒药') {
    actionText = `${data.playerName} ☠️毒药 → ${data.targetName}`;
  }
  addLog(actionText, 'night');
}

function onDawnResult(data) {
  if (data.isPeacefulNight) {
    addSystemMessage('✨ 昨晚平安夜，无人死亡');
    addLog('平安夜', 'system');
  } else {
    for (const death of data.deaths) {
      addSystemMessage(`💀 ${death.name} 昨晚被杀害了！`, 'death');
      addLog(`${death.name} 被杀`, 'death');
      markPlayerDead(death.id);
    }
  }
}

function onPlayerSpeak(data) {
  addSpeechMessage(data, `${data.playerName} 发言`);
}

function onSheriffFinalSpeech(data) {
  // 警长归票发言用特殊样式显示
  const speechData = {
    playerId: data.sheriffId,
    playerName: `🏅 警长${data.sheriffName}`,
    title: '归票发言',
    innerThoughts: data.innerThoughts || '',
    publicSpeech: data.speech,
    round: data.round,
  };
  addSpeechMessage(speechData, `🏅 ${data.sheriffName} 归票`);
}

// ====== 警长竞选事件处理 ======
function onSheriffElectionStart(data) {
  const candidateNames = data.candidates.map(c => c.name).join('、');
  const voterNames = data.voters.map(v => v.name).join('、');
  addSystemMessage(`🏅 警长竞选开始`);
  addLog(`🏅 竞选开始`, 'system');
  addLog(`🙋 上警: ${candidateNames}`, 'system');
  if (data.voters.length > 0) {
    addLog(`👥 警下: ${voterNames}`, 'system');
  }
}

function onSheriffSpeech(data) {
  const speechData = {
    playerId: data.playerId,
    playerName: `🏅 ${data.playerName}`,
    title: '竞选演说',
    innerThoughts: '',
    publicSpeech: data.speech,
    round: 0,
  };
  addSpeechMessage(speechData, `🎤 ${data.playerName} 竞选演说`);
}

function onSheriffWithdraw(data) {
  addSystemMessage(`💧 ${data.playerName} 退水（放弃竞选）`);
  addLog(`💧 ${data.playerName} 退水`, 'system');
}

function onSheriffVote(data) {
  addVoteMessage({
    voterName: data.voterName,
    targetName: data.targetName,
  });
  addLog(`🗳️ ${data.voterName} → ${data.targetName}`, 'vote');
}

function onSheriffVoteResult(data) {
  if (data.tally && data.tally.length > 0) {
    addVoteResultDisplay(data.tally);
  }
}

function onSheriffElected(data) {
  addSystemMessage(`🏅 ${data.sheriffName} 当选警长！`);
  addLog(`🏅 ${data.sheriffName} 当选警长`, 'system');
}

function onSheriffElectionEnd(data) {
  const reasons = {
    no_candidates: '无人竞选，本局无警长',
    all_withdrawn: '所有人退水，本局无警长',
    tie_lost: '二次平票，警徽流失',
    wolf_explode: '狼人自爆，本局无警长',
  };
  const reason = reasons[data.result] || '竞选结束';
  addSystemMessage(`⚠️ ${reason}`);
  addLog(`⚠️ ${reason}`, 'system');
}

function onSheriffPkSpeech(data) {
  const speechData = {
    playerId: data.playerId,
    playerName: `⚔️ ${data.playerName}`,
    title: 'PK发言',
    innerThoughts: '',
    publicSpeech: data.speech,
    round: 0,
  };
  addSpeechMessage(speechData, `⚔️ ${data.playerName} PK发言`);
}

function onWolfExplode(data) {
  addSystemMessage(`💥 ${data.playerName} 自爆！身份是狼人！`);
  addLog(`💥 ${data.playerName} 自爆`, 'death');
  markPlayerDead(data.playerId);
}

function onSheriffTransfer(data) {
  addSystemMessage(`🏅 警长${data.fromName}将警徽传给了${data.toName}！`);
  addLog(`🏅 ${data.fromName} → ${data.toName} 传警徽`, 'system');
}

function onPlayerVote(data) {
  addVoteMessage(data);
  addLog(`${data.voterName} → ${data.targetName}`, 'vote');
}

function onVoteResult(data) {
  addVoteResultDisplay(data.tally);
}

function onPlayerEliminated(data) {
  addSystemMessage(`⚔️ ${data.playerName} 被放逐！`, 'death');
  if (data.lastWords) {
    addSystemMessage(`📜 遗言: "${data.lastWords}"`);
  }
  addLog(`${data.playerName} 被放逐`, 'death');
  markPlayerDead(data.playerId);
}

function onPlayerLastWords(data) {
  addSystemMessage(`📜 ${data.playerName} 遗言: "${data.words}"`);
  addLog(`${data.playerName} 遗言`, 'death');
}

function onHunterShoot(data) {
  addSystemMessage(`🏹 猎人 ${data.hunterName} 开枪带走了 ${data.targetName}！`, 'death');
  addLog(`🏹 ${data.hunterName} → ${data.targetName}`, 'death');
  markPlayerDead(data.targetId);
}

function onGameEnd(data) {
  gameStarted = false;
  gamePaused = false;
  // 复盘阶段：隐藏暂停/继续/重开，但保留语音键（此时仍有 TTS 在播放）
  document.getElementById('btnPause').style.display = 'none';
  document.getElementById('btnResume').style.display = 'none';
  document.getElementById('btnRestart').style.display = 'none';
  // controlBtns 容器保持显示，让"语音"按钮可见

  const isGoodWin = data.winner === 'good';
  const winnerText = isGoodWin ? '🟢 好人阵营胜利！' : '🔴 狼人阵营胜利！';

  addSystemMessage(`🏆 ${winnerText}`);
  addLog(`游戏结束 - ${winnerText}`, 'system');

  // 弹窗
  const modal = document.getElementById('gameEndModal');
  const header = document.getElementById('modalHeader');
  const body = document.getElementById('modalBody');

  header.textContent = `🏆 ${winnerText}`;

  body.textContent = '';
  const reason = document.createElement('p');
  reason.style.marginBottom = '12px';
  reason.textContent = String(data.reason ?? '');
  body.appendChild(reason);
  const reveal = document.createElement('div');
  reveal.style.textAlign = 'left';
  const roleNames = {
    werewolf: '细作（狼人）', seer: '军师（预言家）',
    witch: '神医（女巫）', hunter: '猛将（猎人）',
    guard: '禁卫（守卫）', villager: '平民',
  };
  for (const p of data.players) {
    const item = document.createElement('div');
    item.className = 'reveal-item';
    const icon = p.faction === 'wolf' ? '🐺' : '😇';
    const status = p.isAlive ? '✅' : '❌';
    item.textContent = `${status} ${icon} ${p.name}（${p.title}）- ${roleNames[p.roleType] || p.roleType}`;
    reveal.appendChild(item);
  }
  body.appendChild(reveal);
  modal.style.display = 'flex';

  revealAllRoles(data.players);
  const btnStart = document.getElementById('btnStart');
  if (btnStart) btnStart.disabled = false;
}

// ====== 渲染函数 ======
function renderPlayerList(playerData) {
  const list = document.getElementById('playerList');
  list.innerHTML = '';
  const roleIcons = { werewolf:'🗡️狼', seer:'🔮军师', witch:'💊医', hunter:'🏹将', guard:'🛡️守', villager:'👤民' };
  // wolfPartners 只由服务端附在真人自己的座位上，其他座位不会携带该字段。
  // 因此这里仅在人类玩家确实是狼人时标记队友，不会把信息泄漏给观战/其他客户端。
  const me = mySeatId ? playerData.find(p => p.id === mySeatId) : null;
  const wolfPartnerNames = new Set(
    me && me.roleType === 'werewolf' && Array.isArray(me.wolfPartners) ? me.wolfPartners : [],
  );

  for (const p of playerData) {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.id = `player-${p.id}`;
    // 有 roleType 才显示身份：观战模式所有座位都带；参战模式只有自己座位带（服务端遮罩）。
    // 无身份的座位渲染「？」中性徽章、不加阵营配色。
    const known = !!p.roleType;
    const isMe = mySeatId && p.id === mySeatId;
    const isWolfPartner = !!mySeatId && wolfPartnerNames.has(p.name);
    // 人类狼人视角：队友的真实角色仍然是最基础的狼人（不是预言家/女巫等），
    // 直接在角色徽章显示「🗡️狼」并套狼阵营配色。其他未知座位继续显示「？」。
    const visibleRoleType = isWolfPartner ? 'werewolf' : p.roleType;
    const roleText = (known || isWolfPartner) ? (roleIcons[visibleRoleType] || '？') : '？';
    const factionClass = (known || isWolfPartner) ? (visibleRoleType === 'werewolf' ? 'wolf' : 'good') : 'unknown';

    // 合规：非"你"的座位一律显式标注为 AI 角色（不可关闭）
    const identityTag = isMe
      ? '<span class="me-tag">你</span>'
      : '<span class="ai-tag" title="该角色为人工智能，并非真人玩家">🤖 AI</span>';
    card.innerHTML = `
      <div class="player-avatar">${getCharacterEmoji(p.name)}</div>
      <div class="player-info">
        <div class="player-name">${p.name} ${identityTag}${isWolfPartner ? '<span class="wolf-partner-tag">🐺队友</span>' : ''}</div>
        <div class="player-title">${p.title}</div>
      </div>
      <span class="player-role ${(known || isWolfPartner) ? 'revealed' : 'hidden-role'} ${factionClass}" id="role-${p.id}">${roleText}</span>
    `;
    if (known || isWolfPartner) card.classList.add(factionClass);
    if (isMe) card.classList.add('my-seat');
    list.appendChild(card);
  }
}

function getCharacterEmoji(name) {
  const map = { '曹操':'👑', '诸葛亮':'🪶', '张飞':'🔥', '华佗':'💊', '典韦':'🛡️', '司马懿':'🦊', '关羽':'⚔️', '刘备':'🏯', '周瑜':'🔥', '吕布':'🐎', '貂蝉':'🌸', '赵云':'🗡️' };
  return map[name] || '🎭';
}

function markPlayerDead(playerId) {
  const card = document.getElementById(`player-${playerId}`);
  if (!card) return;
  card.classList.add('dead');
}

function revealAllRoles(playerData) {
  const roleIcons = { werewolf:'🗡️狼', seer:'🔮军师', witch:'💊医', hunter:'🏹将', guard:'🛡️守', villager:'👤民' };
  for (const p of playerData) {
    const card = document.getElementById(`player-${p.id}`);
    const roleSpan = document.getElementById(`role-${p.id}`);
    if (card && roleSpan) {
      roleSpan.textContent = roleIcons[p.roleType] || p.roleType;
      // 终局全揭示：把参战模式下遮掉的座位从「？」中性态翻成已揭示态。
      roleSpan.classList.remove('hidden-role', 'unknown');
      roleSpan.classList.add('revealed');
      card.classList.add(p.faction === 'wolf' ? 'wolf' : 'good');
    }
  }
}

function addSystemMessage(text, extraClass = '') {
  const area = document.getElementById('dialogueArea');
  const div = document.createElement('div');
  div.className = `message-system ${extraClass}`;
  const span = document.createElement('span');
  span.className = 'system-text';
  span.textContent = String(text ?? '');
  div.appendChild(span);
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

// Toast 通知：右上角浮层提示。level: 'error' | 'warn' | 'info'。
// duration=0 表示不自动消失（用于严重错误如熔断，需玩家手动关闭）。
function showToast(title, body, level = 'info', duration = 6000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${level}`;
  toast.innerHTML = `
    <span class="toast-close">✕</span>
    <div class="toast-title">${title}</div>
    <div class="toast-body">${body}</div>
  `;
  const close = () => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  };
  toast.querySelector('.toast-close').addEventListener('click', close);
  container.appendChild(toast);
  // 触发进入动画
  requestAnimationFrame(() => toast.classList.add('show'));
  if (duration > 0) setTimeout(close, duration);
}

// LLM 熔断告警：后端因欠费/额度受限或预算耗尽停止调用 AI 时，弹长驻 Toast 让玩家知情。
function onLlmAlert(data) {
  // 回放期间不弹历史熔断告警：那是旧局记录，此刻已无参考意义，弹出反而误导玩家。
  if (replaying) return;
  const kind = data?.kind || 'billing';
  let title, body;
  if (kind === 'budget') {
    title = '⚠️ AI 调用已达预算上限';
    body = '已达到设定的 token/次数预算，AI 已自动停止以防超支。可在 .env 调高 LLM_TOKEN_BUDGET/LLM_CALL_BUDGET 后重启服务。';
  } else {
    title = '⚠️ AI 暂时无法响应';
    body = 'API 余额不足或调用受限（欠费/额度耗尽），AI 已停止调用以防继续扣费。请检查账户后重启服务。';
  }
  // duration=0：不自动消失，需玩家手动关闭，确保这类关键告警不被错过。
  showToast(title, body, 'error', 0);
  addSystemMessage(`⚠️ ${title}`);
  addLog(`LLM 熔断: ${data?.reason || kind}`, 'system');
}

function addSpeechMessage(data, logText = '') {
  const showMessage = () => {
    const area = document.getElementById('dialogueArea');
    const div = document.createElement('div');
    div.className = 'message';
    const header = document.createElement('div');
    header.className = 'message-header';
    const name = document.createElement('span');
    name.className = 'message-name';
    name.textContent = String(data.playerName ?? '');
    const badge = document.createElement('span');
    const isHuman = humanCharacterName && data.playerName === humanCharacterName;
    badge.className = isHuman ? 'msg-you-badge' : 'msg-ai-badge';
    badge.textContent = isHuman ? '你' : '🤖 AI';
    if (!isHuman) badge.title = '该角色为人工智能，并非真人玩家';
    const title = document.createElement('span');
    title.className = 'message-title';
    title.textContent = String(data.title ?? '');
    header.append(name, badge, title);
    div.appendChild(header);
    const thoughts = String(data.innerThoughts || '').trim();
    if (thoughts) {
      const thoughtNode = document.createElement('div');
      thoughtNode.className = 'message-thoughts';
      thoughtNode.textContent = thoughts;
      div.appendChild(thoughtNode);
    }
    const speech = document.createElement('div');
    speech.className = 'message-bubble';
    speech.textContent = String(data.publicSpeech ?? '');
    div.appendChild(speech);
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
    if (logText) addLog(logText, 'speech');
  };

  const publicSpeech = String(data.publicSpeech ?? '');
  if (publicSpeech) {
    speakText(publicSpeech, data.playerName, showMessage);
  } else {
    showMessage();
  }
}

function addVoteMessage(data) {
  const area = document.getElementById('dialogueArea');
  let container = area.querySelector('.vote-container:last-child');
  if (!container || container.dataset.complete === 'true') {
    container = document.createElement('div');
    container.className = 'vote-container';
    area.appendChild(container);
  }

  const item = document.createElement('div');
  item.className = 'vote-item';
  item.innerHTML = `
    <span class="voter">${data.voterName}</span>
    <span class="arrow">→</span>
    <span class="target">${data.targetName}</span>
  `;
  container.appendChild(item);
  area.scrollTop = area.scrollHeight;
}

function addVoteResultDisplay(tally) {
  const area = document.getElementById('dialogueArea');
  const container = area.querySelector('.vote-container:last-child');
  if (!container) return;
  container.dataset.complete = 'true';

  // 兼容两种格式：对象 {name: count} 和数组 [{name, votes}]
  let entries = [];
  if (Array.isArray(tally)) {
    entries = tally.map(item => [item.name, item.votes]);
  } else {
    entries = Object.entries(tally);
  }

  const maxVotes = Math.max(...entries.map(([_, v]) => v));
  const barContainer = document.createElement('div');
  barContainer.className = 'vote-bar-container';

  for (const [name, count] of entries) {
    const pct = maxVotes > 0 ? (count / players.length) * 100 : 0;
    barContainer.innerHTML += `
      <div class="vote-bar-item">
        <span class="vote-bar-name">${name}</span>
        <div class="vote-bar">
          <div class="vote-bar-fill" style="width:${Math.max(pct, 8)}%">${count}票</div>
        </div>
      </div>`;
  }
  container.appendChild(barContainer);
  area.scrollTop = area.scrollHeight;
}

function showPhaseTransition(text, phaseClass) {
  const overlay = document.createElement('div');
  overlay.className = `phase-transition ${phaseClass}`;
  overlay.innerHTML = `<span class="phase-transition-text">${text}</span>`;
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 1800);
}

function addLog(text, type = '') {
  const log = document.getElementById('eventLog');
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  entry.textContent = `[${time}] ${text}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

// 各决策环节的中文名，用于把后端的 operation 字段翻成玩家能懂的说法。
const DEGRADE_OP_LABELS = {
  speak: '发言',
  vote: '投票',
  nightAction: '夜间技能',
  witchDecide: '女巫用药',
  hunterShoot: '猎人开枪',
  decideYesNo: '上警/退水决策',
  // 人类参战时，服务端会把暴露身份的环节（女巫用药/猎人开枪/夜间技能）抹成中性的 'decision'，
  // 避免"华佗的女巫用药降级"这种日志直接报出别人的身份。
  decision: '决策',
};

// 同一玩家同一环节的降级只提示一次，避免连续失败刷屏。
const degradeSeen = new Set();

/**
 * AI 决策降级提示。message 由后端给定（已过滤 prompt 原文与身份信息），这里只做展示。
 * 首次出现时额外弹一个 toast，让你知道有降级发生；后续同类只进事件日志。
 */
function onAiDecisionDegraded(data) {
  const op = DEGRADE_OP_LABELS[data.operation] || data.operation || '决策';
  addLog(`⚠️ ${data.playerName} 的${op}降级：${data.message}`, 'system');

  const key = `${data.playerId}|${data.operation}|${data.kind}`;
  if (degradeSeen.has(key)) return;
  degradeSeen.add(key);
  // parse 类是"重试后仍失败"，比超时更值得注意（可能是 prompt 或模型侧的稳定问题）。
  showToast(
    'AI 决策降级',
    `${data.playerName} 的${op}${data.message}。该次选择由系统兜底，不代表 AI 的真实判断。`,
    data.kind === 'parse' ? 'warn' : 'info',
    5000,
  );
}

// provider_fallback 的 reason → 中文的映射（顺手兼容 kind 里可能有的 'unknown'）。
const FALLBACK_REASON_LABELS = {
  timeout: '超时',
  parse: 'JSON 解析失败',
  empty: '返回空内容',
  budget: '预算耗尽',
  billing: '欠费/额度受限',
  authentication: '认证失败',
  error: '其他错误',
  startup_mock: '启动即 Mock',
};

// 本局累计 Provider 兜底次数（页面刷新/新局归零，与 currentGameId 生命周期一致）。
let providerFallbackCount = 0;

/**
 * Provider 层降级（真实 Provider → Mock）。与 ai_decision_degraded 不同的是：
 *   - ai_decision_degraded：BaseAgent 拿到 LLMError 后走的最后一道兜底（保守话术 / pass / 随机）；
 *   - provider_fallback：Provider 出错后由 FallbackLLMProvider 转 Mock 处理**当次调用**，
 *     仍能返回结构化结果，因此不会走 BaseAgent 兜底。
 * 两者可能一起出现（策略允许时先转 Mock，Mock 也抛错才落到决策级兜底），也可能只出其一。
 *
 * 顶栏挂一个"Mock 兜底 ×N"的 badge，让玩家一眼看出这局有多"纯"。
 */
function onProviderFallback(data) {
  const reason = FALLBACK_REASON_LABELS[data.reason] || data.reason || '未知';
  const op = data.operation === 'chatJSON' ? '结构化决策' : '发言';
  addLog(`↩ Provider 降级(${data.from}→mock)：${op} 遇到"${reason}"，已由 Mock 接管本次调用`, 'system');

  providerFallbackCount++;
  updateProviderFallbackBadge();

  // 首次触发弹一次 toast；后续只累计不打扰。
  if (providerFallbackCount === 1) {
    showToast(
      'Provider 已降级到 Mock',
      `${data.from} 遇到"${reason}"，${op}这一次由 Mock 接管。可在设置里调整 LLM_FALLBACK_STRATEGY。`,
      data.reason === 'budget' || data.reason === 'billing' || data.reason === 'authentication' ? 'warn' : 'info',
      6000,
    );
  }
}

/** 顶栏右侧显示 "Mock 兜底 ×N" badge；首次挂出时创建 DOM，之后只更新文字。 */
function updateProviderFallbackBadge() {
  let badge = document.getElementById('fallbackBadge');
  if (!badge) {
    const header = document.querySelector('.game-header') || document.querySelector('header') || document.body;
    badge = document.createElement('span');
    badge.id = 'fallbackBadge';
    badge.title = 'Provider 出错后由 Mock 兜底的调用次数。点开设置里的 LLM_FALLBACK_STRATEGY 可切换策略。';
    badge.style.cssText = [
      'display:inline-block',
      'margin-left:8px',
      'padding:2px 8px',
      'font-size:12px',
      'font-weight:bold',
      'color:#fff',
      'background:linear-gradient(135deg,#e67e22,#d35400)',
      'border-radius:10px',
      'box-shadow:0 1px 4px rgba(211,84,0,0.4)',
    ].join(';');
    header.appendChild(badge);
  }
  badge.textContent = `Mock 兜底 ×${providerFallbackCount}`;
}

/** 回欢迎页/新局重置：清空 badge 与计数。 */
function resetProviderFallbackBadge() {
  providerFallbackCount = 0;
  const badge = document.getElementById('fallbackBadge');
  if (badge) badge.remove();
}

function closeModal() {
  document.getElementById('gameEndModal').style.display = 'none';
}

function showRestartButton() {
  // 移除已有的（如有）
  const existing = document.getElementById('restartFloatBtn');
  if (existing) existing.remove();

  const btn = document.createElement('button');
  btn.id = 'restartFloatBtn';
  btn.textContent = '🔄 再来一局';
  btn.style.cssText = `
    padding: 6px 14px;
    font-size: 13px;
    font-weight: bold;
    color: #fff;
    background: linear-gradient(135deg, #e74c3c, #c0392b);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(231,76,60,0.4);
    transition: transform 0.2s, box-shadow 0.2s;
    margin-left: 10px;
  `;
  btn.onmouseenter = () => {
    btn.style.transform = 'scale(1.05)';
    btn.style.boxShadow = '0 4px 12px rgba(231,76,60,0.6)';
  };
  btn.onmouseleave = () => {
    btn.style.transform = 'scale(1)';
    btn.style.boxShadow = '0 2px 8px rgba(231,76,60,0.4)';
  };
  btn.onclick = () => {
    resetToWelcome();
  };
  // 插入到 roundInfo 旁边
  const roundInfo = document.getElementById('roundInfo');
  if (roundInfo && roundInfo.parentNode) {
    roundInfo.parentNode.insertBefore(btn, roundInfo.nextSibling);
  } else {
    document.querySelector('.header-controls').appendChild(btn);
  }
}

// ====== 合规声明弹窗（首次进入必弹） ======
// 国内合规硬性要求：显著标注"AI 角色 ≠ 真人玩家"，需玩家勾选知悉后方可开始。
// 用 localStorage 记住已确认，避免每次刷新都打扰。
function showComplianceModalIfNeeded() {
  try {
    if (localStorage.getItem('compliance_ack_v1') === '1') return;
  } catch (_) { /* 隐私模式下 localStorage 会抛，不影响弹窗流程 */ }
  const modal = document.getElementById('complianceModal');
  if (!modal) return;
  modal.style.display = 'flex';
  // 勾选后启用"进入游戏"按钮
  const ck = document.getElementById('complianceAgree');
  const btn = document.getElementById('btnComplianceOk');
  if (ck && btn) {
    ck.addEventListener('change', () => { btn.disabled = !ck.checked; });
  }
}

function acceptCompliance() {
  const ck = document.getElementById('complianceAgree');
  if (!ck || !ck.checked) return;
  try { localStorage.setItem('compliance_ack_v1', '1'); } catch (_) {}
  const modal = document.getElementById('complianceModal');
  if (modal) modal.style.display = 'none';
}

// ====== 初始化 ======
showComplianceModalIfNeeded();
connectWebSocket();
