import { GameState, VoteRecord, RoleType } from '../types';
import { BaseAgent } from '../agents/BaseAgent';
import { GameEngine } from './GameEngine';
import { EventPublisher, globalEventBus } from './EventBus';
import { scalePacingMs } from './pacing';

/**
 * VoteManager - 投票与放逐管理
 * 严格过滤：只有存活玩家才能投票和被投票
 */
export class VoteManager {
  private agents: BaseAgent[];
  private state: GameState;
  private engine: GameEngine;

  constructor(
    agents: BaseAgent[],
    state: GameState,
    engine: GameEngine,
    private readonly eventBus: EventPublisher = globalEventBus,
  ) {
    this.agents = agents;
    this.state = state;
    this.engine = engine;
  }

  /**
   * 执行投票阶段
   * 返回被放逐的玩家 ID（如有）
   */
  async executeVote(): Promise<string | null> {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🗳️ 第 ${this.state.round} 轮 - 投票放逐`);
    console.log(`${'═'.repeat(50)}`);

    // 严格过滤：只有存活玩家才能参与投票
    const aliveAgents = this.agents.filter(a => a.player.isAlive);
    // 只能投存活的其他玩家
    const aliveCandidateIds = aliveAgents.map(a => a.player.id);

    // 首轮投票
    const firstResult = await this.runVoteRound(aliveAgents, aliveCandidateIds, false);
    if (firstResult.eliminatedId) {
      return this.processEliminated(firstResult.eliminatedId, firstResult.voteCount);
    }

    // 平票 → PK 复投一轮（只在平票玩家中投）
    if (firstResult.tiedIds && firstResult.tiedIds.length >= 2) {
      console.log(`\n  ⚖️ 平票（${firstResult.tiedIds.map(id => this.getPlayerName(id)).join('、')}）→ 进入 PK 复投`);
      this.eventBus.emit('vote_pk_start', { tiedIds: firstResult.tiedIds });
      const pkResult = await this.runVoteRound(aliveAgents, firstResult.tiedIds, true);
      if (pkResult.eliminatedId) {
        return this.processEliminated(pkResult.eliminatedId, pkResult.voteCount);
      }
      console.log(`\n  ⚖️ PK 仍平票，本轮无人被放逐。`);
      this.eventBus.emit('vote_tie', { message: 'PK 仍平票，本轮无人被放逐' });
      return null;
    }

    console.log(`\n  ⚖️ 平票！本轮无人被放逐。`);
    this.eventBus.emit('vote_tie', { message: '平票，本轮无人被放逐' });
    return null;
  }

  /**
   * 单轮投票：返回被放逐者 / 平票列表 / 票数
   */
  private async runVoteRound(
    aliveAgents: BaseAgent[],
    candidateIds: string[],
    isPK: boolean,
  ): Promise<{ eliminatedId?: string; voteCount?: number; tiedIds?: string[] }> {
    const votes: VoteRecord[] = [];
    const context = isPK
      ? `平票 PK 复投。候选人：${candidateIds.map(id => `${this.getPlayerName(id)}(${id})`).join('、')}。请从他们中选一个投票放逐。`
      : `经过白天辩论，现在投票放逐。存活玩家：${aliveAgents.map(a => `${a.player.name}(${a.player.id})`).join('、')}`;

    const ABSTAIN = 'abstain';

    for (const agent of aliveAgents) {
      // PK 阶段：如果自己就是被 PK 的候选人之一，不能自投，但仍可以投另一名候选人或弃票
      // 常规阶段：不能投自己
      const validTargets = candidateIds.filter(id => id !== agent.player.id);

      // 若候选池全部是自己（极端边界），跳过该玩家的投票
      if (validTargets.length === 0) {
        console.log(`  ⚠️ ${agent.player.name} 无可投目标，跳过。`);
        continue;
      }

      await this.engine.checkpoint();
      let voteResult: { targetId: string; reason: string };

      if (agent.isHumanPlayer) {
        const input = await this.engine.waitForHumanInput(
          agent.player.id,
          '请选择你要投票放逐的玩家（可选择弃票）',
          { targets: [...validTargets, ABSTAIN] }
        );
        voteResult = { targetId: input.targetId, reason: input.reason || '人类玩家选择' };
      } else {
        voteResult = await agent.vote(context, validTargets);
      }

      // 校验目标合法性：非合法值视为弃票，而非随机
      let finalTarget = voteResult.targetId;
      if (finalTarget !== ABSTAIN && !validTargets.includes(finalTarget)) {
        console.log(`  ⚠️ ${agent.player.name} 投票目标无效（${finalTarget}），记为弃票`);
        finalTarget = ABSTAIN;
      }

      const vote: VoteRecord = {
        voterId: agent.player.id,
        targetId: finalTarget,
        reason: voteResult.reason,
        round: this.state.round,
      };
      votes.push(vote);

      if (finalTarget === ABSTAIN) {
        console.log(`  📮 ${agent.player.name} → 弃票`);
      } else {
        console.log(`  📮 ${agent.player.name} → ${this.getPlayerName(finalTarget)}`);
      }
      console.log(`     └─ ${voteResult.reason}`);

      this.eventBus.emit('player_vote', {
        voterId: agent.player.id,
        voterName: agent.player.name,
        targetId: finalTarget,
        targetName: finalTarget === ABSTAIN ? '弃票' : this.getPlayerName(finalTarget),
        reason: voteResult.reason,
      });

      await this.delay(800); // 单张投票间隔，让读者看清
    }

    // 统计票数（弃票在 tallyVotes 内自动被忽略）
    const tally = this.tallyVotes(votes);
    console.log(`\n  📊 ${isPK ? 'PK ' : ''}投票结果：`);

    const tallyData: Record<string, number> = {};
    for (const [playerId, count] of tally.entries()) {
      const name = this.getPlayerName(playerId);
      console.log(`     ${name}: ${count} 票`);
      tallyData[name] = count;
    }

    this.eventBus.emit('vote_result', { tally: tallyData, isPK });

    // 把完整投票流向回灌给所有存活玩家（PK 复投除外——PK 只在平票者间投，票型信息量低且易误导）。
    // 投票流向是识别狼人最硬的信号：连续投好人、狼队抱团、为同伴分票洗白，单看发言看不出，必须有完整票型。
    if (!isPK) {
      const flowRecords = votes.map(v => ({
        voterName: this.getPlayerName(v.voterId),
        targetName: v.targetId === ABSTAIN ? '弃票' : this.getPlayerName(v.targetId),
      }));
      for (const a of this.agents.filter(ag => ag.player.isAlive)) {
        a.receiveVoteHistory(this.state.round, flowRecords);
      }
    }

    // 计算最高票玩家（可能唯一，也可能多个平票）
    const top = this.findTopVoted(tally);
    if (top.tiedIds.length === 1) {
      return { eliminatedId: top.tiedIds[0], voteCount: top.maxVotes };
    }
    return { tiedIds: top.tiedIds };
  }

  /**
   * 处理放逐结算：置死、遗言、事件与通知
   */
  private async processEliminated(eliminatedId: string, voteCount: number | undefined): Promise<string | null> {
    const eliminated = this.state.players.find(p => p.id === eliminatedId);
    if (!eliminated) return null;
    eliminated.isAlive = false;
    console.log(`\n  ⚔️ ${eliminated.name} 被投票放逐！`);

    const eliminatedAgent = this.agents.find(a => a.player.id === eliminatedId);
    let lastWords = '';
    // 猎人被投票放逐时，遗言由 GameEngine.handleHunterDeath 在「开枪之后」统一发表（标准规则：先开枪再遗言），
    // 这里跳过，避免出现两次遗言、且顺序颠倒。非猎人则正常在此发表放逐遗言。
    if (eliminatedAgent && eliminated.roleType !== RoleType.HUNTER) {
      lastWords = await this.engine.collectLastWords(eliminatedAgent, '白天被投票放逐');
      console.log(`  📜 遗言: ${lastWords}`);
    }

    this.eventBus.emit('player_eliminated', {
      playerId: eliminated.id,
      playerName: eliminated.name,
      title: eliminated.characterConfig.title,
      roleType: eliminated.roleType,
      faction: eliminated.faction,
      lastWords,
      voteCount: voteCount ?? 0,
    });

    for (const a of this.agents.filter(ag => ag.player.isAlive)) {
      // 放逐是已确认的客观事件，仍进入关键事实；遗言则单独作为待辨真伪的公开信息接收。
      a.receiveNotification(`${eliminated.name}被投票放逐了。`);
      if (lastWords) {
        a.receiveLastWords(eliminated.name, lastWords);
      }
    }
    return eliminatedId;
  }

  private tallyVotes(votes: VoteRecord[]): Map<string, number> {
    const tally = new Map<string, number>();
    for (const vote of votes) {
      // 弃票不计入
      if (vote.targetId === 'abstain') continue;
      // 再次确认目标存活
      const target = this.state.players.find(p => p.id === vote.targetId);
      if (target && target.isAlive) {
        // 警长票数为1.5票
        const weight = (vote.voterId === this.state.sheriffId) ? 1.5 : 1;
        tally.set(vote.targetId, (tally.get(vote.targetId) || 0) + weight);
      }
    }
    return tally;
  }

  /**
   * 找出最高票玩家；返回 { maxVotes, tiedIds }。tiedIds 长度==1 表示唯一最高票。
   */
  private findTopVoted(tally: Map<string, number>): { maxVotes: number; tiedIds: string[] } {
    if (tally.size === 0) return { maxVotes: 0, tiedIds: [] };
    let maxVotes = 0;
    let tiedIds: string[] = [];
    for (const [playerId, count] of tally.entries()) {
      if (count > maxVotes) {
        maxVotes = count;
        tiedIds = [playerId];
      } else if (count === maxVotes) {
        tiedIds.push(playerId);
      }
    }
    return { maxVotes, tiedIds };
  }

  private getPlayerName(id: string): string {
    const player = this.state.players.find(p => p.id === id);
    return player ? player.name : id;
  }

  private delay(ms: number): Promise<void> {
    const scaled = scalePacingMs(ms);
    if (scaled <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, scaled));
  }
}
