// GIF Editor — vanilla JS. All editing state lives in one plain object.
// Output pipeline per frame: original -> mirror -> crop -> stretch-to-output-size.
// Crop is stored in preview space (post-mirror) so the overlay maps 1:1 to
// what the user sees and export reproduces it exactly.

'use strict';

const state = {
  originalFrames: [],                 // [{ imageData, delay(ms) }] — immutable decoder output
  meta: { width: 0, height: 0, frameCount: 0 },
  edit: {
    crop: { x: 0, y: 0, width: 0, height: 0 },
    cropAspect: null,                 // locked ratio w/h for crop resize, or null (free)
    stretch: null,                    // target output ratio w/h, or null (= crop size)
    rotation: 0,                      // 0 | 90 | 180 | 270 (applied to the output)
    trimStart: 0,
    trimEnd: 0,
    speedMultiplier: 1.0,
    mirrorH: false
  },
  ui: { state: 'empty', tool: 'crop', onion: false },
  // multiple loaded GIFs; each keeps its own frames + edit state
  projects: [],          // [{ name, url, frames, meta, edit, isSingle }]
  current: -1,           // index of the project being edited
  // runtime-only
  playIndex: 0,
  timer: null,
  isSingleFrame: false,
  resultBlob: null,
  resultUrl: null,
  resultName: ''
};

// ---- DOM ----
const el = {
  views: {
    empty: document.getElementById('view-empty'),
    loading: document.getElementById('view-loading'),
    picker: document.getElementById('view-picker'),
    editing: document.getElementById('view-editing'),
    error: document.getElementById('view-error')
  },
  pickerGrid: document.getElementById('picker-grid'),
  fileInput: document.getElementById('file-input'),
  emptyError: document.getElementById('empty-error'),
  errorMsg: document.getElementById('error-msg'),
  resetBtn: document.getElementById('reset-btn'),
  exportBtn: document.getElementById('export-btn'),
  canvas: document.getElementById('preview'),
  panels: Array.from(document.querySelectorAll('.tool-panels .panel')),
  tabs: Array.from(document.querySelectorAll('.tabbar .tab')),
  cropChips: Array.from(document.querySelectorAll('#crop-chips .chip')),
  stretchChips: Array.from(document.querySelectorAll('#stretch-chips .chip')),
  stretchDims: document.getElementById('stretch-dims'),
  rotateLeft: document.getElementById('rotate-left'),
  rotateRight: document.getElementById('rotate-right'),
  rotationReadout: document.getElementById('rotation-readout'),
  singleNote: document.getElementById('single-frame-note'),
  onionBtn: document.getElementById('onion-btn'),
  trimStart: document.getElementById('trim-start'),
  trimEnd: document.getElementById('trim-end'),
  stepBtns: Array.from(document.querySelectorAll('.step-btn[data-step="start"], .step-btn[data-step="end"]')),
  speedSteps: Array.from(document.querySelectorAll('.step-btn[data-step="speed"]')),
  trimReadout: document.getElementById('trim-readout'),
  speed: document.getElementById('speed'),
  speedReadout: document.getElementById('speed-readout'),
  mirror: document.getElementById('mirror'),
  exportOverlay: document.getElementById('export-overlay'),
  progressBar: document.getElementById('progress-bar'),
  progressPct: document.getElementById('progress-pct'),
  resultOverlay: document.getElementById('result-overlay'),
  resultPreview: document.getElementById('result-preview'),
  pressTip: document.getElementById('press-tip'),
  saveBtn: document.getElementById('save-btn'),
  resultClose: document.getElementById('result-close'),
  saveHint: document.getElementById('save-hint'),
  toast: document.getElementById('toast')
};

const ctx = el.canvas.getContext('2d');
// Offscreen buffers reused across renders/exports. `off` is read back only once
// per frame during decode elsewhere; here we only write to it, so no readback flag.
const off = document.createElement('canvas');
const offCtx = off.getContext('2d');
const flip = document.createElement('canvas');
const flipCtx = flip.getContext('2d');
// intermediate buffer holding mirror+crop+stretch before rotation
const stage = document.createElement('canvas');
const stageCtx = stage.getContext('2d');

// =====================================================================
// UI state switching
// =====================================================================
function setState(name) {
  state.ui.state = name;
  for (const key in el.views) el.views[key].hidden = (key !== name);
  updateHeader();
}

// The left header button switches role: open the gallery when several GIFs are
// loaded, otherwise add more files.
function updateHeader() {
  const editing = state.ui.state === 'editing';
  el.exportBtn.hidden = !editing;
  el.resetBtn.hidden = !editing;
  if (editing) {
    if (state.projects.length > 1) {
      el.resetBtn.textContent = '☰ Galleria';
      el.resetBtn.dataset.mode = 'gallery';
    } else {
      el.resetBtn.textContent = '＋ Aggiungi';
      el.resetBtn.dataset.mode = 'add';
    }
  }
}

function showEmptyError(msg) {
  el.emptyError.textContent = msg;
  el.emptyError.hidden = false;
}

