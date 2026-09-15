import { HairRenderer } from './renderer.js';
import {
  SHADES, LOOKS, TECHNIQUES, COLOR_DEFAULTS, TONE_DEFAULTS, STYLE_DEFAULTS, STYLES, swatchCss, lengthForCut,
} from './looks.js';

const MAX_SIDE = 1600;
const $ = sel => document.querySelector(sel);

const state = { ...COLOR_DEFAULTS, ...TONE_DEFAULTS, ...STYLE_DEFAULTS, split: 0, showMask: false };
let meta = null;         // segmentation result for the current photo
let plateReady = false;  // hair-removed background available → cut & style enabled
let session = 0;         // guards against responses for a previous photo
let activeWell = 'base';
let activeLook = 'Original';
let activeStyle = 'Original';

const canvas = $('#canvas');
let renderer;
try {
  renderer = new HairRenderer(canvas);
} catch (err) {
  console.error(err);
  toast('Your browser could not start WebGL, which this app needs.', 8000);
}

// ------------------------------------------------------------------ rendering
let frameQueued = false;
function requestRender() {
  if (!meta || !renderer || frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    renderer.render(effectiveState());
  });
}

function effectiveState() {
  if (plateReady) return state;
  return { ...state, ...STYLE_DEFAULTS };  // styles need the background plate
}

function fitCanvas() {
  if (!meta) return;
  const area = $('#canvasArea');
  const cs = getComputedStyle(area);
  const aw = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const s = Math.min(aw / meta.width, ah / meta.height);
  canvas.style.width = `${Math.floor(meta.width * s)}px`;
  canvas.style.height = `${Math.floor(meta.height * s)}px`;
}
new ResizeObserver(fitCanvas).observe($('#canvasArea'));

// ------------------------------------------------------------------ upload
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

function setBusy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busyText').textContent = text;
}

async function loadFile(file) {
  if (!file) return;
  if (!renderer) return toast('WebGL is not available in this browser.');
  const my = ++session;
  setBusy('Reading photo…');
  try {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw new Error("That file couldn't be opened. Try a JPG or PNG.");
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const photo = document.createElement('canvas');
    photo.width = w;
    photo.height = h;
    photo.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise(r => photo.toBlob(r, 'image/jpeg', 0.94));

    setBusy('Finding your hair…');
    const form = () => { const f = new FormData(); f.append('image', blob, 'photo.jpg'); return f; };
    const res = await fetch('/api/segment', { method: 'POST', body: form() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong analysing the photo.');
    if (my !== session) return;
    const [maskImg, strandImg] = await Promise.all([loadImage(data.mask), loadImage(data.strands)]);
    if (my !== session) return;

    meta = data;
    plateReady = false;
    Object.assign(state, STYLE_DEFAULTS);
    activeStyle = 'Original';
    renderer.setSize(data.width, data.height);
    renderer.setTexture('uImage', photo);
    renderer.setTexture('uPlate', photo);
    renderer.setTexture('uMask', maskImg);
    renderer.setTexture('uStrand', strandImg);
    renderer.setMeta(data);

    $('#dropzone').hidden = true;
    $('#canvasWrap').hidden = false;
    for (const id of ['#downloadBtn', '#compareBtn', '#maskBtn', '#resetBtn']) $(id).disabled = false;
    fitCanvas();
    setBusy(null);
    syncAll();
    if (!data.found) toast("I couldn't find much hair in this photo. Try one where your hair is clearly visible.", 6000);

    // The hair-free background takes a few seconds on CPU; colour works meanwhile
    setStyleStatus('loading');
    fetch('/api/plate', { method: 'POST', body: form() })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('plate failed'))))
      .then(b => loadImage(URL.createObjectURL(b)))
      .then(img => {
        if (my !== session) return;
        renderer.setTexture('uPlate', img);
        URL.revokeObjectURL(img.src);
        plateReady = true;
        setStyleStatus('ready');
        syncStyle();
        requestRender();
      })
      .catch(err => {
        if (my !== session) return;
        console.error(err);
        setStyleStatus('error');
      });
  } catch (err) {
    if (my !== session) return;
    setBusy(null);
    toast(err.message || String(err), 6000);
  }
}

