"""Re-record docs/demo.gif and docs/demo.mp4.

Steps the Hair Studio UI frame by frame in headless Chromium, screenshots every
frame, and writes a concat list for ffmpeg. Timing is scripted, so the result is
smooth even where WebGL falls back to software rendering.

    .venv/bin/python app.py                       # in one terminal
    python -m pip install playwright && python -m playwright install chromium
    python docs/record_demo.py photo.jpg /tmp/demo
    cd /tmp/demo
    ffmpeg -f concat -safe 0 -i frames.txt -vf "fps=20,format=yuv420p" \
      -c:v libx264 -crf 21 -preset slow -movflags +faststart demo.mp4
    ffmpeg -i demo.mp4 -vf "setpts=PTS/1.25,fps=10,scale=800:-1:flags=lanczos,split[a][b];\
      [a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
      -loop 0 demo.gif
"""

import math, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

PHOTO = sys.argv[1]
OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
W, H, FPS = 1160, 840, 20
DT = 1 / FPS

CURSOR_JS = r"""
(() => {
  const css = `
  #pw-cursor{position:fixed;left:0;top:0;width:22px;height:30px;z-index:2147483647;pointer-events:none;
    filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
  #pw-cursor svg{display:block}
  .pw-ripple{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;z-index:2147483646;
    pointer-events:none;background:rgba(192,122,79,.40);box-shadow:0 0 0 2px rgba(192,122,79,.9)}
  *{scroll-behavior:auto !important}`;
  const ripples = [];
  const ready = () => {
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    const c = document.createElement('div'); c.id = 'pw-cursor';
    c.innerHTML = `<svg width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 23 L7.5 18.5 L11 27 L15 25.3 L11.6 17 L19 17 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    c.style.transform = 'translate(-100px,-100px)';
    document.body.append(c);
    document.addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX-3}px,${e.clientY-2}px)`; }, true);
    document.addEventListener('mousedown', e => {
      const r = document.createElement('div'); r.className = 'pw-ripple';
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      r.style.transform = 'scale(.6)';
      document.body.append(r); ripples.push({ el: r, t: 0 });
    }, true);
  };
  window.__pwTick = dt => {
    for (const r of [...ripples]) {
      r.t += dt; const p = r.t / 320;
      if (p >= 1) { r.el.remove(); ripples.splice(ripples.indexOf(r), 1); continue; }
      r.el.style.transform = `scale(${0.6 + 2.2 * p})`; r.el.style.opacity = String(1 - p);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
"""

def ease(t):
    return 0.5 - 0.5 * math.cos(math.pi * t)