function showError(msg) {
  el.errorMsg.textContent = msg;
  stopPlayback();
  setState('error');
}

function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  void el.toast.offsetWidth;                 // reflow so the transition runs
  el.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.toast.classList.remove('show');
    setTimeout(() => { el.toast.hidden = true; }, 300);
  }, 2500);
}

// =====================================================================
// Decode (gifuct-js)
// =====================================================================
function ensureGifuct() {
  if (window.gifuct) return Promise.resolve();
  return new Promise(resolve => window.addEventListener('gifuct-ready', resolve, { once: true }));
}

// Decode one or more selected GIF files into projects, then either open the
// single one or show the picker.
async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  el.emptyError.hidden = true;

  setState('loading');
  try {
    await ensureGifuct();
    let added = 0;
    for (const file of files) {
      const looksImage = /image\/(gif|webp)/.test(file.type) || /\.(gif|webp)$/i.test(file.name);
      if (!looksImage) continue;
      try {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const head = String.fromCharCode.apply(null, bytes.subarray(0, 12));

        let dec;
        if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) {
          const gif = window.gifuct.parseGIF(buf);
          const raw = window.gifuct.decompressFrames(gif, true);
          if (!raw || !raw.length) continue;
          dec = decodeGifFrames(gif, raw);
        } else if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
          dec = await decodeWebpFrames(buf, file);
        } else {
          continue;   // unsupported format
        }

        const meta = { width: dec.width, height: dec.height, frameCount: dec.frames.length };
        state.projects.push({
          name: file.name.replace(/\.webp$/i, '.gif'),
          url: URL.createObjectURL(file),
          frames: dec.frames,
          meta,
          edit: defaultEdit(meta),
          isSingle: meta.frameCount <= 1
        });
        added++;
      } catch (_) { /* skip this invalid file, keep the others */ }
    }

    if (added === 0) {
      if (!state.projects.length) { setState('empty'); showEmptyError('Nessuna GIF valida trovata'); }
      else { showToast('Nessuna GIF valida aggiunta'); reopenAfterLoad(); }
      return;
    }
    if (state.projects.length === 1) openProject(0);
    else showPicker();
  } catch (_) {
    if (!state.projects.length) { setState('empty'); showEmptyError('Errore nel caricamento'); }
    else reopenAfterLoad();
  }
}

function reopenAfterLoad() {
  if (state.projects.length > 1) showPicker();
  else openProject(state.current >= 0 ? state.current : 0);
}

function defaultEdit(meta) {
  return {
    crop: { x: 0, y: 0, width: meta.width, height: meta.height },
    cropAspect: null, cropChip: 'free',
    stretch: null, stretchChip: 'original',
    rotation: 0,
    trimStart: 0, trimEnd: meta.frameCount - 1,
    speedMultiplier: 1.0, mirrorH: false
  };
}

// Composite gifuct's patch frames into full-size frames, honoring disposal.
// Returns { frames, width, height } without touching global state.
function decodeGifFrames(gif, raw) {
  const W = gif.lsd.width;
  const H = gif.lsd.height;

  const comp = document.createElement('canvas');
  comp.width = W; comp.height = H;
  const cctx = comp.getContext('2d', { willReadFrequently: true });

  const patch = document.createElement('canvas');
  const pctx = patch.getContext('2d');

  const frames = [];
  let prevDispose = 0;
  let prevDims = null;
  let restoreSnapshot = null;

  for (const f of raw) {
    if (prevDims) {
      if (prevDispose === 2) {
        cctx.clearRect(prevDims.left, prevDims.top, prevDims.width, prevDims.height);
      } else if (prevDispose === 3 && restoreSnapshot) {
        cctx.putImageData(restoreSnapshot, 0, 0);
      }
    }
    if (f.disposalType === 3) restoreSnapshot = cctx.getImageData(0, 0, W, H);

    patch.width = f.dims.width;
    patch.height = f.dims.height;
    const id = pctx.createImageData(f.dims.width, f.dims.height);
    id.data.set(f.patch);
    pctx.putImageData(id, 0, 0);
    cctx.drawImage(patch, f.dims.left, f.dims.top);

    frames.push({
      imageData: cctx.getImageData(0, 0, W, H),
      delay: f.delay && f.delay > 0 ? f.delay : 100
    });

    prevDispose = f.disposalType;
    prevDims = f.dims;
  }

  return { frames, width: W, height: H };
}

// Decode a WebP (static or animated) into full-size frames. Uses the WebCodecs
// ImageDecoder (Chrome/Edge/Android Chrome), falling back to a single frame via
// createImageBitmap on browsers without it. Frames feed the same GIF pipeline.
async function decodeWebpFrames(buf, blob) {
  if ('ImageDecoder' in window) {
    try { return await decodeViaImageDecoder(buf, 'image/webp'); } catch (_) { /* fall back below */ }
  }
  // Fallback: one frame (static WebP, or first frame of an animated one).
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return { frames: [{ imageData: cx.getImageData(0, 0, c.width, c.height), delay: 100 }], width: c.width, height: c.height };
}

