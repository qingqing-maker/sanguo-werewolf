# ⚔️ 三国狼人杀

> 一个由大语言模型驱动的多智能体三国狼人杀。12 个三国人物各自拥有独立人设、阵营策略、记忆和技能决策；支持全 AI 观战，也支持人类选择人物加入。项目重点不是简单调用 LLM，而是把 LLM 放进一个可校验、可回放、可限额的游戏状态机中。

![版本](https://img.shields.io/badge/version-2.0.0-blue)
![LLM](https://img.shields.io/badge/LLM-Volcengine%20%7C%20OpenAI%20compatible%20%7C%20Gemini-green)
![TTS](https://img.shields.io/badge/TTS-Volcengine%20%7C%20Edge-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)

## 项目特点

- **多 Agent 对局**：12 个座位各自维护人物人设、阵营信息、查验记录、关键事实和自我立场档案。
- **完整 12 人规则**：4 狼、1 预言家、1 女巫、1 猎人、1 守卫、4 民；包含首夜黑水、警长竞选、自爆、退水、PK、警徽传承、奶穿和猎人链。
- **人类参战**：可以选择一个三国人物接管座位，其他座位继续由 AI 决策。
- **三档 AI 思考强度**：`novice` 轻量、`standard` 标准、`expert` 深度。通过策略 prompt、记忆窗口、关键事实和规则内失误率形成可测梯度；双方 AI 会同时增强，因此不承诺某阵营胜率单调。
- **实时 Web UI**：WebSocket 推送阶段、发言、内心、夜间行动、投票、死亡和终局事件。
- **TTS 播报**：火山 TTS 或 Edge TTS 按人物音色串行播报公开发言；同一主持人多标签页时只有唯一展示端播放和回执。
- **预算保护**：token 上限 + 调用次数上限、跨进程 JSONL 账本、reserve/settle、文件锁和熔断器，防止意外超支。
- **信息隔离**：观战视角可以看到全局；人类参战视角由 WebServer 对身份、狼队友、内心和私密查验事件做遮罩。
- **玩家文本边界**：公开发言和遗言进入其他 Agent 记忆前，会中和全角/半角控制标签及伪造的聊天角色标签，并始终作为 `user` role 下的不可信引用；这不会被夸大为能阻止所有自然语言 Prompt injection。
- **事件恢复**：活动局重连恢复安全公共时间线、当前权威状态和座位私密快照；无活动局时可回放最近公共日志。两者都不会恢复进程重启后丢失的 Agent 内部状态。

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装

```bash
cd sanguo-werewolf
npm install
```

### 配置 LLM

在项目根目录创建 `.env`。以下只是配置格式示例，不代表当前本地账本的真实额度：

```env
# Provider: openai / siliconflow / deepseek / volcengine / gemini / anthropic / mock
LLM_PROVIDER=volcengine
LLM_API_KEY=your-api-key-here
LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
LLM_MODEL_ID=your-endpoint-or-model-id
# 接口风格：chat_completions（默认）/ responses
# 示例：Doubao-Seed-1.8 使用方舟 /api/v3/responses
LLM_API_STYLE=responses

# 本地硬上限，必须与对应 JSONL 账本第一行 header 完全一致
LLM_TOKEN_BUDGET=400000
LLM_CALL_BUDGET=300

# 单次 Provider 请求超时；瞬时错误最多重试 4 次（可配置 0-10），采用指数退避
LLM_TIMEOUT_MS=60000
LLM_MAX_RETRIES=4

# 可选：显式指定账本和周期；不指定时按模型标识派生
# LLM_BUDGET_LEDGER_PATH=E:/project-qing/sanguo-werewolf/runs/llm-budget-fixed.jsonl
# LLM_BUDGET_PERIOD=fixed-period

# 可选：节奏控制
# FAST_MODE=1
# PACING_SCALE=0.5

# 可选：云端持久磁盘根目录；预算账本与事件日志会放到该目录下
# DATA_DIR=/var/data
# EVENT_LOG_DIR=/var/data/game-logs

# 可选 TTS
TTS_PROVIDER=edge
TTS_APP_ID=your-tts-app-id
TTS_ACCESS_TOKEN=your-tts-access-token
TTS_CLUSTER=volcano_tts

# 火山 TTS 必须显式启用独立预算并配置 JSONL 账本、period、字符与调用上限
# TTS_BUDGET_ENABLED=1
# TTS_BUDGET_LEDGER_PATH=<absolute-path-to-tts-ledger.jsonl>
# TTS_BUDGET_PERIOD=<budget-period>
# TTS_CHARACTER_BUDGET=<positive-integer>
# TTS_CALL_BUDGET=<positive-integer>

PORT=3000
```

**预算配置注意事项**：

1. `LLM_TOKEN_BUDGET`、`LLM_CALL_BUDGET` 不能只改 `.env`；当前账本 header 中的 `tokenBudget`、`callBudget` 也必须同步，否则程序 fail-closed 拒绝启动。
2. 账本按模型/period 隔离，旧账本不要覆盖；切换额度池应创建新 period 并保留旧 JSONL。
3. 预调用先写 `reserve`，调用结束写 `settle`；如果 Provider 没有返回 usage，系统按预留上限结算，宁可保守也不隐瞒成本。
4. 账本跨进程加锁，遇到损坏、截断、悬挂 reservation 或配置不一致时不会自动修复。
5. `mock` 适合离线开发和规则测试；真实 Provider 失败是否允许 Mock fallback 必须在实验报告中区分，不能把 Mock 结果当真实模型统计。

`LLM_TIMEOUT_MS` 只限制**单次 Provider 请求**；瞬时错误会在 `LLM_MAX_RETRIES`（默认 `4`、上限 `10`）范围内按指数退避重试。cancel/restart 会通过 `AbortSignal` 中止本地请求等待与 retry sleep，使旧局尽快退出；取消属于正常控制流，不触发 Mock fallback、熔断或决策降级。这里保证的是本地停止等待和后续重试，不代表 Provider 服务端一定停止已经开始的推理。

`LLM_API_STYLE` 默认是 `chat_completions`，调用 `${LLM_BASE_URL}/chat/completions`。当模型控制台示例要求使用 `${LLM_BASE_URL}/responses` 时，将其设为 `responses`；Provider 会把 system prompt 和历史消息转换为 Responses API 的 `input_text` 消息，并从 `output_text` 中提取回复。

### 启动

```bash
# Web 模式，推荐
npm run web

# 控制台模式
npm run dev
```

打开 <http://localhost:3000>。

首次访问欢迎页时：

- 当前没有房间时，任意访客可以点击**创建房间**；创建者自动成为该房间主持人。
- 单实例同时只允许一个房间，其他访客进入后只能观战。
- 主持人可以选择**开始观战（全 AI）**：12 个座位全部由 AI 决策。
- 主持人也可以选择**加入游戏**：选择一个人物作为人类座位，其余座位由 AI 决策。
- **AI 思考强度**：轻量、标准、深度，观战和参战均生效；重开沿用当前档位。档位表示可用记忆和策略材料，不代表某阵营必胜。

人类输入通过 WebSocket 的 `human_input` 返回；暂停、继续、重开、语音开关和终局回放均由前端控制。

WebSocket 使用连接级随机 256-bit token。服务端仅保存 session token 摘要；同 token 可跨标签页或断线重连到同一进程内 session，并恢复当前 pending input。没有房间时，首个主动发送 `create_room` 的会话创建房间并自动成为主持人，而不是“首个打开网页的人”自动获得权限。单实例只允许一个房间；控制命令和设置接口仅房间创建者可用，匿名 HTTP 状态始终是受限观众投影。开局/重开默认有 10 秒会话级冷却，暂停/继续/取消默认 1 秒；主持人全部连接离线后，空闲房间默认 90 秒自动释放，活动局则等结束后释放。`human_input` 必须匹配服务端座位、gameId 和 requestId。会话仅在当前进程内有效，不提供账号、多房间或跨重启续局。

### TTS 安全边界

- `/api/tts/status` 要求有效 session Bearer token；`/api/tts` 合成进一步要求主持人会话。浏览器使用 WebSocket 认证所用的同一 token。
- 服务端在主持人的多个 WebSocket 连接中选出唯一 TTS 展示端，并为它签发随租约轮换的短期展示凭证；只有该连接能调用合成、播放并发送 `speech_presented`。展示端断线时，同会话其他在线标签页自动接管并换发凭证。
- 默认每段最多 1024 个 Unicode 字符；60 秒滑窗同时限制每 session（30 次/8,000 字符）和每 IP（100 次/30,000 字符）。这些值可通过对应 `TTS_*` 环境变量调整。
- 默认全局并发为 2、等待队列为 8、Provider timeout 为 15 秒；队列满或限流返回 `429`，超时会 abort Provider 调用并返回 `503`。
- 火山 `volc` 属付费 Provider，必须显式设置 `TTS_BUDGET_ENABLED=1`，并提供独立 JSONL 账本、period、字符预算和调用预算；配置缺失时 fail-closed。调用前 reserve，成功或失败均按本次字符数保守 settle。Edge 可不启用该付费预算账本。
- 文档只展示变量名和占位符；不要提交真实 session token、LLM Key 或 TTS 凭据。

## GitHub 与单实例云端部署

仓库提供：

- `.gitignore` / `.dockerignore`：排除 `.env`、预算账本、对局日志、生成媒体和本地 Agent 配置。
- `Dockerfile`：Node 22 多阶段构建，生产容器以非 root 用户运行。
- `render.yaml`：Render 免费单实例 Blueprint，使用临时 `/var/data` 并通过 `/healthz` 健康检查。
- `.github/workflows/ci.yml`：构建、离线测试和高危依赖审计。
- `SECURITY.md` / `DEPLOYMENT.md`：Secret 边界、部署步骤和回滚原则。

当前版本必须保持一个实例，因为房间、主持权、Agent 状态和暂停点都在进程内存中。免费实例没有持久磁盘；预算账本与公共事件日志暂存在容器内，重启或重新部署后可能丢失，也不能让活动对局跨重启续局。详细步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 规则概览

标准配置如下：

| 阵营 | 角色 | 数量 |
|---|---|---:|
| 狼人 | 细作 | 4 |
| 神职 | 军师/预言家 | 1 |
| 神职 | 神医/女巫 | 1 |
| 神职 | 猛将/猎人 | 1 |
| 神职 | 禁卫/守卫 | 1 |
| 平民 | 普通村民 | 4 |

流程简图：

```text
首夜：夜行动 → 暂存死讯 → 警长竞选 → 公布死讯 → 特殊结算
后续：夜行动 → 天亮结算 → 白天发言 → 警长归票 → 投票/PK
      → 猎人/遗言/警徽 → 胜负检查 → 下一轮
```

详细规则以 [RULES.md](./RULES.md) 为准。

## 系统架构

```text
浏览器 index.html / app.js
        │ WebSocket
        ▼
WebServer ── GameController ── GameEngine
                                      │
                 ┌────────────────────┼───────────────────┐
                 ▼                    ▼                   ▼
          PhaseManager          VoteManager          AgentFactory
                 │                    │                   ▼
                 └────────────── BaseAgent × 12 ───── LLMProvider
                                      │
                           EventBus → EventLog → WS/TTS
```

### 关键模块

- `src/index.ts`：加载环境、启动 Web/console、启动前做 Provider 和预算校验。
- `src/server/WebServer.ts`：Express、WebSocket、HTTP 控制接口、事件遮罩、回放和 TTS 接口。
- `src/server/GameController.ts`：合并配置、创建 Provider 和 GameEngine、管理当前 gameId。
- `src/game/GameEngine.ts`：主循环、暂停/取消、人类输入等待、猎人链、警徽传承、胜负判定。
- `src/game/PhaseManager.ts`：夜行动、天亮、首夜警长竞选、白天发言和遗言。
- `src/game/VoteManager.ts`：普通投票、警长票权、PK 复投、放逐。
- `src/agents/BaseAgent.ts`：system prompt、发言、投票、技能、记忆、关键事实和 JSON 解析。
- `src/llm/ProviderFactory.ts`：Provider 选择与配置校验。
- `src/llm/BudgetLedger.ts`：跨进程预算账本。
- `src/llm/LLMCircuitBreaker.ts`：进程级预算/计费/认证熔断。
- `src/server/EventLog.ts`：按 gameId 保存最近的公共 UI 事件；校验严格递增 `sequence`，在活动局用于完整公共时间线恢复，无活动局时用于历史回放。
- `src/game/EventBus.ts`：可实例化、可注入的事件总线；每个实例拥有独立异步 gameId 上下文和可退订监听，WebServer 默认持有自己的实例。兼容代码仍保留 `globalEventBus`，因此这不等于已经支持多房间并发。
- `src/sim_pool.ts`、`src/sim_worker.ts`、`src/sim_report.ts`：批量模拟、单局 worker 和统计报告。

### 事件顺序、重连与重开

- 业务事件携带 `gameId`、协议版本和对局内严格递增的 `sequence`。前端在任何 UI、状态或 TTS 副作用前按 `gameId + sequence` 拒绝重复、倒序和非法序号；EventLog 对新格式日志也拒绝非法/非递增序号。旧日志缺少 sequence 时只能在加载回放时补内存序号，不能提供可靠的实时去重保证。
- 活动对局重连依赖 `authenticated` 权威握手快照：恢复当前受限状态、人类座位私密快照、pending input，以及 EventLog 中已发生的安全公共时间线（阶段、发言、死讯、竞选、投票、放逐、猎人、暂停/继续和降级提示）。历史恢复静音且不覆盖握手中的当前权威状态；若服务端仍在等待某条发言播放，只由当前唯一展示端重新朗读该条。旧 `connected` transport 仅兼容显示消息，不再驱动状态。
- 仅当服务器没有活动对局时，认证后才可能发送最近公共日志的 `replay_start → events → replay_end`。回放用于重建观众 UI，不恢复 Agent、随机状态、调用栈或 session，也不能跨进程重启续局；即使历史日志中途截断、没有 `game_end`，`replay_end` 也会明确退出活动局并允许主持人开新局。
- `start_game` 在已有启动、运行或重开操作时明确返回 `busy`，不会隐式取消旧局。`restart_game` 会先同步占位、取消旧引擎并等待其真实退出，再创建新一代引擎；过快重复控制先返回 `rate_limited`。当前页面“再来一局”按钮采用 cancel 后回欢迎页的产品语义，不会偷偷立即发送 `restart_game`。

## 开发与验证

```bash
# TypeScript 构建
npm run build

# 只做类型检查
npx tsc --noEmit

# 前端 JavaScript 语法检查
node --check public/app.js

# 全部离线测试（不发起任何网络请求、不消耗 token）
npm test

# 也可单独跑
npm run test:budget       # LLM BudgetLedger 跨进程并发/锁/崩溃恢复/重复 settle
npm run test:phase-machine # PhaseMachine 纯转移表
npm run test:phase-seq     # 整局阶段事件序列
npm run test:sim-report    # JSONL 解析、指标口径、首刀多维聚合和预算差值 fixture
npm run test:mock-provider # Mock 夜间/投票 schema 分流，防止 reasoning 被误判为 reason
npm run test:sim-pool      # 模拟池参数、Mock/真实预算分支、meta/summary 编排
npm run test:frontend      # 真实 app.js 重连/回放/TTS/pending input 与 sequence
npm run test:events       # EventBus 实例隔离、EventLog sequence、事件可见性
npm run test:security     # session/房间创建权、协议、人类输入、controller、WebServer 集成
npm run test:controller   # start/restart busy、取消等待与代次语义
npm run test:tts          # TTS 限流、并发、timeout 与字符/调用预算
npm run test:tts-config   # TTS 配置 fail-closed 与预算巡检
node public/event-sequence.test.js      # 前端 gameId+sequence 去重与 replay cursor
npm run test:json         # LLM JSON 输出修复
npm run test:player-content # 玩家发言/遗言控制标签清洗与 Prompt 接线
npm run test:rules        # 确定性规则结算与首夜黑水完整事件时序

# 预算只读巡检（不会创建账本）
npm run budget:status -- --all
npm run budget:status -- --file=runs/llm-budget-model.jsonl --json
npm run tts:budget:status
```

全部测试均为离线测试，不会调用真实 LLM/TTS Provider，也不消耗云端额度。规则测试直接构造 `GameState` 驱动结算与真实 `runDawn()` 编排，覆盖同守同救、连守失效、毒药另计、首夜黑水竞选先于死讯、待死警长传徽、中毒狼人警上自爆、平票 PK、猎人毒杀禁枪和猎人链等分支；`PhaseMachine` 与整局阶段序列另有独立测试；玩家文本测试覆盖公开发言与遗言的控制标签中和及最终 Prompt 接线；模拟报告 fixture 覆盖旧 schema、损坏行、严格干净样本、首刀分布、调用分母和预算差值；事件、安全与 TTS 测试覆盖上述 transport 和资源边界。

### 批量模拟与配置指纹

```bash
# Mock 批量（不花钱），指定难度、随机种子和完整输出文件路径
# --out 的父目录不存在时会在配置校验成功后自动创建
npx ts-node --transpile-only src/sim_pool.ts --games=50 --concurrency=8 --difficulty=novice --seed=42 --out=runs/mock-novice.jsonl

# 从 JSONL 重算报告；传多个文件会自动对比配置指纹差异
npx ts-node --transpile-only src/sim_report.ts runs/a.jsonl runs/b.jsonl
```

每份 JSONL 的 `meta` 行会记录**配置指纹**：prompt 版本（`BaseAgent.ts` 内容哈希）、模型 slug、AI 思考强度、该档解析后的实际失误注入率、节奏设置、运行环境、随机种子。多文件对比时会列出所有差异字段——只有当差异**正好是**你想验证的那一项时，胜率对比才有意义。指纹中不含 API Key。

新版 result 还记录首夜最终狼刀目标、逻辑 `chat/chatJSON` 请求数、最终错误分类，以及 fallback/degrade 的原因和 operation。首刀报告分别按人物、角色、阵营和座位聚合，不能把不同对局中的同一个 `player_N` 当成同一个人物或角色。这里的“逻辑请求”不包含 Provider 内部 retry/JSON 纠正产生的 HTTP attempt；`provider_fallback` 统计的是切换 Mock 的 attempt，不等同于备用 Provider 成功。`effectiveProvider=real` 只表示本局未切 Mock，严格干净 real 还要求没有决策降级和最终请求失败。旧 JSONL 缺少这些字段时报告显示“未记录”，不会误报 0%。

真实 Provider 批次在 `meta` 记录脱敏后的账本文件名、period 和 baseline，并在 `batch_summary` 记录 end/delta；Mock 明确标为不适用。预算 delta 是共享本地 BudgetLedger 的前后差值，不是云厂商账单；若另一个进程同时使用同一账本，差值也会包含其调用。

`sim_pool.ts` 的参数解析、Mock/真实账本分支和 meta/summary 生命周期位于可测试的 `simPoolCore.ts`。导入 CLI 不会解析当前测试进程参数、创建 `runs/` 或启动 worker；Mock 分支也不会读取真实 BudgetLedger。`--out` 表示完整 JSONL 文件路径，支持嵌套父目录。

`--seed` 只让**本地**随机量可复现（角色分配、失误注入、兜底选择）。LLM 侧有自己的随机性，真实局无法逐字复现；Mock 局可完全复现。

#### 固定 seed Mock 工程基线（2026-08-18）

统一使用 `seed=20260817`、默认 12 人配置、每档 100 局、`concurrency=8`，三批配置指纹除 `aiDifficulty` 外完全一致：

| 难度 | 好人胜率（Wilson 95% CI） | 狼人胜率 | 好人逐票读狼命中率（Wilson 95% CI） | 平均回合 | worker 错误 |
|---|---:|---:|---:|---:|---:|
| `novice` | 48.00%（38.46%–57.68%） | 52.00% | 56.29%（54.47%–58.09%） | 4.39 | 0 |
| `standard` | 36.00%（27.27%–45.76%） | 64.00% | 56.61%（54.70%–58.50%） | 4.48 | 0 |
| `expert` | 51.00%（41.35%–60.58%） | 49.00% | 62.50%（60.59%–64.36%） | 4.39 | 0 |

产物：

- `runs/baseline-mock-novice-seed-20260817.jsonl`
- `runs/baseline-mock-standard-seed-20260817.jsonl`
- `runs/baseline-mock-expert-seed-20260817.jsonl`
- `runs/baseline-mock-seed-20260817-report.txt`

三批均有 `batch_summary.completed=true`、`budget.applicability=not_applicable`，逻辑请求失败、fallback 和决策降级均为 0。首夜人物分布中诸葛亮为 8%，座位分布为 4%–13%，匿名化已消除原先的人物名气/固定座位集中；首刀角色分布仍受“每局 4 民、各神职 1 人”的候选基数影响，不能直接按原始百分比比较角色风险。

该结果是 2026-08-18 旧参数下的 `MockProvider` 工程基线，不是人类胜率，也不是任何真实 LLM 的能力结论。2026-08-21 起产品名称改为“思考强度”，并用纯配置测试锁定记忆/事实/策略深度单调递增、预言家重复验人和守卫无效连守率单调递减。阵营胜率仅作观察指标，不再用它证明档位强弱。

#### 零 Token 多随机种子校准（2026-08-21）

统一使用 `seed=2026082100` 起连续 50 个种子、每档 50 局、`concurrency=8`、Mock Provider。三档均为 0 worker 错误、0 fallback、0 决策降级，配置指纹明确标记 `mock-无真实模型` 和 `budget.not_applicable`：

| 思考强度 | 预言家重复验 / 守卫无效连守 | 好人胜率 | 好人逐票读狼命中率 | 平均回合 |
|---|---:|---:|---:|---:|
| 轻量（`novice`） | 20% / 20% | 38.00% | 54.31% | 4.24 |
| 标准（`standard`） | 10% / 10% | 54.00% | 55.97% | 4.62 |
| 深度（`expert`） | 2% / 2% | 54.00% | 62.44% | 4.36 |

这批结果验证了参数与读狼指标的方向，但标准和深度的阵营胜率相同，再次说明双方 AI 同时增强时，胜率不适合作为“难度必须单调”的产品承诺。校准产物保存在本地忽略目录 `runs/`，不会上传 GitHub。

Mock 批量不会调用网络或消耗真实 Provider Token；只有显式传入真实 Provider 模式才会消耗预算。执行真实模拟前必须确认 Provider、period、账本和云端余额。

## 项目边界

- 服务器重启会丢失后端内存中的 Agent、memory、暂停点和决策上下文；事件回放仅恢复观众 UI。
- LLM 输出不是可信程序数据，所有 ID、目标、JSON 和阶段操作都必须经过校验与兜底。
- AI 思考强度目前是一局一个全局档位，不支持每个座位单独配置。
- `novice/standard/expert` 的协议值保持兼容；名称是轻量/标准/深度。零 Token 校准验证参数梯度，阵营胜率不作为单调承诺，也不要求用昂贵真实模型批量校准。
- 当前代码已具备 GitHub + Render 单实例部署清单；实际线上可用性仍取决于云端 Secret、持久磁盘、模型开通状态和账户余额。

## 文档

- [RULES.md](./RULES.md)：当前代码实现对应的完整游戏规则。
- [TODO.md](./TODO.md)：问题、修复记录、待验证事项和产品边界。

> **随机种子兼容性**：游戏随机现采用 RandomSource 子流架构（RNG schema v2）。旧版本相同 seed 的具体局面允许变化；同一新版 algorithm/schema/derivation 指纹下，相同 seed 保证稳定。