function setStyleStatus(kind) {
  const el = $('#styleStatus');
  const notice = $('#styleNotice');
  if (kind === 'loading') {
    el.innerHTML = '<span class="dot pulse"></span>Preparing cut &amp; style…';
    notice.hidden = false;
    notice.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;border-color:rgba(0,0,0,.15);border-top-color:var(--accent)"></span>Getting cut &amp; style ready. This takes a few seconds. Colours already work.';
  } else if (kind === 'ready') {
    el.innerHTML = '<span class="dot ready"></span>Cut &amp; style ready';
    notice.hidden = true;
  } else if (kind === 'error') {
    el.textContent = 'Cut & style unavailable';
    notice.hidden = false;
    notice.textContent = 'Could not prepare the background for restyling. Check the server log.';
  }
}

$('#fileInput').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
$('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
$('#dropzone').addEventListener('click', () => $('#fileInput').click());

const stage = $('#stage');
stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('dragging'); });
stage.addEventListener('dragleave', e => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('dragging'); });
stage.addEventListener('drop', e => {
  e.preventDefault();
  stage.classList.remove('dragging');
  const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
  if (file) loadFile(file);
});
window.addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

// ------------------------------------------------------------------ stage tools
const compareBtn = $('#compareBtn');
compareBtn.addEventListener('click', () => {
  const on = compareBtn.getAttribute('aria-pressed') !== 'true';
  compareBtn.setAttribute('aria-pressed', on);
  state.split = on ? 0.5 : 0;
  syncCompare();
  requestRender();
});
function syncCompare() {
  const on = state.split > 0;
  $('#divider').hidden = !on;
  $('#tagBefore').hidden = !on;
  $('#tagAfter').hidden = !on;
  $('#canvasWrap').classList.toggle('comparing', on);
  $('#divider').style.left = `${state.split * 100}%`;
}
const wrap = $('#canvasWrap');
let dragging = false;
const moveSplit = e => {
  const r = canvas.getBoundingClientRect();
  state.split = Math.min(0.999, Math.max(0.001, (e.clientX - r.left) / r.width));
  syncCompare();
  requestRender();
};
wrap.addEventListener('pointerdown', e => {
  if (state.split <= 0) return;
  dragging = true;
  wrap.setPointerCapture(e.pointerId);
  moveSplit(e);
});
wrap.addEventListener('pointermove', e => { if (dragging) moveSplit(e); });
wrap.addEventListener('pointerup', () => { dragging = false; });

const maskBtn = $('#maskBtn');
maskBtn.addEventListener('click', () => {
  state.showMask = !state.showMask;
  maskBtn.setAttribute('aria-pressed', state.showMask);
  requestRender();
});

$('#resetBtn').addEventListener('click', () => {
  Object.assign(state, COLOR_DEFAULTS, TONE_DEFAULTS, STYLE_DEFAULTS);
  activeLook = 'Original';
  activeStyle = 'Original';
  syncAll();
});

$('#downloadBtn').addEventListener('click', () => {
  if (!meta) return;
  renderer.render({ ...effectiveState(), split: 0, showMask: false });
  canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hair-${(activeLook || 'custom').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    requestRender();
  }, 'image/jpeg', 0.95);
});

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => {
      const on = t === tab;
      t.setAttribute('aria-selected', on);
      $(`#tab-${t.dataset.tab}`).hidden = !on;
    });
  });
});

// ------------------------------------------------------------------ looks
const TECH_NAME = Object.fromEntries(TECHNIQUES.map(t => [t.id, t.name]));
{
  const groups = [...new Set(LOOKS.map(l => l.group))];
  const root = $('#lookGroups');
  for (const g of groups) {
    const sec = document.createElement('section');
    sec.className = 'look-group';
    sec.innerHTML = `<h3 class="section-title">${g}</h3><div class="look-grid"></div>`;
    const grid = sec.querySelector('.look-grid');
    for (const look of LOOKS.filter(l => l.group === g)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'look';
      b.dataset.look = look.name;
      const s = look.settings;
      const isOriginal = look.name === 'Original';
      const tech = isOriginal ? 'No colour' : s.frame > 0 && s.technique === 'solid' ? 'Face-framing' : TECH_NAME[s.technique];
      b.innerHTML = `
        <span class="look-swatch${isOriginal ? ' original' : ''}" style="${isOriginal ? '' : `background:${swatchCss(s)}`}">${isOriginal ? 'as is' : ''}</span>
        <span class="look-name">${look.name}</span>
        <span class="look-tech">${tech}</span>`;
      b.addEventListener('click', () => {
        Object.assign(state, look.settings);
        activeLook = look.name;
        syncColour();
        requestRender();
      });
      grid.append(b);
    }
    root.append(sec);
  }
}

