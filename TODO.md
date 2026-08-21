# 三国狼人杀 - 问题与修复追踪

记录开发、调试、实机验证中遇到的问题，以及当前仍需验证的工程事项。

> 状态说明：`[x]` 表示已完成修复或已有明确处理；`[ ]` 表示仍需测试、校准或设计决策。

## 一、已修复的游戏逻辑问题

- [x] **警长传承错误**：预言家查验出狼人后，死亡时不能把警徽传给已确认的狼人。修复为候选排除 + 二次硬编码兜底。
- [x] **投票言行不一**：LLM 有时返回中文名而不是 `player_x`，导致系统误判为非法目标并随机兜底。`BaseAgent` 现在支持按玩家姓名匹配合法 ID。
- [x] **预言家投票逻辑较弱**：预言家现在优先投票给自己确认的存活狼人。
- [x] **退水玩家错误获得警长票权**：退水后既不能再次当选，也不参加本轮警长投票。已补事件序列测试（见 5.1）。
- [x] **猎人开枪后遗言重复或顺序错误**：猎人统一在开枪后发表遗言，避免先遗言再开枪或重复遗言。
- [x] **遗言编造错误死因**：遗言 prompt 注入实际死因，区分夜杀、放逐、毒杀等情况。
- [x] **猎人链式开枪**：猎人枪杀另一名猎人时支持继续触发，但每次目标都必须是存活合法目标。
- [x] **同守同救结算错误**：守卫守护与女巫解药同时作用于同一目标时，目标照常死亡。
- [x] **首夜狼人集中击杀诸葛亮**：首夜无白天信息时，候选池匿名为“候选-A/B/C”，并要求随机选择，避免按人物名气、称号和历史先验选刀。
- [x] **人类玩家遗言被 AI 代笔**：三处发遗言的调用点（白天放逐、猎人开枪后、首夜被刀）统一走 `GameEngine.collectLastWords`，人类座位改由玩家自己输入遗言，可留空跳过（前端「保持沉默」按钮）；AI 座位仍走 `agent.lastWords()`。
- [x] **人类玩家是狼时看不到队友**：开局 `game_start` 仅在人类自己的狼座位附带 `wolfPartners` 名单（服务端遮罩层保留自身私有字段，不泄漏给其他视角），前端在角色列表与系统提示中显示狼队友。

## 二、已修复的记忆、Prompt 与解析问题

- [x] **白天判断被滚动记忆挤出**：增加独立 `keyFacts` 和 `selfDossier`，保存猎人开枪、验人、出局、警徽等关键事实及自身立场。
- [x] **投票盲目跟警长归票**：投票 prompt 加入回顾自身公开判断、独立判断和具体证据要求。
- [x] **夜间技能与白天信息脱节**：`speak`、`vote`、`nightAction`、女巫用药、是否上警/自爆、猎人开枪等决策统一接入分档后的关键事实块。
- [x] **公开发言跑进内心独白**：解析器兼容半角/全角括号、标签内空格；无标签时优先保留整段为公开发言，避免吞掉内容。
- [x] **转述他人跳预言家被记成本人自跳**：身份声明识别改为只接受第一人称自称，避免假事实在全场记忆中雪球式扩散。
- [x] **玩家自由文本中的控制标签造成 Prompt 注入旁路**：公开发言和遗言统一通过 `sanitizePlayerContent` 中和半角/全角/混合括号、标签空白以及 system/developer/assistant/user 等伪角色标签；文本仍保持 `user` role 的不可信引用，不宣称字符串清洗能阻止所有自然语言诱导。
- [x] **LLM 返回中文名、非法 ID 或不存在目标**：所有行动均经过合法目标校验；必要时按姓名匹配，最终才使用合法随机兜底，避免游戏卡死。
- [x] **AI 思考强度缺少可靠梯度**：协议值保留 `novice/standard/expert`，产品名改为轻量/标准/深度；策略、记忆、关键事实和规则内失误率形成可离线断言的单调梯度，不再用阵营胜率承诺“难度”。

## 三、已修复的 Provider、预算与运行稳定性问题

