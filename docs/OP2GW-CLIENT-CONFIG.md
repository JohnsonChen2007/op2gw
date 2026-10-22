# op2gw 客户端配置经验

更新时间：2026-10-22（Asia/Shanghai）

本文记录本机与两台远程 op2gw 网关的统一配置方式、模型能力、思考档位、客户端差异、备份策略和验证命令。

## 1. 三个标准节点

所有支持多 Provider 的客户端统一使用以下命名，避免同名模型互相覆盖：

| 节点名 | Base URL | 角色 |
|---|---|---|
| `op2gw-local` | `http://127.0.0.1:8787/v1` | 本机网关 |
| `op2gw-sg` | `http://47.129.162.250:8787/v1` | 新加坡远程网关 |
| `op2gw-us` | `http://13.221.11.95:8787/v1` | 美东远程网关 |

两台远程网关当前都应返回 `healthz.status=ok`，并暴露动态目录中的免费模型。模型目录不是永久静态清单：区域不可用或连续上游失败的模型可能被该节点临时隐藏，随后自动恢复。

op2gw 服务端不校验客户端 API key。部分客户端适配器仍要求存在一个非空 key，因此客户端配置统一使用无权限占位值 `public`；不要把 gost 代理密码写入客户端配置。

### 本地 env 凭据清单

本次配置涉及的 key、SSH 信息和 gost 凭据集中在项目根目录的 `.env.op2gw.local`：

```bash
cd /path/to/op2gw
set -a
source .env.op2gw.local
set +a
```

该文件已经被 [.gitignore](../.gitignore) 的 `.env.*` 规则忽略，权限为 `600`，不会进入 Git。内容包括：

- `OP2GW_API_KEY` / `OP2GW_CLIENT_API_KEY`：客户端占位 key，值为 `public`；
- `OP2GW_LOCAL_BASE_URL`、`OP2GW_SG_BASE_URL`、`OP2GW_US_BASE_URL`：三个网关地址；
- 两台服务器的 SSH 主机、用户和私钥路径；
- 新加坡和美东 gost 代理用户名/密码；
- `OP2GW_SG_GOST_PASSWORD`、`OP2GW_US_GOST_PASSWORD` 只供代理诊断脚本使用，不应写入客户端配置或公开 Security Group。

`tlscheck.mjs` 和 `scripts/sync-clients.mjs` 已改为从环境变量读取凭据，不再从配置文件抓取或硬编码真实密码。客户端配置文件中保留 `public` 是有意的：op2gw 网关不会校验客户端 key，且不同客户端对环境变量引用的支持不一致。

## 2. 当前已配置客户端

### Grok

配置文件：`~/.grok/config.toml`

已配置：

- `op2gw-local`
- `op2gw-sg`
- `op2gw-us`
- 每个节点 9 个免费模型
- 默认模型：`op2gw-local-deepseek-v4.1-flash-free`
- 默认思考程度：`high`

Grok 使用 TOML 的：

```toml
[model_providers.op2gw-sg]
base_url = "http://47.129.162.250:8787/v1"
api_backend = "chat_completions"
api_key = "public"

[model."op2gw-sg-beam-free"]
model = "beam-free"
model_provider = "op2gw-sg"
context_window = 1048576
max_completion_tokens = 131072
supports_reasoning_effort = true
```

验证：

```bash
grok --help # 查看 CLI
# 实际 smoke test：
grok --model op2gw-sg-beam-free -p 'Reply exactly GROK_SG_OK' --output-format plain --max-turns 1
```

> 上面的命令应使用本机实际安装的 `grok`；如果命令不存在，先用 `command -v grok` 检查安装路径。

### OMP

配置文件：

- `~/.omp/agent/models.yml`
- `~/.omp/agent/config.yml`

已配置三个 Provider，每个 Provider 9 个模型。默认角色模型为：

```yaml
modelRoles:
  default: op2gw-local/mimo-v2.6-flash-free:high
```

OMP 的模型格式是 YAML：

