// Настройки проекта: значения по умолчанию и нормализация (защита от мусора из localStorage/URL).
import { clamp, deepMerge, safeHexColor } from './util.js';

export const DEFAULT_SETTINGS = Object.freeze({
  split: {
    enabled: true,
    targetLen: 180, // желаемая длина готовой части (с рекламой и повтором), сек
    tolerance: 15, // насколько можно сдвинуть разрез ради «умной» точки, сек
    strict: true, // не превышать targetLen
    overlap: 15, // сколько секунд конца прошлой части повторить в начале следующей
    smart: true, // резать в паузах речи / на смене сцен
    recapSnap: true, // начинать повтор с начала фразы
  },
  ads: {
    perPart: 1, // сколько раз показать рекламу в каждой части
    mode: 'pause', // pause — видео замирает, показывается баннер; overlay — баннер поверх идущего видео
    placement: 'smart', // smart | even | manual
    manualTimes: '1:00',
    minFromStart: 20,
    minFromEnd: 15,
    imageDuration: 5, // длительность показа картинки, сек
    maxVideoDuration: 30, // видеобаннеры длиннее обрежутся
    rotation: 'sequence', // sequence | random | first
    size: 82, // ширина баннера, % от ширины кадра
    position: 'center', // center | top | bottom
    anim: 'slide', // slide | fade | none
    animDur: 0.4,
    freezeBlur: 14, // размытие замершего кадра (0–40)
    freezeDim: 35, // затемнение замершего кадра, %
    tag: true,
    chroma: {
      enabled: false, // убрать зелёный фон у видеобаннеров (хромакей)
      auto: true, // цвет фона определяется по краям кадра каждого баннера
      color: '#00ff00', // цвет, который вырезаем
      similarity: 30, // насколько близкие оттенки вырезать, 1–100
      smooth: 10, // мягкость края, 0–100
    },
    tagText: 'Реклама',
    progress: true,
    adAudio: true, // звук видеобаннера в режиме паузы
    audioFade: 0.25, // плавное затухание звука перед паузой и нарастание после
  },
  look: {
    aspect: '9:16', // source | 9:16 | 1:1 | 4:5 | 16:9
    fit: 'blur', // blur | crop | pad
    resolution: 1080, // короткая сторона кадра
    fps: 30,
    accent: '#ff3b5c',
    partLabel: true,
    partLabelText: 'Часть {n}/{total}',
    partLabelDur: 4, // 0 — показывать всю часть
    recapLabel: true,
    recapLabelText: '↺ Повтор из части {prev}',
    endCard: true,
    endCardText: 'Продолжение в части {next} →',
    endCardDur: 3,
  },
  output: {
    fileName: '{name}_part{n}',
    title: '',
    series: 'one', // несколько видео: one — одна серия (общий текст, нумерация подряд), separate — разные видео
    caption: '{title} — часть {n}/{total} 🔥\n#часть{n} #сериал #fyp',
    engine: 'auto', // auto | server | browser
    encoder: 'x264', // x264 | videotoolbox
    quality: 'high', // high | medium | small
    monitorAudio: true,
    alsoSaveDownloaded: true, // при «Скачать и редактировать» ещё и сохранить файл в Загрузки
  },
});

const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
const num = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : def;
};
const bool = (v, def) => (typeof v === 'boolean' ? v : def);
const str = (v, def, max = 200) => (typeof v === 'string' ? v.slice(0, max) : def);

