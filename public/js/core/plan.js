// Планировщик: из длительности видео, результатов анализа и настроек строит план —
// какие части получатся, где начинается повтор, где пауза с рекламой и какие надписи когда показывать.
// Модуль чистый: его используют и браузер (превью/рендер), и тесты, и сервер.
import { clamp, fillTemplate, mulberry32, parseTimeList } from './util.js';
import { normalizeSettings } from './settings.js';

/** Длительность одного показа баннера. */
export function adDuration(banner, ads) {
  if (banner?.kind === 'video') return clamp(banner.duration || ads.imageDuration, 0.5, ads.maxVideoDuration);
  return ads.imageDuration;
}

/** Точки, где «красиво» резать: паузы в звуке и смены сцен. */
export function buildCandidates(analysis, duration) {
  const silences = analysis?.silences || [];
  const out = [];
  for (const s of silences) {
    const len = s.end - s.start;
    if (len < 0.15) continue;
    out.push({
      t: (s.start + s.end) / 2,
      score: 0.45 + 0.4 * Math.min(1, len / 1.2) + 0.15 * (s.depth ?? 0.5),
      kind: 'silence',
    });
  }
  for (const sc of analysis?.scenes || []) {
    const t = typeof sc === 'number' ? sc : sc.t;
    const strength = clamp(typeof sc === 'number' ? 0.6 : sc.score ?? 0.6, 0, 1);
    const inSilence = silences.some((s) => t >= s.start - 0.3 && t <= s.end + 0.3);
    out.push({ t, score: 0.5 + 0.25 * strength + (inSilence ? 0.35 : 0), kind: 'scene' });
  }
  return out.filter((c) => c.t > 0.5 && c.t < duration - 0.5).sort((a, b) => a.t - b.t);
}