```yaml
providers:
  op2gw-sg:
    api: openai-completions
    baseUrl: http://47.129.162.250:8787/v1
    apiKey: public
    models:
      - id: beam-free
        reasoning: true
        contextWindow: 1048576
        maxTokens: 131072
```

验证：

```bash
omp -p --no-tools --model op2gw-sg/beam-free 'Reply exactly OMP_SG_OK'
```

### Kilo

当前 Kilo 配置文件：`~/.config/kilo/kilo.json`

已配置三个 Provider，每个 Provider 9 个模型。Kilo 使用 JSON，思考档位通过模型的 `variants` 表达：

```json
{
  "op2gw-sg": {
    "name": "op2gw 新加坡 free",
    "npm": "@ai-sdk/openai-compatible",
    "options": {
      "baseURL": "http://47.129.162.250:8787/v1",
      "apiKey": "public"
    },
    "models": {
      "beam-free": {
        "reasoning": true,
        "variants": {
          "low": { "reasoningEffort": "low" },
          "medium": { "reasoningEffort": "medium" },
          "high": { "reasoningEffort": "high" },
          "xhigh": { "reasoningEffort": "xhigh" },
          "max": { "reasoningEffort": "max" }
        },
        "limit": { "context": 1048576, "output": 131072 }
      }
    }
  }
}
```

验证：

```bash
kilo models op2gw-sg
```

### Pi Agent

配置文件：`~/.pi/agent/models.json`

Pi 已经配置完成，本轮跳过修改。当前有：

- `op2gw-local`
- `op2gw-sg`
- `op2gw-us`

每个节点 9 个模型。Pi 使用 `thinkingLevelMap` 描述可用思考档位。

### Claude Code

配置文件：`~/.claude/settings.json`

Claude Code 已经配置了本地兼容网关：

```json
{
  "ANTHROPIC_BASE_URL": "http://localhost:8787",
  "ANTHROPIC_AUTH_TOKEN": "nokey"
}
```

Claude Code 的环境变量模型是**单活动端点**，不是像 OpenCode/Kilo/Pi 那样的多 Provider 注册表。因此当前保留已有本地节点，不把两个远程节点伪装成并列 Provider。临时切换远程节点可以在启动时覆盖：

```bash
ANTHROPIC_BASE_URL=http://47.129.162.250:8787 \
ANTHROPIC_AUTH_TOKEN=public \
claude --model deepseek-v4.1-flash-free
```

切换到美东时将 URL 改为 `http://13.221.11.95:8787`。不要把三个地址同时写进同一个 `ANTHROPIC_BASE_URL`。

## 3. 已检查但本轮不修改的客户端

### Cursor

Cursor CLI 的 `~/.cursor/cli-config.json` 主要是权限、显示、会话和认证状态配置，没有可用的 OpenAI-compatible 多 Provider 注册表。Cursor 的模型路由由 Cursor 服务端和账号能力控制，因此没有安全的本地 op2gw 三节点配置可写入。

如果需要在 Cursor 中使用 op2gw，建议使用已经支持自定义 OpenAI-compatible Provider 的外部 CLI（如 Pi、Kilo、OpenCode、OMP），或在 Cursor 外部运行对应客户端。

### ZCode

ZCode 的实际 Provider 配置入口是：

- `~/.zcode/v2/provider_config.json`：Provider 连接、Provider 排序、模型选择器清单和模型规则
- `~/.zcode/v2/config.json`：运行时 Provider 元数据、上下文/输出限制和输入模态

已配置三个节点：

- `op2gw-local`
- `op2gw-sg`
- `op2gw-us`

每个节点 9 个模型，使用 ZCode 的 `openai-chat-completions` 连接类型；每个节点的模型清单、`contextWindow`、`maxOutputTokens` 和输入模态均已写入两份实际配置。修改前已备份：

- `~/.zcode/v2/provider_config.json.bak-20261022-124732-zcode-op2gw`
- `~/.zcode/v2/config.json.bak-20261022-124732-zcode-op2gw`

校验：

```bash
zcode doctor
```

ZCode 读取的是 `~/.zcode/v2`，不要只修改旧的 `~/.zcode/cli/migrations/` 文件；旧迁移文件不是当前运行时 Provider 配置。