class Rec:
    def __init__(self, page):
        self.page = page
        self.frames = []     # file path per output frame (duplicates = holds)
        self.ncap = 0
        self.x, self.y = W * 0.55, H * 0.6
        page.mouse.move(self.x, self.y)
        self.t0 = time.time()

    # ---- frame plumbing
    def frame(self, tick=True):
        if tick: self.page.evaluate('window.__pwTick(%d)' % round(DT * 1000))
        self.page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        self.ncap += 1
        p = OUT / f'f{self.ncap:04d}.png'
        self.page.screenshot(path=str(p))
        self.frames.append(p)

    def hold(self, sec, live=0):
        """Hold the current picture. `live` frames are re-captured (so ripples animate)."""
        n = max(0, round(sec * FPS))
        for _ in range(min(live, n)): self.frame()
        self.frames.extend([self.frames[-1]] * max(0, n - live))

    def log(self, msg):
        print(f'{time.time()-self.t0:6.1f}s  {len(self.frames)/FPS:5.1f}s video  {msg}', flush=True)

    # ---- motion
    def glide(self, x, y, sec=0.4):
        n = max(4, round(sec * FPS)); x0, y0 = self.x, self.y
        for i in range(1, n + 1):
            t = ease(i / n)
            self.page.mouse.move(x0 + (x - x0) * t, y0 + (y - y0) * t)
            self.frame()
        self.x, self.y = x, y

    def press(self):
        self.page.mouse.down(); self.frame(); self.page.mouse.up()

    def scroll_to(self, sel):
        loc = self.page.locator(sel).first
        before, after = loc.evaluate("""el => { const sc = el.closest('.tab-body'); if (!sc) return [0, 0]; const b = sc.scrollTop;
            el.scrollIntoView({block:'center', behavior:'instant'}); const a = sc.scrollTop; sc.scrollTop = b; return [b, a]; }""")
        if abs(after - before) < 2: return
        sc = loc.locator('xpath=ancestor::*[contains(@class,"tab-body")]').first
        n = 7
        for i in range(1, n + 1):
            sc.evaluate('(el, v) => { el.scrollTop = v; }', before + (after - before) * ease(i / n))
            self.frame()

    def center(self, sel):
        self.scroll_to(sel)
        b = self.page.locator(sel).first.bounding_box()
        return b['x'] + b['width'] / 2, b['y'] + b['height'] / 2

    def click(self, sel, hold=0.9, sec=0.4):
        x, y = self.center(sel)
        self.glide(x, y, sec)
        self.press()
        self.hold(hold, live=6)

    def drag(self, x0, y0, x1, y1, sec=1.0):
        self.glide(x0, y0, 0.35)
        self.page.mouse.down(); self.frame()
        self.glide(x1, y1, sec)
        self.page.mouse.up(); self.frame()

    def slider_pos(self, label, value):
        loc = self.page.locator(f'input[type=range][aria-label="{label}"]').first
        b = loc.bounding_box()
        mn, mx = float(loc.get_attribute('min')), float(loc.get_attribute('max'))
        thumb = 16
        return b['x'] + thumb / 2 + (value - mn) / (mx - mn) * (b['width'] - thumb), b['y'] + b['height'] / 2

    def drag_slider(self, label, to, sec=1.0):
        sel = f'input[type=range][aria-label="{label}"]'
        self.scroll_to(sel)
        cur = float(self.page.locator(sel).first.input_value())
        x0, y0 = self.slider_pos(label, cur)
        x1, _ = self.slider_pos(label, to)
        self.drag(x0, y0, x1, y0, sec)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': W, 'height': H}, color_scheme='light', accept_downloads=True)
    page = ctx.new_page()
    page.add_init_script(CURSOR_JS)
    page.goto('http://127.0.0.1:8000/', wait_until='networkidle')
    r = Rec(page)
    r.frame(); r.hold(0.9)
    r.log('landing')

    # 1. upload
    x, y = r.center('#uploadBtn'); r.glide(x, y, 0.45)
    with page.expect_file_chooser() as fc:
        r.press()
    fc.value.set_files(PHOTO)
    page.wait_for_selector('#busy', state='visible', timeout=10000)
    r.frame(); r.hold(0.8, live=4)
    page.wait_for_selector('#canvasWrap:not([hidden])', timeout=60000)
    page.wait_for_selector('#busy', state='hidden', timeout=60000)
    r.glide(W * 0.30, H * 0.5, 0.5)
    r.hold(1.2)
    r.log('uploaded')

    # 2. looks
    for name in ['Caramel Balayage', 'Platinum Blonde', 'Copper', 'Rose Gold Ombré', 'Lavender Ombré']:
        r.click(f'.look[data-look="{name}"]', hold=1.1)
    r.log('looks')

    # 3. before / after
    r.click('#compareBtn', hold=0.5)
    cb = page.locator('#canvas').bounding_box()
    cy = cb['y'] + cb['height'] * 0.55
    mid = cb['x'] + cb['width'] / 2
    r.drag(mid, cy, cb['x'] + cb['width'] * 0.12, cy, sec=0.9)
    r.hold(0.2)
    r.drag(cb['x'] + cb['width'] * 0.12, cy, cb['x'] + cb['width'] * 0.86, cy, sec=1.1)
    r.hold(0.5)
    r.click('#compareBtn', hold=0.35)
    r.log('compare')

    # 4. colour tab
    r.click('.tab[data-tab="colour"]', hold=0.6)
    r.click('.seg[data-tech="balayage"]', hold=0.7)
    r.click('.shade[aria-label="Honey Blonde"]', hold=0.8)
    r.drag_slider('Lightness', 0.45, sec=0.8)
    r.hold(0.6)
    r.click('.well[data-well="base"]', hold=0.4)
    sv = page.locator('#sv').bounding_box()
    r.drag(sv['x'] + sv['width'] * 0.55, sv['y'] + sv['height'] * 0.55,
           sv['x'] + sv['width'] * 0.88, sv['y'] + sv['height'] * 0.72, sec=0.9)
    r.hold(0.7)
    r.log('colour')

    # 5. cut & style
    page.wait_for_selector('.style-card:not([disabled])', state='attached', timeout=120000)
    r.click('.tab[data-tab="style"]', hold=0.5)
    for name in ['Bob', 'Beach waves', 'Curtain bangs']:
        r.click(f'.style-card[data-style="{name}"]', hold=1.15)
    r.drag_slider('Length', -0.6, sec=0.9)
    r.hold(0.8)
    r.log('style')

    # 6. detected hair + download
    r.click('#maskBtn', hold=0.9)
    r.click('#maskBtn', hold=0.3)
    x, y = r.center('#downloadBtn'); r.glide(x, y, 0.4)
    with page.expect_download():
        r.press()
    r.hold(0.8, live=6)
    r.log('done')

    with open(OUT / 'frames.txt', 'w') as f:
        for fr in r.frames:
            f.write(f"file '{fr.name}'\nduration {DT:.4f}\n")
        f.write(f"file '{r.frames[-1].name}'\n")
    print('FRAMES', len(r.frames), 'captures', r.ncap, 'seconds', len(r.frames) / FPS)
    ctx.close(); browser.close()
