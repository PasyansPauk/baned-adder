// Baned Adder — интерфейс. Связывает настройки, план, превью и оба движка рендера.
import { DEFAULT_SETTINGS, normalizeSettings } from './core/settings.js';
import { buildPlan } from './core/plan.js';
import { outputSize } from './core/layout.js';
import { fillTemplate, fmtTime, parseTime, sanitizeFileName } from './core/util.js';
import { LayerFactory } from './graphics.js';
import { BrowserEngine, pickRecorderMime, seekTo } from './engine-browser.js';
import { loadSegmenter } from './segment.js';
import { analyzeInBrowser } from './analyze-browser.js';
import {
  analyzeOnServer,
  buildServerSpecs,
  cancelJob,
  fetchFromUrl,
  getServerStatus,
  pollJob,
  startRender,
  uploadFile,
} from './engine-server.js';
import { renderTimeline } from './timeline.js';
import { drawQR } from './qr.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'banedAdder.settings.v1';
const PRESETS_KEY = 'banedAdder.presets.v1';

const state = {
  settings: loadSettings(),
  server: null, // статус локального сервера
  videos: [], // все загруженные видео: { id, file, url, duration, width, height, uploadId, uploadPromise, analysis, analysisNote }
  video: null, // активное видео (его план и превью показаны)
  banners: [], // { id, file, name, kind, url, el, width, height, aspect, duration, uploadId }
  analysis: null,
  analysisCtl: null,
  plan: null,
  W: 1080,
  H: 1920,
  factory: null,
  selected: 0,
  renderCtl: null,
  results: [],
};

let batchRun = null; // рендер всех видео по очереди: { cancelled }
let replacing = false; // «Заменить» выбирает файл для активного видео

const engine = new BrowserEngine({ canvas: $('stageCanvas'), video: $('workVideo') });

// ------------------------------------------------------------ хранение настроек

function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(STORE_KEY) || 'null'));
  } catch {
    return normalizeSettings(null);
  }
}
function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.settings));
  } catch {
    /* приватный режим — не страшно */
  }
}
function loadPresets() {
  try {
    return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function savePresets(p) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
  } catch {
    toast('Не удалось сохранить пресет', true);
  }
}

// ------------------------------------------------------------ мелочи UI

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('is-error', isError);
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), isError ? 6000 : 3000);
}

