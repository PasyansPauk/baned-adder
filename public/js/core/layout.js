// Геометрия кадра и анимации. Чистые функции: одна и та же математика используется
// в браузерном рендере (canvas) и в серверном (ffmpeg), чтобы результат выглядел одинаково.
import { clamp, even } from './util.js';

const ASPECTS = { '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5], '16:9': [16, 9] };

/** Размер выходного кадра по настройкам «Оформления» и размеру исходника. */
export function outputSize(look, srcW, srcH) {
  let aw;
  let ah;
  if (ASPECTS[look.aspect]) [aw, ah] = ASPECTS[look.aspect];
  else {
    aw = srcW || 1920;
    ah = srcH || 1080;
  }
  const short = look.resolution || 1080;
  if (aw <= ah) return { W: even(short), H: even((short * ah) / aw) };
  return { W: even((short * aw) / ah), H: even(short) };
}

/** Прямоугольник, в который вписывается исходное видео при режиме fit. */
export function fitRect(fit, srcW, srcH, W, H) {
  if (!srcW || !srcH) return { x: 0, y: 0, w: W, h: H };
  const scale = fit === 'crop' ? Math.max(W / srcW, H / srcH) : Math.min(W / srcW, H / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/** Место баннера в кадре. aspect = ширина / высота баннера. */
export function cardRect(W, H, aspect, ads) {
  const a = aspect > 0 ? aspect : 16 / 9;
  let w = (W * ads.size) / 100;
  let h = w / a;
  const maxH = H * (ads.position === 'center' ? 0.62 : 0.4);
  if (h > maxH) {
    h = maxH;
    w = h * a;
  }
  w = even(w);
  h = even(h);
  const x = even((W - w) / 2);
  let y;
  // Верх и низ кадра в TikTok/Reels заняты интерфейсом — держим баннер в «безопасной» зоне.
  if (ads.position === 'top') y = H * 0.15;
  else if (ads.position === 'bottom') y = H * 0.76 - h;
  else y = (H - h) / 2 - H * 0.02;
  return { x, y: even(clamp(y, 0, H - h)), w, h };
}

/** Полоска-таймер под баннером. */
export function progressRect(card, W, H) {
  const h = even(Math.max(4, H * 0.006));
  const gap = even(H * 0.018);
  let y = card.y + card.h + gap;
  if (y + h > H) y = card.y - gap - h;
  return { x: card.x, y: even(Math.max(0, y)), w: card.w, h };
}

export const slideDistance = (H) => even(H * 0.04);

/**
 * Состояние анимации слоя в момент t: прозрачность и вертикальный сдвиг.
 * Линейные функции — ровно такие же формулы собираются в выражения ffmpeg (см. server/ffmpeg-graph.js).
 */
export function layerAnim(layer, t, H) {
  if (t < layer.start || t > layer.end) return null;
  const F = fadeDuration(layer);
  if (F <= 0) return { alpha: 1, dy: 0 };
  const pin = clamp((t - layer.start) / F, 0, 1);
  const pout = clamp((t - (layer.end - F)) / F, 0, 1);
  const alpha = Math.min(pin, 1 - pout);
  const P = layer.anim === 'slide' ? slideDistance(H) : 0;
  return { alpha, dy: P * (1 - pin) + P * pout };
}

export function fadeDuration(layer) {
  if (layer.anim === 'none') return 0;
  return Math.max(0, Math.min(layer.animDur ?? 0.4, (layer.end - layer.start) / 3));
}

/** Радиус размытия в пикселях выходного кадра. */
export const blurRadius = (blur, W) => Math.round((blur * Math.min(W, 1920)) / 1080);
