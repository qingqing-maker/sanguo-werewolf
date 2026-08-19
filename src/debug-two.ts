import * as dotenv from 'dotenv';
dotenv.config();
process.env.FAST_MODE = '1';
process.env.LLM_PROVIDER = 'mock';

import { GameEngine } from './game/GameEngine';
import { RoleRegistry } from './roles/RoleRegistry';
import { MockProvider } from './llm/MockProvider';
import { EventBus } from './game/EventBus';

const eventBus = new EventBus();

const origChat = MockProvider.prototype.chat;
let n = 0;
(MockProvider.prototype as any).chat = async function(sys: string, msgs: any[]) {
  const res = await origChat.call(this, sys, msgs);
  const last = msgs[msgs.length-1]?.content || '';
  const selfName = (sys.match(/你是"(.+?)"/)||[])[1];
  const role = (sys.match(/身份为【(.+?)】/)||[])[1];
  if (/军师|预言家/.test(role) && n < 20) {
    n++;
    const hasHint = /确认的查验记录/.test(last);
    console.error(`CHAT ${selfName}[${role}] hintInMsg=${hasHint} => "${res.slice(0,60)}"`);
  }
  return res;
};

async function main() {
  const config = RoleRegistry.getDefaultConfig();
  config.enableInnerThoughts = false;
  eventBus.clear();
  eventBus.on('game_end', (ev) => console.error(`END winner=${ev.data.winner}`));
  const engine = new GameEngine(config, new MockProvider());
  const ol = console.log; console.log = () => {};
  await engine.start();
  console.log = ol;
}
main();
