/**
 * PhaseMachine - 阶段状态机（纯逻辑，无副作用）
 *
 * 把原先内联在 GameEngine.gameLoop 里的阶段推进逻辑（首夜竞选先于死讯、自爆跳过白天、
 * 胜负判定后收尾、maxRounds 兜底）显式化为一张转移表。这里**只**回答"当前阶段 + 本阶段
 * 产出的信号 → 下一阶段是谁"，不碰任何游戏状态、不发事件、不 await——所有副作用留在
 * GameEngine 的各 runPhase handler 里。这样转移行为可以被确定性单测逐条钉死。
 */

/** 阶段节点。注意 DAWN 是一个"大阶段"：其 handler 内部按 round 分首夜/后续，并涵盖
 *  竞选、死讯公布、猎人链、警徽传承、胜负检查——但对状态机而言它就是单个节点。 */
export enum PhaseNode {
  START = 'start',
  NIGHT = 'night',
  DAWN = 'dawn',
  DAY = 'day',
  VOTE = 'vote',
  END = 'end',
}

/**
 * 阶段 handler 执行后回传的信号，驱动状态机决定下一步。
 * - exploded：首夜警长竞选中狼人自爆。自爆后死讯已公布、猎人/传承已结算，
 *   但要跳过白天辩论与投票，直接进入下一轮黑夜。
 * - gameEnded：本阶段内 checkGameEnd 或 maxRounds 兜底已判定游戏结束
 *   （announceWinner 已由 handler 发出），状态机应转入 END 收尾。
 */
export interface TransitionSignal {
  exploded?: boolean;
  gameEnded?: boolean;
}

/**
 * 纯转移函数：给定当前阶段与本阶段产出的信号，返回下一阶段。
 *
 * 转移表：
 * - gameEnded 为真     → END（优先级最高，覆盖一切正常转移）
 * - START             → NIGHT
 * - NIGHT             → DAWN
 * - DAWN              → exploded ? NIGHT : DAY（自爆跳过白天/投票）
 * - DAY               → VOTE
 * - VOTE              → NIGHT（进入下一轮）
 * - END               → END（幂等吸收态）
 */
export function nextPhase(current: PhaseNode, signal: TransitionSignal = {}): PhaseNode {
  // 结束信号优先：任意阶段一旦判定结束，立即转 END。
  if (signal.gameEnded) return PhaseNode.END;

  switch (current) {
    case PhaseNode.START:
      return PhaseNode.NIGHT;
    case PhaseNode.NIGHT:
      return PhaseNode.DAWN;
    case PhaseNode.DAWN:
      // 首夜自爆：警徽流失、跳过白天辩论与投票，直接进入下一轮黑夜。
      return signal.exploded ? PhaseNode.NIGHT : PhaseNode.DAY;
    case PhaseNode.DAY:
      return PhaseNode.VOTE;
    case PhaseNode.VOTE:
      return PhaseNode.NIGHT;
    case PhaseNode.END:
      // 吸收态：进入 END 后不再转移。
      return PhaseNode.END;
    default: {
      // 穷尽性检查：新增枚举值若未处理，编译期即报错。
      const _exhaustive: never = current;
      return _exhaustive;
    }
  }
}