async function decodeViaImageDecoder(buf, type) {
  const decoder = new ImageDecoder({ data: buf, type });
  await decoder.tracks.ready;                    // track metadata (frameCount) ready
  await decoder.completed;                       // all input received
  const track = decoder.tracks.selectedTrack;
  const count = (track && track.frameCount) ? track.frameCount : 1;

  const canvas = document.createElement('canvas');
  const cctx = canvas.getContext('2d', { willReadFrequently: true });
  const frames = [];
  let W = 0, H = 0;

  for (let i = 0; i < count; i++) {
    const { image } = await decoder.decode({ frameIndex: i });   // image is a VideoFrame
    if (i === 0) { W = image.displayWidth; H = image.displayHeight; canvas.width = W; canvas.height = H; }
    cctx.clearRect(0, 0, W, H);
    cctx.drawImage(image, 0, 0);
    const delay = image.duration ? Math.max(20, Math.round(image.duration / 1000)) : 100;
    frames.push({ imageData: cctx.getImageData(0, 0, W, H), delay });
    image.close();
  }
  decoder.close();
  if (!frames.length) throw new Error('no frames');
  return { frames, width: W, height: H };
}

// Build the picker grid (animated thumbnails from each file) and show it.
function showPicker() {
  stopPlayback();
  el.pickerGrid.innerHTML = '';
  state.projects.forEach((p, i) => {
    const cell = document.createElement('button');
    cell.className = 'thumb';
    cell.type = 'button';
    const img = document.createElement('img');
    img.src = p.url; img.alt = p.name;
    const cap = document.createElement('span');
    cap.className = 'thumb-name';
    cap.textContent = p.name;
    cell.appendChild(img);
    cell.appendChild(cap);
    cell.addEventListener('click', () => openProject(i));
    el.pickerGrid.appendChild(cell);
  });
  setState('picker');
}

// Load a project into the editor. Its `edit` object is shared by reference, so
// changes persist and are still there when the user switches back to it.
function openProject(i) {
  state.current = i;
  const p = state.projects[i];
  state.originalFrames = p.frames;
  state.meta = p.meta;
  state.edit = p.edit;
  state.isSingleFrame = p.isSingle;
  state.ui.onion = false;
  state.playIndex = clamp(p.edit.trimStart, 0, p.meta.frameCount - 1);

  off.width = p.meta.width; off.height = p.meta.height;
  flip.width = p.meta.width; flip.height = p.meta.height;

  applyEditToControls();
  setState('editing');
  setTool(state.ui.tool || 'crop');
  fitPreview();
  startPlayback();
}

// Sync all controls to reflect the current project's edit state.
function applyEditToControls() {
  const e = state.edit, fc = state.meta.frameCount;
  el.trimStart.min = 0; el.trimStart.max = fc - 1;
  el.trimEnd.min = 0; el.trimEnd.max = fc - 1;
  el.mirror.checked = e.mirrorH;
  el.rotationReadout.textContent = (e.rotation || 0) + '°';

  const dis = state.isSingleFrame;
  el.trimStart.disabled = dis;
  el.trimEnd.disabled = dis;
  el.speed.disabled = dis;
  el.onionBtn.disabled = dis;
  el.onionBtn.classList.remove('active');
  el.singleNote.hidden = !state.isSingleFrame;

  highlightChip(el.cropChips, 'cropaspect', e.cropChip);
  highlightChip(el.stretchChips, 'stretch', e.stretchChip);

  setTrim(e.trimStart, e.trimEnd);   // slider values + step bounds + readout
  setSpeed(e.speedMultiplier);       // slider value + speed bounds + readout
  updateStretchDims();
  updateExportEnabled();
}

function highlightChip(group, attr, value) {
  group.forEach(c => c.classList.toggle('active', c.dataset[attr] === value));
}

// =====================================================================
// Output geometry
// =====================================================================
// Size after mirror + crop + stretch, before rotation.
function outputSize() {
  const cw = Math.max(1, Math.round(state.edit.crop.width));
  const ch = Math.max(1, Math.round(state.edit.crop.height));
  if (!state.edit.stretch) return { w: cw, h: ch };
  // Stretch the cropped content to the chosen ratio (base on crop width).
  return { w: cw, h: Math.max(1, Math.round(cw / state.edit.stretch)) };
}

// Final exported/previewed size, accounting for 90°/270° rotation swapping w/h.
function finalSize() {
  const o = outputSize();
  const r = state.edit.rotation || 0;
  return (r === 90 || r === 270) ? { w: o.h, h: o.w } : { w: o.w, h: o.h };
}

// =====================================================================
// Tools / tabs
// =====================================================================
function setTool(tool) {
  state.ui.tool = tool;
  if (tool !== 'trim' && state.ui.onion) setOnion(false);
  el.panels.forEach(p => { p.hidden = p.dataset.tool !== tool; });
  el.tabs.forEach(t => t.classList.toggle('active', t.dataset.tool === tool));
  syncCanvasSize();
  if (!state.ui.onion) render();
}

function syncCanvasSize() {
  if (state.ui.tool === 'crop' && !state.ui.onion) {
    setCanvasSize(state.meta.width, state.meta.height);
  } else {
    const o = finalSize();
    setCanvasSize(o.w, o.h);
  }
}