- [x] **SiliconFlow 403**：区分额度耗尽/Key 异常，避免把平台错误伪装成正常发言。
- [x] **火山方舟 404**：修正 endpoint 配置约定，明确使用规范接入点 ID（如 `ep-...`）而不是 API Key。
- [x] **真实 Provider 失败时产生 Mock 复读**：Provider 工厂按配置校验 real/mock，错误会分类记录并触发明确兜底和前端告警。
- [x] **超时被误判为沉默狼**：将网络超时写入本人关键事实，并生成说明性兜底发言/投票结果。
- [x] **预算耗尽后仍继续调用**：增加 token 与调用次数双上限、预调用预留、结算、进程熔断和跨进程 `BudgetLedger`。
- [x] **多个 Provider 各自维护熔断器**：抽出共享 `LLMCircuitBreaker` 单例，避免不同 Provider 分别计数导致实际超支。
- [x] **JSONL 预算账本并发写入冲突**：使用原子锁文件、追加式 `reserve/settle` 事件和 fail-closed 策略。
- [x] **预算账本配置漂移**：账本 header 固化 period、tokenBudget、callBudget；当前配置不一致时拒绝自动开启新周期，要求人工处理。
- [x] **LLM 单次超时、瞬时错误重试与取消语义**：`LLM_TIMEOUT_MS` 仅限制单次 Provider 请求；`LLM_MAX_RETRIES` 默认 4、上限 10，瞬时错误按指数退避重试。cancel/restart 通过 `AbortSignal` 中止本地请求等待和 retry sleep；取消属于控制流，不触发 fallback、熔断或降级，也不宣称 Provider 服务端一定停止已开始的推理。

## 四、已修复的前端、服务器与体验问题

- [x] **服务器重启后前端假装仍在游戏中**：前端识别“客户端有局、服务器无局”，提示用户重新开始。
- [x] **WebSocket 断线重连刷屏**：连接/断开日志去重，重连周期固定，避免无意义刷屏。
- [x] **服务器重启后白屏或卡死**：新增按 gameId 的 UI 事件 JSONL 日志，重连时可回放最近一局事件。
- [x] **误把回放当成实时游戏**：回放期间静音 TTS，标记历史事件，并明确“只恢复 UI，不恢复后端 AI 决策状态”。
- [x] **“再来一局”直接偷偷开新局**：终局和回放按钮先返回欢迎页，用户再次选择观战/参战后才发送 `start_game`。
- [x] **欢迎页节点被永久删除**：统一保留并复用 `welcomePanel`，集中处理开局、重开和返回首页。
- [x] **游戏速度过慢**：统一接入 `PACING_SCALE` 和 `FAST_MODE`，缩放 PhaseManager、GameEngine、VoteManager 的停顿。
- [x] **TTS 失败阻塞游戏**：后端 TTS 失败时前端降级浏览器 `speechSynthesis`；额度耗尽时显示不可误解的提示。

- [x] **主持权改为房间创建者自动获得**：首个打开页面的 session 不自动成为 host；没有房间时，主动创建唯一房间的会话自动成为主持人。服务端只保存 session token 摘要，同 token 可重连同一 session。
- [x] **TTS 接口缺少成本与滥用边界**：状态接口要求 session Bearer，合成接口进一步要求主持人 session；增加 Unicode 长度、session+IP 请求/字符滑窗、全局并发、有界队列、timeout/abort。火山 TTS 必须显式启用独立字符+调用预算账本，配置缺失 fail-closed。
- [x] **事件重复/倒序产生重复 UI 与漏音**：业务事件使用 gameId+sequence；前端在副作用前去重，EventLog 拒绝非法/重复/倒序 sequence。活动局重连只恢复当前快照、私密座位状态和 pending input，不宣称补齐断线窗口全部事件；无活动局才回放公共历史。
- [x] **EventBus 实例污染与监听生命周期**：EventBus 可实例化、可注入并返回幂等退订函数；WebServer 默认使用自己的实例并传给 controller/engine。兼容全局实例仍保留，当前仍非多房间架构。
- [x] **并发开局/重开竞态**：start 在启动、运行或重开中明确 busy；restart 同步占位，先 cancel 并等待旧引擎退出，再创建新代次，第二个并发 start/restart 稳定 busy。
- [x] **公网主持人离线后永久占房**：最后一个主持人连接断开后进入可配置宽限期；空闲房间到期释放，活动局等结束后释放，重连会取消释放计时。
- [x] **同一主持人多标签页 TTS 重叠**：服务端维护唯一展示端租约，只有该连接播放和回执；断线后同 token 其他标签页自动接管 pending 发言。
- [x] **活动局刷新只恢复发言、时间线残缺**：认证快照携带安全公共时间线，恢复阶段/死讯/竞选/投票/放逐/猎人/暂停与降级记录；历史静音，当前状态仍以握手快照为准。
- [x] **控制命令缺少公网冷却**：WebSocket 与 HTTP 的开局/重开共享冷却，暂停/继续/取消使用短冷却，重复请求返回 `rate_limited`。

