// Клиент локального сервера (Mac + ffmpeg). Всё общение — только с этим компьютером в вашей сети.
import { blurRadius, fadeDuration, slideDistance } from './core/layout.js';
import { orderLayers } from './core/layers.js';
import { BITMAP_KINDS, canvasToBlob } from './graphics.js';

export async function getServerStatus(timeout = 2500) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const r = await fetch('api/status', { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    return j.app === 'baned-adder' ? j : null;
  } catch {
    return null;
  }
}

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Ошибка сервера (${r.status})`);
  return j;
}

/** Загрузка файла на сервер с прогрессом (XHR — у fetch нет прогресса отправки). */
export function uploadFile(blob, name, { probe = false, onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `api/upload?name=${encodeURIComponent(name)}${probe ? '&probe=1' : ''}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let j = {};
      try {
        j = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status === 200) resolve(j);
      else reject(new Error(j.error || `Загрузка не удалась (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Нет связи с компьютером. Проверьте, что сервер запущен и вы в той же Wi-Fi сети.'));
    xhr.onabort = () => reject(new DOMException('Отменено', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

export async function pollJob(jobId, onUpdate, signal) {
  for (;;) {
    if (signal?.aborted) {
      fetch(`api/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
      throw new DOMException('Отменено', 'AbortError');
    }
    const r = await fetch(`api/jobs/${jobId}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('Задача потеряна (сервер перезапускали?)');
    const job = await r.json();
    onUpdate?.(job);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(job.error || 'Ошибка рендера');
    if (job.status === 'canceled') throw new DOMException('Отменено', 'AbortError');
    await new Promise((res) => setTimeout(res, 700));
  }
}

export async function analyzeOnServer(uploadId, { onProgress, signal } = {}) {
  const { jobId } = await api('api/analyze', { id: uploadId });
  const job = await pollJob(jobId, (j) => onProgress?.(j.progress), signal);
  return job.result;
}

/**
 * Готовит спецификации частей для ffmpeg: координаты, тайминги и PNG-слои
 * (PNG рисуются тем же кодом, что и превью, и загружаются на сервер).
 */
export async function buildServerSpecs(plan, parts, { factory, banners, W, H, settings, fileNameFor, onProgress, signal }) {
  const pngIds = new Map();
  const uploadPng = async (bm) => {
    if (pngIds.has(bm.key)) return pngIds.get(bm.key);
    const blob = await canvasToBlob(bm.canvas);
    const { id } = await uploadFile(blob, 'layer.png', { signal });
    pngIds.set(bm.key, id);
    return id;
  };
  const out = [];
  for (const [i, part] of parts.entries()) {
    onProgress?.(i / parts.length);
    const segments = part.segments.map((seg) =>
      seg.type === 'content'
        ? { type: 'content', start: seg.srcStart - part.srcStart, end: seg.srcEnd - part.srcStart }
        : {
            type: 'freeze',
            t: seg.srcTime - part.srcStart,
            dur: seg.outEnd - seg.outStart,
            blur: blurRadius(settings.ads.freezeBlur, W),
            dim: settings.ads.freezeDim / 100,
          }
    );
    const spec = {
      partIndex: part.index,
      W,
      H,
      fps: settings.look.fps,
      fit: settings.look.fit,
      accent: settings.look.accent,
      srcStart: part.srcStart,
      srcEnd: part.srcEnd,
      duration: part.duration,
      audioFade: settings.ads.audioFade,
      segments,
      adVideos: [],
      layers: [],
      progress: [],
    };
    for (const layer of orderLayers(part.layers)) {
      const F = fadeDuration(layer);
      const slide = layer.anim === 'slide' ? slideDistance(H) : 0;
      if (BITMAP_KINDS.has(layer.kind)) {
        const bm = factory.get(layer, part);
        spec.layers.push({ file: await uploadPng(bm), x: bm.x, y: bm.y, start: layer.start, end: layer.end, fade: F, slide });
      } else if (layer.kind === 'adVideo') {
        const b = banners[layer.banner];
        if (!b.uploadId) throw new Error('Видеобаннер не загружен на сервер');
        const r = factory.cardRect(layer.banner);
        const segIndex = part.segments.findIndex((s) => s.type === 'ad' && Math.abs(s.outStart - layer.start) < 1e-6);
        spec.adVideos.push({
          file: b.uploadId,
          ...r,
          start: layer.start,
          end: layer.end,
          fade: F,
          slide,
          audioSeg: settings.ads.mode === 'pause' && settings.ads.adAudio ? segIndex : -1,
          chroma: settings.ads.chroma.enabled
            ? { ...settings.ads.chroma, color: (settings.ads.chroma.auto && b.keyColor) || settings.ads.chroma.color }
            : null,
        });
      } else if (layer.kind === 'progress') {
        spec.progress.push({ ...factory.progressRect(layer.banner), start: layer.start, end: layer.end, fade: F });
      }
    }
    out.push({ spec, fileName: fileNameFor(part) });
  }
  onProgress?.(1);
  return out;
}

export async function startRender({ sourceId, parts, encoder, quality }) {
  const { jobId } = await api('api/render', { sourceId, parts, encoder, quality });
  return jobId;
}

export function cancelJob(jobId) {
  return fetch(`api/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
}

/**
 * Скачивание видео по ссылке (YouTube/TikTok) на компьютере через yt-dlp.
 * Возвращает { uploadId, name, title, size, info, url } — файл уже лежит на сервере.
 */
export async function fetchFromUrl(url, { onProgress, signal } = {}) {
  const { jobId } = await api('api/fetch', { url });
  const job = await pollJob(jobId, (j) => onProgress?.(j.progress, j.message), signal);
  return job.result;
}