// Set the canvas bitmap size and, when it changes, recompute the on-screen size.
function setCanvasSize(w, h) {
  if (el.canvas.width !== w || el.canvas.height !== h) {
    el.canvas.width = w;
    el.canvas.height = h;
    fitPreview();
  }
}

// Scale the canvas on screen to fill the preview area while keeping its aspect
// ratio — so a small crop zooms up instead of showing tiny.
function fitPreview() {
  const wrap = el.canvas.parentElement;
  if (!wrap) return;
  const cs = getComputedStyle(wrap);
  const availW = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const cw = el.canvas.width, ch = el.canvas.height;
  if (cw <= 0 || ch <= 0 || availW <= 0 || availH <= 0) return;
  const scale = Math.min(availW / cw, availH / ch);
  el.canvas.style.width = Math.max(1, Math.round(cw * scale)) + 'px';
  el.canvas.style.height = Math.max(1, Math.round(ch * scale)) + 'px';
}

// =====================================================================
// Rendering
// =====================================================================
function displayScale() {
  const rect = el.canvas.getBoundingClientRect();
  const w = rect.width || el.canvas.width;
  return el.canvas.width / w;
}

// Draw mirror -> crop -> stretch -> rotation of frame `idx` into a destination
// context sized (fw, fh) = finalSize().
function drawOutputInto(dctx, idx, fw, fh) {
  const frame = state.originalFrames[idx];
  const W = state.meta.width, H = state.meta.height, c = state.edit.crop;
  const o = outputSize();                       // pre-rotation size
  const rot = state.edit.rotation || 0;

  // frame -> mirror (full frame)
  offCtx.putImageData(frame.imageData, 0, 0);
  flipCtx.clearRect(0, 0, W, H);
  flipCtx.save();
  if (state.edit.mirrorH) { flipCtx.translate(W, 0); flipCtx.scale(-1, 1); }
  flipCtx.drawImage(off, 0, 0);
  flipCtx.restore();

  // mirror -> crop + stretch into the stage buffer
  stage.width = o.w; stage.height = o.h;
  stageCtx.clearRect(0, 0, o.w, o.h);
  stageCtx.drawImage(flip, c.x, c.y, c.width, c.height, 0, 0, o.w, o.h);

  // stage -> rotate about the centre into the destination
  dctx.clearRect(0, 0, fw, fh);
  dctx.save();
  dctx.translate(fw / 2, fh / 2);
  dctx.rotate(rot * Math.PI / 180);
  dctx.drawImage(stage, -o.w / 2, -o.h / 2);
  dctx.restore();
}

function buildOutputCanvas(idx) {
  const o = finalSize();
  const out = document.createElement('canvas');
  out.width = o.w; out.height = o.h;
  // willReadFrequently: gif.js reads this context back during export.
  drawOutputInto(out.getContext('2d', { willReadFrequently: true }), idx, o.w, o.h);
  return out;
}

function render() {
  if (!state.originalFrames.length) return;
  if (state.ui.onion) { renderOnion(); return; }
  if (state.ui.tool === 'crop') renderCropEditor();
  else renderOutput(state.playIndex);
}

function renderCropEditor() {
  const W = state.meta.width, H = state.meta.height;
  setCanvasSize(W, H);
  const frame = state.originalFrames[state.playIndex];
  offCtx.putImageData(frame.imageData, 0, 0);
  flipCtx.clearRect(0, 0, W, H);
  flipCtx.save();
  if (state.edit.mirrorH) { flipCtx.translate(W, 0); flipCtx.scale(-1, 1); }
  flipCtx.drawImage(off, 0, 0);
  flipCtx.restore();
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(flip, 0, 0);
  drawCropOverlay();
}

function renderOutput(idx) {
  const o = finalSize();
  setCanvasSize(o.w, o.h);
  drawOutputInto(ctx, idx, o.w, o.h);
}

// Static overlay of the first and last selected frames to check the loop.
function renderOnion() {
  const o = finalSize();
  setCanvasSize(o.w, o.h);
  const first = buildOutputCanvas(state.edit.trimStart);
  const last = buildOutputCanvas(state.edit.trimEnd);
  ctx.clearRect(0, 0, o.w, o.h);
  ctx.globalAlpha = 1;   ctx.drawImage(first, 0, 0);
  ctx.globalAlpha = 0.5; ctx.drawImage(last, 0, 0);
  ctx.globalAlpha = 1;
}