## 五、当前仍需验证或优化的事项

### 5.1 游戏规则与状态机

- [x] 为同守同救、女巫毒杀猎人禁枪、猎人链式开枪、警徽传承补组合测试。
      → `src/game/rules.test.ts`（`npm run test:rules`，当前 80 条顶层用例）。覆盖天亮结算、胜负判定、
      投票/PK、猎人链、警徽传承、预言家私密查验、首夜黑水与中毒狼人警上自爆等关键分支。
      全程用 StubProvider，零网络请求、零 token。
- [x] 明确并测试最大回合数边界：`checkGameEnd` 在 `round >= maxRounds` 判狼人胜，已有用例钉死当前语义。
- [x] 为首夜黑水流程补完整事件序列测试：`runDawn()` 锁定计算死讯后待死者仍可上警、发言、投票和当选，`dawn_result` 恰好一次且严格晚于竞选；待死警长随后传徽。另覆盖“中毒狼人警上自爆”，并修复 `eliminatedTonight` 漏记已先自爆的夜间死者，使其与 `dawn_result.deaths` 保持一致。
- [x] 为退水资格、PK 复投、二次平票警徽流失补事件序列测试。
      → 退水、警长二次平票、白天 PK 打破平局与再次平票均已有确定性 StubProvider 用例。
- [x] 将阶段转移抽为 `PhaseMachine.nextPhase()` 纯函数，并由 `GameEngine.gameLoop()` 接线；
      `npm run test:phase-machine` 验证转移表，`npm run test:phase-seq` 锁定整局事件序列。

### 5.2 AI 思考强度与公平性

- [x] 用相同随机种子和相同 Mock Provider 分别跑 `novice/standard/expert`，统计好人胜率、狼人胜率、逐票命中率、平均回合数和错误率。
      → 2026-08-18 固定 `seed=20260817`、默认 12 人、每档 100 局、并发 8；三批配置指纹除 `aiDifficulty` 外一致。
      好人胜率依次为 48% / 36% / 51%，逐票读狼命中率为 56.29% / 56.61% / 62.50%，平均回合为 4.39 / 4.48 / 4.39，worker 错误均为 0。
      三份 JSONL 和合并报告见 `runs/baseline-mock-*-seed-20260817.jsonl` 与 `runs/baseline-mock-seed-20260817-report.txt`。
- [x] 模拟 worker 已记录首夜最终狼刀的结构化目标，报告分别按人物、角色、阵营和座位统计次数与占比；
      同时修复了两个会制造假偏置的问题：报告不能按跨局复用的 `playerId` 合并人物/角色；`MockProvider` 不能因 `reasoning` schema 或上下文含“投票”而把首夜行动误分到投票分支。
      修复后诸葛亮首刀为 8%，座位分布为 4%–13%，没有此前的固定人物/座位集中。
- [x] 完成当前 Mock 基线的难度校准证据采集：expert 的读狼命中率最高（62.50%），但好人胜率并不单调（48% / 36% / 51%）。
      结论是三档已具备可重复工程基线，但 `MockProvider` 同时调节好人和狼人能力，不能把单个 seed 的胜率直接解释成严格单调难度；后续需多 seed 或少量受预算保护的真实 Provider 样本验证，不基于这 100 局过拟合调参。
- [x] 给模拟结果记录模型、难度、prompt 版本、随机种子等，保证结果可追溯。
      → `src/simFingerprint.ts`。每份 `runs/*.jsonl` 的 meta 行现在带 `fingerprint`：
      prompt 哈希（BaseAgent.ts 内容）、模型 slug/provider/端点主机（不含 API Key）、AI 思考强度、
      说话风格开关、三项失误注入率、节奏设置、Node/平台、批次 seed。
      `sim_report.ts` 会打印指纹；传多个文件时用 `diffFingerprints` 列出配置差异，
      并提示"只有当差异正是你想验证的那一项时，胜率对比才有意义"。
      mock 批次的 llm 字段一律标 `mock`，不冒用 .env 里的真实模型名。