function pickBest(cands, ideal, lo, hi, radius) {
  let best = null;
  let bestScore = -Infinity;
  for (const c of cands) {
    if (c.t < lo || c.t > hi) continue;
    const s = c.score - (0.6 * Math.abs(c.t - ideal)) / Math.max(radius, 1);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

/** Разбиение исходника на диапазоны [srcStart, srcEnd]; newStart — где кончается повтор и начинается новое. */
export function splitRanges(D, cands, split, adTime, q, warnings) {
  const L = split.targetLen;
  const T = Math.max(1, split.tolerance);
  const slack = split.strict ? 0 : split.tolerance;
  const maxLen = L - adTime + slack;
  if (!split.enabled || D <= maxLen) return [{ srcStart: 0, newStart: 0, srcEnd: D }];

  const O = Math.min(split.overlap, L / 2);
  let cap = L - adTime - O;
  if (cap < 10) {
    warnings.push('Длина части слишком маленькая: реклама и повтор занимают почти всё время. Увеличьте длину части или уменьшите повтор/рекламу.');
    cap = 10;
  }

  const trySplit = (n, smart) => {
    const ranges = [];
    let start = 0;
    let newStart = 0;
    for (let k = 1; k < n; k++) {
      // Цель пересчитывается от фактического предыдущего разреза: если «умный» разрез
      // сдвинулся, остаток снова делится поровну и последняя часть не раздувается.
      const left = n - k + 1;
      const ideal = k === 1 ? O + (D - O) / n : newStart + (D - newStart) / left;
      const hiBound = start + Math.max(maxLen, cap + O);
      let lo = Math.max(ideal - T, newStart + 5);
      let hi = Math.min(ideal + T, hiBound, D - 5);
      // окно схлопнулось — жёсткий предел длины (hiBound) важнее «идеальной» точки
      if (hi < lo) lo = hi = Math.max(newStart + 5, Math.min(hi, D - 5));
      let cut = clamp(ideal, lo, hi);
      if (smart) {
        const best = pickBest(cands, ideal, lo, hi, T);
        if (best) cut = best.t;
      }
      cut = q(cut);
      ranges.push({ srcStart: start, newStart, srcEnd: cut });
      newStart = cut;
      if (O > 0) {
        let r = cut - O;
        if (smart && split.recapSnap) {
          const best = pickBest(cands, r, r - 3, Math.min(r + 2, cut - 2), 3);
          if (best) r = best.t;
        }
        start = q(Math.max(r, ranges[ranges.length - 1].srcStart + 1, 0));
      } else start = cut;
    }
    ranges.push({ srcStart: start, newStart, srcEnd: D });
    const ok = ranges.every((r) => r.srcEnd - r.srcStart <= maxLen + 0.05);
    return { ok, ranges };
  };

  const n0 = Math.max(2, Math.ceil((D - O) / (cap + slack)));
  if (split.smart) {
    for (let n = n0; n < n0 + 4; n++) {
      const r = trySplit(n, true);
      if (r.ok) return r.ranges;
    }
  }
  // «Умные» точки слишком редкие для такой короткой длины — режем ровно: так длина гарантирована.
  for (let n = n0; n < n0 + 4; n++) {
    const r = trySplit(n, false);
    if (r.ok) {
      if (split.smart && cands.length) warnings.push('Для такой длины частей не хватило пауз — часть разрезов сделана по ровному времени.');
      return r.ranges;
    }
  }
  warnings.push('Не удалось уложить все части в заданную длину — некоторые получились чуть длиннее.');
  return trySplit(n0, false).ranges;
}

/** Моменты вставки рекламы внутри диапазона (в секундах исходника). */
function placeAds(range, index, s, cands, durs, warnings) {
  const ads = s.ads;
  const overlay = ads.mode === 'overlay';
  if (ads.placement === 'manual') {
    return parseTimeList(ads.manualTimes)
      .map((t) => range.srcStart + t)
      .filter((t) => t > range.srcStart + 0.5 && t < range.srcEnd - 0.5);
  }
  const N = ads.perPart;
  if (!N) return [];
  const partLen = range.srcEnd - range.srcStart;
  let ra = Math.max(range.srcStart + ads.minFromStart, range.newStart + (index > 0 ? 2 : 0));
  let rb = range.srcEnd - ads.minFromEnd - (overlay ? Math.max(...durs) : 0);
  if (rb - ra < Math.min(4, partLen / 4)) {
    warnings.push('Некоторые части короткие — реклама в них поставлена ближе к началу/концу, чем задано.');
    ra = range.srcStart + partLen * 0.15;
    rb = range.srcEnd - partLen * 0.15 - (overlay ? Math.max(...durs) : 0);
    if (rb < ra) rb = ra;
  }
  const spacing = (rb - ra) / N;
  const times = [];
  for (let j = 0; j < N; j++) {
    const ideal = ra + spacing * (j + 0.5);
    let t = ideal;
    if (ads.placement === 'smart') {
      const r = Math.min(8, spacing * 0.35);
      const best = pickBest(cands, ideal, Math.max(ra, ideal - r), Math.min(rb, ideal + r), r);
      if (best) t = best.t;
    }
    times.push(t);
  }
  return times;
}

function srcToOut(segments, t) {
  for (const seg of segments) {
    if (seg.type === 'content' && t >= seg.srcStart && t <= seg.srcEnd) return seg.outStart + (t - seg.srcStart);
  }
  return 0;
}

/**
 * Главная функция.
 * @param {object} p
 * @param {number} p.duration — длительность исходника, сек
 * @param {object} [p.analysis] — {silences:[{start,end,depth}], scenes:[{t,score}]}
 * @param {object} p.settings — настройки (будут нормализованы)
 * @param {{kind:'image'|'video', duration?:number}[]} p.banners
 */
/**
 * series — сквозная нумерация, когда видео несколько: { offset, total }.
 * offset — сколько частей у видео перед этим, total — сколько частей во всей серии.
 * Тогда части второго видео получают номера после частей первого («Часть 4/6»), а не начинают снова с 1.
 */
export function buildPlan({ duration, analysis, settings, banners = [], series = null }) {
  const s = normalizeSettings(settings);
  const fps = s.look.fps;
  const q = (t) => Math.round(t * fps) / fps;
  const warnings = [];
  const D = q(duration);
  if (!(D > 0)) return { parts: [], warnings: ['Нет видео'], settings: s, candidates: [] };

  const cands = buildCandidates(analysis, D);
  const adsOn = banners.length > 0;
  const durs = adsOn ? banners.map((b) => q(adDuration(b, s.ads))) : [0];
  const maxAd = Math.max(...durs);
  const perPart = !adsOn ? 0 : s.ads.placement === 'manual' ? parseTimeList(s.ads.manualTimes).length : s.ads.perPart;
  const adTime = s.ads.mode === 'pause' ? perPart * maxAd : 0;

  const ranges = splitRanges(D, cands, s.split, adTime, q, warnings);
  const total = ranges.length;
  const offset = Math.max(0, series?.offset || 0);
  const seriesTotal = Math.max(series?.total || 0, offset + total);
  const rand = mulberry32(1337);
  let adCounter = 0;
  const nextBanner = () => {
    const i = adCounter++;
    if (s.ads.rotation === 'first') return 0;
    if (s.ads.rotation === 'random') return Math.floor(rand() * banners.length);
    return i % banners.length;
  };

  const parts = ranges.map((range, index) => {
    const times = adsOn ? placeAds(range, index, s, cands, durs, warnings) : [];
    const segments = [];
    const layers = [];
    const ads = [];
    let out = 0;
    let cur = range.srcStart;
    let lastAdEnd = -Infinity;

    for (const rawT of times) {
      const t = q(rawT);
      const banner = nextBanner();
      const d = durs[banner];
      if (s.ads.mode === 'pause') {
        if (t <= cur) continue;
        segments.push({ type: 'content', srcStart: cur, srcEnd: t, outStart: q(out), outEnd: q(out + (t - cur)) });
        out = q(out + (t - cur));
        cur = t;
        segments.push({ type: 'ad', srcTime: t, banner, outStart: out, outEnd: q(out + d) });
        ads.push({ srcTime: t, banner, outStart: out, outEnd: q(out + d) });
        out = q(out + d);
      } else {
        const o = q(t - range.srcStart);
        if (o < lastAdEnd + 1 || o + d > range.srcEnd - range.srcStart) {
          warnings.push(`Часть ${index + 1}: реклама на ${o.toFixed(1)} с пропущена — не помещается.`);
          continue;
        }
        ads.push({ srcTime: t, banner, outStart: o, outEnd: q(o + d) });
        lastAdEnd = o + d;
      }
    }
    if (range.srcEnd > cur) {
      segments.push({ type: 'content', srcStart: cur, srcEnd: range.srcEnd, outStart: out, outEnd: q(out + (range.srcEnd - cur)) });
      out = q(out + (range.srcEnd - cur));
    }
    const partDur = out;
    const num = offset + index + 1; // номер части во всей серии
    const vars = { n: num, total: seriesTotal, prev: num - 1, next: num + 1 };
    const animDur = s.ads.animDur;

    if (s.look.partLabel && seriesTotal > 1) {
      const end = s.look.partLabelDur > 0 ? Math.min(s.look.partLabelDur, partDur) : partDur;
      layers.push({ kind: 'partLabel', text: fillTemplate(s.look.partLabelText, vars), start: 0, end, anim: 'fade', animDur: 0.35 });
    }
    const recapLen = index > 0 ? srcToOut(segments, range.newStart) : 0;
    if (s.look.recapLabel && recapLen >= 1.5) {
      layers.push({ kind: 'recapLabel', text: fillTemplate(s.look.recapLabelText, vars), start: 0, end: recapLen, anim: 'fade', animDur: 0.35 });
    }
    if (s.look.endCard && num < seriesTotal) {
      const d = Math.min(s.look.endCardDur, partDur / 3);
      layers.push({ kind: 'endCard', text: fillTemplate(s.look.endCardText, vars), start: q(partDur - d), end: partDur, anim: 'slide', animDur: 0.35 });
    }
    for (const ad of ads) {
      const isVideo = banners[ad.banner]?.kind === 'video';
      const anim = isVideo ? (s.ads.anim === 'none' ? 'none' : 'fade') : s.ads.anim;
      if (isVideo) layers.push({ kind: 'adVideo', banner: ad.banner, start: ad.outStart, end: ad.outEnd, anim, animDur });
      layers.push({ kind: 'ad', banner: ad.banner, start: ad.outStart, end: ad.outEnd, anim, animDur });
      if (s.ads.progress) layers.push({ kind: 'progress', banner: ad.banner, start: ad.outStart, end: ad.outEnd, anim: 'fade', animDur: Math.min(0.25, animDur) });
    }

    return {
      index,
      total,
      num,
      seriesTotal,
      srcStart: range.srcStart,
      newStart: range.newStart,
      srcEnd: range.srcEnd,
      recapLen,
      duration: partDur,
      segments,
      layers,
      ads,
    };
  });

  return { parts, warnings: [...new Set(warnings)], settings: s, candidates: cands, duration: D };
}
