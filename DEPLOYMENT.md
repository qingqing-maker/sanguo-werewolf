# 单实例云端部署

推荐路径：

```text
本地代码
  → GitHub 仓库（只含源码和模板）
  → Render Blueprint（render.yaml）
  → 1 个 Node Web Service
  → 1 块 /var/data 持久磁盘
```

## 为什么固定为一个实例

游戏房间、主持权、Agent 状态和暂停点都保存在 Node 进程内存中。多个实例会让不同访客被路由到不同进程，看到不同房间状态；因此当前版本必须保持 `numInstances: 1`。

持久磁盘只保存预算账本与公共事件日志，不保存可继续运行的 Agent 状态。服务重启后可以回放最近公共事件，但不能续局。

## GitHub 上线前

1. 确认 `.gitignore` 已生效：

   ```bash
   git status --short --ignored
   git check-ignore -v .env runs game-logs
   ```

2. 执行 Secret 扫描并确认没有真实 Key：

   ```bash
   git grep -n -E "ark-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}" -- . \
     ":(exclude).env.example" ":(exclude)*.test.*"
   ```

3. 本地验证：

   ```bash
   npm ci
   npm run build
   npm test
   docker build -t sanguo-werewolf .
   ```

## Render 部署

1. 将代码推送到 GitHub。
2. 在 Render 创建 Blueprint，并选择仓库根目录的 `render.yaml`。
3. 在创建过程中填写 `LLM_API_KEY`。不要把 Key 写进 `render.yaml`。
4. 保持单实例与 `/var/data` 持久磁盘。
5. 部署完成后访问 `/healthz`，应返回 `status: ok`。
6. 打开首页，第一位点击“创建房间”的访客会自动成为主持人。

生产环境使用火山方舟前，还必须确保账户无欠费、目标模型已开通，并设置云端账单告警。当前本地排查曾返回 `AccountOverdueError`；欠费状态下部署成功也无法完成真实推理。

## 回滚

应用代码可回滚到上一个成功部署。不要回滚或覆盖 `/var/data/runs` 中的预算账本；若需要新额度周期，应改用新的 `LLM_BUDGET_PERIOD` 和账本文件名，保留旧记录。
