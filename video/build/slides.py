# -*- coding: utf-8 -*-
"""把场景数据渲染成 HTML 幻灯片，由 headless Chrome 截图为 PNG。"""

import html

ASPECTS = {
    "landscape": {"w": 1920, "h": 1080, "label": "16:9 横屏"},
    "portrait": {"w": 1080, "h": 1920, "label": "9:16 竖屏"},
}


def esc(s):
    return html.escape(str(s), quote=True)


def _base_css(a):
    """横屏/竖屏共用一套设计语言，只有尺度不同。"""
    if a == "landscape":
        pad, kicker, title, lead, body = 96, 24, 78, 32, 27
        gap, card_pad, radius = 34, 38, 22
        hero_title, cols = 168, 2
    else:
        pad, kicker, title, lead, body = 72, 25, 74, 30, 29
        gap, card_pad, radius = 26, 31, 21
        hero_title, cols = 130, 1

    return f"""
  :root {{
    --pad:{pad}px; --kicker:{kicker}px; --title:{title}px; --lead:{lead}px;
    --body:{body}px; --gap:{gap}px; --card-pad:{card_pad}px; --radius:{radius}px;
    --hero-title:{hero_title}px; --cols:{cols};
  }}
  * {{ box-sizing:border-box; margin:0; padding:0; }}
  html,body {{ width:100%; height:100%; }}
  body {{
    background:#070A12; color:#E8EDF7;
    font-family:"PingFang SC","Hiragino Sans GB","Heiti SC",-apple-system,sans-serif;
    font-feature-settings:"tnum";
    display:flex; flex-direction:column; overflow:hidden; position:relative;
  }}
  /* 背景光晕 + 网格 */
  body::before {{
    content:""; position:absolute; inset:0;
    background:
      radial-gradient(60% 45% at 12% 6%, rgba(56,189,248,.20), transparent 62%),
      radial-gradient(55% 45% at 92% 96%, rgba(167,139,250,.18), transparent 60%),
      linear-gradient(160deg,#0A0F1C 0%,#070A12 55%,#0B0A16 100%);
  }}
  body::after {{
    content:""; position:absolute; inset:0; opacity:.5;
    background-image:
      linear-gradient(rgba(255,255,255,.028) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.028) 1px, transparent 1px);
    background-size:{'72px' if a=='landscape' else '62px'} {'72px' if a=='landscape' else '62px'};
    mask-image:radial-gradient(80% 70% at 50% 40%, #000 30%, transparent 100%);
  }}
  .slide {{ position:relative; z-index:2; display:flex; flex-direction:column;
            height:100%; padding:var(--pad); }}
  /* 竖版为 Shorts / Reels 留出底部 UI 安全区 */
  .slide {{ {'padding:64px 64px 210px;' if a == 'portrait' else ''} }}

  /* ---- 顶栏 ---- */
  .top {{ display:flex; align-items:center; gap:20px; margin-bottom:var(--gap); }}
  .kicker {{
    font-size:var(--kicker); font-weight:700; letter-spacing:.20em; text-transform:uppercase;
    color:#7DD3FC; padding:11px 20px; border-radius:999px;
    background:rgba(56,189,248,.10); border:1px solid rgba(56,189,248,.30);
  }}
  .idx {{ font-size:var(--kicker); font-weight:700; color:#3D4A63; letter-spacing:.14em;
          font-family:"SF Mono",Menlo,monospace; }}
  .rule {{ flex:1; height:1px; background:linear-gradient(90deg,rgba(125,211,252,.42),transparent); }}

  h1.title {{ font-size:var(--title); font-weight:800; letter-spacing:-.015em; line-height:1.14;
              margin-bottom:.42em; }}
  h1.title .hl {{ background:linear-gradient(96deg,#38BDF8,#A78BFA 72%);
                  -webkit-background-clip:text; background-clip:text; color:transparent; }}
  p.lead {{ font-size:var(--lead); line-height:1.52; color:#9FB0CC; max-width:96%;
            margin-bottom:var(--gap); flex:0 0 auto; }}

  /* 标题 + 导语 + 正文作为一整块在画面中垂直居中，避免正文被单独居中后
     与导语之间出现大片空洞 */
  .main {{ flex:1; display:flex; flex-direction:column; justify-content:center; min-height:0; }}
  .body {{ display:flex; flex-direction:column; gap:var(--gap); }}
  /* 子项不压缩（内容超出后由 JS 整体缩放） */
  .body > * {{ flex:0 0 auto; }}
  .grid2 {{ display:grid; grid-template-columns:repeat(var(--cols),1fr); gap:var(--gap); }}

  /* ---- 卡片 ---- */
  .card {{ background:linear-gradient(150deg,rgba(255,255,255,.062),rgba(255,255,255,.022));
           border:1px solid rgba(255,255,255,.10); border-radius:var(--radius);
           padding:var(--card-pad); display:flex; flex-direction:column; gap:.55em;
           position:relative; overflow:hidden; }}
  .card::before {{ content:""; position:absolute; left:0; top:0; bottom:0; width:4px;
                   background:linear-gradient(180deg,#38BDF8,#A78BFA); opacity:.9; }}
  .card .k {{ font-size:calc(var(--body)*.80); font-weight:700; letter-spacing:.14em;
              color:#7DD3FC; text-transform:uppercase; }}
  .card .v {{ font-size:calc(var(--body)*1.24); font-weight:800; color:#fff; line-height:1.28;
              font-family:"SF Mono",Menlo,monospace; letter-spacing:-.01em; }}
  .card .s {{ font-size:calc(var(--body)*.88); color:#93A4C0; line-height:1.5; }}

  /* ---- 对比 ---- */
  .cmp {{ display:grid; grid-template-columns:1fr auto 1fr; gap:var(--gap); align-items:stretch; }}
  .side {{ border-radius:var(--radius); padding:var(--card-pad); border:1px solid rgba(255,255,255,.10);
           background:rgba(255,255,255,.035); }}
  .side.bad h3 {{ color:#F0A5A5; }}
  .side.good {{ background:linear-gradient(150deg,rgba(56,189,248,.13),rgba(167,139,250,.07));
                border-color:rgba(56,189,248,.34); }}
  .side.good h3 {{ color:#7DD3FC; }}
  .side h3 {{ font-size:calc(var(--body)*1.06); font-weight:800; margin-bottom:.7em;
              letter-spacing:.02em; }}
  .side li {{ list-style:none; font-size:calc(var(--body)*.92); color:#A6B6D0; line-height:1.5;
              padding-left:1.15em; position:relative; margin-bottom:.52em; }}
  .side.good li {{ color:#D6E4F8; }}
  .side li::before {{ content:""; position:absolute; left:0; top:.62em; width:7px; height:7px;
                      border-radius:50%; background:#4A5875; }}
  .side.good li::before {{ background:#38BDF8; box-shadow:0 0 10px #38BDF8; }}
  .vs {{ align-self:center; font-size:calc(var(--body)*.86); font-weight:800; color:#46536E;
         letter-spacing:.18em; }}

  /* ---- 步骤 / 来源 / 分层 ---- */
  .step {{ display:flex; flex-direction:column; gap:.45em; }}
  .step .row {{ display:flex; align-items:baseline; gap:14px; }}
  .step .n {{ font-size:calc(var(--body)*.92); font-weight:800; color:#38BDF8;
              font-family:"SF Mono",Menlo,monospace; }}
  .step .t {{ font-size:calc(var(--body)*1.16); font-weight:800; color:#fff; }}
  .step .d {{ font-size:calc(var(--body)*.80); color:#7DD3FC; font-family:"SF Mono",Menlo,monospace; }}
  .step .b {{ font-size:calc(var(--body)*.92); color:#9FB0CC; line-height:1.55; }}

  .src {{ display:flex; gap:var(--gap); flex-direction:column; }}
  .src .item {{ display:flex; align-items:flex-start; gap:20px; background:rgba(255,255,255,.038);
                border:1px solid rgba(255,255,255,.09); border-radius:var(--radius);
                padding:calc(var(--card-pad)*.78) var(--card-pad); }}
  .src .tag {{ font-size:calc(var(--body)*1.02); font-weight:900; color:#0A0F1C; flex:none;
               background:linear-gradient(135deg,#38BDF8,#A78BFA); border-radius:12px;
               padding:.16em .62em; letter-spacing:.04em; }}
  .src .txt {{ flex:1; min-width:0; }}
  .src .t {{ font-size:calc(var(--body)*1.02); font-weight:700; color:#fff;
             font-family:"SF Mono",Menlo,monospace; margin-bottom:.22em; }}
  .src .b {{ font-size:calc(var(--body)*.88); color:#93A4C0; line-height:1.45; }}
  .src .r {{ flex:none; align-self:center; font-size:calc(var(--body)*.76); color:#7DD3FC;
             font-weight:700; white-space:nowrap; }}

  .tier {{ display:flex; gap:18px; align-items:flex-start; background:rgba(255,255,255,.038);
           border:1px solid rgba(255,255,255,.09); border-radius:var(--radius);
           padding:calc(var(--card-pad)*.78) var(--card-pad); }}
  .tier .tag {{ flex:none; font-size:calc(var(--body)*.80); font-weight:900; letter-spacing:.1em;
               color:#0A0F1C; background:linear-gradient(135deg,#34D399,#38BDF8);
               border-radius:10px; padding:.24em .6em; }}
  .tier .txt .t {{ font-size:calc(var(--body)*1.06); font-weight:800; color:#fff; margin-bottom:.24em; }}
  .tier .txt .b {{ font-size:calc(var(--body)*.90); color:#9FB0CC; line-height:1.5; }}

  .flow {{ display:flex; align-items:center; gap:12px; flex-wrap:wrap; }}
  .flow .f {{ font-size:calc(var(--body)*.88); font-weight:700; color:#0A0F1C;
              background:linear-gradient(135deg,#7DD3FC,#C4B5FD); border-radius:999px;
              padding:.42em 1.05em; white-space:nowrap; }}
  .flow .ar {{ color:#46536E; font-weight:800; font-size:calc(var(--body)*.95); }}

  ul.rules {{ list-style:none; display:flex; flex-direction:column; gap:.5em; }}
  ul.rules li {{ font-size:calc(var(--body)*.92); color:#A6B6D0; line-height:1.5;
                 padding-left:1.3em; position:relative; }}
  ul.rules li::before {{ content:"▸"; position:absolute; left:0; color:#38BDF8; font-weight:900; }}

  /* ---- 代码块 ---- */
  pre.code {{ background:#05070E; border:1px solid rgba(125,211,252,.24); border-radius:var(--radius);
              padding:calc(var(--card-pad)*.72) var(--card-pad); overflow:hidden;
              font-family:"SF Mono",Menlo,monospace; color:#9FE8C0; }}
  pre.code .ct {{ display:block; font-size:calc(var(--body)*.78); color:#7DD3FC; font-weight:700;
                  letter-spacing:.1em; margin-bottom:.55em; font-family:"PingFang SC",sans-serif; }}
  pre.code .ln {{ display:block; font-size:calc(var(--body)*.94); line-height:1.55; white-space:pre-wrap; }}

  .note {{ font-size:calc(var(--body)*.88); color:#8FA3C2; line-height:1.55;
           border-left:3px solid rgba(167,139,250,.65); padding-left:1.1em; }}
  .stat {{ font-size:calc(var(--body)*.98); font-weight:800; color:#34D399; letter-spacing:.02em; }}

  /* ---- 封面 ---- */
  .cover {{ flex:1; display:flex; flex-direction:column; justify-content:center; gap:.34em; }}
  .cover .mark {{ font-size:calc(var(--body)*1.2); font-weight:800; color:#38BDF8;
                  letter-spacing:.32em; margin-bottom:.5em; }}
  .cover .big {{ font-size:var(--hero-title); font-weight:900; letter-spacing:-.035em; line-height:1.02;
                 background:linear-gradient(120deg,#FFFFFF 8%,#7DD3FC 52%,#A78BFA 96%);
                 -webkit-background-clip:text; background-clip:text; color:transparent; }}
  .cover .sub {{ font-size:calc(var(--title)*.66); font-weight:700; color:#E8EDF7; margin-top:.22em; }}
  .cover .tagline {{ font-size:calc(var(--body)*1.02); color:#8FA3C2; margin-top:.7em;
                     letter-spacing:.02em; }}
  .cover .rule2 {{ width:150px; height:5px; border-radius:3px; margin:1.05em 0 .1em;
                   background:linear-gradient(90deg,#38BDF8,#A78BFA); }}

  /* ---- 底栏 / 进度 ---- */
  .foot {{ margin-top:var(--gap); display:flex; align-items:center; gap:20px; }}
  .brand {{ font-size:calc(var(--body)*.80); font-weight:800; color:#2F3B52;
            font-family:"SF Mono",Menlo,monospace; letter-spacing:.16em; }}
  .track {{ flex:1; height:5px; border-radius:3px; background:rgba(255,255,255,.07); overflow:hidden; }}
  .track .fill {{ height:100%; border-radius:3px; background:linear-gradient(90deg,#38BDF8,#A78BFA); }}
  .pct {{ font-size:calc(var(--body)*.76); font-weight:700; color:#4A5875; font-family:"SF Mono",Menlo,monospace; }}
"""


