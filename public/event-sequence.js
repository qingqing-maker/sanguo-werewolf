(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EventSequence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // WebSocket 协议控制消息不属于 GameUIEvent，不占用也不检查业务 sequence。
  const TRANSPORT_TYPES = new Set([
    'authenticated', 'session_updated', 'room_state', 'room_create_result', 'connected', 'replay_start', 'replay_end',
    'human_input_result', 'error', 'pong', 'settings', 'settings_updated',
  ]);

  function isValidSequence(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function createEventSequenceGuard() {
    const cursors = new Map();

    return {
      shouldProcess(message) {
        if (!message || typeof message !== 'object' || TRANSPORT_TYPES.has(message.type)) return true;
        if (message.sequence === undefined) return true; // legacy 可播放，但无法可靠去重
        if (!isValidSequence(message.sequence)) return false;

        const gameId = message.data && message.data.gameId;
        // 启动前的进程级 LLM 熔断告警可能没有 gameId，仍需展示；局内告警照常去重。
        if (message.type === 'llm_alert' && (typeof gameId !== 'string' || gameId.length === 0)) return true;
        if (typeof gameId !== 'string' || gameId.length === 0) return false;
        const previous = cursors.get(gameId) || 0;
        if (message.sequence <= previous) return false;
        cursors.set(gameId, message.sequence);
        return true;
      },

      seed(gameId, sequence) {
        if (typeof gameId !== 'string' || gameId.length === 0 || !isValidSequence(sequence)) return false;
        const previous = cursors.get(gameId) || 0;
        if (sequence > previous) cursors.set(gameId, sequence);
        return true;
      },

      resetGame(gameId) {
        if (typeof gameId === 'string' && gameId.length > 0) cursors.delete(gameId);
      },

      getCursor(gameId) {
        return cursors.get(gameId) || 0;
      },
    };
  }

  return { createEventSequenceGuard, isValidSequence };
});