- [x] `sim_pool` 编排已抽到 `simPoolCore.ts`：Mock 不读取真实账本、真实配置校验后才建目录/写 meta、
      账本路径白名单脱敏、`batch_summary.completed` 与预算 delta 均有纯离线回归（`npm run test:sim-pool`）。
- [x] 模拟结果已记录逻辑 `chat/chatJSON` 请求数、最终错误分类、fallback attempt 与决策降级，
      并按 operation 聚合；该分母不包含 Provider 内部 HTTP retry attempt，预算差值也不是云厂商账单。
- [x] AI 规则内失误已按思考强度分档：预言家重复验人与守卫无效连守默认轻量 20%、标准 10%、深度 2%；显式环境变量仍可全局覆盖。`difficultyProfile.test.ts` 零网络验证记忆/事实/策略/失误率梯度。
- [x] 2026-08-21 完成零 Token 多随机种子 Mock 校准：每档 50 局、连续 seed、0 worker 错误/0 fallback/0 降级；读狼命中为 54.31% / 55.97% / 62.44%，但标准与深度好人胜率同为 54%，因此继续使用“思考强度”而非胜率型难度承诺。

### 5.3 LLM 与安全边界

- [x] 非法 JSON 兜底已提取为共享模块 `src/llm/jsonRepair.ts`，并有 34 条单测（`npm run test:json`）。此前最完整的修复逻辑只存在于 `AnthropicProvider` 内部，而实际在用的 doubao 走 `OpenAIProvider`，那里只有一句正则——最好的实现没跑在真实路径上。现三个 Provider 统一接入。
- [x] `OpenAIProvider.chatJSON` 对 `parse`/`empty` 失败重试一次（附纠正提示）；`timeout`/`billing`/`authentication`/`budget` 立即抛出，不浪费 token。
- [x] JSON 解析失败不再静默降级：`BaseAgent.handleDecisionDegraded()` 统一写 keyFact + 发 `ai_decision_degraded` 事件 + console，前端事件日志与首次 toast 可见。此前只有 timeout 留痕，parse 落进 else 分支，表现为“AI 突然变蠢”且无法归因。
- [x] 为 speech parser、seer claim 识别、中文名转 ID 增加纯函数单元测试。
      → 三块逻辑均已抽成无状态纯函数模块并各自单测：`speechParser.ts`（`test:speech`）、
      `seerClaim.ts`（`test:seer`，19 条）、`nameResolver.ts`（`test:nameid`，10 条）。
      `seerClaim.ts` 把原内联在 `BaseAgent` 的静态方法 `detectSelfSeerClaim` + 验人结论抽取
      提纯为 `detectSelfSeerClaim`/`extractSeerVerdicts`；`nameResolver.ts` 把 witchDecide/
      nightAction/vote/hunterShoot 四处重复的「中文名→ID」兜底统一为 `resolvePlayerIdByName`。
      重点覆盖：他人转述不误判为自跳（核心防误伤）、角色专属自称只对本人生效、
      含名短语（"我这票投张飞"）解析、命中但不在合法白名单时返回 undefined。
      三个脚本已挂进聚合 `test` 链。
- [ ] 统一 403、404、429、timeout、billing、budget 的用户提示和日志字段（JSON parse 部分已完成）。
- [x] fallback 策略可配置，模拟结果区分 `real/mixed/mock`；严格干净 real 还要求无决策降级、无最终逻辑请求失败。
      报告中的 `provider_fallback` 是切换尝试次数，不冒充备用 Provider 成功次数。
- [ ] 对跨 Provider 的 token usage 缺失、估算预留和 full settle 进行成本监控，避免估算偏差长期累积。
- [x] 增加 Prompt 注入回归样例：`npm run test:player-content` 覆盖全角/混合/空白标签、连续标签、伪造 system/developer/assistant/user 消息、Markdown/多行文本、清洗幂等、公开遗言旁路、原文去重，以及第一人称身份声明与第三方转述不误判。

### 5.4 预算与运维

- [x] `BudgetLedger` 已有 Windows 真实跨进程 reserve/settle 竞争、进程强杀后的悬挂 reservation、
      遗留锁 fail-closed/人工删锁恢复、截断 JSONL 和重复 settle 不二次计费测试（`npm run test:budget`）。
- [x] 遗留锁人工恢复流程：先确认没有活跃写进程，再删除对应 `.lock`；禁止程序自动删锁，避免双写。
- [x] `npm run budget:status` 输出 period、已结算/预留/剩余 token、调用数、锁状态和悬挂 reservation；
      支持 `--file`、`--all`、`--json`。TTS 独立使用 `npm run tts:budget:status`。
