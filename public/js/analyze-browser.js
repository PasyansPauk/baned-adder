// Анализ видео прямо в браузере (когда нет Mac-сервера с ffmpeg):
//  • паузы в звуке — decodeAudioData + общий детектор из core/audio.js
//  • смены сцен — покадровое сравнение маленьких превью через seek
import { LoudnessMeter, detectSilences } from './core/audio.js';
import { seekTo } from './engine-browser.js';

const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function analyzeAudio(file) {
  // на iPhone память ограничена — огромные файлы целиком в память не грузим
  const limit = (isIOS() ? 700 : 2500) * 1024 * 1024;
  if (file.size > limit) return { silences: [], skipped: 'Файл большой — паузы в звуке не анализировались' };
  const buf = await file.arrayBuffer();
  let audio;
  for (const rate of [16000, 22050, 44100]) {
    try {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new OAC(1, 1, rate);
      audio = await new Promise((res, rej) => {
        const p = ctx.decodeAudioData(buf.slice(0), res, rej);
        if (p && p.then) p.then(res, rej);
      });
      break;
    } catch {
      audio = null;
    }
  }
  if (!audio) return { silences: [], skipped: 'В видео нет звука или браузер не смог его прочитать' };
  const meter = new LoudnessMeter(audio.sampleRate);
  const chans = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  const block = 65536;
  const mix = new Float32Array(block);
  for (let i = 0; i < audio.length; i += block) {
    const n = Math.min(block, audio.length - i);
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (const ch of chans) s += ch[i + j];
      mix[j] = s / chans.length;
    }
    meter.push(n === block ? mix : mix.subarray(0, n));
  }
  const { db, hopSec } = meter.result();
  return { silences: detectSilences(db, hopSec) };
}

const GW = 48;
const GH = 27;

function frameSignature(ctx, video) {
  ctx.drawImage(video, 0, 0, GW, GH);
  const d = ctx.getImageData(0, 0, GW, GH).data;
  const luma = new Float32Array(GW * GH);
  const hist = new Float32Array(16);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    luma[p] = y;
    hist[Math.min(15, (y * 16) | 0)]++;
  }
  for (let i = 0; i < 16; i++) hist[i] /= luma.length;
  return { luma, hist };
}

function distance(a, b) {
  let px = 0;
  for (let i = 0; i < a.luma.length; i++) px += Math.abs(a.luma[i] - b.luma[i]);
  px /= a.luma.length;
  let h = 0;
  for (let i = 0; i < 16; i++) h += Math.abs(a.hist[i] - b.hist[i]);
  return 0.6 * px * 3 + 0.4 * (h / 2);
}

async function analyzeScenes(url, duration, onProgress, signal) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  video.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0';
  document.body.appendChild(video);
  try {
    await new Promise((res, rej) => {
      video.onloadeddata = res;
      video.onerror = () => rej(new Error('Видео не читается'));
    });
    const canvas = document.createElement('canvas');
    canvas.width = GW;
    canvas.height = GH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const step = duration > 2400 ? 2 : duration > 900 ? 1 : 0.5;
    const sigAt = async (t) => {
      await seekTo(video, Math.min(duration - 0.05, Math.max(0, t)));
      return frameSignature(ctx, video);
    };

    const samples = [];
    for (let t = 0; t < duration - 0.1; t += step) {
      if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
      samples.push({ t, sig: await sigAt(t) });
      onProgress?.(t / duration);
    }
    const diffs = samples.map((s, i) => (i ? distance(samples[i - 1].sig, s.sig) : 0));
    const sorted = [...diffs].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 0;
    const mad = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 0;
    const thr = Math.max(0.22, med + 6 * mad);

    const scenes = [];
    for (let i = 1; i < diffs.length; i++) {
      if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
      if (diffs[i] < thr || diffs[i] < (diffs[i - 1] || 0) || diffs[i] < (diffs[i + 1] || 0)) continue;
      // уточняем момент смены сцены бинарным поиском
      let lo = samples[i - 1].t;
      let hi = samples[i].t;
      const A = samples[i - 1].sig;
      const B = samples[i].sig;
      for (let k = 0; k < 5; k++) {
        const mid = (lo + hi) / 2;
        const m = await sigAt(mid);
        if (distance(A, m) < distance(m, B)) lo = mid;
        else hi = mid;
      }
      scenes.push({ t: Math.round(hi * 1000) / 1000, score: Math.min(1, diffs[i] / 0.6) });
    }
    return scenes;
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

export async function analyzeInBrowser(file, url, duration, { onProgress, signal } = {}) {
  onProgress?.(0, 'Звук…');
  let audio = { silences: [] };
  try {
    audio = await analyzeAudio(file);
  } catch (e) {
    audio = { silences: [], skipped: 'Звук не проанализирован: ' + e.message };
  }
  if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
  onProgress?.(0.05, 'Сцены…');
  const scenes = await analyzeScenes(url, duration, (p) => onProgress?.(0.05 + p * 0.95, 'Сцены…'), signal);
  return { silences: audio.silences, scenes, note: audio.skipped || '', engine: 'browser' };
}