// ------------------------------------------------------------------ colour controls
{
  const root = $('#techniques');
  for (const t of TECHNIQUES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg';
    b.dataset.tech = t.id;
    b.textContent = t.name;
    b.addEventListener('click', () => {
      state.technique = t.id;
      if (state.strength === 0) state.strength = 0.9;
      if (t.id !== 'solid') activeWell = 'light';
      markCustom();
    });
    root.append(b);
  }
}

document.querySelectorAll('.well').forEach(w => {
  w.addEventListener('click', () => { activeWell = w.dataset.well; syncColour(); });
});

{
  const root = $('#shades');
  for (const s of SHADES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'shade';
    b.title = s.name;
    b.setAttribute('aria-label', s.name);
    b.dataset.hex = s.hex;
    b.style.backgroundColor = s.hex;
    b.addEventListener('click', () => setWellColour(s.hex));
    root.append(b);
  }
}

function setWellColour(hex) {
  state[activeWell] = hex.toLowerCase();
  if (state.strength === 0) state.strength = 0.9;
  if (activeWell === 'light' && state.technique === 'solid' && state.frame === 0) state.technique = 'balayage';
  markCustom();
}

function markCustom() {
  const match = LOOKS.find(l => Object.keys(COLOR_DEFAULTS).every(k => l.settings[k] === state[k]));
  activeLook = match ? match.name : null;
  syncColour();
  requestRender();
}

