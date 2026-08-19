import * as dotenv from 'dotenv';
dotenv.config();

import { GameEngine } from './game/GameEngine';
import { RoleRegistry } from './roles/RoleRegistry';
import { assertProviderConfiguration, createLLMProvider } from './llm/ProviderFactory';
import { WebServer } from './server/WebServer';

// 真实模式在服务/控制台启动前验证硬预算；配置缺失、账本损坏或遗留锁均拒绝启动。
assertProviderConfiguration();

/**
 * 三国狼人杀 - 入口文件
 * 支持两种模式：console（控制台）和 web（Web UI）
 */

async function runConsole() {
  console.log('正在初始化三国狼人杀（控制台模式）...\n');
  const config = RoleRegistry.getDefaultConfig();
  const llm = createLLMProvider();
  const engine = new GameEngine(config, llm);

  try {
    await engine.start();
  } catch (error) {
    console.error('游戏运行出错:', error);
  }
}

function runWeb() {
  console.log('正在启动三国狼人杀 Web 服务...\n');
  const server = new WebServer();
  server.start();
}

// 解析命令行参数
const args = process.argv.slice(2);
const modeArg = args.find(a => a.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : 'web';

if (mode === 'console') {
  runConsole().catch(console.error);
} else {
  runWeb();
}