### CodeBuddy

CodeBuddy 的正式用户级自定义模型入口是 `~/.codebuddy/models.json`。官方 schema 支持 OpenAI-compatible Chat Completions，关键字段包括：

- `id`：模型唯一 ID，而且会原样作为上游请求的 `model` 字段；
- `url`：必须写完整的 `/v1/chat/completions` 路径；
- `apiKey`：可以写占位 key，因为 op2gw 服务端不校验客户端 key；
- `maxInputTokens` / `maxOutputTokens`；
- `supportsToolCall` / `supportsImages` / `supportsReasoning`；
- `reasoning.defaultEffort` / `reasoning.supportedEfforts`。

CodeBuddy 的一个重要限制是：同一个 `models.json` 里不能把同一个真实上游模型用三个不同的展示 ID 注册后再指望网关识别，因为 `id` 会原样发送给上游。比如 `op2gw-sg-beam-free` 会被上游当成真实模型名并返回 `Model is unavailable`。

因此采用 CodeBuddy 官方支持的 `CODEBUDDY_CONFIG_DIR` profile 切换方式：每个 profile 使用真实模型 ID，但指向不同节点。

| Profile | 配置目录 | 节点 |
|---|---|---|
| 默认 | `~/.codebuddy` | `op2gw-local` |
| 新加坡 | `~/.codebuddy-op2gw-sg` | `op2gw-sg` |
| 美东 | `~/.codebuddy-op2gw-us` | `op2gw-us` |

切换示例：

```bash
# 本地（默认）
codebuddy --model beam-free

# 新加坡
CODEBUDDY_CONFIG_DIR="$HOME/.codebuddy-op2gw-sg" codebuddy --model beam-free

# 美东
CODEBUDDY_CONFIG_DIR="$HOME/.codebuddy-op2gw-us" codebuddy --model beam-free
```

当前每个 profile 都有 9 个真实模型 ID。配置文件权限为 `600`。本轮生成的备份是：

```text
~/.codebuddy/models.json.bak-20261022-130705-codebuddy
```

CodeBuddy 实际请求最初暴露了两个兼容性问题：它会在消息中附带 `agent` 和 `conversationRequestId` 字段，而上游免费模型拒绝未知字段。op2gw 已在 [protocol.ts](../src/gateway/protocol.ts) 的 Chat wire 整形阶段移除这两个 CodeBuddy 专属字段，并补充回归测试；本地与两台远程网关均重新构建、测试并重启。

远程源码回滚备份：

```text
/home/ubuntu/op2gw.bak-20261022-051014-codebuddy-compat
/home/ubuntu/op2gw.bak-20261022-051345-codebuddy-compat2
/home/ubuntu/src/op2gw.bak-20261022-020134
/home/ubuntu/src/op2gw.bak-20261022-051051-codebuddy-compat
/home/ubuntu/src/op2gw.bak-20261022-051433-codebuddy-compat2
```

真实验证结果：

```text
CODEBUDDY_LOCAL_OK
CODEBUDDY_SG_OK
CODEBUDDY_US_OK
```

### OpenBitFun

OpenBitFun 使用用户级配置文件：`~/.openbitfun/config.yaml`。当前已经存在三个命名 Provider：

- `op2gw-local` → `http://127.0.0.1:8787/v1`
- `op2gw-sg` → `http://47.129.162.250:8787/v1`
- `op2gw-us` → `http://13.221.11.95:8787/v1`

每个 Provider 都有 9 个模型、正确的 `limit.context` / `limit.output`、`reasoning`、`thinking.effortOptions` 和默认 `high`。YAML 解析及三节点模型数量校验均通过。本轮确认后跳过重复修改。

OpenBitFun 是桌面应用，配置变更后重启应用或重新加载模型目录。

### Qoder CLI

Qoder CLI 实际入口是：

```text
~/.qoder/bin/qodercli/qodercli-1.1.76
```

