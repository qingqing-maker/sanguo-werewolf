'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const EventSequence = require('./event-sequence.js');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  toggle(value, force) {
    if (force === undefined ? !this.values.has(value) : force) this.values.add(value);
    else this.values.delete(value);
  }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(tagName = 'div', document = null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.id = '';
    this.className = '';
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = {};
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (child.id && this.ownerDocument) this.ownerDocument.elements.set(child.id, child);
    return child;
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    if (this.id && this.ownerDocument) this.ownerDocument.elements.delete(this.id);
    this.parentNode = null;
  }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  querySelector(selector) {
    if (selector === '.toast-close') return this.children[0] || new FakeElement('span', this.ownerDocument);
    if (selector === '.vote-container:last-child') {
      return [...this.children].reverse().find((child) => String(child.className).includes('vote-container')) || null;
    }
    return null;
  }
  insertBefore(child, reference) {
    child.parentNode = this;
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.body = this.make('body', 'body');
    this.body.classList = new FakeClassList();
  }
  make(tag, id) {
    const element = new FakeElement(tag, this);
    element.id = id;
    this.elements.set(id, element);
    return element;
  }
  getElementById(id) {
    if (!this.elements.has(id)) this.body.appendChild(this.make('div', id));
    return this.elements.get(id);
  }
  createElement(tag) { return new FakeElement(tag, this); }
  querySelector(selector) {
    if (selector === '.game-header' || selector === 'header' || selector === '.header-controls') return this.body;
    return null;
  }
}

function makeHarness() {
  const document = new FakeDocument();
  const ids = [
    'humanInputPanel', 'inputOptions', 'inputPrompt', 'inputTextArea', 'humanTextInput',
    'modelInfo', 'btnStart', 'btnJoin', 'btnPause', 'btnResume', 'btnRestart', 'controlBtns',
    'dialogueArea', 'welcomePanel', 'playerList', 'roundInfo', 'phaseBadge',
    'eventLog', 'difficultyBadge', 'toastContainer', 'modeSelect', 'characterPicker',
    'btnCreateRoom', 'btnCloseRoom', 'roomStatus', 'btnSettings',
    'gameEndModal', 'modalHeader', 'modalBody', 'complianceModal',
  ];
  ids.forEach((id) => document.body.appendChild(document.make('div', id)));
  document.getElementById('welcomePanel').parentNode = document.getElementById('dialogueArea');

  const storage = new Map([
    ['sanguo-session-token', 'A'.repeat(43)],
    ['compliance_ack_v1', '1'],
  ]);
  const timers = [];
  const fetchCalls = [];
  const audioInstances = [];
  let pendingFetch = null;

  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.onopen?.(); }
    close(code = 1006) { this.onclose?.({ code }); }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }

  class FakeAudio {
    constructor(url) { this.url = url; this.paused = false; this.played = false; this.playCount = 0; this.listeners = {}; audioInstances.push(this); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    play() { this.played = true; this.paused = false; this.playCount++; return Promise.resolve(); }
    pause() { this.paused = true; }
  }

  const speechSynthesis = {
    cancelCount: 0, speakCount: 0, pauseCount: 0, resumeCount: 0, utterances: [], onvoiceschanged: null,
    getVoices: () => [],
    cancel() { this.cancelCount++; },
    pause() { this.pauseCount++; },
    resume() { this.resumeCount++; },
    speak(utterance) { this.speakCount++; this.utterances.push(utterance); },
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    document,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    crypto: { getRandomValues: (array) => array.fill(1) },
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    Uint8Array,
    EventSequence,
    WebSocket: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost:3000' },
    setTimeout: (fn, delay) => { const timer = { fn, delay, active: true }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.active = false; },
    requestAnimationFrame: (fn) => fn(),
    fetch: (url, options) => {
      fetchCalls.push({ url, options });
      if (url === '/api/tts/status') return Promise.resolve({ ok: true, json: async () => ({ enabled: true }) });
      if (pendingFetch) return pendingFetch.promise;
      return Promise.resolve({ ok: true, blob: async () => ({}) });
    },
    speechSynthesis,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    Audio: FakeAudio,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Blob,
    Set,
    Map,
    Date,
    JSON,
    Math,
    Promise,
    Array,
    Object,
    String,
    Number,
    RegExp,
  };
  context.window = { speechSynthesis, addEventListener() {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), context, { filename: 'app.js' });

  const evaluate = (expression) => vm.runInContext(expression, context);
  return {
    context, document, timers, fetchCalls, audioInstances, speechSynthesis,
    sockets: FakeWebSocket.instances,
    evaluate,
    runNextTimer() {
      const timer = timers.find((candidate) => candidate.active);
      assert.ok(timer, '应存在待执行 timer');
      timer.active = false;
      timer.fn();
    },
    deferFetch() {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      pendingFetch = { promise, resolve };
      return pendingFetch;
    },
  };
}

