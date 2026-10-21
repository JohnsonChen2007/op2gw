<div align="center">

# op2gw

视频介绍看B站：
https://www.bilibili.com/video/BV11hYw6vEx4/?spm_id_from=333.1387.homepage.video_card.click&vd_source=9073f486417417fcfc08a185bc6ad90e


**面向 OpenCode Zen 免费通道的独立 OpenAI v1 兼容网关**

一键启动 · 免 API key · 多出口 IP 池 · 结构化日志 · 自我修复 · 内置调试网页

</div>

---

任何 OpenAI 兼容工具（opencode、curl、各类 SDK、其他 Agent）把 `base_url` 指向 op2gw，它就会把每一次请求**伪装成 OpenCode 官方 CLI**，转发到 [OpenCode Zen](https://opencode.ai/zen) 的**匿名免费通道**——无需注册、无需 key。内置的**多出口动态 IP 池**把负载分散到多个出口 IP 上，缓解「匿名配额按 IP 限流」导致单机被卡死的问题；内置**前后端调试网页**实时展示模型、池健康、日志、请求追踪，还带一个在线调试台。

op2gw 是 `opencode2dsh`（DSH 进程内插件）的**独立网关演进版**：沿用同一套请求伪装与目录逻辑，但作为自己的 HTTP 服务器，**独占 HTTP 客户端**——因此能干净地为每个请求指定出口（`{ dispatcher }` per request），实现真正的按请求 IP 轮换，而不是插件形态被迫使用的全局 dispatcher hack。

## 目录

- [一键安装启动](#一键安装启动)
- [架构原理](#架构原理)
  - [为什么是网关而不是插件](#为什么是网关而不是插件)
  - [一次请求的完整生命周期](#一次请求的完整生命周期)
  - [请求伪装：骗过免费层的两道门禁](#请求伪装骗过免费层的两道门禁)
  - [模型目录：S1/S2/S3 三源回退链](#模型目录s1s2s3-三源回退链)
  - [多出口 IP 池：两层健康 + 轮换重试](#多出口-ip-池两层健康--轮换重试)
  - [日志与自我修复](#日志与自我修复)
- [模型可用性验证结果](#模型可用性验证结果)
- [配置](#配置)
- [接入示例](#接入示例)
- [端点一览](#端点一览)
- [目录结构](#目录结构)
- [合规声明](#合规声明)

---

## 一键安装启动

**前置条件**：Node.js ≥ 20（`node -v` 确认）。

**macOS / Linux**

```sh
cd op2gw
./install.sh              # 检查环境 → 装依赖 → 编译 → 启动
```

常用参数：

```sh
./install.sh --pool             # 启用多出口 IP 池
./install.sh --port 9000        # 指定端口
./install.sh --no-start         # 只安装不启动
```

**Windows（PowerShell）**

```powershell
cd op2gw
powershell -ExecutionPolicy Bypass -File install.ps1
# 可选： .\install.ps1 -Pool -Port 9000
```

**手动方式**（等价）：

```sh
npm install && npm run build && npm start
# 开发模式（免编译，Node 直接跑 TS）： npm run serve
```

启动后打开 **http://127.0.0.1:8787/** 即是调试控制台。验证：

```sh
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

---

## 架构原理

### 为什么是网关而不是插件

| 维度 | opencode2dsh（DSH 进程内插件） | **op2gw（独立网关）** |
| --- | --- | --- |
| 服务对象 | 只有 DSH 一个宿主 | 任何 OpenAI v1 工具：opencode / curl / SDK / 其他 Agent |
| HTTP 客户端 | pi-ai 抢占了内置 fetch，只能全局 `setGlobalDispatcher` hack | **自己独占 undici**，每请求传 `{ dispatcher }` |
| IP 轮换 | 全局 dispatcher，粒度受限 | **真正按请求选出口**：每次上游调用走为它选中的出口 |
| 可观测性 | 依赖宿主日志 | 内置结构化日志 + SSE 实时流 + 请求追踪 + 调试网页 |
| 部署 | 装进 DSH | 独立进程，一键起，谁都能连 |

核心洞察：**只有独占 HTTP 客户端，才能真正做到「这次请求走出口 A，下次走出口 B」**。这是网关形态相对插件形态的结构性优势，也是多 IP 池能精确到「每请求 × 每出口 × 每模型」粒度做冷却与封禁的前提。

### 一次请求的完整生命周期

```
OpenAI 兼容客户端 (opencode / curl / SDK / 任意工具)
   │  POST /v1/chat/completions   (base_url = http://host:port/v1)
   ▼
┌──────────────────────── op2gw 网关 ────────────────────────┐
│ 1. catalog   这个模型免费吗?   S1在售 ∩ S2零成本 (S3 只背书)   │
│ 2. ids       从对话首条 user 消息派生 CLI 会话/请求/项目 id     │
│ 3. freelane  注入 bash+read 门禁工具, 强制上游流式             │
│ 4. pool      选出口 (pinned → 会话粘性 → 最优健康节点)         │
│              region 门禁模型无代理出口时明确拒绝, 不回退直连    │
│ 5. upstream  经该出口的代理拨号, 带 CLI 伪装头, Bearer public  │
│ 6. rotate    响应前失败则换出口重试 (有上限); 出流后不重放      │
│ 7. stream    上游 SSE 原样透传; 非流式客户端则重组为单个 JSON   │
└────────────────────────────────────────────────────────────┘
   ▼
https://opencode.ai/inference/v1/{chat/completions | responses}   (匿名免费通道)
```

对应源码：`gateway/gateway.ts`（编排）· `gateway/upstream.ts`（转发+看门狗）· `core/ids.ts`（伪装）· `core/freelane.ts`（门禁）· `catalog/catalog.ts`（目录）· `pool/*`（IP 池）。

### 请求伪装：骗过免费层的门禁

OpenCode 把匿名免费通道迁到了 `https://opencode.ai/inference/v1`（旧的 `/zen/v1` 对匿名请求一律 403），并会逐项比对官方 CLI 的指纹。2026-10-15 与本机官方 CLI 1.18.18 同机、同出口逐项对照实测，**下面任何一项不符，该请求在所有出口都会 403 `FreeTierError`**，op2gw 逐一满足：

1. **路径**：`/inference/v1/{chat/completions|responses}`（`core/config.ts` 的 `zenBaseUrl` 默认值）。
2. **请求头**（`core/ids.ts`）：只发官方 CLI 实际发送的 `user-agent`、`x-opencode-client`、`x-opencode-session`、`x-opencode-request`、`x-opencode-project`。多发 `x-opencode-session-id`、`x-session-affinity`、`X-Session-Id` 会被拒。User-Agent 的 `opencode/<版本>` 必须落在上游认可的区间：低于 1.18.0 返回 `426`，实测 1.18.0–1.18.30 通过、1.18.34 及更高按伪造 403（旧值 1.18.35 正好落在被拒区间）；`ai-sdk` 后缀版本不校验。网关固定使用本机 CLI 的 `opencode/1.18.18`（chat 带 `provider-utils/4.0.23`，responses 带 `4.0.38`）。
3. **会话 id 形状**（`core/ids.ts`）：`ses_`/`msg_` 后 12 位 hex 必须是 CLI 的 `tU()` 时间戳编码（随机 hex 视为伪造）。网关以对话**首条 user 消息**为种子缓存会话 id，多轮对话保持稳定（保留上游 prompt-cache 亲和），不同对话自然分离。
4. **智能体形态门禁**（`core/freelane.ts`）：请求体必须「流式」且 `tools` 同时含 `bash`、`glob`、`grep`、`read`，并且这些工具的**描述与参数结构要与官方定义一致**（占位存根被拒；`$schema`、系统信息或临时目录这类细节不同则无妨）。网关发送前注入取自官方 CLI 的定义（`core/gate-tools.ts`），客户端自带的同名工具会被替换，其余工具保留。`tool_choice: "none"` 同样被拒，网关会改写为官方 CLI 始终发送的 `"auto"`。

**门禁第四维：出口 IP。** 2026-10-18 实测（`scripts/probe-path.mjs`、`scripts/probe-ua-window.mjs`）：逐项满足以上四条的同一个匿名请求，从部分出口 IP 403 `FreeTierError`（含默认出口 10808、池内多个出口），从另一些出口同秒 200——与 UA 版本无关（1.17.9–1.20.0 全档 403），是被按 egress 判定放行与否。网关的处理（`pool/pool.ts` 的 `markGate` + `gateway/gateway.ts`）：身份门禁 403 **按出口惩罚并轮换**——该「出口×模型」立即封禁，出口整体进入指数冷却（冷却理由 `gate`，可达性探活不清除：隧道活着不代表 lane 放行），剩余预算继续在全池找通过的出口；此前的「指纹问题、fail-fast 不轮换」策略已废弃。若需要立即稳定，把 `pool.pinnedExitId` 钉到已验证通过的出口（实测 2026-10-18：`socks5://127.0.0.1:21002` 通过，`/admin/pool` 可见各出口冷却状态）。`GET {zen}/v1/models`（目录 S1）不受此门禁影响。

已知限制：注入的 `bash`/`glob`/`grep`/`read` 无法再用 `tool_choice: "none"` 压住，没有自带工具的纯聊天客户端在问到文件/命令时，模型仍可能对这些工具发起调用（实测加描述备注或 system 提示都压不住）。

**官方 CLI 升级、再次出现全出口 403 时**，重新取证即可，不需要猜：

```bash
# 1. 起一个只落盘请求的本地服务（任意 http server，记录 headers + body）
# 2. 用空 HOME 跑官方 CLI，把内置 opencode provider 的 baseURL 指过去
mkdir -p /tmp/oc-home/.config/opencode
echo '{"provider":{"opencode":{"options":{"baseURL":"http://127.0.0.1:18931/inference/v1"}}}}' \
  > /tmp/oc-home/.config/opencode/opencode.jsonc
HOME=/tmp/oc-home opencode run -m opencode/big-pickle hello
```

对照抓到的请求头、`tools[bash|read]` 与 `core/ids.ts`、`core/gate-tools.ts` 逐项更新；`opencode run -m opencode/muse-spark-1.3-contributor-free hello` 可取到 responses 方言。`~/.cache/opencode/models.json` 里 `opencode.api` 字段即当前上游基址。

凭证就是字面量 `Authorization: Bearer public`，无需任何 key，不存储、无遥测。

### 模型目录：S1/S2/S3（实时发现，不是静态清单）

对外暴露的模型 = **在售 ∧ 判定为免费**（`catalog/catalog.ts`）。覆盖范围由上游驱动：上游新增一个免费模型，下一轮刷新就自动出现，**不需要改代码**。

| 层 | 来源 | 作用 | 刷新 |
| --- | --- | --- | --- |
| **S1** | `GET {zen}/v1/models` | Zen 在售模型全集（含付费） | 默认 300s |
| **S2** | `models.dev/api.json` | 每模型成本 + 生命周期状态 | 24h + 磁盘缓存 |
| **S3** | 编译期知识 | 冷启动引导清单 + 元数据失声时的免费背书 | 随版本 |

判定规则：

1. **付费判定永远说话**（S2 成本 > 0 → 不暴露）。
2. **在售 ∧ 零成本 → 暴露**。注意这里必须用 S1 的在售事实：models.dev 有一批零成本行的 `status` 停在 `deprecated`，但对 Zen 仍在售、仍免费供应的 id（实测 2026-10-01：`muse-spark-1.2-contributor-free`、`mimo-v2.5-free`、`deepseek-v4-flash-free` 三个仍在 `/v1/models` 且匿名通道可用，而另外 32 个 deprecated 行确实已下架）。**只信「在售」的零成本行**，因此不会把付费模型带进免费清单。
3. 元数据**没有这一行**时（models.dev 落后于 Zen），S3 背书或 id 名含 `free` 才放行。
4. S3 的引导清单只在 S1 从未成功过（冷启动 / 上游不可达）时充当列表。

回退链：S1 失败用上次结果 → 从未成功用 S3 启动 → S2 失败读 7 天磁盘缓存或退化为名称启发式。

### 出口选择：为什么 `includeDirect: false` 必须真的生效

`pool.includeDirect = false` 表示「出口只走代理」。这个开关不是偏好问题，而是**正确性问题**：

- **region 门禁按调用方国家判定**。Zen 对 `muse-spark-*` 返回 `403 RegionError`，而本机若在不受支持的地区，直连必然失败；同一个请求从受支持的出口发出则 **200**。
- 所以直连回退会把「受地区门禁的模型」静默变成「来自错误国家的请求」，同时把操作者的真实国家暴露给上游。

网关因此在两处同时封死：池的 `pick()` 直接过滤 direct，网关再对 direct 出口做一次兜底拒绝，并返回可执行的 503（「没有可用代理出口」），而不是一个看不出所以然的 403。

### 同一条请求，curl 200 而 Node 403：不要相信环境代理

一个违反直觉但会致命的细节：**Node 内置 `fetch` 不能用来控制出口**。

- Node ≥ 24 下，裸 `fetch` 只在显式开启 `--use-env-proxy` / `NODE_USE_ENV_PROXY` 时才读代理环境变量，否则**完全忽略** `https_proxy`；
- 就算它读了，走的是 `HTTP(S)_PROXY` 的通用代理路径，而不是网关配置的出口。

两种失效模式都会让请求**静默绕过所选出口**（实测：配置了海外出口，实际却从本地真实直连 IP 出网），于是受地区门禁的模型 403，而出口本身完全健康。更棘手的是同一出口上用不同 HTTP 客户端结果不同——**curl 返回 200，Node 的 proxied fetch 返回 403**，因为上游会按客户端特征判定。

因此网关所有自有的出网调用（目录抓取、元数据、免费代理源）一律走 `dispatchers.boundFetch()`，用 undici 的 `dispatcher` 显式指定出口，不依赖任何环境变量。


### 多出口 IP 池：两层健康 + 轮换重试

默认关闭（纯直连）；`--pool` 开启。出口来源：手填明文代理 + 免费源抓取（带断路器，默认关闭）+ 固定主力(pinned)。

- **两层健康**（`pool/pool.ts`）：
  - **Tier 1 per-exit**：429 冷却**整个出口**（配额按出口 IP 计）+ 传输失败标记 dead；冷却按连续次数指数退避。
  - **Tier 2 per-(出口×模型)**：401/403/地区封锁通常是**模型级**（如 muse 的 RegionError），只封禁该「出口×模型」配对，出口服务其他模型不受影响。
- **配额冷却对齐上游真实重置时间**（2026-10-22 实测）：免费层对耗尽出口返回 `429 FreeUsageLimitError` + `retry-after: 26843~26851`（**≈7.4 小时**）。网关此前只做本地 60s 退避，于是每小时都在重撞一个未来 7 小时都不会答应的 IP。现在 `markFailure` 接收上游 `retry-after`，冷却取下限 `cooldownMs`、上限 `maxCooldownMs`，配额冷却也不再进入「池饥饿时采样短冷却出口」的兜底分支（那分支只留给传输抖动）。
- **一个出口 IP 只算一个出口**：节点地址 ≠ 出口 IP。实测 `10808` 与 `21006` 同时出网于 `47.131.86.109`，该 IP 配额一耗尽两者同秒一起 429。`pick()` 现按 `exitIP` 去重（同 IP 只取一个代表，优先 pinned、再低延迟），轮换预算也据此计数；`scripts/xray-pool.mjs gen --dedupe-egress` 可在生成 sidecar 时按实测出口 IP 收敛端口。
- **轮换有墙钟上限**：轮流重试次数按**可用独立出口**数计算（不再是含 dead/冷却的总数），并受 `rotateBudgetMs`（默认 45s）约束。此前 25 个槽位的脏池会让单个请求最多试 25 个出口、每个耗 6s 连接超时，最坏 150 秒才报错。
- **每出口并发上限**（`maxInflightPerExit`，默认 4）：长流不会把同一个 IP 的配额瞬间抽干；预留槽位幂等释放，成功、失败、客户端断开三条路径都会归还。
- **选择顺序**：pinned 固定出口 → 会话粘性（同对话粘同出口，保 prompt-cache）→ 最优健康节点（低延迟优先）。
- **轮换重试**（`gateway/gateway.ts`）：一次客户端请求内，若流在**任何内容落地之前**失败，网关透明换一个健康出口重发（有上限）；一旦有字节流出就停止轮换（已交付的流绝不重放）。
- **后台探活**（`pool/prober.ts`）：多站点可达性验证——先探网关自己的上游 `GET {zen}/v1/models`（出口能服务推理流量即为活），再试 Google 204 / YouTube / ipify（拿真实出口 IP，兼作路由键与展示值）。**任何 HTTP 应答（含 404/429/5xx）都证明隧道可用**，只有传输层错误（连接超时/重置/中止）才算失败——部分代理线路会硬重置 Google/YouTube（实测 2026-10-02：两条远程出口 ~0.3s 内 RST 所有 Google 连接而 opencode.ai 正常），仅靠通用站点判活会把健康出口误杀。全部站点失败才标记 dead；请求路径的传输失败只做短期冷却，死活判定权归探活的异地多站点验证。长期 dead 的免费节点被淘汰，手动出口永不淘汰（可被后续探活复活）。
- **每出口独立 dispatcher**（`pool/dispatchers.ts`）：direct 用 keep-alive Agent，代理用 ProxyAgent（`pipelining: 0` 规避野代理半开隧道），LRU 缓存防连接池泄漏。
- **流体空闲看门狗**（`gateway/upstream.ts`）：首字节 30s / 体空闲 120s（responses 300s），防止「隧道建立却永不推流」把请求挂死。

### 日志与自我修复

- **结构化日志**（`core/logger.ts`）：每条 JSON 行输出到 stdout（error/warn 走 stderr）+ 内存环形缓冲；调试网页经 `/admin/logs/stream`（SSE）实时订阅；日志级别可在运行时热切换。
- **请求追踪**：每次请求记录出口、出口 IP、状态码、尝试次数、耗时、结果，调试网页「请求」标签页可查。
- **自我修复看门狗**（`selfheal.ts`）：周期检查——目录过期则强制刷新；direct 出口被误标死亡则复活（保证网关永不「无出口可用」）；池长期无可用出口则告警；写 `~/.op2gw/status.json` 健康快照供外部监控。
- **外部看门狗**（`scripts/watchdog.sh` + launchd `com.op2gw.watchdog`，60s 一轮）：统计 `logs/op2gw.log` 尾部的**连续错误连击**——`attempt failed`、`level=error`、`pool degraded` 计入，`request ok` 清零，目录刷新告警视为中性；连击 ≥5 且最新错误在 10 分钟内时，执行一次带冷却（默认 10 分钟）的处置：**①更换链路**——把默认出口轮换到次健康的其他池出口（`POST /admin/settings/default-proxy` 热生效并持久化；网关无响应时直改 `~/.op2gw/config.json`）→ **②重启网关**——`launchctl kickstart -k com.op2gw.gateway` → **③更新所有可用的免费模型**——`POST /admin/catalog/refresh` + 全量复探出口。行为可用环境变量调参（阈值/冷却/新鲜度），`OP2GW_WATCHDOG_DRY_RUN=1` 只演练不执行；处置记录写入 `logs/watchdog.log`（健康时静默）。

---

## 模型可用性验证结果

12 个免费模型全部通过 `GET /v1/models` 暴露（实时计算，非静态清单）。能跑通的 8 个在
**chat / responses × 流式 / 非流式** 四条路径上全部通过；其余 4 个是上游侧不可用，状态码如实透传。
完整报告见 [VERIFY-REPORT.md](./VERIFY-REPORT.md)。

| 模型 | 线协议 | chat 非流式 | chat 流式 | responses 非流式 | responses 流式 |
| --- | --- | --- | --- | --- | --- |
| `big-pickle` | chat | ✅ | ✅ | ✅ | ✅ |
| `longcat-2.5-preview-free` | chat | ✅ | ✅ | ✅ | ✅ |
| `mimo-v2.5-free` | chat | ✅ | ✅ | ✅ | ✅ |
| `mimo-v2.6-flash-free` | chat | ✅ | ✅ | ✅ | ✅ |
| `space-bunny-free` | chat | ✅ | ✅ | ✅ | ✅ |
| `nemotron-3-ultra-free` | chat | ✅ | ✅ | ✅ | ✅ |
| `nemotron-3.5-lightning-free` | chat | ✅ | ✅ | ✅ | ✅ |
| `muse-spark-1.2-contributor-free` | **responses** | ✅ | ✅ | ✅ | ✅ |
| `muse-spark-1.3-contributor-free` | **responses** | ✅ | ✅ | ✅ | ✅ |
| `deepseek-v4-flash-free` | chat | ❌ 上游 400（Model is unavailable） | | | |
| `jev-1.13-free` | chat | ❌ 上游 500（Internal server error） | | | |
| `ling-3.0-flash-fin-free` | chat | ❌ 上游 400（Endpoint is unavailable） | | | |

> **muse-spark 两个模型四条路径全部可用**——包括 chat 客户端打 responses 线协议（网关内双向转码）。
> 三个失败模型在直连上游时同样失败，证明是上游侧原因而非网关问题。
>
> 零配置的「直连 + 不支持的国家」下 muse-spark 仍会 403：上游按**调用方国家**判定，此时网关会明确
> 报错而不是静默泄露操作者真实出口。给出境出口即可（见 `--pool` / 设置页）。

---

## 配置

零配置即可在 loopback 直连运行；可用 `~/.op2gw/config.json`、`--config <path>`、环境变量或命令行覆盖。op2gw 已删除本机客户端 API key 认证：`Authorization`、`x-api-key` 可省略、为空或填写任意值，均不会被网关校验。默认监听仍为 `127.0.0.1`，因此默认只接受本机访问；若显式把 `host`/`OP2GW_HOST` 设为 `0.0.0.0` 或其他非 loopback 地址，网关和 `/admin` 将在该网络范围内完全开放，请只在可信网络使用。上游请求仍固定使用匿名凭证 `Authorization: Bearer public`，不会转发客户端填写的值。


| 字段 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` / `port` | `OP2GW_HOST` / `OP2GW_PORT` | `127.0.0.1` / `8787` | 亦可 `--host` / `--port` |
| `zenBaseUrl` | `OP2GW_ZEN_URL` | `https://opencode.ai/inference` | 上游地址（旧的 `/zen` 对匿名请求已 403；`~/.op2gw/config.json` 里若固定了旧值需同步改掉） |
| `refreshSeconds` | `OP2GW_REFRESH_SECONDS` | `300` | 实时目录刷新间隔 |
| `logLevel` | `OP2GW_LOG_LEVEL` | `info` | debug/info/warn/error |
| `pool.enabled` | `OP2GW_POOL_ENABLED` | `false` | `--pool` 开启 |
| `pool.includeDirect` | `OP2GW_POOL_INCLUDE_DIRECT` | `true` | `false` = 出口只走代理，直连仅作最后手段 |
| `pool.manual` | `OP2GW_POOL_MANUAL` | `[]` | `http://h:p`、`socks5://h:p` |
| `pool.freeSources` | `OP2GW_POOL_FREE_SOURCES` | `[]` | 免费代理清单 URL（纯文本，每行一个） |
| `pool.freeTargetSize` | `OP2GW_POOL_FREE_TARGET` | `0` | 免费池目标规模；`0` = 关闭。公开清单对 opencode.ai 实测 0 存活（2026-10-22），默认不再启用 |
| `pool.maxRotateAttempts` | `OP2GW_POOL_MAX_ROTATE` | `3` | 单请求内最少轮换次数（实际按**可用独立出口**数上浮） |
| `pool.rotateBudgetMs` | `OP2GW_POOL_ROTATE_BUDGET_MS` | `45000` | 轮换循环的**墙钟**上限；超出即停止轮换并回最后一个真实上游错误，`0` 关闭 |
| `pool.honorRetryAfter` | `OP2GW_POOL_HONOR_RETRY_AFTER` | `true` | 用上游 `Retry-After` 作为该出口的配额冷却（免费层窗口以**小时**计） |
| `pool.cooldownMs` | `OP2GW_POOL_COOLDOWN_MS` | `60000` | 冷却下限（传输失败用此值） |
| `pool.maxCooldownMs` | `OP2GW_POOL_MAX_COOLDOWN_MS` | `8h` | 单次冷却上限，防异常头把出口停到很久以后 |
| `pool.maxInflightPerExit` | `OP2GW_POOL_MAX_INFLIGHT` | `4` | 每出口并发上限，`0` 不限；避免单个出口 IP 的配额被长流瞬间抽干 |
| `pool.pinnedExitId` | `OP2GW_POOL_PINNED` | `` | 固定主力出口 |
| `proxy` | `OP2GW_PROXY` | 自动检测 | 默认出口代理；留空直连，`--proxy`/`--no-proxy` |

### 默认使用本机代理

op2gw 首次启动时**自动从环境变量采集本机代理**（`https_proxy` / `http_proxy` /
`all_proxy`），把它设为默认出口——所有上游请求（含目录抓取和推理）都经它发出。
无需任何配置：只要 shell 里有代理变量，网关就用它。要显式指定或关闭：

```sh
./install.sh --proxy socks5://127.0.0.1:10808   # 指定
./install.sh --no-proxy                          # 强制直连
```

代理与 IP 池正交：代理是「单一默认出口」，池是「多出口轮换」。也可在**设置页**里
随时改，即时生效无需重启。

示例 `~/.op2gw/config.json`：

```json
{
  "port": 8787,
  "pool": {
    "enabled": true,
    "manual": ["socks5://127.0.0.1:1080"],
    "maxRotateAttempts": 3,
    "rotateBudgetMs": 45000,
    "honorRetryAfter": true,
    "maxInflightPerExit": 4
  }
}
```

---

## 接入示例

**opencode**：添加一个 OpenAI 兼容 provider，base URL 填 `http://127.0.0.1:8787/v1`，key 任意/留空，然后选 op2gw 暴露的模型。

**OpenAI Python SDK**：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
resp = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

**curl（流式）**：见上文一键安装小节。

---

## 端点一览

| 路由 | 用途 |
| --- | --- |
| `GET /healthz` | 存活探针 + 目录快照 |
| `GET /v1/models` | 免费模型清单（OpenAI 形状） |
| `POST /v1/chat/completions` | Chat Completions（流式 / 非流式聚合） |
| `POST /v1/responses` | Responses API（线协议由模型决定，与客户端协议无关，网关双向转码） |
| `POST /v1/messages` | **Anthropic Messages —— Claude Code 直接接入**（新增，纯附加） |
| `GET /admin/status` · `/admin/models` · `/admin/logs` · `/admin/logs/stream` · `/admin/traces` | 调试后端 |
| `POST /admin/pool/exits` · `/admin/pool/pin` · `/admin/pool/refresh` · `/admin/catalog/refresh` | 调试控制 |
| `GET /admin/settings` · `PUT /admin/settings` | 读取 / 更新配置（端口、代理、日志级别；代理与日志即时生效，端口保存后重启生效） |
| `GET /` | 调试控制台网页（含仿 omniroute 的设置页） |

---

## 目录结构

```
op2gw/
├── install.sh / install.ps1   一键安装启动脚本 (macOS·Linux / Windows)
├── src/
│   ├── index.ts               HTTP 服务器: /v1、/admin、静态 UI
│   ├── runtime.ts             子系统组装 + 生命周期
│   ├── selfheal.ts            自愈看门狗: 目录 + 池 + status.json
│   ├── core/                  types、logger、config、ids(伪装)、freelane(门禁)
│   ├── catalog/               S1/S2/S3 模型目录 + 静态知识(vouch)
│   ├── pool/                  ExitPool、每出口 dispatcher、免费源、探活
│   ├── gateway/               上游转发 + 编排(轮换/聚合)
│   └── admin/                 调试 JSON/SSE 后端
└── public/                    调试控制台 (index.html / app.css / app.js)
```

---

## 合规声明

op2gw 以官方 CLI 完全相同的方式（同款请求头、canonical 会话形状、`Bearer public`）使用 OpenCode 官方开放的匿名通道，**不伪造凭证、不破解、不绕过付费**。IP 池改变的只是「请求从哪台机器出口」，**默认关闭**，且匿名配额仍由上游按 IP 限流。请使用你自有的代理/订阅节点，并遵守上游服务条款。

## License

MIT