当前 `qodercli --list-models` 只显示 Qoder 平台内置模型，用户配置 [~/.qoder/settings.json](~/.qoder/settings.json) 只有默认模型和权限设置，没有 OpenAI-compatible 自定义 Provider、`baseURL`、模型 API key 或 `models.json` 入口。`qodercli --config-dir` 只提供配置目录隔离，不等于支持自定义 Provider。

因此本轮没有猜测性修改 Qoder 配置，也没有把 OpenBitFun/Kilo 的字段复制进去。当前 Qoder 处于“未配置 op2gw”状态；如果后续 Qoder 版本提供正式的 custom model/provider schema，应优先使用该入口，并用 `qodercli --list-models` 和一次 `-p` 请求验证。

### ChatGPT

本机没有独立的 `chatgpt` CLI，也没有发现可写的 ChatGPT 自定义 Provider 配置。ChatGPT 桌面/Web 客户端不提供将任意 OpenAI-compatible Base URL 注册为本地模型节点的通用配置，因此本轮不修改。

## 4. 模型上下文、输出和思考档位

当前客户端采用网关广告值：

| 模型 | 上下文 | 最大输出 | effort |
|---|---:|---:|---|
| `beam-free` | 1,048,576 | 131,072 | low/medium/high/xhigh/max |
| `big-pickle` | 1,048,576 | 131,072 | 未声明，只有 reasoning |
| `deepseek-v4.1-flash-free` | 1,048,576 | 131,072 | low/high/max |
| `flint-40b-free` | 1,048,576 | 131,072 | low/medium/high/xhigh/max |
| `glm-5.3-flash-free` | 1,048,576 | 131,072 | low/high/max |
| `mimo-v2.6-flash-free` | 1,048,576 | 131,072 | 未声明，只有 reasoning |
| `minimax-m3.1-flash-free` | 1,048,576 | 131,072 | low/medium/high/xhigh/max |
| `nemotron-3.5-lightning-free` | 1,048,576 | 131,072 | 未声明，只有 reasoning |
| `nemotron-3.5-super-vl-free` | 1,048,576 | 131,072 | none/minimal/low/medium/high/xhigh |

默认 effort 为 `high`。当前 op2gw 网关对所有已暴露免费模型统一广告 `contextWindow=1,048,576`、`maxOutputTokens=131,072`，这只是客户端预算广告，不等于每个上游模型的物理能力；请求仍可能受到上游真实上下文/输出限制。没有明确声明 effort 的模型不要强行附加 `reasoning_effort`，否则某些上游会拒绝请求。

## 5. 备份与修改原则

修改用户目录配置前：

1. 必须先用 `read` 或等价方式读取当前文件；不要复用旧快照的 `old_string`。
2. 先创建带时间戳的 `.bak-*` 备份。
3. 只修改目标 Provider，不覆盖其他 Provider、权限、插件和 hooks。
4. JSON/JSONC、YAML、TOML 修改后分别解析验证。
5. 已打开的客户端通常需要重启，或重新加载模型目录。
6. DSH profile 是展开后的配置，不要拿仓库中的 WorkBuddy 源补丁覆盖它。

本轮备份：

- `~/.grok/config.toml.bak-20261022-124148-more-agents`
- `~/.omp/agent/models.yml.bak-20261022-124148-more-agents`
- `~/.omp/agent/config.yml.bak-20261022-124148-more-agents`
- `~/.config/kilo/kilo.json.bak-20261022-124148-more-agents`

此前其他客户端的备份仍保留在各自配置目录中。

## 6. 通用验证命令

检查三个网关：

```bash
for url in \
  http://127.0.0.1:8787 \
  http://47.129.162.250:8787 \
  http://13.221.11.95:8787; do
  curl --noproxy '*' "$url/healthz"
done
```

检查模型目录：

```bash
curl --noproxy '*' http://47.129.162.250:8787/v1/models
curl --noproxy '*' http://13.221.11.95:8787/v1/models
```

Smoke test 示例：

