# -*- coding: utf-8 -*-
"""
op2gw 讲解视频构建器
  TTS (edge-tts) → headless Chrome 幻灯片截图 → ffmpeg 合成
产出：16:9 横屏 + 9:16 竖屏各一支 MP4
"""

import asyncio
import json

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scenes import SCENES  # noqa: E402
from slides import ASPECTS, render  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent          # video/
BUILD = ROOT / "build"
AUD = BUILD / "audio"
SLIDES = BUILD / "slides"
CLIPS = BUILD / "clips"

# Playwright 自带的 chrome-headless-shell：专用无头壳，~0.4s/张，比完整 Chrome 快且不会挂起
CHROME = next(
    (str(p) for p in Path.home().glob(
        "Library/Caches/ms-playwright/chromium_headless_shell-*/"
        "chrome-headless-shell-*/chrome-headless-shell") if p.exists()),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
VOICE = "zh-CN-YunxiNeural"
TARGET_SECONDS = 180.0          # 3 分钟
LEAD_IN, TAIL, GAP = 1.0, 1.6, 0.55   # 片头静默 / 片尾静默 / 场景间呼吸
XFADE = 0.45                          # 场景叠化时长，落在 GAP 静音区内
FPS = 30


def sh(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def dur(path):
    out = sh(["ffprobe", "-v", "error", "-show_entries", "format=duration",
              "-of", "csv=p=0", str(path)]).stdout.decode().strip()
    return float(out)


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- 1. TTS
async def _synth(text, voice, rate, out: Path):
    import edge_tts
    c = edge_tts.Communicate(text, voice, rate=rate)
    await c.save(str(out))


def synth_all(rate):
    AUD.mkdir(parents=True, exist_ok=True)
    async def run():
        for i, sc in enumerate(SCENES, 1):
            out = AUD / f"{sc['id']}.mp3"
            await _synth(sc["narration"], VOICE, rate, out)
            log(f"   TTS {i}/{len(SCENES)}  {sc['id']:<16} {dur(out):6.2f}s")
    asyncio.run(run())
    return [dur(AUD / f"{sc['id']}.mp3") for sc in SCENES]


def total_of(durs):
    # 与 clip 长度算法保持一致：每个场景尾随一个 GAP，首尾再加片头/片尾静默
    return LEAD_IN + TAIL + sum(durs) + GAP * len(durs)


# ---------------------------------------------------------------- 2. 幻灯片
def shoot(scene, aspect, progress, path: Path):
    d = ASPECTS[aspect]
    tmpdir = Path(tempfile.mkdtemp(prefix="op2gw-shot-"))
    htmlp = tmpdir / "slide.html"
    htmlp.write_text(render(scene, aspect, progress), encoding="utf-8")
    try:
        sh([CHROME,
            "--headless", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
            "--force-device-scale-factor=1", "--disable-lcd-text",
            "--disable-extensions", "--no-first-run",
            "--virtual-time-budget=3000",
            f"--window-size={d['w']},{d['h']}",
            f"--screenshot={path}",
            htmlp.as_uri()])
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------- 3. 合成
def clip_cmd(i, sc, aspect, length):
    """单场景片段：静图 + 缓慢推镜（Ken Burns），音频按长度补静音。

    这里不做任何淡入淡出——场景之间统一由 xfade 叠化，否则每刀都会闪一帧全黑。
    """
    d = ASPECTS[aspect]
    src = SLIDES / aspect / f"{sc['id']}.png"
    out = CLIPS / aspect / f"{i:02d}.mp4"
    nframes = int(round(length * FPS))
    zoom_end = 1.10 if i % 2 == 0 else 1.0
    # 先放大到 2 倍再 zoompan，避免静图抖动
    vf = (
        f"scale={d['w']*2}:{d['h']*2}:flags=lanczos,"
        f"zoompan=z='min(1+({zoom_end}-1)*on/{max(nframes-1,1)},{zoom_end})'"
        f":d={nframes}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        f":s={d['w']}x{d['h']}:fps={FPS},format=yuv420p"
    )
    sh(["ffmpeg", "-y", "-v", "error",
        "-loop", "1", "-i", str(src),
        "-i", str(AUD / f"{sc['id']}.mp3"),
        "-filter_complex",
        f"[1:a]apad,atrim=0:{length:.3f},aresample=48000,"
        f"loudnorm=I=-16:TP=-1.5:LRA=11[a];"
        f"[0:v]{vf}[v]",
        "-map", "[v]", "-map", "[a]",
        "-t", f"{length:.3f}",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-r", str(FPS), "-movflags", "+faststart", str(out)])
    return out


def build(aspect, durs):
    (CLIPS / aspect).mkdir(parents=True, exist_ok=True)
    lengths = []
    clips = []
    for i, sc in enumerate(SCENES):
        length = durs[i] + GAP
        if i == 0:
            length += LEAD_IN
        if i == len(SCENES) - 1:
            length += TAIL
        lengths.append(length)
        clips.append(clip_cmd(i, sc, aspect, length))

    # 相邻场景叠化。转场落在 GAP 静音区里（片头 LEAD_IN / 片尾 TAIL 也是静音），
    # 所以 acrossfade 不会切到任何一句词。
    n = len(clips)
    chain, cur_v, cur_a = [], "0:v", "0:a"
    off = lengths[0] - XFADE
    for i in range(1, n):
        chain.append(f"[{cur_v}][{i}:v]xfade=transition=fade:duration={XFADE}"
                     f":offset={off:.3f}[vx{i}]")
        chain.append(f"[{cur_a}][{i}:a]acrossfade=d={XFADE}:c1=tri:c2=tri[ax{i}]")
        cur_v, cur_a = f"vx{i}", f"ax{i}"
        off += lengths[i] - XFADE
    total = off + XFADE

    # 首尾各做一次整体淡入淡出（落在片头/片尾静默上）
    chain.append(f"[{cur_v}]fade=t=in:st=0:d=0.6,"
                 f"fade=t=out:st={total - 1.0:.3f}:d=1.0[vout]")
    chain.append(f"[{cur_a}]afade=t=in:st=0:d=0.6,"
                 f"afade=t=out:st={total - 1.0:.3f}:d=1.0[aout]")

    dest = ROOT / ("op2gw-讲解-16x9-横屏.mp4" if aspect == "landscape"
                   else "op2gw-讲解-9x16-竖屏.mp4")
    args = ["ffmpeg", "-y", "-v", "error"]
    for c in clips:
        args += ["-i", str(c)]
    args += [
        "-filter_complex", ";".join(chain),
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-r", str(FPS), "-movflags", "+faststart", str(dest),
    ]
    sh(args)
    return dest


# ---------------------------------------------------------------- main
def main():
    reuse = os.environ.get("REUSE_TTS") == "1" and all(
        (AUD / f"{sc['id']}.mp3").exists() for sc in SCENES)

    for p in (SLIDES, CLIPS):
        shutil.rmtree(p, ignore_errors=True)
    for p in (AUD, SLIDES, CLIPS):
        p.mkdir(parents=True, exist_ok=True)

    # --- 语速自适应，逼近 180s（基准 +20%，中文讲解不至于太赶）---
    rate = "+20%"
    if reuse:
        log("\n[1/4] TTS  复用已有配音（REUSE_TTS=1）")
        durs = [dur(AUD / f"{sc['id']}.mp3") for sc in SCENES]
        tj = BUILD / "timing.json"
        if tj.exists():
            rate = json.loads(tj.read_text(encoding="utf-8")).get("rate", rate)
        log(f"   总时长 {total_of(durs):.1f}s  rate={rate}")
    else:
        for attempt in range(3):
            log(f"\n[1/4] TTS  pass={attempt+1}  rate={rate}")
            durs = synth_all(rate)
            tot = total_of(durs)
            log(f"   总时长 {tot:.1f}s (目标 {TARGET_SECONDS}s)")
            if abs(tot - TARGET_SECONDS) <= 5.0:
                break
            adj = tot / TARGET_SECONDS
            pct = int(rate.strip("+-%")) + round((adj - 1.0) * 100)
            pct = max(-15, min(60, pct))
            new_rate = f"{pct:+d}%"
            if new_rate == rate:
                break
            rate = new_rate
            log(f"   → 调整语速至 {rate}")

    # --- 幻灯片（进度条按累计时长） ---
    log("\n[2/4] 渲染幻灯片")
    lengths = []
    for i, sc in enumerate(SCENES):
        lengths.append(durs[i] + GAP + (LEAD_IN if i == 0 else 0)
                       + (TAIL if i == len(SCENES) - 1 else 0))
    total = sum(lengths)
    acc = 0.0
    for i, sc in enumerate(SCENES):
        for aspect in ASPECTS:
            out = SLIDES / aspect / f"{sc['id']}.png"
            out.parent.mkdir(parents=True, exist_ok=True)
            shoot(sc, aspect, acc / total, out)
        acc += lengths[i]
        log(f"   {i+1}/{len(SCENES)}  {sc['id']:<16} {lengths[i]:6.2f}s")

    # --- 合成 ---
    log("\n[3/4] 合成片段")
    made = []
    for aspect in ASPECTS:
        log(f"   合成 {ASPECTS[aspect]['label']}")
        made.append(build(aspect, durs))

    log("\n[4/4] 产出")
    for m in made:
        log(f"   {m.name}   {dur(m):.1f}s   "
            f"{ASPECTS['landscape' if '16x9' in m.name else 'portrait']['w']}x"
            f"{ASPECTS['landscape' if '16x9' in m.name else 'portrait']['h']}")

    (BUILD / "timing.json").write_text(json.dumps(
        {"rate": rate, "scenes": [{"id": s["id"], "duration": l}
                                  for s, l in zip(SCENES, lengths)]},
        ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