FIT_JS = """
<script>
(function(){
  function fit(){
    var m=document.querySelector('.main'); if(!m) return;
    m.style.transform=''; m.style.width='';               // 先复位再量
    var avail=m.getBoundingClientRect().height, need=m.scrollHeight;
    if(need>avail+1){
      var k=Math.max(0.55, avail/need);
      m.style.transform='scale('+k+')';
      m.style.transformOrigin='top left';
      m.style.width=(100/k)+'%';                           // 先放宽再缩放，视觉宽度不变
    }
  }
  fit();
  if(document.fonts&&document.fonts.ready){document.fonts.ready.then(fit);}
  setTimeout(fit,150); setTimeout(fit,600);
})();
</script>"""


def _head(a, body):
    d = ASPECTS[a]
    return (
        f"<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        f"<style>{_base_css(a)}</style></head><body>{body}{FIT_JS}</body></html>"
    )


def _foot(progress, aspect):
    return f"""
  <div class="foot">
    <div class="brand">OP2GW</div>
    <div class="track"><div class="fill" style="width:{progress*100:.1f}%"></div></div>
    <div class="pct">{ASPECTS[aspect]['label']}</div>
  </div>"""


def render(scene, aspect, progress):
    L = scene["layout"]
    b = []

    if L == "cover":
        b.append(
            f"""<div class="slide">
      <div class="top">
        <div class="kicker">{esc(scene['kicker'])}</div>
        <div class="rule"></div>
      </div>
      <div class="cover">
        <div class="mark">OPEN SOURCE GATEWAY</div>
        <div class="big">{esc(scene['title'])}</div>
        <div class="rule2"></div>
        <div class="sub">{esc(scene['subtitle'])}</div>
        <div class="tagline">{esc(scene['tagline'])}</div>
      </div>
      {_foot(progress, aspect)}
    </div>"""
        )
        return _head(aspect, "".join(b))

    b.append(
        f"""<div class="slide">
      <div class="top">
        <div class="kicker">{esc(scene['kicker'])}</div>
        <div class="idx">{esc(scene['id'].split('-')[0])} / 08</div>
        <div class="rule"></div>
      </div>
      <div class="main">
        <h1 class="title">{esc(scene['title'])}</h1>
        <p class="lead">{esc(scene['lead'])}</p>
        <div class="body">"""
    )

    if L == "cards":
        items = "".join(
            f"""<div class="card"><div class="k">{esc(c['k'])}</div>
              <div class="v">{esc(c['v'])}</div><div class="s">{esc(c['sub'])}</div></div>"""
            for c in scene["cards"]
        )
        b.append(f'<div class="grid2">{items}</div>')
        if scene.get("note"):
            b.append(f'<div class="note">{esc(scene["note"])}</div>')

    elif L == "compare":
        li = lambda xs: "".join(f"<li>{esc(x)}</li>" for x in xs)
        b.append(
            f"""<div class="cmp">
        <div class="side bad"><h3>{esc(scene['left_title'])}</h3><ul>{li(scene['left'])}</ul></div>
        <div class="vs">VS</div>
        <div class="side good"><h3>{esc(scene['right_title'])}</h3><ul>{li(scene['right'])}</ul></div>
      </div>"""
        )
        b.append(f'<div class="note">{esc(scene["note"])}</div>')

    elif L == "steps":
        for i, s in enumerate(scene["steps"], 1):
            b.append(
                f"""<div class="step card">
          <div class="row"><div class="n">0{i}</div><div class="t">{esc(s['t'])}</div>
            <div class="d">{esc(s['d'])}</div></div>
          <div class="b">{esc(s['b'])}</div></div>"""
            )
        code = "\n".join(
            f'<span class="ln">{esc(l)}</span>' for l in scene["code"].split("\n")
        )
        b.append(
            f'<pre class="code"><span class="ct">{esc(scene["code_title"])}</span>{code}</pre>'
        )

    elif L == "pool":
        for t in scene["tiers"]:
            b.append(
                f"""<div class="tier"><div class="tag">{esc(t['tag'])}</div>
          <div class="txt"><div class="t">{esc(t['t'])}</div><div class="b">{esc(t['b'])}</div></div></div>"""
            )
        flow = ' <span class="ar">→</span> '.join(
            f'<span class="f">{esc(x)}</span>' for x in scene["flow"]
        )
        b.append(f'<div class="flow">{flow}</div>')
        ul = "".join(f"<li>{esc(x)}</li>" for x in scene["notes"])
        b.append(f'<ul class="rules">{ul}</ul>')

    elif L == "flow":
        items = "".join(
            f"""<div class="item"><div class="tag">{esc(s['tag'])}</div>
          <div class="txt"><div class="t">{esc(s['t'])}</div><div class="b">{esc(s['b'])}</div></div>
          <div class="r">{esc(s['r'])}</div></div>"""
            for s in scene["sources"]
        )
        b.append(f'<div class="src">{items}</div>')
        ul = "".join(f"<li>{esc(x)}</li>" for x in scene["rules"])
        b.append(f'<ul class="rules">{ul}</ul>')
        b.append(f'<div class="stat">{esc(scene["stat"])}</div>')

    elif L == "howto":
        for blk in scene["blocks"]:
            code = "\n".join(
                f'<span class="ln">{esc(l)}</span>' for l in blk["b"].split("\n")
            )
            b.append(
                f"""<div class="card"><div class="k">{esc(blk['t'])}</div>
          <pre class="code" style="border:none;background:rgba(0,0,0,.34);padding:.7em 0">{code}</pre>
          <div class="s">{esc(blk['s'])}</div></div>"""
            )
        b.append(
            f"""<div class="card"><div class="k">{esc(scene['verify_title'])}</div>
          <pre class="code" style="border:none;background:rgba(0,0,0,.34);padding:.7em 0">
          <span class="ln">{esc(scene['verify'])}</span></pre>
          <div class="s">{esc(scene['clients'])}</div></div>"""
        )

    b.append("</div>")
    b.append("</div>")   # /.body
    b.append("</div>")   # /.main
    b.append(_foot(progress, aspect))
    b.append("</div>")   # /.slide
    return _head(aspect, "".join(b))
