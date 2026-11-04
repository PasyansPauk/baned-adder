// Браузерный движок: превью и рендер прямо на телефоне/компьютере, без сервера.
// Кадр собирается в <canvas>, звук — через Web Audio, запись — MediaRecorder.
// Рендер идёт в реальном времени (часть 3 мин ≈ 3 мин записи), зато работает даже на iPhone без Mac.
import { blurRadius, fadeDuration, fitRect, layerAnim } from './core/layout.js';
import { orderLayers } from './core/layers.js';
import { BITMAP_KINDS } from './graphics.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function seekTo(video, t, timeout = 4000) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.002 && video.readyState >= 2) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    video.addEventListener('seeked', finish);
    video.currentTime = t;
  });
}

export function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const list = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return list.find((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  }) || null;
}

export class BrowserEngine {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.canvas — сюда рисуется кадр (виден пользователю как превью)
   * @param {HTMLVideoElement} o.video — исходное видео
   */
  constructor({ canvas, video }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video;
    this.small = document.createElement('canvas');
    this.freeze = document.createElement('canvas');
    this.tmp = document.createElement('canvas');
    this.key = document.createElement('canvas');
    this.audio = null;
    this.running = null;
  }

  /** Вызывать синхронно в обработчике клика (iOS разрешает звук только так). */
  unlockAudio() {
    if (!this.audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      const dest = ac.createMediaStreamDestination();
      const monitor = ac.createGain();
      monitor.connect(ac.destination);
      this.audio = { ac, dest, monitor, sources: new Map() };
    }
    if (this.audio.ac.state === 'suspended') this.audio.ac.resume();
  }

  /** Подключает медиа-элемент к аудиографу (один раз на элемент). */
  route(el) {
    if (!this.audio) return null;
    let node = this.audio.sources.get(el);
    if (!node) {
      const src = this.audio.ac.createMediaElementSource(el);
      const gain = this.audio.ac.createGain();
      src.connect(gain);
      gain.connect(this.audio.dest);
      gain.connect(this.audio.monitor);
      node = { src, gain };
      this.audio.sources.set(el, node);
    }
    return node.gain;
  }

  configure({ W, H, settings, factory, banners, srcW, srcH }) {
    this.W = W;
    this.H = H;
    this.s = settings;
    this.factory = factory;
    this.banners = banners;
    this.srcW = srcW;
    this.srcH = srcH;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    this.small.width = Math.max(2, Math.round(W / 12));
    this.small.height = Math.max(2, Math.round(H / 12));
    this.freeze.width = W;
    this.freeze.height = H;
  }

