# WorkBuddy bridge backup

Snapshot of the working WorkBuddy CN + AI setup used by OmniRoute. Code only:
no credentials, no `.bridge-key`, no logs.

## Provenance and licensing

`plugin/` is a **snapshot of a third-party project**, not original work:

| Field | Value |
|---|---|
| Upstream | `dsh-workbuddy-connect` — <https://github.com/corrinehu/dsh-workbuddy-connect> |
| Upstream author | Corrine Hu |
| Upstream license | MIT (see `plugin/LICENSE`) |
| Snapshot version | `0.6.5` (`plugin/package.json`) |
| Local changes | `patches/plugin-upstream.patch` (adds the AI channel-verification headers) |

`bridge/`, `patches/`, `launchd/`, and `acceptance/` are original work of this
repository, MIT-licensed like the rest of op2gw.

**No machine-specific data is committed here.** Absolute paths are replaced by
placeholders (`__HOME__`, `__BRIDGE_DIR__`, `__PATH__`) or resolved at runtime
via `homedir()` / environment variables. The OmniRoute connection id needed by
the acceptance script is read from `WB_AI_CONNECTION_ID` instead of being
pinned. See the Restore section for how to fill these in.

## Layout

| Path | What it is |
|---|---|
| `bridge/bridge.mjs` | The running OpenAI-compatible bridge (patched). |
| `plugin/` | Snapshot of `dsh-workbuddy-connect` (source, tests, built `lib/`; no `node_modules`/`.git`). |
| `patches/plugin-upstream.patch` | Source diff that adds the AI channel-verification headers. |
| `patches/bridge-changes.patch` | Bridge diff against the pre-fix backup, for review. |
| `launchd/com.omniroute.workbuddy-bridge.plist` | LaunchAgent TEMPLATE (placeholders, not real paths). |
| `acceptance/workbuddy_acceptance.py` | Live end-to-end checks (9 assertions). |

## Key fixes captured here

1. **AI channel verification.** `https://www.workbuddy.ai` rejects chat calls
   without desktop-client conversation headers (`400 / code 11128`). The plugin
   now adds `X-Agent-Intent: craft` plus UUID `X-Conversation-*` / `X-Request-ID`
   headers **only for the `global` region**, so the CN wire is unchanged.
2. **Model prefix parsing.** `workbuddy-ai/<model>` is stripped with a direct
   `replace` before the body is prepared. The previous regex path produced an
   empty model and upstream returned `model [] service info not found`.
3. **Variant routing.** OmniRoute strips the provider prefix, so both products
   would otherwise resolve to CN for shared model ids. Each OmniRoute provider
   connection must send a variant hint. This is stored in
   `provider_connections.provider_specific_data` as:
   - `WorkBuddy`     -> `{"customHeaders":{"x-workbuddy-variant":"workbuddy"}}`
   - `WorkBuddy AI`  -> `{"customHeaders":{"x-workbuddy-variant":"workbuddy-ai"}}`

   `provider_nodes.custom_headers_json` is intentionally empty; the running
   request builder reads `providerSpecificData.customHeaders`, not the node row.
4. **Scoped catalogs.** `GET /v1/models` returns only the variant named by
   `x-workbuddy-variant` when that header is present; otherwise it keeps the
   historical merged list.
5. **Electron env ordering.** `WORKBUDDY_ELECTRON_BIN` and
   `WORKBUDDY_AI_ELECTRON_BIN` are set before the plugin is imported, so
   encrypted credential envelopes can always be opened.

## Restore

```bash
# SRC = this workbuddy-bridge directory; PLUGIN = your dsh-workbuddy-connect checkout
SRC=~/src/op2gw/workbuddy-bridge
PLUGIN=~/dsh-workbuddy-connect

# 1. plugin
rsync -a --exclude node_modules "$SRC/plugin/" "$PLUGIN/"
cd "$PLUGIN" && pnpm install && pnpm run build

# 2. bridge
mkdir -p ~/.omniroute/workbuddy-bridge
cp "$SRC/bridge/bridge.mjs" ~/.omniroute/workbuddy-bridge/
# recreate the shared secret (must match the API key stored in OmniRoute)
openssl rand -hex 16 > ~/.omniroute/workbuddy-bridge/.bridge-key

# 3. launchd — the tracked plist is a TEMPLATE; substitute its placeholders
#    (__HOME__, __BRIDGE_DIR__, __PATH__) for your machine before loading it.
mkdir -p ~/Library/LaunchAgents
sed -e "s#__HOME__#$HOME#g" \
    -e "s#__BRIDGE_DIR__#$HOME/.omniroute/workbuddy-bridge#g" \
    "$SRC/launchd/com.omniroute.workbuddy-bridge.plist" \
    > ~/Library/LaunchAgents/com.omniroute.workbuddy-bridge.plist
launchctl load ~/Library/LaunchAgents/com.omniroute.workbuddy-bridge.plist
```

Then point both OmniRoute providers at `http://127.0.0.1:11459/v1`, using the
same secret as the provider API key, and set the custom headers above.

## Acceptance

```bash
# WB_AI_CONNECTION_ID = the OmniRoute connection id of your WorkBuddy AI
# provider (a per-install row id; read it from OmniRoute's provider list).
WB_AI_CONNECTION_ID=<your-ai-connection-uuid> \
  python3 "$SRC/acceptance/workbuddy_acceptance.py"
```

Expected: `9/9 checks passed`. The last check reads OmniRoute `call_logs` and
asserts that `workbuddy-ai/hy3` used the WorkBuddy AI connection, not CN.

## Known limitations

- WorkBuddy AI is a **free** account. GPT/Gemini/Grok models return
  `11158 model not allowed for user type personal_free_user`.
- AI models verified working: `hy3`, `step-5-preview`, `space-bunny`,
  `kimi-k3`, `kimi-k2.8-preview`, `kimi-k2.7`, `kimi-k2.6`,
  `minimax-m3.1-flash`, `minimax-m3`, `deepseek-v4.1-flash`.
- OmniRoute model sync may omit some reasoning models from the dashboard list;
  direct `workbuddy-ai/<model>` calls still work. A `workbuddy-ai/kimi-k3`
  alias is present locally for discoverability.
- Model sync can overwrite hand-added aliases; provider custom headers persist.
- CN token lifetime is short (days) and relies on refresh; AI token is longer.
  Re-login in the desktop app if refresh ever fails.