- [x] 预算或云端资源包切换时保留旧账本，创建新模型账本/period，不直接覆盖历史额度语义。
- [x] 模拟报告已写入配置指纹（模型 slug、provider、端点主机、难度、失误注入率、prompt 哈希、seed、节奏、Node/平台），见 `src/simFingerprint.ts`。mock 批次不记录 `.env` 里的真实模型名，避免把 MockProvider 的结果误认为是 doubao 跑出来的。
- [x] 真实模拟批次 meta 记录脱敏账本文件名、period 和 baseline，`batch_summary` 记录 end/delta；
      Mock 明确 `not_applicable`。这些是批次报告字段而非配置指纹字段，避免绝对路径泄漏。
      若有其他进程共享账本，delta 会包含外部调用，仍需人工确认归因。

### 5.5 前端、回放与语音

- [x] 事件 transport 已补集成与离线测试：`npm run test:events` 覆盖实例 EventBus、EventLog sequence 和可见性；`npm run test:security` 覆盖 session/房间创建权、协议、pending input、controller 与 WebServer；`node public/event-sequence.test.js` 覆盖前端 gameId+sequence 去重和 replay cursor。
- [x] TTS 服务边界已有独立离线测试：`npm run test:tts` 覆盖 Unicode 长度、session/IP 滑窗、并发/队列、timeout abort、字符+调用预算及失败保守 settle；`npm run test:tts-config` 覆盖付费配置 fail-closed 与只读巡检。
- [x] 为首次连接、短暂断线、服务器丢局、活动局/公共回放、重复握手、旧 gameId/sequence、
      回放 TTS 静音和 pending input 增加真实 `app.js` Node VM 状态机测试（`npm run test:frontend`）。
      `authenticated` 现为唯一权威握手，旧 `connected` 只显示消息；WebServer 集成测试另锁定活动局公共时间线过滤、
      唯一 TTS 展示端接管、空闲房间释放、公共回放顺序和 invalid token 的 4002 终止。
- [x] 明确事件回放是“观众 UI 恢复”而非“游戏续局”。
      → 回放结束的提示已写明原因：“AI 的记忆只存在于服务器内存里，重启后无法还原，
      因此这局只能回看、不能接着打。”不再让玩家自己猜为什么不能续。
- [ ] （暂不实现）若将来真要支持续局，需要后端 checkpoint 序列化，而不是靠事件日志倒推。
      设计要点已调研，记录在下方“七、checkpoint 续局设计备忘”，当前判断 ROI 不足：
      当前已部署为 GitHub + Render 免费单实例，但免费实例仍可能休眠、重启或重新部署。
- [ ] 测试回放期间 `llm_alert`、TTS、旧 gameId 事件过滤和 replay_start/replay_end 顺序。
- [x] TTS 换局漏音已修复：根因不是"清得不彻底"，而是 `processQueue` 里 `await fetch('/api/tts')` 期间用户换局，那个在途请求无从取消，返回后照样 `new Audio().play()`。改为 `ttsEpoch` 代次令牌，每个 await 边界比对，不匹配即丢弃且不驱动队列（跨代驱动会产生两条并发消费链）。同时补齐 4 个缺失的清理点：`restartGame`（此前完全没清）、`toggleTts` 静音、`onGameStart`（兜底位）、`onReplayStart`。
- [ ] TTS 仍存边界：`speechSynthesis.cancel()` 在部分浏览器上异步生效，换局瞬间可能有不到一秒残音；仅在回退到浏览器语音时出现，受浏览器实现限制。

## 六、当前已知产品边界

- 服务器重启会丢失后端内存中的 Agent、记忆、暂停状态和 AI 决策上下文；事件日志只能帮助观众回看 UI，不能续局。
- AI 可能因模型输出不规范、网络错误或规则约束触发合法随机兜底；这属于稳定性保障，不应被当作真实推理结果。
- AI 思考强度当前是全局统一档位，不支持一局内给不同座位配置不同强度。
- 统计模拟结果受随机种子、模型版本、prompt 版本和 Provider 错误影响，不能直接等同于“真实人类胜率”。
- 项目当前通过 GitHub + Render 免费单实例部署；不具备账号、多房间、跨实例或跨重启续局能力。

## 七、checkpoint 续局设计备忘（暂不实现，仅存档调研结论）

