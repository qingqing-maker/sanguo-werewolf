# 单实例云端部署

推荐路径：

```text
本地代码
  → GitHub 仓库（只含源码和模板）
  → Render Blueprint（render.yaml）
  → 1 个免费 Node Web Service
  → 容器内临时 /var/data
```

## 为什么固定为一个实例

游戏房间、主持权、Agent 状态和暂停点都保存在 Node 进程内存中。多个实例会让不同访客被路由到不同进程，看到不同房间状态；因此当前版本必须保持 `numInstances: 1`。

免费实例没有持久磁盘。预算账本和公共事件日志暂存在容器内的 `/var/data`，服务重启或重新部署后可能丢失；活动对局同样不能跨重启续局。

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
4. 保持免费单实例。`/var/data` 是临时存储，预算账本和公共事件日志会在重启或重新部署后重置。
5. 部署完成后访问 `/healthz`，应返回 `status: ok`。
6. 打开首页，第一位点击“创建房间”的访客会自动成为主持人。
7. 默认主持人全部标签页离线 90 秒后释放空闲房间；可用 `HOST_DISCONNECT_GRACE_MS` 调整。开局/重开默认冷却 10 秒，暂停/继续/取消默认冷却 1 秒。

同一主持人打开多个标签页时，服务端只授予其中一个连接 TTS 展示租约；该页断线后其他主持人标签页会自动接管，避免多路语音重叠。

生产环境使用火山方舟前，还必须确保账户无欠费、目标模型已开通，并设置云端账单告警。当前本地排查曾返回 `AccountOverdueError`；欠费状态下部署成功也无法完成真实推理。

## 回滚

应用代码可回滚到上一个成功部署。免费实例的 `/var/data` 不具备持久性；如果以后升级为持久磁盘实例，不要回滚或覆盖 `/var/data/runs` 中的预算账本。若需要新额度周期，应改用新的 `LLM_BUDGET_PERIOD` 和账本文件名，保留旧记录。