// HSV picker
const sv = $('#sv');
const hue = $('#hue');
let hsv = [25, 0.45, 0.42];
const hsvToHex = ([h, s, v]) => {
  const f = n => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
};
const hexToHsv = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
};
function pickFromSv(e) {
  const r = sv.getBoundingClientRect();
  hsv[1] = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  hsv[2] = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
  setWellColour(hsvToHex(hsv));
}
let svDrag = false;
sv.addEventListener('pointerdown', e => { svDrag = true; sv.setPointerCapture(e.pointerId); pickFromSv(e); });
sv.addEventListener('pointermove', e => { if (svDrag) pickFromSv(e); });
sv.addEventListener('pointerup', () => { svDrag = false; });
hue.addEventListener('input', () => { hsv[0] = +hue.value; setWellColour(hsvToHex(hsv)); });
$('#hex').addEventListener('input', e => {
  let v = e.target.value.trim();
  if (!v.startsWith('#')) v = '#' + v;
  if (/^#[0-9a-f]{6}$/i.test(v)) setWellColour(v);
});

const shadeName = hex => SHADES.find(s => s.hex === hex.toLowerCase())?.name;

// Sliders
const pct = v => `${Math.round(v * 100)}%`;
const signed = v => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}`);
const COLOUR_SLIDERS = [
  { key: 'strength', label: 'Colour intensity', min: 0, max: 1, fmt: pct },
  { key: 'lift', label: 'Lightness', min: -1, max: 1, fmt: signed, ends: ['Darker', 'Lighter'] },
  { key: 'coverage', label: 'Highlight amount', min: 0, max: 1, fmt: pct, when: s => ['balayage', 'babylights', 'highlights'].includes(s.technique) },
  { key: 'blend', label: 'Where the colour starts', min: 0.05, max: 0.9, fmt: v => (v < 0.35 ? 'Higher' : v > 0.6 ? 'Lower' : 'Mid-length'), ends: ['Near roots', 'Just the ends'], when: s => ['balayage', 'ombre'].includes(s.technique) },
  { key: 'root', label: 'Root shadow', min: 0, max: 1, fmt: pct },
  { key: 'frame', label: 'Face-framing (money piece)', min: 0, max: 1, fmt: pct },
  { key: 'shine', label: 'Shine', min: 0, max: 1, fmt: pct },
];
const STYLE_SLIDERS = [
  { key: 'length', label: 'Length', min: -1, max: 0.5, fmt: signed, ends: ['Shorter', 'Longer'] },
  { key: 'volume', label: 'Volume', min: -0.5, max: 1, fmt: signed, ends: ['Flatter', 'Fuller'] },
  { key: 'wave', label: 'Waves', min: 0, max: 1, fmt: pct },
  { key: 'waveSize', label: 'Wave pattern', min: 0, max: 1, fmt: v => (v < 0.34 ? 'Loose' : v > 0.66 ? 'Tight' : 'Medium'), ends: ['Loose', 'Tight'] },
  { key: 'curl', label: 'Curls (perm)', min: 0, max: 1, fmt: pct },
  { key: 'sleek', label: 'Sleek & smooth', min: 0, max: 1, fmt: pct },
  { key: 'bangs', label: 'Curtain bangs', min: 0, max: 1, fmt: pct },
];

function buildSliders(container, defs, onChange) {
  for (const d of defs) {
    const el = document.createElement('div');
    el.className = 'slider';
    el.innerHTML = `
      <label class="slider-head"><span class="slider-label">${d.label}</span><span class="slider-value"></span></label>
      <input type="range" min="${d.min}" max="${d.max}" step="0.01" aria-label="${d.label}">
      ${d.ends ? `<div class="slider-ends"><span>${d.ends[0]}</span><span>${d.ends[1]}</span></div>` : ''}`;
    const input = el.querySelector('input');
    input.addEventListener('input', () => {
      state[d.key] = +input.value;
      el.querySelector('.slider-value').textContent = d.fmt(state[d.key]);
      onChange(d);
    });
    d.el = el;
    d.input = input;
    container.append(el);
  }
}
buildSliders($('#colourSliders'), COLOUR_SLIDERS, () => markCustom());
buildSliders($('#styleSliders'), STYLE_SLIDERS, () => { activeStyle = null; syncStyle(); requestRender(); });

function syncSliders(defs, disabled = false) {
  for (const d of defs) {
    d.el.hidden = d.when ? !d.when(state) : false;
    d.input.value = state[d.key];
    d.input.disabled = disabled;
    d.el.classList.toggle('disabled', disabled);
    d.el.querySelector('.slider-value').textContent = d.fmt(state[d.key]);
  }
}

function syncColour() {
  document.querySelectorAll('.look').forEach(b => b.setAttribute('aria-pressed', b.dataset.look === activeLook));
  document.querySelectorAll('.seg').forEach(b => b.setAttribute('aria-pressed', b.dataset.tech === state.technique));
  $('#techHint').textContent = TECHNIQUES.find(t => t.id === state.technique)?.hint ?? '';

  const lightUsed = state.technique !== 'solid' || state.frame > 0;
  $('#lightLabel').textContent = state.technique === 'split' ? 'Second colour' : 'Highlight colour';
  document.querySelectorAll('.well').forEach(w => {
    const key = w.dataset.well;
    w.setAttribute('aria-pressed', key === activeWell);
    w.classList.toggle('dim', key === 'light' && !lightUsed);
    w.querySelector('.well-swatch').style.background = state[key];
    w.querySelector('.well-name').textContent = shadeName(state[key]) ?? state[key].toUpperCase();
  });

  const hex = state[activeWell];
  const [h, s, v] = hexToHsv(hex);
  if (hsvToHex(hsv) !== hex) hsv = [s > 0.01 ? h : hsv[0], s, v];
  sv.style.backgroundColor = `hsl(${hsv[0]} 100% 50%)`;
  $('#svThumb').style.left = `${hsv[1] * 100}%`;
  $('#svThumb').style.top = `${(1 - hsv[2]) * 100}%`;
  $('#svThumb').style.background = hex;
  hue.value = hsv[0];
  const hexInput = $('#hex');
  if (document.activeElement !== hexInput) hexInput.value = hex.toUpperCase();
  $('#hexPreview').style.background = hex;
  $('#shadeName').textContent = shadeName(hex) ?? 'Custom';
  document.querySelectorAll('.shade').forEach(b => b.setAttribute('aria-pressed', b.dataset.hex === hex));

  syncSliders(COLOUR_SLIDERS);
}

// ------------------------------------------------------------------ style controls
{
  const root = $('#styleGrid');
  for (const st of STYLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'style-card';
    b.dataset.style = st.name;
    b.innerHTML = `<span class="style-name">${st.name}</span><span class="style-desc">${st.desc}</span>`;
    b.addEventListener('click', () => {
      Object.assign(state, STYLE_DEFAULTS, st.settings);
      if (st.cutTo && meta) state.length = lengthForCut(meta, st.cutTo);
      activeStyle = st.name;
      syncStyle();
      requestRender();
    });
    root.append(b);
  }
}

function syncStyle() {
  const locked = !!meta && !plateReady;
  document.querySelectorAll('.style-card').forEach(b => {
    b.setAttribute('aria-pressed', b.dataset.style === activeStyle);
    b.disabled = locked;
  });
  syncSliders(STYLE_SLIDERS, locked);
}

function syncAll() {
  syncColour();
  syncStyle();
  syncCompare();
  requestRender();
}

// ------------------------------------------------------------------ toast
let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

syncAll();