const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} ГБ` : `${Math.max(0.1, b / 1e6).toFixed(1)} МБ`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isAbort = (e) => e?.name === 'AbortError';

function setProgress(el, p) {
  el.hidden = p === null;
  if (p !== null) el.querySelector('i').style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}
function setPath(obj, path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = v;
}

function activeEngine() {
  const want = state.settings.output.engine;
  const ok = !!state.server?.ffmpeg?.available;
  if (want === 'browser') return 'browser';
  // нейросеть для удаления фона работает только в браузере
  const c = state.settings.look.chroma;
  if (c.enabled && c.mode === 'ai') return 'browser';
  return ok ? 'server' : 'browser';
}

// ------------------------------------------------------------ привязка настроек к форме

const settingEls = [...document.querySelectorAll('[data-setting]')];

function writeForm() {
  const s = state.settings;
  for (const el of settingEls) {
    const v = getPath(s, el.dataset.setting);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = el.value === String(v);
    else if (el.dataset.type === 'time') el.value = fmtTime(v);
    else el.value = v;
  }
  syncOutputs();
  syncDeps();
  syncChips();
}

function syncOutputs() {
  for (const o of document.querySelectorAll('output[data-for]')) {
    const v = getPath(state.settings, o.dataset.for);
    o.textContent = typeof v === 'number' ? String(Math.round(v * 100) / 100) : v;
  }
  document.documentElement.style.setProperty('--accent', state.settings.look.accent);
}

function syncDeps() {
  for (const el of document.querySelectorAll('[data-dep]')) {
    const dep = el.dataset.dep;
    let on;
    const m = dep.match(/^([\w.]+)(!?=)(.+)$/);
    if (m) {
      const v = m[1] === 'engine' ? activeEngine() : String(getPath(state.settings, m[1]));
      on = m[2] === '=' ? v === m[3] : v !== m[3];
    } else on = !!getPath(state.settings, dep);
    el.classList.toggle('is-off', !on);
  }
  const pause = state.settings.ads.mode === 'pause';
  $('modeHint').textContent = pause
    ? 'Видео замирает (стоп-кадр с размытием), показывается баннер, затем видео продолжается с того же места.'
    : 'Баннер появляется поверх идущего видео, звук не прерывается.';
}

function syncChips() {
  for (const c of document.querySelectorAll('#lenChips .chip')) {
    c.classList.toggle('is-active', Number(c.dataset.len) === state.settings.split.targetLen);
  }
}

function readEl(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'time') return parseTime(el.value);
  if (el.type === 'number' || el.type === 'range' || el.dataset.type === 'number') return Number(el.value);
  return el.value;
}

function applySetting(path, value) {
  const next = structuredClone(state.settings);
  setPath(next, path, value);
  state.settings = normalizeSettings(next);
  saveSettings();
  syncOutputs();
  syncDeps();
  syncChips();
  schedulePlan();
}

for (const el of settingEls) {
  const ev = el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT' || el.dataset.type === 'time' ? 'change' : 'input';
  el.addEventListener(ev, () => {
    if (el.type === 'radio' && !el.checked) return;
    const v = readEl(el);
    if (el.dataset.type === 'time' && !Number.isFinite(v)) {
      toast('Введите время как мм:сс, например 2:30', true);
      el.value = fmtTime(getPath(state.settings, el.dataset.setting));
      return;
    }
    applySetting(el.dataset.setting, v);
    if (el.dataset.type === 'time') el.value = fmtTime(getPath(state.settings, el.dataset.setting));
    if (el.dataset.setting === 'output.engine') onEngineChanged();
  });
  if (el.type === 'number') el.addEventListener('blur', () => (el.value = getPath(state.settings, el.dataset.setting)));
}

/** Определяет цвет фона по краям текущего кадра (медиана по каналам) и подставляет его как цвет хромакея. */
function detectChromaColor() {
  const v = $('workVideo');
  if (!state.video || !v.videoWidth) return false;
  const w = 64;
  const h = Math.max(8, Math.round((w * v.videoHeight) / v.videoWidth));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  try {
    ctx.drawImage(v, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const ch = [[], [], []];
    const m = 3;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (x >= m && x < w - m && y >= m && y < h - m) continue;
        const i = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) ch[k].push(d[i + k]);
      }
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const hex = ch.map((a) => med(a).toString(16).padStart(2, '0')).join('');
    applySetting('look.chroma.color', '#' + hex);
    writeForm();
    return true;
  } catch {
    return false;
  }
}
$('chromaPick').addEventListener('click', () => {
  if (!detectChromaColor()) toast('Сначала загрузите видео', true);
});
for (const el of document.querySelectorAll('[data-setting^="look.chroma."]')) {
  if (el.type !== 'checkbox' && el.type !== 'radio') continue;
  el.addEventListener('change', () => {
    const c = state.settings.look.chroma;
    onEngineChanged();
    if (!c.enabled) return;
    if (c.mode === 'color' && el.dataset.setting === 'look.chroma.mode') detectChromaColor();
    if (c.mode === 'ai') {
      toast('Загружаю нейросеть для удаления фона…');
      loadSegmenter()
        .then(() => schedulePlan())
        .catch((e) => toast(e.message, true));
    }
  });
}

$('lenChips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-len]');
  if (!c) return;
  applySetting('split.targetLen', Number(c.dataset.len));
  $('targetLen').value = fmtTime(state.settings.split.targetLen);
});

document.querySelectorAll('[data-step]').forEach((b) =>
  b.addEventListener('click', () => {
    const input = $(b.dataset.target);
    input.value = Math.max(0, Number(input.value || 0) + Number(b.dataset.step));
    input.dispatchEvent(new Event('input'));
  })
);

// ------------------------------------------------------------ сервер

async function detectServer() {
  state.server = await getServerStatus();
  const badge = $('engineBadge');
  if (state.server?.ffmpeg?.available) {
    badge.textContent = 'Компьютер + ffmpeg';
    badge.className = 'badge ok';
    badge.title = `Найден локальный сервер с ffmpeg ${state.server.ffmpeg.version}: быстрый рендер`;
  } else if (state.server) {
    badge.textContent = 'Без ffmpeg — браузер';
    badge.className = 'badge info';
    badge.title = 'Сервер запущен, но ffmpeg не найден (brew install ffmpeg). Рендер в браузере.';
  } else {
    badge.textContent = 'Рендер в браузере';
    badge.className = 'badge info';
    badge.title = 'Сервер не найден — всё делается прямо в браузере';
  }
  updateLinkBox();
  $('phoneBtn').hidden = !(state.server?.lanUrls?.length && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
  const vt = state.server?.ffmpeg?.encoders?.videotoolbox;
  $('encoder').querySelector('[value="videotoolbox"]').disabled = !vt;
  if (!vt && state.settings.output.encoder === 'videotoolbox') applySetting('output.encoder', 'x264');
  onEngineChanged();
}

function onEngineChanged() {
  syncDeps();
  const eng = activeEngine();
  $('encoderField').hidden = eng !== 'server';
  const hint = $('engineHint');
  if (eng === 'server') {
    hint.textContent = 'Видео обрабатывается ffmpeg на компьютере — быстро и в максимальном качестве. Готовые файлы можно скачать и на iPhone.';
  } else {
    const mime = pickRecorderMime();
    hint.textContent = mime
      ? `Запись идёт прямо в браузере в реальном времени (часть 3 минуты ≈ 3 минуты записи). Не блокируйте экран и не сворачивайте вкладку. Формат: ${mime.startsWith('video/mp4') ? 'MP4' : 'WebM'}.`
      : 'Этот браузер не умеет записывать видео. Используйте Safari 14.1+ / Chrome или запустите сервер на Mac.';
  }
  if (eng === 'server' && state.video && !state.video.uploadId && !state.video.uploadPromise) ensureSourceUploaded().catch(() => {});
  updateButtons();
}

async function ensureSourceUploaded(v = state.video) {
  if (!v) throw new Error('Нет видео');
  if (v.uploadId) return v.uploadId;
  if (!v.uploadPromise) {
    const ctl = new AbortController();
    v.uploadCtl = ctl;
    v.uploadPromise = uploadFile(v.file, v.file.name, {
      probe: true,
      signal: ctl.signal,
      onProgress: (p) => state.video === v && ($('uploadState').textContent = `Передача на компьютер: ${Math.round(p * 100)}%`),
    })
      .then((r) => {
        v.uploadId = r.id;
        v.serverInfo = r.info;
        if (state.video === v) $('uploadState').textContent = '✓ Видео на компьютере';
        return r.id;
      })
      .catch((e) => {
        v.uploadPromise = null;
        if (!isAbort(e) && state.video === v) $('uploadState').textContent = 'Не удалось передать: ' + e.message;
        throw e;
      });
  }
  return v.uploadPromise;
}

async function ensureBannersUploaded() {
  for (const b of state.banners) {
    if (b.kind !== 'video' || b.uploadId) continue;
    const r = await uploadFile(b.file, b.file.name || 'banner.mp4');
    b.uploadId = r.id;
  }
}

// ------------------------------------------------------------ загрузка видео

function bindDrop(label, onFiles) {
  label.addEventListener('dragover', (e) => {
    e.preventDefault();
    label.classList.add('is-over');
  });
  label.addEventListener('dragleave', () => label.classList.remove('is-over'));
  label.addEventListener('drop', (e) => {
    e.preventDefault();
    label.classList.remove('is-over');
    if (e.dataTransfer?.files?.length) onFiles([...e.dataTransfer.files]);
  });
}

const videoFiles = (f) => {
  const v = f.filter((x) => x.type.startsWith('video/'));
  return v.length ? v : f.slice(0, 1);
};
bindDrop($('videoDrop'), (f) => addVideos(videoFiles(f)));
bindDrop($('secVideo'), (f) => state.videos.length && addVideos(videoFiles(f)));
bindDrop($('bannerDrop'), (f) => addBanners(f));
$('videoInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  // «Заменить» меняет активное видео на первый выбранный файл, остальные добавляются
  if (replacing && state.video) replaceVideo(files);
  else addVideos(files);
  replacing = false;
});
$('videoAddInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) addVideos(files);
});
$('videoAdd').addEventListener('click', () => $('videoAddInput').click());
$('bannerInput').addEventListener('change', (e) => {
  addBanners([...e.target.files]);
  e.target.value = '';
});
$('videoReplace').addEventListener('click', () => {
  replacing = true;
  $('videoInput').click();
});

function waitMeta(el) {
  return new Promise((res, rej) => {
    if (el.readyState >= 1) return res();
    el.addEventListener('loadedmetadata', () => res(), { once: true });
    el.addEventListener('error', () => rej(new Error('Не удалось открыть файл. Возможно, формат не поддерживается этим браузером.')), { once: true });
  });
}

let videoSeq = 0;

/** Читает длительность и размер видео, не трогая активный плеер. */
async function probeVideo(file) {
  const url = file.remote ? file.url : URL.createObjectURL(file);
  const el = document.createElement('video');
  el.preload = 'metadata';
  el.muted = true;
  el.src = url;
  try {
    await waitMeta(el);
  } catch (e) {
    if (!file.remote) URL.revokeObjectURL(url);
    throw new Error(`${file.name}: ${e.message}`);
  }
  const v = { id: ++videoSeq, file, url, duration: el.duration, width: el.videoWidth, height: el.videoHeight, analysis: null, analysisNote: '' };
  el.removeAttribute('src');
  el.load();
  if (file.remote) {
    v.uploadId = file.uploadId;
    v.uploadPromise = Promise.resolve(file.uploadId);
  }
  return v;
}

function busyGuard() {
  if (engine.busy || state.renderCtl) {
    toast('Сначала остановите воспроизведение или рендер', true);
    return true;
  }
  return false;
}

/**
 * Добавляет видео в список и открывает первое из добавленных.
 * file — File с устройства или «удалённый» источник { remote: true, name, size, url, uploadId }:
 * файл, который уже лежит на компьютере (скачан по ссылке) — его не надо загружать повторно.
 */
async function addVideos(files) {
  files = files.filter(Boolean);
  if (!files.length || busyGuard()) return false;
  const added = [];
  for (const f of files) {
    try {
      added.push(await probeVideo(f));
    } catch (e) {
      toast(e.message, true);
    }
  }
  if (!added.length) return false;
  state.videos.push(...added);
  if (added.length > 1) toast(`Добавлено видео: ${added.length}`);
  await activateVideo(added[0]);
  if (activeEngine() === 'server') for (const v of added) ensureSourceUploaded(v).catch(() => {});
  return true;
}

/** Совместимость: открыть одно видео (например, скачанное по ссылке). */
function loadVideo(file) {
  return addVideos([file]);
}

async function replaceVideo(files) {
  if (busyGuard()) return;
  const old = state.video;
  const at = state.videos.indexOf(old);
  let fresh;
  try {
    fresh = await probeVideo(files[0]);
  } catch (e) {
    return toast(e.message, true);
  }
  state.videos.splice(at, 1, fresh);
  disposeVideo(old);
  state.video = null;
  await activateVideo(fresh);
  if (files.length > 1) await addVideos(files.slice(1));
}

function disposeVideo(v) {
  v.uploadCtl?.abort();
  if (!v.file.remote) URL.revokeObjectURL(v.url);
  // скачанное по ссылке не удаляем: его ещё можно сохранить в Загрузки (сервер сам почистит позже)
  if (v.uploadId && !v.file.remote) fetch(`api/uploads/${v.uploadId}`, { method: 'DELETE' }).catch(() => {});
  const keep = state.results.filter((r) => r.videoId !== v.id);
  for (const r of state.results) if (r.videoId === v.id && r.objectUrl) URL.revokeObjectURL(r.objectUrl);
  state.results = keep;
  renderResults();
}

async function removeVideo(v) {
  if (busyGuard()) return;
  const at = state.videos.indexOf(v);
  if (at < 0) return;
  state.videos.splice(at, 1);
  disposeVideo(v);
  if (state.video === v) {
    state.video = null;
    const next = state.videos[Math.min(at, state.videos.length - 1)];
    if (next) await activateVideo(next);
    else resetVideoUi();
  } else renderVideoList();
}

function resetVideoUi() {
  stopAnalysis();
  state.analysis = null;
  state.plan = null;
  $('workVideo').removeAttribute('src');
  $('videoPreview').removeAttribute('src');
  $('videoDrop').hidden = false;
  $('videoInfo').hidden = true;
  $('stageEmpty').hidden = false;
  $('analysisState').textContent = '';
  renderVideoList();
  rebuildPlan();
}

/** Делает видео активным: превью, анализ и план показываются для него. */
async function activateVideo(v) {
  if (!v) return false;
  if (state.video === v) {
    renderVideoList();
    return true;
  }
  stopAnalysis();
  state.video = v;
  const work = $('workVideo');
  work.src = v.url;
  $('videoPreview').src = v.url;
  try {
    await waitMeta(work);
  } catch (e) {
    toast(e.message, true);
    return false;
  }
  if (state.video !== v) return false;
  state.analysis = v.analysis;
  state.selected = 0;
  $('videoDrop').hidden = true;
  $('videoInfo').hidden = false;
  $('videoName').textContent = v.file.name;
  $('videoMeta').textContent = `${fmtTime(v.duration)} · ${v.width}×${v.height} · ${fmtSize(v.file.size)}`;
  $('uploadState').textContent = v.uploadId ? (v.file.remote ? '✓ Скачано по ссылке, видео на компьютере' : '✓ Видео на компьютере') : '';
  $('stageEmpty').hidden = true;
  renderVideoList();
  await seekTo(work, Math.min(1, v.duration / 2));
  schedulePlan(0);
  if (activeEngine() === 'server') ensureSourceUploaded(v).catch(() => {});
  if (v.analysis) $('analysisState').textContent = v.analysisNote;
  else startAnalysis();
  return true;
}

function renderVideoList() {
  const ul = $('videoList');
  ul.innerHTML = '';
  $('videoListBox').hidden = state.videos.length < 2;
  $('renderEvery').hidden = state.videos.length < 2;
  $('renderEvery').textContent = `Создать части всех видео (${state.videos.length})`;
  state.videos.forEach((v, i) => {
    const li = document.createElement('li');
    li.className = 'video-item' + (v === state.video ? ' is-active' : '');
    li.tabIndex = 0;
    li.setAttribute('aria-current', v === state.video ? 'true' : 'false');
    const done = state.results.filter((r) => r.videoId === v.id).length;
    li.innerHTML = `<span class="num">${i + 1}</span><div class="grow"><div class="ellipsis">${esc(v.file.name)}</div>
      <div class="muted small">${fmtTime(v.duration)} · ${v.width}×${v.height}${done ? ` · готово частей: ${done}` : ''}</div></div>
      <button type="button" class="btn btn-sm btn-ghost" aria-label="Убрать видео ${esc(v.file.name)}">Убрать</button>`;
    li.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      removeVideo(v);
    });
    const open = () => !busyGuard() && activateVideo(v);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    ul.appendChild(li);
  });
}

// ------------------------------------------------------------ скачивание по ссылке

const link = { ctl: null, result: null };

function linkAvailable() {
  return !!(state.server?.ffmpeg?.available && state.server?.ytdlp?.available);
}

function updateLinkBox() {
  const ok = linkAvailable();
  const busy = !!link.ctl;
  $('linkBox').classList.toggle('is-off', !ok);
  $('linkEdit').disabled = !ok || busy;
  $('linkSave').disabled = !ok || busy;
  $('linkInput').disabled = busy;
  $('linkCancel').hidden = !busy;
  let hint;
  if (!state.server) {
    hint = 'Скачивание по ссылке работает, когда открыт сайт с вашего Mac (npm start). На Mac нужно установить: brew install yt-dlp ffmpeg';
  } else if (!state.server.ffmpeg?.available) {
    hint = 'Для скачивания по ссылке установите на компьютере ffmpeg: brew install ffmpeg';
  } else if (!state.server.ytdlp?.available) {
    hint = 'Для скачивания по ссылке установите на компьютере yt-dlp: brew install yt-dlp — затем обновите страницу.';
  } else {
    hint = 'Видео скачивается на ваш компьютер (до 1080p, MP4). Скачивайте только то, на что у вас есть права: своё видео или с разрешения автора.';
  }
  $('linkHint').textContent = hint;
}

/** Достаёт ссылку из текста: в TikTok «Поделиться → Копировать» добавляет лишний текст вокруг. */
function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[),.;!?]+$/, '') : String(text || '').trim();
}

if (navigator.clipboard?.readText && window.isSecureContext) {
  $('linkPaste').hidden = false;
  $('linkPaste').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      $('linkInput').value = extractUrl(t);
      $('linkInput').focus();
    } catch {
      toast('Нет доступа к буферу обмена — вставьте ссылку вручную', true);
    }
  });
}

function saveToDownloads(url, name) {
  const a = document.createElement('a');
  a.href = `${url}?download=1`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function renderLinkResult(r, { edited }) {
  const box = $('linkResult');
  box.hidden = false;
  box.innerHTML = `<div class="grow"><b class="ellipsis" style="display:block">${esc(r.title || r.name)}</b>
      <span class="muted small">${esc(r.name)} · ${fmtSize(r.size)} · ${fmtTime(r.info?.duration || 0)}</span></div>
    <div class="row gap-s wrap">
      ${edited ? '' : '<button type="button" class="btn btn-sm btn-primary" data-act="edit">Открыть в редакторе</button>'}
      <a class="btn btn-sm" href="${r.url}?download=1" download="${esc(r.name)}">Сохранить в Загрузки</a>
      ${navigator.share ? '<button type="button" class="btn btn-sm" data-act="share">Поделиться / в Фото</button>' : ''}
    </div>`;
  box.querySelector('[data-act="edit"]')?.addEventListener('click', async () => {
    if (await openDownloaded(r)) renderLinkResult(r, { edited: true });
  });
  box.querySelector('[data-act="share"]')?.addEventListener('click', (e) => shareResult(r, e.target));
}

function openDownloaded(r) {
  return loadVideo({ remote: true, name: r.name, size: r.size, url: r.url, uploadId: r.uploadId });
}

async function downloadByLink(mode) {
  const url = extractUrl($('linkInput').value);
  $('linkInput').value = url;
  if (!url) {
    $('linkInput').focus();
    return toast('Вставьте ссылку на видео YouTube или TikTok', true);
  }
  if (!/^https?:\/\/([^/]+\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com|tiktok\.com)(\/|$)/i.test(url)) {
    return toast('Нужна ссылка на YouTube или TikTok, например https://www.tiktok.com/@user/video/123…', true);
  }
  if (mode === 'edit' && (engine.busy || state.renderCtl)) return toast('Сначала остановите воспроизведение или рендер', true);
  const ctl = new AbortController();
  link.ctl = ctl;
  updateLinkBox();
  $('linkResult').hidden = true;
  const st = $('linkState');
  const bar = $('linkProgress');
  st.textContent = 'Отправляю ссылку на компьютер…';
  setProgress(bar, 0);
  try {
    const r = await fetchFromUrl(url, {
      signal: ctl.signal,
      onProgress: (p, msg) => {
        setProgress(bar, p);
        st.textContent = `${msg || 'Скачиваю…'} ${Math.round(p * 100)}%`;
      },
    });
    link.result = r;
    st.textContent = `✓ Скачано: ${r.title || r.name}`;
    if (mode === 'save' || state.settings.output.alsoSaveDownloaded) saveToDownloads(r.url, r.name);
    let edited = false;
    if (mode === 'edit') {
      st.textContent = '✓ Скачано, открываю в редакторе…';
      edited = await openDownloaded(r);
      st.textContent = edited ? `✓ Открыто в редакторе: ${r.title || r.name}` : `✓ Скачано: ${r.title || r.name}`;
      if (edited) toast('Видео скачано и открыто');
    } else toast('Видео скачано — смотрите в Загрузках');
    renderLinkResult(r, { edited });
    $('linkInput').value = '';
  } catch (e) {
    st.textContent = isAbort(e) || e.message === 'Отменено' ? 'Скачивание отменено.' : e.message;
    if (!isAbort(e)) toast('Не получилось скачать видео', true);
  } finally {
    link.ctl = null;
    setProgress(bar, null);
    updateLinkBox();
  }
}

$('linkEdit').addEventListener('click', () => downloadByLink('edit'));
$('linkSave').addEventListener('click', () => downloadByLink('save'));
$('linkCancel').addEventListener('click', () => link.ctl?.abort());
$('linkInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!$('linkEdit').disabled) downloadByLink('edit');
  }
});
$('linkInput').addEventListener('paste', () => setTimeout(() => ($('linkInput').value = extractUrl($('linkInput').value)), 0));

// ------------------------------------------------------------ баннеры

let bannerSeq = 0;
async function addBanners(files) {
  if (engine.busy || state.renderCtl) return toast('Сначала остановите воспроизведение или рендер', true);
  for (const file of files) {
    const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : null;
    if (!kind) {
      toast(`«${file.name}» — не картинка и не видео`, true);
      continue;
    }
    const url = URL.createObjectURL(file);
    const b = { id: ++bannerSeq, file, name: file.name, kind, url };
    try {
      if (kind === 'image') {
        const img = new Image();
        img.src = url;
        await img.decode();
        Object.assign(b, { el: img, width: img.naturalWidth, height: img.naturalHeight });
      } else {
        const v = document.createElement('video');
        v.playsInline = true;
        v.preload = 'auto';
        v.src = url;
        document.querySelector('.work-media').appendChild(v);
        await waitMeta(v);
        Object.assign(b, { el: v, width: v.videoWidth, height: v.videoHeight, duration: v.duration });
      }
      b.aspect = b.width / b.height || 16 / 9;
      state.banners.push(b);
    } catch {
      URL.revokeObjectURL(url);
      toast(`Не удалось открыть «${file.name}»`, true);
    }
  }
  renderBanners();
  schedulePlan(0);
}

function removeBanner(id) {
  if (engine.busy || state.renderCtl) return toast('Сначала остановите воспроизведение или рендер', true);
  const i = state.banners.findIndex((b) => b.id === id);
  if (i < 0) return;
  const [b] = state.banners.splice(i, 1);
  if (b.kind === 'video') b.el.remove();
  URL.revokeObjectURL(b.url);
  renderBanners();
  schedulePlan(0);
}

function renderBanners() {
  const ul = $('bannerList');
  ul.innerHTML = '';
  for (const b of state.banners) {
    const li = document.createElement('li');
    li.className = 'banner-item';
    const thumb = b.kind === 'image' ? `<img src="${b.url}" alt="">` : `<video src="${b.url}" muted playsinline preload="metadata"></video>`;
    const info = b.kind === 'image'
      ? `картинка ${b.width}×${b.height}`
      : `видео ${fmtTime(b.duration)} · ${b.width}×${b.height}`;
    li.innerHTML = `${thumb}<div class="grow"><div class="ellipsis">${esc(b.name)}</div><div class="muted small">${info}</div></div>
      <button type="button" class="btn btn-sm btn-ghost" aria-label="Удалить баннер ${esc(b.name)}">Удалить</button>`;
    li.querySelector('button').addEventListener('click', () => removeBanner(b.id));
    ul.appendChild(li);
  }
  $('rotationField').hidden = state.banners.length < 2;
}

// ------------------------------------------------------------ анализ

function stopAnalysis() {
  state.analysisCtl?.abort();
  state.analysisCtl = null;
}

function startAnalysis() {
  if (!state.video) return Promise.resolve();
  stopAnalysis();
  const p = runAnalysis();
  state.video.analysisPromise = p;
  return p;
}

async function runAnalysis() {
  const ctl = new AbortController();
  state.analysisCtl = ctl;
  const v = state.video;
  const st = $('analysisState');
  const bar = $('analysisProgress');
  $('analyzeCancel').hidden = false;
  updateButtons();
  try {
    let result;
    if (activeEngine() === 'server') {
      st.textContent = 'Передаю видео на компьютер для анализа…';
      setProgress(bar, 0);
      const id = await ensureSourceUploaded();
      st.textContent = 'Ищу паузы в речи и смены сцен (ffmpeg)…';
      result = await analyzeOnServer(id, { signal: ctl.signal, onProgress: (p) => setProgress(bar, p) });
    } else {
      st.textContent = 'Ищу паузы в речи и смены сцен…';
      setProgress(bar, 0);
      let file = v.file;
      if (file.remote) {
        st.textContent = 'Получаю видео с компьютера для анализа…';
        const blob = await (await fetch(file.url, { signal: ctl.signal })).blob();
        file = new File([blob], file.name, { type: blob.type || 'video/mp4' });
      }
      result = await analyzeInBrowser(file, v.url, v.duration, {
        signal: ctl.signal,
        onProgress: (p, label) => {
          setProgress(bar, p);
          st.textContent = `Анализ: ${label} ${Math.round(p * 100)}%`;
        },
      });
    }
    v.analysis = result;
    v.analysisNote = `Найдено пауз: ${result.silences.length}, смен сцен: ${result.scenes.length}.` + (result.note ? ` ${result.note}` : '');
    if (state.video !== v) return;
    state.analysis = result;
    st.textContent = v.analysisNote;
    schedulePlan(0);
  } catch (e) {
    if (state.video !== v) return;
    if (isAbort(e)) st.textContent = 'Анализ отменён — нарезка по ровному времени.';
    else st.textContent = 'Анализ не удался: ' + e.message + ' Нарезка по ровному времени.';
  } finally {
    if (state.analysisCtl === ctl) state.analysisCtl = null;
    setProgress(bar, null);
    $('analyzeCancel').hidden = true;
    updateButtons();
  }
}

$('analyzeBtn').addEventListener('click', () => startAnalysis());
$('analyzeCancel').addEventListener('click', () => stopAnalysis());

// ------------------------------------------------------------ план

let planTimer;
function schedulePlan(delay = 150) {
  clearTimeout(planTimer);
  planTimer = setTimeout(rebuildPlan, delay);
}

function rebuildPlan() {
  if (!state.video) {
    updateButtons();
    return;
  }
  if (engine.busy && !state.renderCtl) engine.stop();
  const s = state.settings;
  state.plan = buildPlan({
    duration: state.video.duration,
    analysis: state.analysis,
    settings: s,
    banners: state.banners.map((b) => ({ kind: b.kind, duration: b.duration })),
  });
  const { W, H } = outputSize(s.look, state.video.width, state.video.height);
  state.W = W;
  state.H = H;
  state.factory = new LayerFactory({ W, H, settings: state.plan.settings, banners: state.banners });
  engine.configure({
    W,
    H,
    settings: state.plan.settings,
    factory: state.factory,
    banners: state.banners,
    srcW: state.video.width,
    srcH: state.video.height,
  });
  if (state.selected >= state.plan.parts.length) state.selected = 0;
  renderPlan();
  renderCaptions();
  drawStill();
  updateButtons();
}

function renderPlan() {
  const plan = state.plan;
  const parts = plan.parts;
  const durs = parts.map((p) => p.duration);
  const adsTotal = parts.reduce((a, p) => a + p.ads.length, 0);
  const minD = Math.min(...durs);
  const maxD = Math.max(...durs);
  $('planSummary').innerHTML = `
    <div class="stat"><b>${parts.length}</b><span>${parts.length === 1 ? 'часть' : parts.length < 5 ? 'части' : 'частей'}</span></div>
    <div class="stat"><b>${Math.abs(maxD - minD) < 1 ? fmtTime(maxD) : `${fmtTime(minD)}–${fmtTime(maxD)}`}</b><span>длина части</span></div>
    <div class="stat"><b>${adsTotal}</b><span>показов рекламы</span></div>
    <div class="stat"><b>${state.W}×${state.H}</b><span>кадр</span></div>`;
  renderTimeline($('timeline'), plan, { selected: state.selected });
  $('legend').hidden = false;
  $('warnings').innerHTML = plan.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
  if (!state.banners.length) {
    $('warnings').innerHTML += '<li>Баннеры не добавлены — видео будет только нарезано на части.</li>';
  }

  const list = $('partList');
  list.innerHTML = parts
    .map((p, i) => {
      const ads = p.ads.length ? `реклама: ${p.ads.map((a) => fmtTime(a.outStart)).join(', ')}` : 'без рекламы';
      const recap = p.recapLen > 0 ? ` · повтор ${Math.round(p.recapLen)} с` : '';
      return `<li class="part-item${i === state.selected ? ' is-selected' : ''}" data-part="${i}">
        <div class="grow"><b>Часть ${i + 1}</b> · ${fmtTime(p.duration)}
          <div class="muted small">из исходника ${fmtTime(p.srcStart)}–${fmtTime(p.srcEnd)}${recap} · ${ads}</div></div>
        <div class="row gap-s">
          <button type="button" class="btn btn-sm" data-act="preview" data-part="${i}" aria-label="Смотреть часть ${i + 1}">▶ Смотреть</button>
          <button type="button" class="btn btn-sm" data-act="render" data-part="${i}" aria-label="Создать только часть ${i + 1}">Создать</button>
        </div></li>`;
    })
    .join('');

  const sel = $('previewPart');
  sel.innerHTML = parts.map((p, i) => `<option value="${i}">Часть ${i + 1} · ${fmtTime(p.duration)}</option>`).join('');
  sel.value = String(state.selected);
}

function selectPart(i, { still = true } = {}) {
  state.selected = i;
  $('previewPart').value = String(i);
  document.querySelectorAll('.part-item').forEach((el) => el.classList.toggle('is-selected', Number(el.dataset.part) === i));
  document.querySelectorAll('.tl-row').forEach((el, k) => el.classList.toggle('is-selected', k === i));
  if (still) drawStill();
}

$('partList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const i = Number(b.dataset.part);
  if (b.dataset.act === 'preview') {
    selectPart(i, { still: false });
    playPreview(0);
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else renderParts([state.plan.parts[i]]);
});

$('timeline').addEventListener('click', (e) => {
  const ad = e.target.closest('.tl-ad');
  const bar = e.target.closest('.tl-bar');
  if (ad) {
    selectPart(Number(ad.dataset.part), { still: false });
    playPreview(Math.max(0, Number(ad.dataset.out) - 2));
  } else if (bar) selectPart(Number(bar.dataset.part));
});

$('previewPart').addEventListener('change', (e) => selectPart(Number(e.target.value)));

// ------------------------------------------------------------ превью

let stillToken = 0;
async function drawStill() {
  const part = state.plan?.parts[state.selected];
  if (!part || engine.busy) return;
  const token = ++stillToken;
  const t = part.ads.length ? part.ads[0].outStart + Math.min(1.2, (part.ads[0].outEnd - part.ads[0].outStart) / 2) : Math.min(1.5, part.duration / 2);
  // дождаться предыдущей перемотки, чтобы кадры не перепутались
  await new Promise((r) => setTimeout(r, 30));
  if (token !== stillToken || engine.busy) return;
  try {
    await engine.drawStill(part, t);
    $('previewTime').textContent = `${fmtTime(t)} / ${fmtTime(part.duration)}`;
  } catch {
    /* ignore */
  }
}

async function playPreview(fromOut = 0) {
  const part = state.plan?.parts[state.selected];
  if (!part || state.renderCtl) return;
  if (engine.busy) {
    engine.stop();
    await new Promise((r) => setTimeout(r, 60));
  }
  engine.unlockAudio();
  $('previewPlay').hidden = true;
  $('previewStop').hidden = false;
  try {
    await engine.play(part, {
      fromOut,
      onTime: (t) => ($('previewTime').textContent = `${fmtTime(t)} / ${fmtTime(part.duration)}`),
    });
  } catch (e) {
    toast('Превью: ' + e.message, true);
  } finally {
    $('previewPlay').hidden = false;
    $('previewStop').hidden = true;
  }
}

$('previewPlay').addEventListener('click', () => {
  engine.unlockAudio();
  playPreview(0);
});
$('previewAd').addEventListener('click', () => {
  engine.unlockAudio();
  const part = state.plan?.parts[state.selected];
  const ad = part?.ads[0];
  playPreview(ad ? Math.max(0, ad.outStart - 2) : 0);
});
$('previewStop').addEventListener('click', () => engine.stop());

function updateButtons() {
  const hasPlan = !!state.plan?.parts?.length;
  const rendering = !!state.renderCtl;
  $('previewPlay').disabled = !hasPlan || rendering;
  $('previewAd').disabled = !hasPlan || rendering || !state.plan?.parts[state.selected]?.ads.length;
  $('renderAll').disabled = !hasPlan || rendering || !!batchRun;
  $('renderEvery').disabled = !state.videos.length || rendering || !!batchRun;
  $('analyzeBtn').disabled = !state.video || !!state.analysisCtl || rendering;
  document.querySelectorAll('[data-act="render"]').forEach((b) => (b.disabled = rendering));
}

// ------------------------------------------------------------ рендер

function fileNameFor(part) {
  const base = state.video ? sanitizeFileName(state.video.file.name) : 'video';
  return sanitizeFileName(fillTemplate(state.settings.output.fileName, { name: base, n: part.index + 1, total: part.total }), `part${part.index + 1}`);
}

function addResult(r) {
  const v = state.video;
  r.videoId = v?.id;
  state.results = state.results.filter((x) => !(x.videoId === r.videoId && x.index === r.index));
  state.results.push(r);
  renderResults();
  renderVideoList();
}

const videoNo = (r) => state.videos.findIndex((v) => v.id === r.videoId) + 1;

function renderResults() {
  const ul = $('results');
  ul.innerHTML = '';
  state.results.sort((a, b) => videoNo(a) - videoNo(b) || a.index - b.index);
  for (const r of state.results) {
    const li = document.createElement('li');
    li.className = 'result-item';
    const href = r.objectUrl || r.url;
    const dl = r.objectUrl ? href : `${href}?download=1`;
    const multi = state.videos.length > 1;
    li.innerHTML = `<div class="grow"><b>${multi ? `Видео ${videoNo(r)} · ` : ''}Часть ${r.index + 1}</b> <span class="muted small">${esc(r.name)} · ${fmtSize(r.size)}</span></div>
      <div class="row gap-s wrap">
        <button type="button" class="btn btn-sm" data-act="watch">Смотреть</button>
        <a class="btn btn-sm" href="${dl}" download="${esc(r.name)}">Скачать</a>
        ${navigator.share ? '<button type="button" class="btn btn-sm btn-primary" data-act="share">Сохранить / Поделиться</button>' : ''}
      </div>`;
    li.querySelector('[data-act="watch"]').addEventListener('click', (e) => {
      const existing = li.querySelector('video');
      if (existing) {
        existing.remove();
        e.target.textContent = 'Смотреть';
        return;
      }
      const v = document.createElement('video');
      v.src = href;
      v.controls = true;
      v.playsInline = true;
      li.appendChild(v);
      e.target.textContent = 'Скрыть';
      v.play().catch(() => {});
    });
    li.querySelector('[data-act="share"]')?.addEventListener('click', (e) => shareResult(r, e.target));
    ul.appendChild(li);
  }
  $('downloadAllRow').hidden = state.results.length < 2;
}

async function shareResult(r, btn) {
  try {
    if (!r.file) {
      btn.textContent = 'Готовлю файл…';
      btn.disabled = true;
      const blob = r.blob || (await (await fetch(r.url)).blob());
      r.file = new File([blob], r.name, { type: blob.type || 'video/mp4' });
      btn.disabled = false;
    }
    if (navigator.canShare && !navigator.canShare({ files: [r.file] })) throw new Error('Этот браузер не умеет делиться файлами — используйте «Скачать»');
    await navigator.share({ files: [r.file], title: r.name });
    btn.textContent = 'Сохранить / Поделиться';
  } catch (e) {
    btn.disabled = false;
    if (e.name === 'NotAllowedError') {
      // iOS разрешает «Поделиться» только сразу после нажатия — файл уже готов, нужно нажать ещё раз
      btn.textContent = 'Нажмите ещё раз, чтобы сохранить';
    } else if (!isAbort(e)) {
      btn.textContent = 'Сохранить / Поделиться';
      toast(e.message, true);
    } else btn.textContent = 'Сохранить / Поделиться';
  }
}

$('downloadAll').addEventListener('click', async () => {
  for (const r of state.results) {
    const a = document.createElement('a');
    a.href = r.objectUrl || `${r.url}?download=1`;
    a.download = r.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((res) => setTimeout(res, 900));
  }
});

$('renderAll').addEventListener('click', () => {
  engine.unlockAudio();
  renderParts(state.plan.parts);
});
$('renderEvery').addEventListener('click', async () => {
  if (state.renderCtl || batchRun) return;
  engine.unlockAudio();
  const run = { cancelled: false };
  batchRun = run;
  const list = [...state.videos];
  let ok = 0;
  try {
    for (const [i, v] of list.entries()) {
      if (run.cancelled || !state.videos.includes(v)) continue;
      $('renderState').textContent = `Видео ${i + 1} из ${list.length}: ${v.file.name} — готовлю план…`;
      if (!(await activateVideo(v))) continue;
      // ждём поиск пауз, чтобы части резались по паузам, как при ручном рендере
      await v.analysisPromise?.catch(() => {});
      if (run.cancelled) break;
      clearTimeout(planTimer);
      rebuildPlan();
      if (!state.plan?.parts?.length) continue;
      if (await renderParts(state.plan.parts, { batch: run })) ok++;
    }
    $('renderState').textContent = run.cancelled
      ? `Рендер отменён. Готово видео: ${ok} из ${list.length}.`
      : `Готово: части для ${ok} из ${list.length} видео.`;
    if (!run.cancelled) toast('Все видео готовы');
  } finally {
    batchRun = null;
    updateButtons();
  }
});

$('renderCancel').addEventListener('click', () => {
  if (batchRun) batchRun.cancelled = true;
  state.renderCtl?.abort();
  engine.stop();
});

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* не поддерживается */
  }
}

function beforeUnload(e) {
  e.preventDefault();
  e.returnValue = '';
}

async function renderParts(parts, { batch = null } = {}) {
  if (!parts?.length || state.renderCtl) return false;
  engine.unlockAudio();
  if (engine.busy) {
    engine.stop();
    await new Promise((r) => setTimeout(r, 80));
  }
  const ctl = new AbortController();
  state.renderCtl = ctl;
  const st = $('renderState');
  const bar = $('renderProgress');
  $('renderCancel').hidden = false;
  updateButtons();
  window.addEventListener('beforeunload', beforeUnload);
  setProgress(bar, 0);
  const t0 = performance.now();
  try {
    if (activeEngine() === 'server') await renderOnServer(parts, ctl, st, bar);
    else await renderInBrowser(parts, ctl, st, bar);
    const sec = Math.round((performance.now() - t0) / 1000);
    st.textContent = `Готово: ${parts.length} ${parts.length === 1 ? 'часть' : 'частей'} за ${fmtTime(sec)}.`;
    if (!batch) toast('Видео готовы');
    return true;
  } catch (e) {
    st.textContent = isAbort(e) ? 'Рендер отменён.' : 'Ошибка: ' + e.message;
    if (isAbort(e) && batch) batch.cancelled = true;
    if (!isAbort(e)) toast('Рендер не удался', true);
    return false;
  } finally {
    state.renderCtl = null;
    window.removeEventListener('beforeunload', beforeUnload);
    keepAwake(false);
    setProgress(bar, null);
    $('renderCancel').hidden = true;
    updateButtons();
    drawStill();
  }
}

function batchPrefix() {
  return batchRun ? `Видео ${state.videos.indexOf(state.video) + 1} из ${state.videos.length} · ` : '';
}

async function renderOnServer(parts, ctl, st, bar) {
  st.textContent = 'Передаю видео на компьютер…';
  const sourceId = await ensureSourceUploaded();
  await ensureBannersUploaded();
  st.textContent = 'Готовлю графику…';
  const specs = await buildServerSpecs(state.plan, parts, {
    factory: state.factory,
    banners: state.banners,
    W: state.W,
    H: state.H,
    settings: state.plan.settings,
    fileNameFor,
    signal: ctl.signal,
  });
  const jobId = await startRender({
    sourceId,
    parts: specs,
    encoder: state.settings.output.encoder,
    quality: state.settings.output.quality,
  });
  ctl.signal.addEventListener('abort', () => cancelJob(jobId), { once: true });
  const seen = new Set();
  await pollJob(
    jobId,
    (job) => {
      setProgress(bar, job.progress);
      if (job.status === 'running') st.textContent = `${batchPrefix()}${job.message || 'Рендер'} · ${Math.round(job.progress * 100)}%`;
      else if (job.status === 'queued') st.textContent = 'В очереди…';
      for (const r of job.results) {
        if (seen.has(r.name)) continue;
        seen.add(r.name);
        addResult({ index: r.index, name: r.name, size: r.size, url: r.url });
      }
    },
    ctl.signal
  );
}

async function renderInBrowser(parts, ctl, st, bar) {
  if (!pickRecorderMime()) throw new Error('Браузер не умеет записывать видео');
  await keepAwake(true);
  const total = parts.reduce((a, p) => a + p.duration, 0);
  let done = 0;
  for (const [k, part] of parts.entries()) {
    if (ctl.signal.aborted) throw new DOMException('Отменено', 'AbortError');
    selectPart(part.index, { still: false });
    st.textContent = `${batchPrefix()}Запись части ${part.index + 1} (${k + 1} из ${parts.length}) — не блокируйте экран`;
    const blob = await engine.play(part, {
      record: true,
      monitor: state.settings.output.monitorAudio,
      onTime: (t) => {
        setProgress(bar, (done + t) / total);
        $('previewTime').textContent = `● ${fmtTime(t)} / ${fmtTime(part.duration)}`;
      },
    });
    if (ctl.signal.aborted || !blob) throw new DOMException('Отменено', 'AbortError');
    done += part.duration;
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const name = `${fileNameFor(part)}.${ext}`;
    addResult({ index: part.index, name, size: blob.size, blob, objectUrl: URL.createObjectURL(blob) });
  }
}

// ------------------------------------------------------------ подписи

function renderCaptions() {
  const parts = state.plan?.parts || [];
  const s = state.settings.output;
  const title = s.title.trim() || (state.video ? state.video.file.name.replace(/\.[^.]+$/, '') : '');
  $('captionList').innerHTML = parts
    .map((p, i) => {
      const text = fillTemplate(s.caption, { title, n: i + 1, total: p.total, next: i + 2, prev: i });
      return `<li><div><pre>${esc(text)}</pre><button type="button" class="btn btn-sm" data-copy="${i}" aria-label="Скопировать подпись части ${i + 1}">Копировать</button></div></li>`;
    })
    .join('');
}

$('captionList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const text = b.parentElement.querySelector('pre').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('Подпись скопирована');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Подпись скопирована');
  }
});

// ------------------------------------------------------------ пресеты

function renderPresets() {
  const p = loadPresets();
  const names = Object.keys(p);
  $('presetSelect').innerHTML = names.length
    ? names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
    : '<option value="">Нет сохранённых пресетов</option>';
  $('presetLoad').disabled = !names.length;
  $('presetDelete').disabled = !names.length;
}

$('presetSave').addEventListener('click', () => {
  const name = prompt('Название пресета', 'Мой TikTok');
  if (!name?.trim()) return;
  const p = loadPresets();
  p[name.trim().slice(0, 60)] = state.settings;
  savePresets(p);
  renderPresets();
  $('presetSelect').value = name.trim().slice(0, 60);
  toast('Пресет сохранён');
});
$('presetLoad').addEventListener('click', () => {
  const p = loadPresets()[$('presetSelect').value];
  if (!p) return;
  state.settings = normalizeSettings(p);
  saveSettings();
  writeForm();
  onEngineChanged();
  schedulePlan(0);
  toast('Пресет применён');
});
$('presetDelete').addEventListener('click', () => {
  const name = $('presetSelect').value;
  if (!name || !confirm(`Удалить пресет «${name}»?`)) return;
  const p = loadPresets();
  delete p[name];
  savePresets(p);
  renderPresets();
});
$('presetReset').addEventListener('click', () => {
  if (!confirm('Вернуть все настройки по умолчанию?')) return;
  state.settings = normalizeSettings(DEFAULT_SETTINGS);
  saveSettings();
  writeForm();
  onEngineChanged();
  schedulePlan(0);
});

// ------------------------------------------------------------ iPhone

$('phoneBtn').addEventListener('click', () => {
  const urls = state.server?.lanUrls || [];
  if (!urls.length) return;
  const canvas = document.createElement('canvas');
  try {
    drawQR(canvas, urls[0], 6, 3);
  } catch {
    /* ignore */
  }
  $('qrBox').replaceChildren(canvas);
  $('phoneUrls').innerHTML = urls.map((u) => `<code>${esc(u)}</code>`).join('<br>');
  $('phoneDialog').showModal();
});

// ------------------------------------------------------------ старт

writeForm();
renderPresets();
updateButtons();
updateLinkBox();
detectServer();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// для автотестов и отладки
window.__banedAdder = { state, engine, rebuildPlan, renderParts };
