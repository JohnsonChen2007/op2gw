# model-live-monitor

实时查看 ZCode 当前调用的模型与生成速度（tok/s）。

## 能力

- **命令 `/model-speed`**：查询最近一次调用、最近调用列表、按模型速度汇总，或实时跟随若干秒的新调用。
- **技能 `model-live-monitor`**：教代理定位并运行读取脚本，用中文汇报模型、耗时、输出 token 与 tok/s。
- **钩子 `UserPromptSubmit`**：每次提问时读取最近一次调用，向会话注入一行速度状态；同一次调用只注入一次，不重复膨胀上下文。

## 数据源与口径

- `~/.zcode/cli/rollout/model-io-*.jsonl`：每次模型调用一条记录，含真实 token 用量，是速度计算的唯一数据源。
- `~/.zcode/cli/log/zcode-*.jsonl`：`model.request.started` 事件用于实时显示“请求开始”（token 已脱敏，不参与速度计算）。
- 速度 = 输出 token ÷ 总耗时（含网络往返与首字延迟）。

## 本地运行

```bash
node scripts/model-monitor.mjs now
node scripts/model-monitor.mjs last 10
node scripts/model-monitor.mjs summary
node scripts/model-monitor.mjs tail --seconds 30
```

## 验证

```bash
zcode plugins validate .
```

版本：0.1.0
