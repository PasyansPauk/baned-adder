// Отрисовка графических слоёв (надписи, карточки рекламы) в canvas.
// Одни и те же картинки используются в превью, в браузерном рендере и отправляются
// в ffmpeg как PNG — поэтому результат совпадает в обоих движках.
import { cardRect, progressRect } from './core/layout.js';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const BITMAP_KINDS = new Set(['partLabel', 'recapLabel', 'endCard', 'ad']);

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitFont(ctx, text, weight, size, maxW) {
  let s = size;
  for (let i = 0; i < 20; i++) {
    ctx.font = `${weight} ${Math.round(s)}px ${FONT}`;
    if (ctx.measureText(text).width <= maxW) break;
    s *= 0.92;
  }
  return Math.round(s);
}

/** Плашка с текстом. Возвращает { canvas, x, y } в координатах кадра. */
function pill(W, text, { size, weight = 700, bg, fg = '#fff', centerY, shadow = true }) {
  const probe = makeCanvas(4, 4).getContext('2d');
  const fs = fitFont(probe, text, weight, size, W * 0.86);
  probe.font = `${weight} ${fs}px ${FONT}`;
  const tw = probe.measureText(text).width;
  const padX = Math.round(fs * 0.75);
  const padY = Math.round(fs * 0.45);
  const m = shadow ? Math.round(fs * 0.6) : 0;
  const w = Math.ceil(tw + padX * 2);
  const h = Math.ceil(fs * 1.25 + padY * 2);
  const c = makeCanvas(w + m * 2, h + m * 2);
  const ctx = c.getContext('2d');
  if (shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = m * 0.8;
    ctx.shadowOffsetY = m * 0.2;
  }
  roundRectPath(ctx, m, m, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = fg;
  ctx.font = `${weight} ${fs}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, m + w / 2, m + h / 2 + fs * 0.04);
  return { canvas: c, x: Math.round((W - c.width) / 2), y: Math.round(centerY - c.height / 2), h: c.height };
}

function drawTag(ctx, text, x, y, fs) {
  ctx.font = `600 ${fs}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  const padX = fs * 0.55;
  const h = fs * 1.6;
  roundRectPath(ctx, x, y, tw + padX * 2, h, h / 2);
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + padX, y + h / 2 + fs * 0.04);
}

/**
 * Фабрика слоёв для конкретного размера кадра и настроек.
 * banners: [{ kind, el (Image | Video), aspect }]
 */
export class LayerFactory {
  constructor({ W, H, settings, banners }) {
    this.W = W;
    this.H = H;
    this.s = settings;
    this.banners = banners;
    this.cache = new Map();
  }

  key(layer, part) {
    if (layer.kind === 'ad') return `ad:${layer.banner}`;
    const row = layer.kind === 'recapLabel' && part?.layers.some((l) => l.kind === 'partLabel') ? 1 : 0;
    return `${layer.kind}:${row}:${layer.text}`;
  }

  cardRect(bannerIndex) {
    const b = this.banners[bannerIndex];
    return cardRect(this.W, this.H, b?.aspect || 16 / 9, this.s.ads);
  }

  progressRect(bannerIndex) {
    return progressRect(this.cardRect(bannerIndex), this.W, this.H);
  }

  /** Растровый слой {canvas, x, y} — кэшируется. */
  get(layer, part) {
    const k = this.key(layer, part);
    let v = this.cache.get(k);
    if (!v) {
      v = this.render(layer, part);
      v.key = k;
      this.cache.set(k, v);
    }
    return v;
  }

  render(layer, part) {
    const { W, H, s } = this;
    const base = Math.round(W * 0.042);
    switch (layer.kind) {
      case 'partLabel':
        return pill(W, layer.text, { size: base, bg: 'rgba(0,0,0,0.55)', centerY: H * 0.115 });
      case 'recapLabel': {
        const row = part?.layers.some((l) => l.kind === 'partLabel') ? 1 : 0;
        return pill(W, layer.text, {
          size: base * 0.78,
          weight: 600,
          bg: 'rgba(255,255,255,0.88)',
          fg: '#111',
          centerY: H * 0.115 + row * base * 2.6,
        });
      }
      case 'endCard':
        return pill(W, layer.text, { size: base * 1.08, bg: s.look.accent, centerY: H * 0.7 });
      case 'ad':
        return this.renderAd(layer.banner);
      default:
        throw new Error('Неизвестный слой ' + layer.kind);
    }
  }

  renderAd(bannerIndex) {
    const { W, s } = this;
    const b = this.banners[bannerIndex];
    const r = this.cardRect(bannerIndex);
    const m = Math.round(W * 0.045);
    const c = makeCanvas(r.w + m * 2, r.h + m * 2);
    const ctx = c.getContext('2d');
    const isVideo = b?.kind === 'video';
    const radius = isVideo ? 0 : Math.round(Math.min(r.w, r.h) * 0.05);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = m * 0.9;
    ctx.shadowOffsetY = m * 0.25;
    roundRectPath(ctx, m, m, r.w, r.h, radius);
    ctx.fillStyle = '#111';
    ctx.fill();
    ctx.restore();
    if (isVideo) {
      // «окно» под видео: само видео рисуется слоем ниже
      ctx.clearRect(m, m, r.w, r.h);
    } else if (b?.el) {
      ctx.save();
      roundRectPath(ctx, m, m, r.w, r.h, radius);
      ctx.clip();
      ctx.drawImage(b.el, m, m, r.w, r.h);
      ctx.restore();
    }
    if (s.ads.tag && s.ads.tagText.trim()) {
      const fs = Math.max(12, Math.round(W * 0.026));
      drawTag(ctx, s.ads.tagText.trim(), m + fs * 0.6, m + fs * 0.6, fs);
    }
    return { canvas: c, x: r.x - m, y: r.y - m };
  }

  clear() {
    this.cache.clear();
  }
}

/** PNG из canvas (для отправки в ffmpeg). */
export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось создать PNG'))), 'image/png')
  );
}

export { roundRectPath };
