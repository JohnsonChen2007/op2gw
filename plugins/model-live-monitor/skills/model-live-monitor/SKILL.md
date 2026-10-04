---
name: model-live-monitor
description: 当用户询问当前/最近调用了哪个模型、生成速度（tok/s）、模型调用耗时、速度对比或模型监控时使用。提供读取 ZCode rollout 调用记录的脚本：最近一次调用、最近调用列表、按模型速度汇总，以及实时跟随新的模型调用。
---

# 模型调用实时监控

回答“现在用的什么模型？”“生成速度多少？”一类问题，或需要实时观察模型调用时，运行本技能的脚本。命令里的 `${ZCODE_SKILL_DIR}` 会由加载器替换为技能目录的绝对路径，直接复制运行即可。

## 数据源

- `~/.zcode/cli/rollout/model-io-*.jsonl`：每完成一次模型调用追加一条记录，含 `model.modelId`、`providerId`、`durationMs` 与真实 `response.usage` token 数。速度计算只用这个来源。
- `~/.zcode/cli/log/zcode-*.jsonl`：应用日志；`model.request.started` 事件用于实时看到“请求开始”，但其中 token 已脱敏，不能换算速度。
- 会话结束或达到保留上限后 rollout 文件会轮转删除，脚本每次运行都重新扫描目录，不要缓存文件名。

## 命令

```bash
# 最近一次调用（默认命令）
node "${ZCODE_SKILL_DIR}/../../scripts/model-monitor.mjs" now

# 最近 N 次调用明细
node "${ZCODE_SKILL_DIR}/../../scripts/model-monitor.mjs" last 20

# 按模型汇总：调用次数、平均耗时、平均速度与速度区间
node "${ZCODE_SKILL_DIR}/../../scripts/model-monitor.mjs" summary

# 实时跟随（每 0.5 秒轮询；Ctrl-C 退出；--seconds N 可定时退出）
node "${ZCODE_SKILL_DIR}/../../scripts/model-monitor.mjs" tail
```

常用选项：`--session <ID>` 过滤会话；`--json` 输出 JSON 行；`--all` 读取完整文件（默认只读每文件尾部 8MB）；`--no-log` 关闭“请求开始”事件监听。

## 使用方式

- 用户直接提问模型或速度 → 运行 `now`（或 `last N` / `summary`），把模型、耗时、输出 token、tok/s 用中文简洁汇报。
- 用户要求实时观看 → 后台启动 `tail --seconds 300`，随后定期读取其输出并转述新增调用；或告诉用户可在自己的终端直接运行上面的 tail 命令实时观看。
- 需要脚本化处理时加 `--json`。

## 结果解读

- 速度 = 输出 token ÷ 总耗时，总耗时含网络往返与首字延迟，因此低于纯生成阶段的速度。
- `finishReason` 为 `tool-calls` 表示该次调用以工具调用结束；`querySource` 为 `subagent` 表示子代理调用；`attempt > 1` 是重试；“错误”字段非空表示该次调用失败。
- 输出为空时，脚本会列出已检查的目录；先确认 `~/.zcode/cli/rollout` 非空，或用环境变量 `ZCODE_ROLLOUT_DIR` 指定记录目录后重试。