> 结论先行：真正续局需要一条**独立于 EventLog 的引擎状态序列化通道**。EventLog 是脱敏后的 UI 事件流，职责是"观众看到哪了"，绝不应被扩大成"恢复后端决策状态"的载体——那会把表现层和权威状态耦死，且 EventLog 落盘的是遮罩后副本，连全知信息都不全，物理上就无法反推引擎状态。

### 7.1 为什么不复用 EventLog

- EventLog 存的是 `maskEvent()` **遮罩之后**的事件（WebServer.ts:343-347）。人类参战模式下他人 roleType/faction、innerThoughts、夜间行动明细已被剥离，磁盘副本本身就残缺，无法倒推出权威状态。
- EventLog 是追加写的 JSONL，语义是"曾经发生过的画面"，不是"当前权威快照"。用事件倒推状态等于重写一遍规则引擎，脆弱且必然与真实实现漂移。
- 职责隔离：EventLog 面向观众可回看、可脱敏、可丢弃；checkpoint 面向引擎需全知、需精确、需可重建。两者受众、脱敏要求、生命周期都不同，必须是两条通道。

### 7.2 需要序列化的权威状态（全盘点）

**A. GameEngine 核心（可直接 JSON 化）**
- `gameId`（GameEngine.ts:17，构造时随机生成，续局必须从存档恢复而非重建）
- `config`（GameConfig：角色配置、maxRounds、humanCharacterName、difficulty 等）
- `state`（GameState 全字段：phase / round / players / nightActions / eliminatedTonight / witchSaveUsed / witchPoisonUsed / lastGuardTarget / sheriffId；`events` 数组疑似未使用可忽略）

**B. 每个 BaseAgent 的私密记忆（不在 GameState 内，是续局能否正确决策的关键）**
- 对话/去重记忆：`memory`（ChatMessage[]）、`receivedLastWords`（Set→数组）
- 立场档案：`keyFacts`、`selfDossier`、`declaredVoteTarget`、`seerResults`（预言家唯一硬信息，绝对必须）、`lastSuspectId`、`lastVoteTargetId`、`currentRound`
- 人格锁定：`tacticStyle`（只存 `key`，恢复时从 SPEECH_STYLES 查回）、`difficulty`、`isHumanPlayer`
- 派生量保持空让其重建：`systemPromptCache=null`（前提是 tacticStyle/difficulty 已正确恢复）

**C. 必须重建注入、不可序列化**
- `llm`（LLMProvider，含网络/密钥）——重新 createLLMProvider 注入
- `phaseManager` / `voteManager`（无自有状态，用恢复后的 state/agents 重建）
- `allPlayers` / `findPlayerById` 闭包——恢复后统一重建 players 数组再对每个 agent `setPlayersRef()`；Player 对象必须与 state.players 保持**同一引用**
- `player.characterConfig`——按 name 从 ALL_CHARACTERS 查回，不整份序列化

**D. 控制流瞬态（复位即可，无需序列化）**
- `_paused=false`、`_cancelled=false`、`_pausePromise=null`、`_pauseResolve=null`、`_humanInputResolve=null`

### 7.3 两个无法直接序列化的根本障碍

**障碍一：调用栈 = 隐式程序计数器。** `GameState.phase` 只是粗粒度阶段标记。真正的细粒度断点全部只活在 JS 调用栈和局部变量里，不写回 state，无法序列化：gameLoop 的 `node`、executeSheriffElection 走到上警/发言/退水/投票哪一步、投票循环遍历到第几个 agent 及已收集的 `votes`、狼投 `wolfChoices`、竞选 `candidates/speechesByCandidate/withdrawals`、猎人链 `queue/visited`。**含义**：GameState 只能把你恢复到"某阶段开头"，无法恢复到"投票投到一半"。

**障碍二：`Math.random` 内部状态不可读取。** 生产代码全程用裸 `Math.random()`（洗牌、平票裁决、AI 失误注入、各种兜底）。续局后所有随机决策不可复现。

### 7.4 设计决策：阶段级 checkpoint（推荐）

面对障碍一，最干净的方案是**只在阶段边界存档**，接受"阶段级"恢复粒度：