```bash
# Grok
grok --model op2gw-sg-beam-free -p 'Reply exactly OK' --output-format plain --max-turns 1

# OMP
omp -p --no-tools --model op2gw-sg/beam-free 'Reply exactly OK'

# Kilo
kilo models op2gw-sg

# Pi
pi -p --no-session --no-tools --model op2gw-sg/beam-free --thinking high 'Reply exactly OK'

# OpenCode
opencode run --standalone --model op2gw-sg/beam-free 'Reply exactly OK'

# MiniMax Code
mcode exec --model custom_provider:op2gw-sg/beam-free --effort high --permission off --max-steps 1 'Reply exactly OK'

# DSH
OP2GW_API_KEY=public dsh --profile headless --json 'Reply exactly OK'
```

## 7. 当前验证结果

本轮实际验证：

- Grok：三节点配置解析通过；新加坡节点真实请求成功。
- OMP：三节点 YAML 解析通过；新加坡节点真实请求成功。
- Kilo：三节点 JSON 解析通过；新加坡节点模型目录可见。
- Pi：原有三节点配置已存在，本轮跳过。
- 三个 op2gw 网关：`healthz=ok`，各返回 9 个模型；当前出口池健康。
- ZCode：`~/.zcode/v2/provider_config.json` 与 `~/.zcode/v2/config.json` 均已配置 `op2gw-local`、`op2gw-sg`、`op2gw-us`，每个 9 个模型；`zcode doctor` 通过。重启 ZCode 后模型选择器刷新。
- OpenBitFun：`~/.openbitfun/config.yaml` 已有三个节点，各 9 个模型；YAML 解析和节点计数通过。
- Qoder CLI：`qodercli --list-models` 只显示平台内置模型；`qodercli status -o json` 显示 `allow_byok=0`，且没有发现正式自定义 Provider schema，因此未猜测性修改。
- CodeBuddy：已通过 `~/.codebuddy/models.json` 及两个 `CODEBUDDY_CONFIG_DIR` profile 配置三个节点，三节点真实调用通过。
- Cursor、ChatGPT：没有发现安全、稳定、可写的多 Provider 配置 schema，本轮没有猜测性修改。
- Claude Code：已有本地单端点配置，保留不改；远程节点可通过启动环境变量临时切换。

## 8. 本机 Agent 覆盖矩阵

以下是本机当前发现的 Agent/CLI 与 op2gw 配置覆盖情况：

| Agent/CLI | 已配置节点 | 模型覆盖 | 验证状态 |
|---|---|---:|---|
| OpenCode | local / sg / us | 3 × 9 | 真实调用通过 |
| Pi Agent | local / sg / us | 3 × 9 | 真实调用通过 |
| DSH Web/TUI/Headless | local / sg / us | 3 × 9 | profile 合成、Headless 调用通过 |
| MiniMax Code | local / sg / us | 3 × 9 | 真实调用通过 |
| OpenBitFun | local / sg / us | 3 × 9 | YAML 与节点计数通过；桌面应用需重启后刷新 |
| Kimi Code | local / sg / us | 3 × 9 | doctor 与真实调用通过 |
| Grok | local / sg / us | 3 × 9 | TOML 与真实调用通过 |
| OMP | local / sg / us | 3 × 9 | YAML 与真实调用通过 |
| Kilo | local / sg / us | 3 × 9 | JSON 与模型列表通过 |
| ZCode | local / sg / us | 3 × 9 | `zcode doctor` 通过；重启后刷新选择器 |
| Claude Code | local 默认；sg/us 可启动时切换 | 单端点 | 本地配置存在；多节点需环境变量切换 |
| CodeBuddy | local / sg / us（3 个 `CODEBUDDY_CONFIG_DIR` profile） | 3 × 9 | 三节点真实调用通过 |
| Qoder CLI | 未配置 | — | 仅内置平台模型，未发现自定义 Provider schema |
| Cursor CLI | 未配置 | — | CLI 配置无自定义 Provider schema |
| ChatGPT CLI | 未配置 | — | 本机没有独立 CLI 或可写 Provider 配置 |

“本机所有安装的 Agent”按当前 PATH 和已发现配置目录盘点：支持自定义 OpenAI-compatible Provider 的客户端均已配置；Qoder、Cursor、ChatGPT 因缺少可用的正式自定义 Provider 入口而明确保持未配置，没有猜测性写入内部状态或数据库。
