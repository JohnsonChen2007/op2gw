---
description: 查看当前或最近的模型调用与生成速度（tok/s）
argument-hint: [now|last N|summary|tail [秒数]]
skills: model-live-monitor
---

查询模型调用与生成速度，并用中文向用户汇报。按参数选择模式（脚本路径与选项见 model-live-monitor 技能）：

- 参数为空或 `now`：汇报最近一次调用的模型、提供商、耗时、输出 token、tok/s、完成原因。
- `last N`：列出最近 N 次调用的时间、模型、耗时与速度。
- `summary`：汇报按模型的调用次数、平均耗时、平均速度与速度区间。
- `tail [秒数]`：实时跟随指定秒数（默认 60 秒）的新调用，结束后汇报期间捕获的调用。

只呈现脚本实际输出的数据；数据缺失时如实说明原因。