export function normalizeSettings(input) {
  const d = DEFAULT_SETTINGS;
  const s = deepMerge(d, input || {});
  return {
    split: {
      enabled: bool(s.split.enabled, d.split.enabled),
      targetLen: num(s.split.targetLen, 15, 3600, d.split.targetLen),
      tolerance: num(s.split.tolerance, 0, 120, d.split.tolerance),
      strict: bool(s.split.strict, d.split.strict),
      overlap: num(s.split.overlap, 0, 120, d.split.overlap),
      smart: bool(s.split.smart, d.split.smart),
      recapSnap: bool(s.split.recapSnap, d.split.recapSnap),
    },
    ads: {
      perPart: Math.round(num(s.ads.perPart, 0, 20, d.ads.perPart)),
      mode: pick(s.ads.mode, ['pause', 'overlay'], d.ads.mode),
      placement: pick(s.ads.placement, ['smart', 'even', 'manual'], d.ads.placement),
      manualTimes: str(s.ads.manualTimes, d.ads.manualTimes, 500),
      minFromStart: num(s.ads.minFromStart, 0, 600, d.ads.minFromStart),
      minFromEnd: num(s.ads.minFromEnd, 0, 600, d.ads.minFromEnd),
      imageDuration: num(s.ads.imageDuration, 1, 60, d.ads.imageDuration),
      maxVideoDuration: num(s.ads.maxVideoDuration, 1, 300, d.ads.maxVideoDuration),
      rotation: pick(s.ads.rotation, ['sequence', 'random', 'first'], d.ads.rotation),
      size: num(s.ads.size, 20, 100, d.ads.size),
      position: pick(s.ads.position, ['center', 'top', 'bottom'], d.ads.position),
      anim: pick(s.ads.anim, ['slide', 'fade', 'none'], d.ads.anim),
      animDur: num(s.ads.animDur, 0, 2, d.ads.animDur),
      freezeBlur: num(s.ads.freezeBlur, 0, 40, d.ads.freezeBlur),
      freezeDim: num(s.ads.freezeDim, 0, 90, d.ads.freezeDim),
      tag: bool(s.ads.tag, d.ads.tag),
      chroma: {
        // раньше хромакей был в «Оформлении» (для основного видео) — переносим включённый флажок сюда
        enabled: bool(s.ads.chroma?.enabled, bool(s.look.chroma?.enabled, d.ads.chroma.enabled)),
        auto: bool(s.ads.chroma?.auto, d.ads.chroma.auto),
        color: safeHexColor(s.ads.chroma?.color, safeHexColor(s.look.chroma?.color, d.ads.chroma.color)),
        similarity: num(s.ads.chroma?.similarity, 1, 100, num(s.look.chroma?.similarity, 1, 100, d.ads.chroma.similarity)),
        smooth: num(s.ads.chroma?.smooth, 0, 100, num(s.look.chroma?.smooth, 0, 100, d.ads.chroma.smooth)),
      },
      tagText: str(s.ads.tagText, d.ads.tagText, 40),
      progress: bool(s.ads.progress, d.ads.progress),
      adAudio: bool(s.ads.adAudio, d.ads.adAudio),
      audioFade: num(s.ads.audioFade, 0, 2, d.ads.audioFade),
    },
    look: {
      aspect: pick(s.look.aspect, ['source', '9:16', '1:1', '4:5', '16:9'], d.look.aspect),
      fit: pick(s.look.fit, ['blur', 'crop', 'pad'], d.look.fit),
      resolution: Number(pick(Number(s.look.resolution), [480, 720, 1080], d.look.resolution)),
      fps: Number(pick(Number(s.look.fps), [24, 25, 30, 60], d.look.fps)),
      accent: safeHexColor(s.look.accent, d.look.accent),
      partLabel: bool(s.look.partLabel, d.look.partLabel),
      partLabelText: str(s.look.partLabelText, d.look.partLabelText, 80),
      partLabelDur: num(s.look.partLabelDur, 0, 600, d.look.partLabelDur),
      recapLabel: bool(s.look.recapLabel, d.look.recapLabel),
      recapLabelText: str(s.look.recapLabelText, d.look.recapLabelText, 80),
      endCard: bool(s.look.endCard, d.look.endCard),
      endCardText: str(s.look.endCardText, d.look.endCardText, 80),
      endCardDur: num(s.look.endCardDur, 1, 30, d.look.endCardDur),
    },
    output: {
      fileName: str(s.output.fileName, d.output.fileName, 120),
      title: str(s.output.title, d.output.title, 200),
      caption: str(s.output.caption, d.output.caption, 2000),
      series: pick(s.output.series, ['one', 'separate'], d.output.series),
      engine: pick(s.output.engine, ['auto', 'server', 'browser'], d.output.engine),
      encoder: pick(s.output.encoder, ['x264', 'videotoolbox'], d.output.encoder),
      quality: pick(s.output.quality, ['high', 'medium', 'small'], d.output.quality),
      monitorAudio: bool(s.output.monitorAudio, d.output.monitorAudio),
      alsoSaveDownloaded: bool(s.output.alsoSaveDownloaded, d.output.alsoSaveDownloaded),
    },
  };
}