  /** Хромакей: вырезаем цвет по расстоянию в плоскости Cb/Cr (как ffmpeg chromakey), кладём на сплошной фон. */
  drawKeyed(ctx, sw, sh) {
    const { W, H, video } = this;
    const c = this.s.look.chroma;
    const r = fitRect(this.s.look.fit === 'crop' ? 'crop' : 'pad', sw, sh, W, H);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    const kw = Math.max(2, Math.round(r.w));
    const kh = Math.max(2, Math.round(r.h));
    if (this.key.width !== kw || this.key.height !== kh) {
      this.key.width = kw;
      this.key.height = kh;
      this.keyCtx = this.key.getContext('2d', { willReadFrequently: true });
    }
    const kctx = this.keyCtx || (this.keyCtx = this.key.getContext('2d', { willReadFrequently: true }));
    kctx.drawImage(video, 0, 0, kw, kh);
    const img = kctx.getImageData(0, 0, kw, kh);
    const d = img.data;
    const cb = (R, G, B) => -0.168736 * R - 0.331264 * G + 0.5 * B;
    const cr = (R, G, B) => 0.5 * R - 0.418688 * G - 0.081312 * B;
    const kr = parseInt(c.color.slice(1, 3), 16);
    const kg = parseInt(c.color.slice(3, 5), 16);
    const kb = parseInt(c.color.slice(5, 7), 16);
    const kcb = cb(kr, kg, kb);
    const kcr = cr(kr, kg, kb);
    const sim = Math.min(0.5, Math.max(0.01, c.similarity / 200));
    const blend = Math.min(0.5, Math.max(0, c.smooth / 200));
    const norm = 255 * Math.SQRT2;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i];
      const G = d[i + 1];
      const B = d[i + 2];
      const dcb = cb(R, G, B) - kcb;
      const dcr = cr(R, G, B) - kcr;
      const diff = Math.sqrt(dcb * dcb + dcr * dcr) / norm;
      const a = blend > 0.0001 ? Math.min(1, Math.max(0, (diff - sim) / blend)) : diff > sim ? 1 : 0;
      d[i + 3] = Math.round(a * 255);
    }
    kctx.putImageData(img, 0, 0);
    ctx.drawImage(this.key, r.x, r.y, r.w, r.h);
  }

  drawContent(ctx = this.ctx) {
    const { W, H, video } = this;
    const fit = this.s.look.fit;
    const sw = video.videoWidth || this.srcW;
    const sh = video.videoHeight || this.srcH;
    if (this.s.look.chroma?.enabled) {
      ctx.save();
      this.drawKeyed(ctx, sw, sh);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (fit === 'crop') {
      const r = fitRect('crop', sw, sh, W, H);
      ctx.drawImage(video, r.x, r.y, r.w, r.h);
    } else {
      if (fit === 'blur') {
        const sm = this.small.getContext('2d');
        const r = fitRect('crop', sw, sh, this.small.width, this.small.height);
        sm.drawImage(video, r.x, r.y, r.w, r.h);
        ctx.drawImage(this.small, 0, 0, W, H);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(0, 0, W, H);
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
      }
      const r = fitRect('pad', sw, sh, W, H);
      ctx.drawImage(video, r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  }

  /** Стоп-кадр с размытием и затемнением — считается один раз на паузу. */
  buildFreeze() {
    const { W, H } = this;
    const fctx = this.freeze.getContext('2d');
    this.drawContent(fctx);
    const r = blurRadius(this.s.ads.freezeBlur, W);
    if (r > 0) {
      const k = Math.max(2, r * 0.9);
      this.tmp.width = Math.max(2, Math.round(W / k));
      this.tmp.height = Math.max(2, Math.round(H / k));
      const t = this.tmp.getContext('2d');
      t.imageSmoothingQuality = 'high';
      t.drawImage(this.freeze, 0, 0, this.tmp.width, this.tmp.height);
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(this.tmp, 0, 0, W, H);
    }
    const dim = this.s.ads.freezeDim / 100;
    if (dim > 0) {
      fctx.fillStyle = `rgba(0,0,0,${dim})`;
      fctx.fillRect(0, 0, W, H);
    }
  }

  drawLayers(part, t) {
    const ctx = this.ctx;
    for (const layer of orderLayers(part.layers)) {
      const a = layerAnim(layer, t, this.H);
      if (!a || a.alpha <= 0) continue;
      ctx.save();
      ctx.globalAlpha = a.alpha;
      if (BITMAP_KINDS.has(layer.kind)) {
        const bm = this.factory.get(layer, part);
        ctx.drawImage(bm.canvas, bm.x, bm.y + a.dy);
      } else if (layer.kind === 'adVideo') {
        const el = this.banners[layer.banner]?.el;
        const r = this.factory.cardRect(layer.banner);
        if (el && el.readyState >= 2) ctx.drawImage(el, r.x, r.y + a.dy, r.w, r.h);
      } else if (layer.kind === 'progress') {
        const r = this.factory.progressRect(layer.banner);
        const p = Math.min(1, Math.max(0, (t - layer.start) / Math.max(0.01, layer.end - layer.start)));
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = this.s.look.accent;
        ctx.fillRect(r.x, r.y, Math.round(r.w * p), r.h);
      }
      ctx.restore();
    }
  }

  /** Статичный кадр части в момент outT (для обложки превью). */
  async drawStill(part, outT) {
    const seg = part.segments.find((s) => outT >= s.outStart && outT <= s.outEnd) || part.segments[0];
    if (seg.type === 'content') {
      await seekTo(this.video, seg.srcStart + (outT - seg.outStart));
      this.drawContent();
    } else {
      await seekTo(this.video, Math.max(0, seg.srcTime - 1 / this.s.look.fps));
      this.buildFreeze();
      this.ctx.drawImage(this.freeze, 0, 0);
    }
    this.drawLayers(part, outT);
  }

  stop() {
    if (this.running) this.running.stopped = true;
  }

  get busy() {
    return !!this.running;
  }

  /**
   * Проигрывает часть (превью) или записывает её (record = true).
   * @returns {Promise<Blob|null>}
   */
  async play(part, { record = false, fromOut = 0, onTime, monitor = true } = {}) {
    if (this.running) throw new Error('Уже идёт воспроизведение');
    const run = { stopped: false };
    this.running = run;
    const fps = this.s.look.fps;
    const video = this.video;
    this.unlockAudio();
    const srcGain = this.route(video);
    const adEls = new Set(part.layers.filter((l) => l.kind === 'adVideo').map((l) => this.banners[l.banner]?.el).filter(Boolean));
    const adGains = new Map([...adEls].map((el) => [el, this.route(el)]));
    if (this.audio) {
      this.audio.monitor.gain.value = monitor ? 1 : 0;
    }
    const fade = this.s.ads.audioFade;
    const pauseMode = this.s.ads.mode === 'pause';
    const setGain = (g, v, ramp = 0) => {
      if (!g || !this.audio) return;
      const now = this.audio.ac.currentTime;
      g.gain.cancelScheduledValues(now);
      if (ramp > 0) {
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(v, now + ramp);
      } else g.gain.setValueAtTime(v, now);
    };

    let rec = null;
    const chunks = [];
    let mime = null;
    if (record) {
      mime = pickRecorderMime();
      if (!mime) throw new Error('Этот браузер не умеет записывать видео (нет MediaRecorder). Используйте Safari 14.1+ или Chrome.');
      const stream = this.canvas.captureStream(fps);
      const tracks = [...stream.getVideoTracks()];
      if (this.audio) tracks.push(...this.audio.dest.stream.getAudioTracks());
      const px = this.W * this.H;
      const q = { high: 1, medium: 0.6, small: 0.35 }[this.s.output.quality] || 0.8;
      rec = new MediaRecorder(new MediaStream(tracks), {
        mimeType: mime,
        videoBitsPerSecond: Math.round(10_000_000 * q * (px / (1080 * 1920)) + 1_000_000),
        audioBitsPerSecond: 160_000,
      });
      rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    }
    const canPause = rec && typeof rec.pause === 'function';
    const recPause = () => canPause && rec.state === 'recording' && rec.pause();
    const recResume = () => {
      if (!rec) return;
      if (rec.state === 'inactive') rec.start(1000);
      else if (rec.state === 'paused') rec.resume();
    };

    const syncAdVideos = async (t) => {
      // в режиме «поверх видео» баннер-видео запускается внутри обычного сегмента
      for (const l of part.layers) {
        if (l.kind !== 'adVideo') continue;
        const el = this.banners[l.banner]?.el;
        if (!el) continue;
        const inside = t >= l.start && t < l.end;
        if (inside && el.paused && !el._starting) {
          el._starting = true;
          setGain(adGains.get(el), 0);
          el.currentTime = Math.max(0, t - l.start);
          el.play().catch(() => {}).finally(() => (el._starting = false));
        } else if (!inside && !el.paused) el.pause();
      }
    };

    try {
      const segs = part.segments;
      let first = segs.findIndex((s) => fromOut >= s.outStart && fromOut < s.outEnd);
      if (first < 0) first = 0;
      for (let i = first; i < segs.length && !run.stopped; i++) {
        const seg = segs[i];
        const offset = i === first ? Math.max(0, fromOut - seg.outStart) : 0;
        const nextIsAd = segs[i + 1]?.type === 'ad';
        if (seg.type === 'content') {
          recPause();
          await seekTo(video, seg.srcStart + offset);
          setGain(srcGain, 0);
          // первый кадр сегмента — до старта записи, чтобы в запись не попал «старый» кадр
          this.drawContent();
          this.drawLayers(part, seg.outStart + offset);
          recResume();
          setGain(srcGain, 1, i > 0 && segs[i - 1].type === 'ad' ? fade : 0.03);
          await video.play();
          let fadingOut = false;
          while (!run.stopped) {
            const ct = video.currentTime;
            const outT = seg.outStart + (ct - seg.srcStart);
            if (!pauseMode) await syncAdVideos(outT);
            this.drawContent();
            this.drawLayers(part, outT);
            onTime?.(outT);
            if (nextIsAd && !fadingOut && ct >= seg.srcEnd - fade) {
              fadingOut = true;
              setGain(srcGain, 0, Math.max(0.01, seg.srcEnd - ct));
            }
            if (ct >= seg.srcEnd - 0.5 / fps || video.ended) break;
            await nextFrame();
          }
          video.pause();
          for (const el of adEls) el.pause();
        } else {
          // пауза с рекламой
          if (Math.abs(video.currentTime - seg.srcTime) > 0.15) {
            recPause();
            await seekTo(video, Math.max(0, seg.srcTime - 1 / fps));
          }
          setGain(srcGain, 0);
          this.buildFreeze();
          const dur = seg.outEnd - seg.outStart;
          const adLayer = part.layers.find((l) => l.kind === 'adVideo' && l.start === seg.outStart);
          const adEl = adLayer ? this.banners[adLayer.banner]?.el : null;
          if (adEl) {
            await seekTo(adEl, offset);
            const g = adGains.get(adEl);
            setGain(g, 0);
            if (this.s.ads.adAudio) setGain(g, 1, 0.08);
            adEl.play().catch(() => {});
          }
          this.ctx.drawImage(this.freeze, 0, 0);
          this.drawLayers(part, seg.outStart + offset);
          recResume();
          const t0 = performance.now() - offset * 1000;
          while (!run.stopped) {
            const el = (performance.now() - t0) / 1000;
            if (el >= dur) break;
            const outT = seg.outStart + el;
            this.ctx.drawImage(this.freeze, 0, 0);
            this.drawLayers(part, outT);
            onTime?.(outT);
            if (adEl && el > dur - 0.25) setGain(adGains.get(adEl), 0, 0.2);
            await nextFrame();
          }
          if (adEl) adEl.pause();
        }
      }
    } finally {
      video.pause();
      for (const el of adEls) el.pause();
      this.running = null;
    }

    if (!rec) return null;
    if (rec.state === 'inactive') return null;
    const stopped = new Promise((r) => (rec.onstop = r));
    if (rec.state === 'paused') rec.resume();
    rec.stop();
    await stopped;
    if (run.stopped) return null;
    return new Blob(chunks, { type: mime.split(';')[0] });
  }
}

export { fadeDuration };