function state(gameId = null, isRunning = false) {
  return {
    isRunning, paused: false, provider: 'mock', model: 'mock', gameId,
    phase: isRunning ? 'night' : null, round: isRunning ? 1 : 0,
    players: isRunning ? [{ id: 'p1', name: '诸葛亮', title: '卧龙', roleType: 'seer', faction: 'good', isAlive: true }] : [],
    aiDifficulty: 'standard', humanCharacterName: null,
  };
}

function authenticated(data = {}) {
  return {
    type: 'authenticated',
    data: {
      sessionId: 's1', seatId: null,
      room: { exists: true, roomId: 'room-1', isCreator: true },
      capabilities: { createRoom: false, closeRoom: true, startGame: true, pauseGame: true, resumeGame: true, restartGame: true },
      state: state(), stateSequence: 0, hasReplay: false, pendingInput: null, ...data,
    },
  };
}

function logs(harness) {
  return harness.document.getElementById('eventLog').children.map((child) => child.textContent);
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

async function main() {
  console.log('\n=== 前端真实 app.js 重连状态机 VM 测试 ===\n');
  let passed = 0;
  let failed = 0;
  async function check(name, fn) {
    try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
    catch (error) { failed++; process.stdout.write(`  ✗ ${name}\n      ${String(error.message || error).split('\n')[0]}\n`); }
  }

  await check('首次连接只创建一个 socket，open 后只发送一次 authenticate', async () => {
    const h = makeHarness();
    assert.equal(h.sockets.length, 1);
    h.sockets[0].open();
    assert.deepEqual(h.sockets[0].sent, [{ type: 'authenticate', token: 'A'.repeat(43) }]);
    h.sockets[0].message(authenticated());
    assert.equal(h.evaluate('authenticated'), true);
    assert.equal(h.evaluate('isReconnect'), false);
  });

  await check('短断线清 pending、只安排一次 1s 重连，旧 generation 消息无效', async () => {
    const h = makeHarness();
    const first = h.sockets[0];
    first.open();
    first.message(authenticated({ state: state('g1', true), seatId: 'p1', pendingInput: { gameId: 'g1', requestId: 'r1', playerId: 'p1', prompt: '选', options: {} } }));
    assert.equal(h.evaluate('pendingHumanRequest.requestId'), 'r1');
    first.close(1006);
    assert.equal(h.evaluate('pendingHumanRequest'), null);
    assert.equal(h.timers.filter((timer) => timer.active && timer.delay === 1000).length, 1);
    h.runNextTimer();
    assert.equal(h.sockets.length, 2);
    first.message({ type: 'game_cancelled', data: { gameId: 'g1' }, sequence: 99 });
    assert.equal(h.evaluate('gameStarted'), true, '旧 socket 的迟到消息必须忽略');
  });

  await check('活动局重连恢复权威快照、pending，并用 stateSequence 去重', async () => {
    const h = makeHarness();
    const first = h.sockets[0];
    first.open();
    first.message(authenticated({ state: state('g1', true), seatId: 'p1', stateSequence: 5 }));
    first.close(1006);
    h.runNextTimer();
    const second = h.sockets[1];
    second.open();
    second.message(authenticated({ state: state('g1', true), seatId: 'p1', stateSequence: 5, pendingInput: { gameId: 'g1', requestId: 'r2', playerId: 'p1', prompt: '恢复', options: {} } }));
    assert.equal(h.evaluate('currentGameId'), 'g1');
    assert.equal(h.evaluate('pendingHumanRequest.requestId'), 'r2');
    const before = logs(h).length;
    second.message({ type: 'phase_change', data: { gameId: 'g1', phase: 'day', round: 1 }, sequence: 5 });
    assert.equal(logs(h).length, before);
    second.message({ type: 'phase_change', data: { gameId: 'g1', phase: 'day', round: 1 }, sequence: 6 });
    assert.ok(logs(h).length > before);
  });

  await check('重连后服务端无活动局且无回放，进入 lost-game 状态', async () => {
    const h = makeHarness();
    const first = h.sockets[0];
    first.open(); first.message(authenticated({ state: state('g1', true) }));
    first.close(1006); h.runNextTimer();
    const second = h.sockets[1]; second.open(); second.message(authenticated({ state: state(null, false), hasReplay: false }));
    assert.equal(h.evaluate('gameStarted'), false);
    assert.equal(h.evaluate('currentGameId'), null);
    assert.ok(logs(h).some((entry) => entry.includes('服务器无进行中对局')));
  });

  await check('4002 只呈现 terminal 语义且不自动重连', async () => {
    const h = makeHarness();
    h.sockets[0].open();
    h.sockets[0].close(4002);
    assert.equal(h.evaluate('reconnectStopped'), true);
    assert.equal(h.timers.some((timer) => timer.active && timer.delay === 1000), false);
    const allLogs = logs(h).join('\n');
    assert.ok(allLogs.includes('会话令牌无效'));
    assert.equal(allLogs.includes('正在自动重连'), false);
  });

  await check('公共回放结束明确退出活动局，重复 authenticated/connected 不重复恢复', async () => {
    const h = makeHarness();
    const socket = h.sockets[0]; socket.open();
    socket.message(authenticated({ state: state(null, false), hasReplay: true }));
    const before = h.document.getElementById('dialogueArea').children.length;
    socket.message(authenticated({ state: state('should-ignore', true) }));
    assert.equal(h.evaluate('currentGameId'), null);
    socket.message({ type: 'connected', data: { message: 'legacy', state: state('legacy', true) } });
    assert.equal(h.evaluate('currentGameId'), null);
    socket.message({ type: 'replay_start', data: { gameId: 'old', count: 1 } });
    socket.message({ type: 'player_speak', data: { gameId: 'old', playerId: 'p1', playerName: '诸葛亮', title: '卧龙', publicSpeech: '历史', innerThoughts: '', round: 1 }, sequence: 1 });
    socket.message({ type: 'replay_end', data: { gameId: 'old' } });
    assert.equal(h.evaluate('replaying'), false);
    assert.equal(h.evaluate('gameStarted'), false);
    assert.equal(h.evaluate('currentGameId'), null);
    assert.ok(h.document.getElementById('dialogueArea').children.length > before);
  });

  await check('旧 gameId、重复和倒序 sequence 在 DOM/TTS 前被拒绝', async () => {
    const h = makeHarness(); const socket = h.sockets[0]; socket.open();
    socket.message(authenticated({ state: state('g2', true), stateSequence: 0 }));
    const before = h.document.getElementById('dialogueArea').children.length;
    socket.message({ type: 'player_speak', data: { gameId: 'old', playerName: 'A', title: '', publicSpeech: 'old' }, sequence: 1 });
    assert.equal(h.document.getElementById('dialogueArea').children.length, before);
    const event = { type: 'player_speak', data: { gameId: 'g2', playerName: 'A', title: '', publicSpeech: 'one' }, sequence: 1 };
    socket.message(event); socket.message(event);
    socket.message({ ...event, sequence: 0 });
    assert.equal(h.document.getElementById('dialogueArea').children.length, before + 1);
  });

  await check('下一名角色的文字等待上一段 TTS 播放结束后才显示', async () => {
    const h = makeHarness(); const socket = h.sockets[0]; socket.open();
    socket.message(authenticated({ state: state('g1', true), stateSequence: 0 }));
    await flush();
    h.evaluate('backendTtsAvailable = true');
    const dialogue = h.document.getElementById('dialogueArea');
    const before = dialogue.children.length;

    socket.message({ type: 'player_speak', data: { gameId: 'g1', playerName: '甲', title: '', publicSpeech: '第一段' }, sequence: 1 });
    socket.message({ type: 'player_speak', data: { gameId: 'g1', playerName: '乙', title: '', publicSpeech: '第二段' }, sequence: 2 });

    assert.equal(dialogue.children.length, before + 1, '第一名角色应立即显示，第二名角色仍在等待');
    await flush();
    await flush();
    assert.equal(h.audioInstances.length, 1, '第一段后端 TTS 应已创建音频播放器');
    h.audioInstances[0].listeners.ended();
    assert.equal(dialogue.children.length, before + 2, '第一段音频结束后才显示第二名角色');
  });

  await check('主持人只在当前发言 TTS 结束后发送对应 sequence 回执', async () => {
    const h = makeHarness(); const socket = h.sockets[0]; socket.open();
    socket.message(authenticated({ isHost: true, state: state('g1', true), stateSequence: 0 }));
    await flush();
    h.evaluate('backendTtsAvailable = true');
    socket.message({ type: 'player_speak', data: { gameId: 'g1', playerName: '甲', title: '', publicSpeech: '等待读完' }, sequence: 4 });
    await flush(); await flush();
    assert.equal(socket.sent.some((message) => message.type === 'speech_presented'), false, '播放结束前不得回执');
    h.audioInstances[0].listeners.ended();
    assert.deepEqual(socket.sent.at(-1), {
      type: 'speech_presented',
      data: { gameId: 'g1', sequence: 4 },
    });
  });

  await check('暂停会暂停当前音频，继续后恢复且不会提前回执', async () => {
    const h = makeHarness(); const socket = h.sockets[0]; socket.open();
    socket.message(authenticated({ isHost: true, state: state('g1', true), stateSequence: 0 }));
    await flush();
    h.evaluate('backendTtsAvailable = true');
    socket.message({ type: 'player_speak', data: { gameId: 'g1', playerName: '甲', title: '', publicSpeech: '暂停测试' }, sequence: 1 });
    for (let i = 0; i < 5 && !h.evaluate('currentAudio'); i++) await flush();
    const audio = h.audioInstances[0];
    socket.message({ type: 'game_paused', data: { gameId: 'g1' }, sequence: 2 });
    assert.equal(audio.paused, true, '暂停事件应调用当前 Audio.pause()');
    assert.equal(socket.sent.some((message) => message.type === 'speech_presented'), false, '暂停时不得把当前发言标记为已播完');
    socket.message({ type: 'game_resumed', data: { gameId: 'g1' }, sequence: 3 });
    assert.ok(audio.playCount >= 2, '继续后应恢复当前音频');
    audio.listeners.ended();
    assert.equal(socket.sent.at(-1).data.sequence, 1, '恢复后真正 ended 才回执原发言 sequence');
  });

  await check('活动局恢复只朗读服务端仍在等待的当前发言，其余历史只显示文字', async () => {
    const h = makeHarness(); const socket = h.sockets[0]; socket.open();
    const speechHistory = [
      { type: 'player_speak', data: { gameId: 'g1', playerName: '甲', title: '', publicSpeech: '已完成' }, sequence: 1 },
      { type: 'player_speak', data: { gameId: 'g1', playerName: '乙', title: '', publicSpeech: '待完成' }, sequence: 2 },
    ];
    socket.message(authenticated({
      isHost: true,
      state: state('g1', true),
      stateSequence: 2,
      speechHistory,
      pendingPresentationSequence: 2,
    }));
    await flush();
    assert.equal(h.speechSynthesis.speakCount, 1, '只应朗读仍待回执的第二条');
    assert.equal(h.document.getElementById('dialogueArea').children.filter((child) => child.className === 'message').length, 2);
    h.speechSynthesis.utterances[0].onend();
    assert.equal(socket.sent.at(-1).data.sequence, 2);
  });

  await check('replay_start 作废在途 TTS，回放对白静音，结束后实时对白恢复', async () => {
    const h = makeHarness(); const socket = h.sockets[0]; socket.open();
    socket.message(authenticated({ state: state('g1', true), stateSequence: 0 }));
    await flush();
    h.evaluate('backendTtsAvailable = true');
    const deferred = h.deferFetch();
    socket.message({ type: 'player_speak', data: { gameId: 'g1', playerName: 'A', title: '', publicSpeech: '在途' }, sequence: 1 });
    assert.ok(h.fetchCalls.some((call) => call.url === '/api/tts'));
    socket.message({ type: 'replay_start', data: { gameId: 'old', count: 1 } });
    assert.ok(h.speechSynthesis.cancelCount > 0);
    socket.message({ type: 'player_speak', data: { gameId: 'old', playerName: 'A', title: '', publicSpeech: '历史' }, sequence: 1 });
    const ttsCallsDuringReplay = h.fetchCalls.filter((call) => call.url === '/api/tts').length;
    deferred.resolve({ ok: true, blob: async () => ({}) });
    await flush();
    assert.equal(h.audioInstances.length, 0, '旧代 fetch 返回后不得创建音频');
    socket.message({ type: 'replay_end', data: { gameId: 'old' } });
    h.evaluate('currentGameId = "g2"; gameStarted = true');
    h.context.fetch = (url, options) => { h.fetchCalls.push({ url, options }); return Promise.resolve({ ok: true, blob: async () => ({}) }); };
    socket.message({ type: 'player_speak', data: { gameId: 'g2', playerName: 'A', title: '', publicSpeech: '实时' }, sequence: 1 });
    await flush();
    assert.ok(h.fetchCalls.filter((call) => call.url === '/api/tts').length > ttsCallsDuringReplay);
  });

  await check('wrong-seat 不污染 pending；拒绝保留、接受清理；提交携带权威标识', async () => {
    const h = makeHarness(); const socket = h.sockets[0]; socket.open();
    socket.message(authenticated({ state: state('g1', true), seatId: 'p1' }));
    socket.message({ type: 'human_input_required', data: { gameId: 'g1', requestId: 'bad', playerId: 'p2', prompt: '错', options: {} }, sequence: 1 });
    assert.equal(h.evaluate('pendingHumanRequest'), null);
    socket.message({ type: 'human_input_required', data: { gameId: 'g1', requestId: 'good', playerId: 'p1', prompt: '对', options: { targets: ['p1'] } }, sequence: 2 });
    h.evaluate('submitHumanChoice("p1")');
    assert.deepEqual(socket.sent.at(-1).data.gameId, 'g1');
    assert.deepEqual(socket.sent.at(-1).data.requestId, 'good');
    socket.message({ type: 'human_input_result', data: { accepted: false, reason: 'stale_request' } });
    assert.equal(h.evaluate('pendingHumanRequest.requestId'), 'good');
    socket.message({ type: 'human_input_result', data: { accepted: true } });
    assert.equal(h.evaluate('pendingHumanRequest'), null);
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
}

main();