function drawCropOverlay() {
  const W = state.meta.width, H = state.meta.height, c = state.edit.crop;
  const scale = displayScale();

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, W, c.y);
  ctx.fillRect(0, c.y + c.height, W, H - (c.y + c.height));
  ctx.fillRect(0, c.y, c.x, c.height);
  ctx.fillRect(c.x + c.width, c.y, W - (c.x + c.width), c.height);

  // Inset the border by half its width so it stays fully visible at frame edges.
  const lw = Math.max(1, 2 * scale);
  ctx.strokeStyle = '#5b8cff';
  ctx.lineWidth = lw;
  ctx.strokeRect(c.x + lw / 2, c.y + lw / 2, c.width - lw, c.height - lw);

  // Corner handles: translucent (so they don't hide the image) and clamped
  // inside the canvas so they're fully visible even when the crop hugs an edge.
  const r = 11 * scale;
  const corners = [
    [c.x, c.y], [c.x + c.width, c.y],
    [c.x, c.y + c.height], [c.x + c.width, c.y + c.height]
  ];
  for (const [px, py] of corners) {
    const hx = clamp(px, r, W - r);
    const hy = clamp(py, r, H - r);
    ctx.beginPath();
    ctx.arc(hx, hy, r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.35;               // see-through fill
    ctx.fillStyle = '#5b8cff';
    ctx.fill();
    ctx.globalAlpha = 0.95;               // solid ring for visibility
    ctx.lineWidth = Math.max(1.5, 2.5 * scale);
    ctx.strokeStyle = '#cfe0ff';
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// =====================================================================
// Playback
// =====================================================================
function startPlayback() {
  stopPlayback();
  if (state.ui.onion) { render(); return; }
  if (state.isSingleFrame) { state.playIndex = state.edit.trimStart; render(); return; }
  if (state.playIndex < state.edit.trimStart || state.playIndex > state.edit.trimEnd) {
    state.playIndex = state.edit.trimStart;
  }
  step();
}

function step() {
  render();
  const frame = state.originalFrames[state.playIndex];
  const delay = Math.max(20, (frame.delay || 100) / state.edit.speedMultiplier);
  state.timer = setTimeout(() => {
    state.playIndex++;
    if (state.playIndex > state.edit.trimEnd || state.playIndex < state.edit.trimStart) {
      state.playIndex = state.edit.trimStart;
    }
    step();
  }, delay);
}

function stopPlayback() {
  clearTimeout(state.timer);
  state.timer = null;
}

// =====================================================================
// Crop touch controls (pointer events on the canvas, crop tab only)
// =====================================================================
let dragMode = null;      // 'move' | 'nw' | 'ne' | 'sw' | 'se'
let dragStart = null;

function canvasPoint(e) {
  const rect = el.canvas.getBoundingClientRect();
  const sx = el.canvas.width / rect.width;
  const sy = el.canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function hitCorner(p) {
  const c = state.edit.crop;
  const t = 22 * displayScale();
  const corners = {
    nw: [c.x, c.y], ne: [c.x + c.width, c.y],
    sw: [c.x, c.y + c.height], se: [c.x + c.width, c.y + c.height]
  };
  for (const key in corners) {
    const [cx, cy] = corners[key];
    if (Math.hypot(p.x - cx, p.y - cy) <= t) return key;
  }
  return null;
}

function insideCrop(p) {
  const c = state.edit.crop;
  return p.x >= c.x && p.x <= c.x + c.width && p.y >= c.y && p.y <= c.y + c.height;
}

function onPointerDown(e) {
  if (state.ui.tool !== 'crop' || !state.originalFrames.length) return;
  const p = canvasPoint(e);
  dragMode = hitCorner(p) || (insideCrop(p) ? 'move' : null);
  if (!dragMode) return;
  dragStart = { px: p.x, py: p.y, crop: { ...state.edit.crop } };
  el.canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onPointerMove(e) {
  if (!dragMode) return;
  const p = canvasPoint(e);
  const W = state.meta.width, H = state.meta.height, s = dragStart.crop;

  if (dragMode === 'move') {
    state.edit.crop.x = clamp(s.x + (p.x - dragStart.px), 0, W - s.width);
    state.edit.crop.y = clamp(s.y + (p.y - dragStart.py), 0, H - s.height);
  } else if (state.edit.cropAspect) {
    resizeAspect(dragMode, p, s, W, H);
  } else {
    resizeFree(dragMode, p, s, W, H);
  }

  if (state.isSingleFrame) render();   // no loop running to refresh it
  e.preventDefault();
}

function resizeFree(mode, p, s, W, H) {
  let left = s.x, right = s.x + s.width, top = s.y, bottom = s.y + s.height;
  const px = clamp(p.x, 0, W), py = clamp(p.y, 0, H);
  if (mode.includes('w')) left = px; else right = px;
  if (mode.includes('n')) top = py; else bottom = py;

  if (right - left < 10) { if (mode.includes('w')) left = right - 10; else right = left + 10; }
  if (bottom - top < 10) { if (mode.includes('n')) top = bottom - 10; else bottom = top + 10; }

  state.edit.crop.x = clamp(left, 0, W - 10);
  state.edit.crop.y = clamp(top, 0, H - 10);
  state.edit.crop.width = clamp(right - left, 10, W - state.edit.crop.x);
  state.edit.crop.height = clamp(bottom - top, 10, H - state.edit.crop.y);
}

// Ratio-locked resize: the opposite corner stays anchored, ratio is preserved,
// and the box is clamped inside the frame.
function resizeAspect(mode, p, s, W, H) {
  const r = state.edit.cropAspect;                 // w / h
  const ax = mode.includes('w') ? s.x + s.width : s.x;   // anchored x (opposite corner)
  const ay = mode.includes('n') ? s.y + s.height : s.y;  // anchored y
  const dirX = mode.includes('w') ? -1 : 1;
  const dirY = mode.includes('n') ? -1 : 1;

  let w = Math.abs(clamp(p.x, 0, W) - ax);
  w = Math.min(w, dirX > 0 ? W - ax : ax, (dirY > 0 ? H - ay : ay) * r);
  w = Math.max(w, 10, 10 * r);
  const h = w / r;

  const x2 = ax + dirX * w, y2 = ay + dirY * h;
  state.edit.crop.x = Math.min(ax, x2);
  state.edit.crop.y = Math.min(ay, y2);
  state.edit.crop.width = w;
  state.edit.crop.height = h;
}

function onPointerUp(e) {
  if (!dragMode) return;
  dragMode = null;
  dragStart = null;
  try { el.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
}

// =====================================================================
// Chips / sliders / toggles
// =====================================================================
function parseRatio(s) { const [w, h] = s.split(':').map(Number); return w / h; }

function setActiveChip(group, active) {
  group.forEach(c => c.classList.toggle('active', c === active));
}

function applyCropAspect(v) {
  if (v === 'free') { state.edit.cropAspect = null; return; }
  const r = parseRatio(v);
  state.edit.cropAspect = r;
  const fw = state.meta.width, fh = state.meta.height;
  let w = fw, h = w / r;
  if (h > fh) { h = fh; w = h * r; }
  state.edit.crop = { x: (fw - w) / 2, y: (fh - h) / 2, width: w, height: h };
}

function applyStretch(v) {
  state.edit.stretch = (v === 'original') ? null : parseRatio(v);
  syncCanvasSize();
  updateStretchDims();
}

function updateStretchDims() {
  const o = finalSize();
  el.stretchDims.textContent = `→ ${o.w}×${o.h}px`;
}

// Rotate the output by +/-90°; the canvas resizes (w/h swap) and re-renders.
function rotateBy(delta) {
  state.edit.rotation = (((state.edit.rotation || 0) + delta) % 360 + 360) % 360;
  el.rotationReadout.textContent = state.edit.rotation + '°';
  syncCanvasSize();
  updateStretchDims();
  render();
}

function setOnion(on) {
  if (state.isSingleFrame) return;
  state.ui.onion = on;
  el.onionBtn.classList.toggle('active', on);
  if (on) { stopPlayback(); syncCanvasSize(); render(); }
  else { startPlayback(); }
}

// Commit a start/end pair: sync state, sliders and everything that depends on it.
function setTrim(s, e) {
  state.edit.trimStart = s;
  state.edit.trimEnd = e;
  el.trimStart.value = s;
  el.trimEnd.value = e;
  if (state.playIndex < s || state.playIndex > e) state.playIndex = s;

  el.stepBtns.forEach(b => {
    const isStart = b.dataset.step === 'start';
    const dir = parseInt(b.dataset.dir, 10);
    const atBound = isStart
      ? (dir < 0 ? s <= 0 : s >= e - 1)
      : (dir < 0 ? e <= s + 1 : e >= state.meta.frameCount - 1);
    b.disabled = state.isSingleFrame || atBound;
  });

  updateReadouts();
  updateExportEnabled();
  if (state.ui.onion) render();
}

function onTrimInput() {
  let s = parseInt(el.trimStart.value, 10);
  let e = parseInt(el.trimEnd.value, 10);
  const max = state.meta.frameCount - 1;

  if (s >= e) {                      // keep at least 2 frames selected
    if (document.activeElement === el.trimStart) { s = Math.min(s, max - 1); e = s + 1; }
    else { e = Math.max(e, 1); s = e - 1; }
  }
  setTrim(s, e);
}

// Step one frame at a time via the arrow buttons (high-precision trimming).
function stepStart(delta) {
  setTrim(clamp(state.edit.trimStart + delta, 0, state.edit.trimEnd - 1), state.edit.trimEnd);
}
function stepEnd(delta) {
  setTrim(state.edit.trimStart, clamp(state.edit.trimEnd + delta, state.edit.trimStart + 1, state.meta.frameCount - 1));
}

function onSpeedInput() {
  setSpeed(parseFloat(el.speed.value));
}

// Commit a speed value: round to the slider granularity, sync slider + buttons.
function setSpeed(v) {
  v = Math.round(clamp(v, 0.25, 4) * 100) / 100;
  state.edit.speedMultiplier = v;
  el.speed.value = v;
  el.speedSteps.forEach(b => {
    const dir = parseInt(b.dataset.dir, 10);
    const atBound = dir < 0 ? v <= 0.25 : v >= 4;
    b.disabled = state.isSingleFrame || atBound;
  });
  updateReadouts();
}

// Step speed one slider tick (0.05) at a time via the arrow buttons.
function stepSpeed(delta) {
  setSpeed(state.edit.speedMultiplier + delta * 0.05);
}

function onMirrorChange() {
  state.edit.mirrorH = el.mirror.checked;
  render();
}

function updateReadouts() {
  const s = state.edit.trimStart, e = state.edit.trimEnd;
  el.trimReadout.textContent = `${s} – ${e} (${e - s + 1} frame)`;
  el.speedReadout.textContent = `${state.edit.speedMultiplier.toFixed(2)}×`;
}

function validTrim() {
  return state.isSingleFrame || state.edit.trimStart < state.edit.trimEnd;
}

function updateExportEnabled() {
  el.exportBtn.disabled = !validTrim();
}

// =====================================================================
// Export (gif.js)
// =====================================================================
let workerUrl = null;

async function getWorkerUrl() {
  if (workerUrl) return workerUrl;
  const resp = await fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js');
  const blob = await resp.blob();
  workerUrl = URL.createObjectURL(blob);
  return workerUrl;
}

async function exportGif() {
  if (state.ui.state !== 'editing' || !validTrim()) return;

  const wasOnion = state.ui.onion;
  if (wasOnion) setOnion(false);
  stopPlayback();
  setExporting(true);

  try {
    const url = await getWorkerUrl();
    const o = finalSize();

    const gif = new GIF({ workers: 2, quality: 10, workerScript: url, width: o.w, height: o.h });

    gif.on('progress', p => setProgress(p));
    gif.on('finished', blob => {
      setExporting(false);
      state.resultName = `edited-gif-${Date.now()}.gif`;
      showResult(blob);
    });

    const s = state.edit.trimStart;
    const e = state.isSingleFrame ? state.edit.trimStart : state.edit.trimEnd;
    for (let i = s; i <= e; i++) {
      const c = buildOutputCanvas(i);
      const delay = Math.max(20, Math.round((state.originalFrames[i].delay || 100) / state.edit.speedMultiplier));
      // Pass the 2D context (not the canvas): gif.js then reads each distinct
      // context once instead of reusing one internal canvas per frame, which
      // avoids the "Multiple readback operations" warning.
      gif.addFrame(c.getContext('2d', { willReadFrequently: true }), { delay, copy: true });
    }

    setProgress(0);
    gif.render();
  } catch (err) {
    setExporting(false);
    showError('Errore durante l\'esportazione. Riprova.');
  }
}

function setExporting(active) {
  el.exportOverlay.hidden = !active;
  el.exportBtn.disabled = active || !validTrim();
  if (active) setProgress(0);
}

function setProgress(p) {
  const pct = Math.round(clamp(p, 0, 1) * 100);
  el.progressBar.style.width = pct + '%';
  el.progressPct.textContent = pct + '%';
}

// Show the "GIF ready" step so the user can save with a real tap (needed for
// the Android share sheet) and choose the destination.
function showResult(blob) {
  stopPlayback();
  state.resultBlob = blob;
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(blob);
  el.resultPreview.src = state.resultUrl;
  el.pressTip.hidden = !IS_TOUCH || isCapacitorNative();   // native saves directly, no long-press needed
  el.saveHint.textContent = saveHintText();
  el.saveBtn.disabled = false;
  el.resultOverlay.hidden = false;
}

function closeResult() {
  el.resultOverlay.hidden = true;
  el.resultPreview.removeAttribute('src');
  if (state.resultUrl) { URL.revokeObjectURL(state.resultUrl); state.resultUrl = null; }
  state.resultBlob = null;
  startPlayback();
}

const IS_TOUCH = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;

function canShareFiles(file) {
  return !!navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }));
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// base64 payload without the "data:...;base64," prefix (for Capacitor Filesystem)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// True only when running inside the Capacitor native container (the APK).
function isCapacitorNative() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

function triggerDownload(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Explain what "Salva" will do on this device. The long-press tip is the
// universal fallback that works even when downloads/share are blocked (WebView).
function saveHintText() {
  if (isCapacitorNative()) return 'Verrà salvata nella cartella Documenti del telefono.';
  const f = new File([new Blob()], 'x.gif', { type: 'image/gif' });
  let base;
  if (canShareFiles(f)) base = 'Si apre il menu di condivisione: scegli "Salva su file" o un\'app.';
  else if (window.showSaveFilePicker) base = 'Scegli cartella e nome nella finestra di salvataggio.';
  else if (IS_TOUCH) base = 'Se il file non compare nei Download, usa il tocco prolungato sull\'anteprima; oppure apri il sito in Chrome.';
  else base = 'Il file viene scaricato nella cartella Download.';
  return base;
}

// Save/share the exported GIF using the best mechanism the device offers.
async function saveGif(blob, name) {
  // 0. Native app (Capacitor APK): write a real file with the Filesystem plugin.
  //    This is the whole reason for the container — a proper save on the phone.
  if (isCapacitorNative() && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) {
    try {
      const b64 = await blobToBase64(blob);
      await window.Capacitor.Plugins.Filesystem.writeFile({
        path: name, data: b64, directory: 'DOCUMENTS', recursive: true
      });
      return 'capacitor-saved';
    } catch (e) { /* fall back to the web methods below */ }
  }

  const file = new File([blob], name, { type: 'image/gif' });

  // 1. Web Share with files: real browsers and modern WebViews. Opens the
  //    native share sheet so the user picks the destination folder / app.
  if (canShareFiles(file)) {
    try {
      await navigator.share({ files: [file], title: name, text: name });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // otherwise fall through to the other methods
    }
  }

  // 2. Desktop Chromium: real "save as" picker (choose folder + name).
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'GIF', accept: { 'image/gif': ['.gif'] } }]
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return 'saved';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }

  // 3. Download. Inside an Android WebView a blob: download is silently dropped,
  //    but the wrapper's DownloadListener can usually handle a data: URL (the
  //    bytes are inline), so use that on touch devices. Desktop uses a blob URL.
  if (IS_TOUCH) {
    try {
      triggerDownload(await blobToDataURL(blob), name);
      return 'downloaded-touch';
    } catch (_) { /* fall through to blob download */ }
  }
  const url = URL.createObjectURL(blob);
  triggerDownload(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return IS_TOUCH ? 'downloaded-touch' : 'downloaded';
}

async function onSave() {
  if (!state.resultBlob) return;
  el.saveBtn.disabled = true;
  let outcome;
  try {
    outcome = await saveGif(state.resultBlob, state.resultName);
  } catch (_) {
    outcome = 'error';
  }
  el.saveBtn.disabled = false;

  if (outcome === 'cancelled') return;   // keep the overlay open to retry
  if (outcome === 'error') { showToast('Salvataggio non riuscito — tieni premuto sull\'anteprima'); return; }

  if (outcome === 'capacitor-saved') { showToast('Salvata in Documenti ✓'); closeResult(); }
  else if (outcome === 'shared') { showToast('GIF salvata / condivisa ✓'); closeResult(); }
  else if (outcome === 'saved') { showToast('GIF salvata ✓'); closeResult(); }
  else if (outcome === 'downloaded') { showToast('Scaricata in Download ✓'); closeResult(); }
  else {
    // Touch/WebView: we can't confirm the download landed, so keep the overlay
    // open with the long-press escape hatch still available.
    showToast('Avviato. Se non lo trovi, tieni premuto sull\'anteprima');
  }
}

// =====================================================================
// Helpers
// =====================================================================
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Android hardware/gesture Back — handled sensibly inside the app instead of
// closing it immediately. Capacitor container only; a no-op in the browser.
function initCapacitor() {
  if (!isCapacitorNative()) return;
  document.body.classList.add('capacitor');   // enables status-bar spacing in CSS
  const App = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!App || !App.addListener) return;
  App.addListener('backButton', () => {
    if (!el.exportOverlay.hidden) return;                       // busy exporting: ignore
    if (!el.resultOverlay.hidden) { closeResult(); return; }    // result -> editor
    if (state.ui.state === 'editing' && state.projects.length > 1) { showPicker(); return; } // editor -> gallery
    App.exitApp();                                              // nothing left to pop
  });
}

// =====================================================================
// Wiring
// =====================================================================
el.fileInput.addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
el.resetBtn.addEventListener('click', () => {
  if (el.resetBtn.dataset.mode === 'gallery') showPicker();
  else el.fileInput.click();
});
window.addEventListener('resize', fitPreview);
window.addEventListener('orientationchange', fitPreview);

el.canvas.addEventListener('pointerdown', onPointerDown);
el.canvas.addEventListener('pointermove', onPointerMove);
el.canvas.addEventListener('pointerup', onPointerUp);
el.canvas.addEventListener('pointercancel', onPointerUp);

el.tabs.forEach(t => t.addEventListener('click', () => setTool(t.dataset.tool)));

el.cropChips.forEach(ch => ch.addEventListener('click', () => {
  setActiveChip(el.cropChips, ch);
  state.edit.cropChip = ch.dataset.cropaspect;
  applyCropAspect(ch.dataset.cropaspect);
  render();
}));
el.stretchChips.forEach(ch => ch.addEventListener('click', () => {
  setActiveChip(el.stretchChips, ch);
  state.edit.stretchChip = ch.dataset.stretch;
  applyStretch(ch.dataset.stretch);
  render();
}));

el.onionBtn.addEventListener('click', () => setOnion(!state.ui.onion));
el.trimStart.addEventListener('input', onTrimInput);
el.trimEnd.addEventListener('input', onTrimInput);
el.stepBtns.forEach(b => b.addEventListener('click', () => {
  const dir = parseInt(b.dataset.dir, 10);
  if (b.dataset.step === 'start') stepStart(dir); else stepEnd(dir);
}));
el.speedSteps.forEach(b => b.addEventListener('click', () => stepSpeed(parseInt(b.dataset.dir, 10))));
el.speed.addEventListener('input', onSpeedInput);
el.rotateLeft.addEventListener('click', () => rotateBy(-90));
el.rotateRight.addEventListener('click', () => rotateBy(90));
el.mirror.addEventListener('change', onMirrorChange);
el.exportBtn.addEventListener('click', exportGif);
el.saveBtn.addEventListener('click', onSave);
el.resultClose.addEventListener('click', closeResult);

setState('empty');
initCapacitor();
