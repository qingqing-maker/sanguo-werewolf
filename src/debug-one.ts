import * as dotenv from 'dotenv';
dotenv.config();
process.env.FAST_MODE = '1';
process.env.LLM_PROVIDER = 'mock';

import { GameEngine } from './game/GameEngine';
import { RoleRegistry } from './roles/RoleRegistry';
import { MockProvider } from './llm/MockProvider';
import { EventBus } from './game/EventBus';

const eventBus = new EventBus();

// Patch MockProvider to log key decisions
const orig = MockProvider.prototype.chatJSON;
let logCount = 0;
(MockProvider.prototype as any).chatJSON = async function(sys: string, msgs: any[], schema: string) {
  const res = await orig.call(this, sys, msgs, schema);
  const last = msgs[msgs.length-1]?.content || '';
  if (/投票环节/.test(last) && logCount < 30) {
    logCount++;
    const selfName = (sys.match(/你是"(.+?)"/)||[])[1];
    const isWolf = /阵营为【🔴 狼人】/.test(sys);
    const memHasWolfMark = /【[^【】=]+=狼】/.test(msgs.map((m:any)=>m.content).join('\n'));
    console.error(`VOTE by ${selfName}(${isWolf?'狼':'好'}) -> ${(res as any).targetId} | memHasWolfMark=${memHasWolfMark}`);
  }
  return res;
};

eventBus.on('game_end', (ev) => {
  console.error(`\n=== GAME END: winner=${ev.data.winner} reason=${ev.data.reason}`);
});

async function main() {
  const config = RoleRegistry.getDefaultConfig();
  config.enableInnerThoughts = false;
  eventBus.clear();
  eventBus.on('game_end', (ev) => {
    console.error(`=== END winner=${ev.data.winner} reason=${ev.data.reason}`);
  });
  const engine = new GameEngine(config, new MockProvider());
  // suppress normal logs
  const ol = console.log; console.log = () => {};
  await engine.start();
  console.log = ol;
}
main();