- **存档点**：`checkpoint()`（GameEngine.ts:176）已是每个关键步骤前的天然拦截点。在每次进入新 phase 的边界处（runNight/runDawn/runDay/runVote 入口，state.phase 刚写定、局部循环尚未开始时）序列化一次 GameSnapshot 落盘。
- **恢复粒度**：重启后从"当前 phase 的开头"重放。代价是当前阶段可能重复 emit 事件、重复 LM 调用、重复计票——因此阶段内的操作需保证可安全重入（幂等），或接受"最多丢一个阶段"的进度。
- **不做**中途精确恢复：要支持"投票投到一半续上"，得把每个子步骤进度和 seeded RNG 显式落到可序列化状态，改造面覆盖 PhaseManager/VoteManager 几乎所有循环，ROI 极低，明确不做。

针对障碍二，若要确定性续局：把 sim_worker 已有的 mulberry32 提升为 GameEngine 持有的 RNG 实例字段，其 state 计入 snapshot，并替换掉所有裸 `Math.random()` 调用点。**当前判断**：本地单机跑、不要求可复现，此项也不做，续局后随机分支不可复现是可接受的。

**卡在 `waitForHumanInput` 时重启是最危险的场景**：resolver 已丢，且没有任何记录说明"当前正等谁、等什么输入"。阶段级方案下，恢复到阶段开头会重新走到该 waitForHumanInput 并重新 emit `human_input_required`，前端重新弹窗——这反而是阶段级粒度自带的正确行为，无需额外处理。

### 7.5 数据结构草案

```ts
interface GameSnapshot {
  version: number;            // schema 版本，用于向后兼容
  gameId: string;
  savedAt: number;            // Date.now()
  config: GameConfig;
  state: GameState;           // 权威游戏状态（未脱敏，全知）
  agents: AgentSnapshot[];
}

interface AgentSnapshot {
  playerId: string;           // 对应 state.players[i].id，恢复时按此关联
  difficulty: Difficulty;
  isHumanPlayer: boolean;
  tacticStyleKey: string | null;
  memory: ChatMessage[];
  receivedLastWords: string[];   // Set 序列化为数组
  keyFacts: string[];
  selfDossier: Array<{ round: number; phase: string; memo: string; pinned?: boolean }>;
  declaredVoteTarget: { round: number; name: string; quote: string } | null;
  seerResults: { name: string; isWolf: boolean; round: number }[];
  lastSuspectId: string | null;
  lastVoteTargetId: string | null;
  currentRound: number;
}
```

落地需在 BaseAgent 上新增 `toSnapshot()` / `restore(snap)`（当前这些字段多为 private 且无 getter/setter），在 GameEngine 上新增 `toSnapshot()` / `static fromSnapshot(snap, llm)`。snapshot 通道独立于 EventLog，建议存到独立目录（如 `game-snapshots/{gameId}.json`），与 `game-logs/` 分开。

### 7.6 恢复流程

1. 读 `game-snapshots/{gameId}.json` → GameSnapshot。
2. `createLLMProvider()` 重建 llm。
3. 逐 AgentSnapshot 重建 BaseAgent：new(player, llm) → 设 difficulty/isHumanPlayer → 灌回 B 类记忆（receivedLastWords 数组转回 Set、tacticStyleKey 查回 SPEECH_STYLES）→ systemPromptCache 保持 null。
4. 重建共享 players 数组（与 state.players 同引用），对每个 agent `setPlayersRef()` 重建 allPlayers/findPlayerById 闭包。
5. 重建 phaseManager/voteManager，控制流字段全部复位。
6. 从 `state.phase` 对应的 runXxx 阶段开头重入 gameLoop。

### 7.7 ROI 判断（为何暂不实现）

- 当前是公网免费单实例，进程可能休眠或滚动重启；完整 checkpoint 续局仍因改造面较大暂不实现。
- 阶段级 checkpoint 已能覆盖"崩溃后不想从头再打"的主要诉求，但改造需触碰 GameEngine + BaseAgent + 序列化通道 + 落盘 IO，且要处理阶段内重入幂等，工作量与收益不成比例。
- 因此当前只归档设计，不动代码。若将来要做，按 7.4 阶段级方案落地，切勿走"扩大 EventLog"的捷径。

## 八、多人上线设计边界备忘（暂不实现，仅存档方向）

当前项目仍是本地单进程、单局形态（GameController 单 engine 引用），但已具备进程内连接级随机 token 会话、host 命令授权、服务端座位绑定、逐连接事件投影与断线恢复 pending input。它不是账号体系，也不支持跨重启会话、多房间或多个人类座位。若将来要上线成多人在线版本，以下维度仍需补齐。

### 8.1 数据库（状态持久化）

