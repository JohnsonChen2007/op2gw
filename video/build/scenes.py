# -*- coding: utf-8 -*-
"""场景脚本：文案 + 幻灯片内容。数据全部来自 op2gw 仓库实测（README / package.json / npm test）。"""

# layout: landscape=16:9 竖版挂片; portrait=9:16 竖版全屏

SCENES = [
    {
        "id": "01-cover",
        "layout": "cover",
        "kicker": "OPEN SOURCE · MIT",
        "title": "op2gw",
        "subtitle": "面向 OpenCode Zen 免费通道的独立网关",
        "tagline": "一条命令启动 · 免 API key · 多出口 IP 池 · 内置调试台",
        "narration": (
            "你好，今天用三分钟带你看懂 op2gw。"
            "这是一个面向 OpenCode Zen 免费通道的独立网关：一条命令启动，不用注册，不用 API key，"
            "任何 OpenAI 兼容的工具都能直接接上。"
        ),
    },
    {
        "id": "02-author",
        "layout": "cards",
        "kicker": "作者 · AUTHOR",
        "title": "谁写的",
        "lead": "一个非常年轻、但已经相当扎实的项目",
        "cards": [
            {"k": "开发者", "v": "johnson202609", "sub": "独立作者，全仓库唯一提交者"},
            {"k": "开源协议", "v": "MIT", "sub": "托管于 GitCode，仓库无远端推送"},
            {"k": "提交历史", "v": "2 次提交", "sub": "全部发生在 2026-10-01 同一天"},
            {"k": "测试覆盖", "v": "159 通过 / 0 失败", "sub": "16 个测试文件，并接入 CI 流水线"},
        ],
        "narration": (
            "先说作者。op2gw 由 johnson202609 独立开发，开源在 GitCode，采用 MIT 协议。"
            "整个项目非常年轻，只有两次提交，而且都在 2026 年 10 月 1 日这一天。"
            "但别被它年轻骗了，代码已经相当扎实：一百五十九个测试用例全部通过，还配了 CI 流水线。"
        ),
    },
    {
        "id": "03-why-gateway",
        "layout": "compare",
        "kicker": "演进 · FROM PLUGIN TO GATEWAY",
        "title": "为什么是网关，不是插件",
        "lead": "op2gw 是 opencode2dsh（DSH 进程内插件）的独立网关演进版。真正的差别只有一条：HTTP 客户端归谁。",
        "left_title": "插件形态 opencode2dsh",
        "left": ["内置 fetch 被宿主 pi-ai 抢占", "只能 setGlobalDispatcher 全局 hack", "IP 轮换粒度受限"],
        "right_title": "网关形态 op2gw",
        "right": ["独占 undici，HTTP 客户端自持", "每请求传 { dispatcher }", "真正按请求粒度选出口"],
        "note": "核心洞察：只有独占 HTTP 客户端，才能做到「这次走出口 A，下次走出口 B」。",
        "narration": (
            "op2gw 是从 opencode2dsh 这个进程内插件演进出来的独立网关，核心差别只有一条：HTTP 客户端归谁。"
            "插件形态下 fetch 被宿主抢占，只能用全局代理 hack，出口粒度受限；"
            "网关独占自己的客户端，于是每个请求都能单独指定出口。"
            "这就是它能做按请求 IP 轮换的原因。"
        ),
    },
    {
        "id": "04-gate",
        "layout": "steps",
        "kicker": "核心功能 ① 免 API KEY",
        "title": "骗过免费层的两道门禁",
        "lead": "OpenCode Zen 匿名免费层经实测有两道校验，缺一即被 403 拒绝。",
        "steps": [
            {"t": "会话形状门禁", "d": "core/ids.ts", "b": "x-opencode-session 必须是官方形状 ses_ + 12 位 hex + 14 位 Base62。取对话首条 user 消息 SHA-256 派生，多轮对话历史增长时保持稳定，保住上游 prompt-cache 亲和。"},
            {"t": "智能体形态门禁", "d": "core/freelane.ts", "b": "请求体必须流式，且 tools 数组同时含名为 bash 与 read 的 function 工具。缺了就发送前注入存根；客户端没带工具时补 tool_choice: none。"},
        ],
        "code_title": "凭证就是字面量",
        "code": 'Authorization: Bearer public\n# 无需任何 key · 不存储 · 无遥测',
        "narration": (
            "第一个核心功能，是让匿名免费通道真正能用起来。免费层有两道门禁。"
            "第一道是会话形状：会话 ID 必须符合官方格式，"
            "而且由对话首条用户消息哈希派生，多轮对话时保持稳定。"
            "第二道是智能体形态：请求体必须流式，并且带上 bash 和 read 两个工具声明，缺了自动注入。"
            "至于凭证，就是字面量 Bearer public，不需要任何 key。"
        ),
    },
    {
        "id": "05-pool",
        "layout": "pool",
        "kicker": "核心功能 ② 多出口 IP 池",
        "title": "匿名配额按 IP 计，所以要轮换",
        "lead": "默认关闭，加 --pool 开启。出口来源：手填代理 + 免费源抓取 + pinned 固定主力。",
        "tiers": [
            {"tag": "TIER 1", "t": "出口级健康", "b": "429 冷却整个出口（配额按出口 IP 计）+ 传输失败标记 dead，冷却按连续次数指数退避。"},
            {"tag": "TIER 2", "t": "出口 × 模型级", "b": "401 / 403 / 地区封锁通常是模型级的，只封禁该配对，出口服务其他模型不受影响。"},
        ],
        "flow": ["pinned 固定出口", "会话粘性", "最优健康节点"],
        "notes": [
            "同一对话粘同一出口，保证 prompt-cache 亲和",
            "流未落地失败 → 透明换出口重试（有上限）",
            "已吐出字节 → 绝不重放，避免重复交付",
        ],
        "narration": (
            "第二个核心功能，是多出口 IP 池。匿名配额是按 IP 计算的，单机很容易被打满。"
            "网关维护两层健康度：出口级处理 429 和传输失败，模型级处理 401、403 和地区封锁。"
            "同一对话会粘在同一个出口上，保证缓存亲和；"
            "如果流还没吐出任何内容就失败，网关会自动换一个出口重试，一旦有字节流出就绝不重放。"
        ),
    },
    {
        "id": "06-catalog",
        "layout": "flow",
        "kicker": "核心功能 ③ 实时模型目录",
        "title": "不是静态清单，是三源回退链",
        "lead": "对外暴露的模型 = 在售 ∧ 判定为免费。上游新增免费模型，下一轮刷新自动出现，不用改代码。",
        "sources": [
            {"tag": "S1", "t": "GET {zen}/v1/models", "b": "Zen 在售模型全集（含付费）", "r": "刷新 300s"},
            {"tag": "S2", "t": "models.dev/api.json", "b": "每模型成本 + 生命周期状态", "r": "刷新 24h + 磁盘缓存"},
            {"tag": "S3", "t": "编译期内置知识", "b": "冷启动引导 + 元数据失声时背书", "r": "随版本"},
        ],
        "rules": [
            "付费判定永远说话：S2 成本 > 0 → 一律不暴露",
            "只有「在售 ∧ 零成本」才放行，只信 S1 的在售事实",
            "S1 失败用上次结果；从未成功才用 S3 启动",
        ],
        "stat": "12 个免费模型 · 8 个四条路径全通",
        "narration": (
            "第三个核心功能，是实时模型目录。它不是静态清单，而是一条三源回退链："
            "上游的在售模型列表、models.dev 的成本数据，再加一层内置知识。"
            "只有同时满足在售、并且判定为零成本的模型，才会被暴露出去。"
            "所以上游一旦新增免费模型，下一轮刷新就自动出现，不需要改一行代码。"
            "目前实测十二个免费模型里，有八个在全部四条路径上跑通。"
        ),
    },
    {
        "id": "07-console",
        "layout": "cards",
        "kicker": "核心功能 ④ 调试台与自愈",
        "title": "自带控制台，起来就能看",
        "lead": "启动后直接打开 http://127.0.0.1:8787/ ，就是一个可操作的调试控制台。",
        "cards": [
            {"k": "模型目录", "v": "/v1/models", "sub": "实时计算出来的免费清单"},
            {"k": "出口池健康", "v": "/admin/pool/exits", "sub": "每个出口的延迟、IP、冷却状态"},
            {"k": "请求追踪", "v": "/admin/traces", "sub": "出口、出口 IP、状态码、尝试次数、耗时"},
            {"k": "日志实时流", "v": "/admin/logs/stream", "sub": "SSE 推送，运行时热切日志级别"},
        ],
        "note": "自愈看门狗：目录过期强制刷新 · 误判死亡的 direct 出口自动复活 · 池长期无可用出口则告警 · 写 ~/.op2gw/status.json 供外部监控",
        "narration": (
            "第四个核心功能，是自带的调试控制台。启动之后直接打开 8787 端口就是一个网页，"
            "实时看模型目录、出口池健康、请求追踪和日志流，配置也能直接改，即时生效不用重启。"
            "网关还带一个自愈看门狗：目录过期就强制刷新，出口被误判死亡就复活，"
            "池子长期没有可用出口就告警，同时把健康快照写到本地，供外部监控读取。"
        ),
    },
    {
        "id": "08-howto",
        "layout": "howto",
        "kicker": "上手 · GET STARTED",
        "title": "怎么用",
        "lead": "前置条件只有一个：Node.js ≥ 20。",
        "blocks": [
            {"t": "macOS / Linux", "b": "cd op2gw\n./install.sh", "s": "检查环境 → 装依赖 → 编译 → 启动"},
            {"t": "Windows", "b": "powershell -ExecutionPolicy Bypass\n  -File install.ps1", "s": "可选参数 -Pool / -Port"},
            {"t": "常用参数", "b": "./install.sh --pool --port 9000\n./install.sh --no-start --no-proxy", "s": "开 IP 池 / 换端口 / 只装不启动"},
        ],
        "verify_title": "启动后验证",
        "verify": "curl http://127.0.0.1:8787/v1/models",
        "clients": "接入：opencode · Claude Code · curl · OpenAI Python SDK —— base_url 填 http://127.0.0.1:8787/v1",
        "narration": (
            "最后说怎么用。前置条件只要 Node.js 二十以上。"
            "macOS 和 Linux 执行 install.sh，装依赖、编译、启动一条龙；"
            "Windows 用 PowerShell 跑 install.ps1。"
            "启动后打开调试台，curl 一下 v1 斜杠 models 就是免费的模型清单。"
            "要接 opencode 或 Claude Code，把 base URL 指向本机 8787 端口就行。"
            "op2gw，开源免费，随取随用。"
        ),
    },
]

# 片尾
OUTRO = {
    "id": "09-outro",
    "layout": "cover",
    "kicker": "MIT LICENSE · 2026",
    "title": "op2gw",
    "subtitle": "免 API key 的 OpenAI 兼容网关",
    "tagline": "默认关闭 IP 池 · 遵守上游条款 · 请使用你自己的代理节点",
    "narration": "",  # 复用第 8 场尾部静音
}
