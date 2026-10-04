# op2gw 讲解视频

约 3 分钟的中文讲解视频，横屏与竖屏各一支。文案内容全部取自本仓库实测：
`README.md`、`package.json`、`VERIFY-REPORT.md`，以及 `npm test` 的真实结果（159 passed / 0 failed）。

## 产出

| 文件 | 分辨率 | 时长 | 大小 |
| --- | --- | --- | --- |
| `op2gw-讲解-16x9-横屏.mp4` | 1920×1080 | 2:59 | 25 MB |
| `op2gw-讲解-9x16-竖屏.mp4` | 1080×1920 | 2:59 | 27 MB |

编码：H.264（yuv420p / 30fps）+ AAC 48kHz 立体声，`+faststart`。
竖版底部预留 210px 安全区，适合 Shorts / Reels。

## 分镜

| # | 标题 | 内容 |
| --- | --- | --- |
| 01 | 封面 | op2gw 是什么 |
| 02 | 谁写的 | 作者 johnson202609、MIT、2 次提交、159 测试 |
| 03 | 为什么是网关 | 插件 vs 网关：HTTP 客户端归属决定能否按请求选出口 |
| 04 | 两道门禁 | 会话形状门禁 + 智能体形态门禁，`Bearer public` |
| 05 | 多出口 IP 池 | Tier1 出口级 / Tier2 出口×模型级，会话粘性与轮换重试 |
| 06 | 实时模型目录 | S1/S2/S3 三源回退链，12 个免费模型 8 个全通 |
| 07 | 调试台与自愈 | `/v1/models`、`/admin/*`、自愈看门狗 |
| 08 | 怎么用 | `install.sh` / `install.ps1`、验证与接入 |

## 重新生成

```sh
cd video/build
python3 build.py            # 完整重跑（含 TTS）
REUSE_TTS=1 python3 build.py # 复用已有配音，只重渲染画面与合成
```

依赖：ffmpeg、Python 3、`edge-tts`（`pip install edge-tts`）、
以及 Playwright 缓存里的 `chrome-headless-shell`（用于截图幻灯片）。

### 文件

- `scenes.py` — 文案与幻灯片内容（改这里就能改内容）
- `slides.py` — HTML/CSS 模板，横竖屏共用一套设计语言、只改尺度；
  内含一段自动缩放脚本，内容超出一屏时整体等比缩小
- `build.py` — 流水线：TTS → 截图 → ffmpeg 合成

### 流水线要点

1. **语速自适应**：先按 +20% 合成，测出总时长后按比例回调语速，
   最多三轮逼近 180 秒（本次收敛到 +24%）。中文讲解不宜再快。
2. **幻灯片**：场景数据 → HTML → `chrome-headless-shell` 截图，
   约 0.4 秒一张。用无头壳而不是完整 Chrome——后者会挂起。
3. **转场**：相邻场景用 `xfade` / `acrossfade` 叠化 0.45 秒。
   转场点落在场景间的静音区，所以不会切到任何一句词；
   早期版本每刀都淡入淡出到全黑，场景切换处会闪一帧黑屏，已废弃。
4. **动态**：静图叠 `zoompan` 缓慢推镜，画面不呆。
5. **响度**：`loudnorm` 统一到 -16 LUFS（实测 mean -20 dB / peak -1.5 dB）。