- 现状：所有权威状态都在进程内存（GameState + agents 记忆 + 暂停/输入态），仅 EventLog 落 jsonl 给 UI 回放。多人版下进程一崩，所有房间全丢。
- 方向：把第七节的 checkpoint 序列化通道升级为真正的持久层。单局存档（GameSnapshot/AgentSnapshot）落数据库而非本地文件；房间、玩家、对局历史、统计需要结构化存储。
- 选型建议：对局快照本身是文档型 JSON，Postgres（JSONB）或 Mongo 均可；关系型更利于房间/用户/统计的关联查询与审计。
- 关键约束：AI 私密记忆（seerResults、身份认知等）属敏感全知信息，落库时必须与"可下发给客户端的脱敏视图"物理分表/分库，杜绝查询越权泄漏（与 8.5 联动）。

### 8.2 鉴权（身份与会话）

- 现状：WebSocket 首包必须提交 256-bit 随机 token；服务端只存 SHA-256 摘要，同 token 可重连同一 session。首个 session 不自动成为 host；没有房间时，主动创建唯一房间的会话自动成为主持人。控制命令仅房间创建者可用；`human_input` 校验 session seat + gameId + requestId。该机制只覆盖单进程连接身份，不是用户账号。
- 方向：公网多人版接入账号体系（OAuth / 邮箱 / 第三方），把临时 session 映射到持久 userId，并增加撤销、过期、审计与设备管理。
- 踩点：当前会话与座位绑定不会跨进程重启，且产品明确维持单 human；多人版需按房间和多个座位寻址。

### 8.3 房间隔离（多局并发）

- 现状：WebServer 默认创建实例 EventBus 并注入 GameController/GameEngine，每个 bus 的 AsyncLocalStorage gameId 上下文和监听器相互隔离；兼容路径仍保留 `globalEventBus`。更关键的是 `GameController` 仍只持一个 `engine`，WebServer 广播也仍是单局模型，因此当前不支持多房间。
- 方向：引入 Room/Match 概念，每房一个 GameEngine 实例 + 独立事件通道（按 roomId 命名空间隔离，或每房一个 EventBus 实例）；broadcast 只发给该房成员的连接，绝不跨房。
- 踩点：`globalEventBus` 的单例假设、EventLog 按 gameId 单文件、WebServer 的全局 broadcast 都要改成按房间路由。这是改动面最大的一项。

### 8.4 速率限制（防滥用与成本失控）

- 现状：LLM 有 BudgetLedger 全局 token/调用预算；TTS 合成要求主持人 session，并有 per-session/per-IP 请求数与字符滑窗、并发/队列/timeout，以及火山 TTS 独立字符+调用预算。开局/重开与暂停/继续/取消已有 session 级冷却；`human_input` 仍主要依赖唯一 pending request、座位和 requestId 防重。
- 方向：网关层或应用层加限流（按 user/IP/room 维度），保护 LLM 与 TTS 成本；开局、重开、消息发送要有冷却与配额；预算从"全局一本账"细化到"按房间/按用户"计量与熔断。
- 踩点：现有 BudgetLedger 是单例全局账本，多租户下要能按维度切分，否则一个用户能烧光所有人的额度。

### 8.5 审计脱敏（合规与防泄漏）

- 现状：`maskEvent()` 已在下发/落盘前做身份遮罩（人类参战模式剥离他人身份/内心独白），但这是对局内的"上帝视角防泄漏"，不是面向运维/合规的审计脱敏。
- 方向：区分三类数据流并各自脱敏——①下发客户端（沿用并强化 maskEvent，按 user 视角遮罩）；②落库审计日志（记录谁在何时做了什么操作，但不落明文密钥、不落他人身份）；③错误/监控上报（堆栈与日志里禁止出现 API key、token、玩家 PII）。
- 踩点：`.env` 里的 LLM/TTS 密钥当前直接进程读取，多人版要接密钥管理服务（KMS / secrets manager），日志与审计管道要有统一的敏感字段打码。

### 8.6 总体判断（为何暂不实现）

- 当前定位是公网可试玩的免费单实例，而不是互不信任的大规模多人平台。上述数据库、账号、多房间和租户预算仍会连带重构 WebServer / GameController / EventBus 的核心假设。
- 因此当前只实现单实例必要防护，完整多人化仍按 8.3 房间隔离 → 8.1 数据库 → 8.2 鉴权 → 8.4 多租户限流 → 8.5 审计脱敏逐层推进。
