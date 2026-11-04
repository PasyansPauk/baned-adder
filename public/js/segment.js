// Удаление фона нейросетью: MediaPipe Selfie Segmenter выделяет человека в кадре.
// Работает прямо в браузере (WebGL/WASM), модель ~250 КБ, загружается при первом включении.
const VER = '0.10.14';
const LIB = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/vision_bundle.mjs`;
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}/wasm`;
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

let loading = null;

async function create(vision, delegate) {
  return vision.ImageSegmenter.createFromOptions(await vision.FilesetResolver.forVisionTasks(WASM), {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'IMAGE',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
}

/** Загружает сегментатор один раз (сначала на видеокарте, при ошибке — на процессоре). */
export function loadSegmenter() {
  if (!loading) {
    loading = (async () => {
      const vision = await import(LIB);
      try {
        return await create(vision, 'GPU');
      } catch {
        return await create(vision, 'CPU');
      }
    })().catch((e) => {
      loading = null;
      throw new Error('Не удалось загрузить нейросеть для удаления фона (нужен интернет при первом запуске): ' + (e?.message || e));
    });
  }
  return loading;
}

/**
 * Строит маску человека для кадра: канвас размера входа, альфа = уверенность «это человек».
 * @param {object} seg — ImageSegmenter
 * @param {HTMLCanvasElement} input — уменьшенный кадр
 * @param {HTMLCanvasElement} out — сюда кладётся маска
 * @param {{strength:number, smooth:number}} o — сила (1–100) и мягкость края (0–100)
 * @returns {number} доля кадра, занятая человеком (0–1)
 */
export function personMask(seg, input, out, o) {
  const w = input.width;
  const h = input.height;
  const res = seg.segment(input);
  try {
    const masks = res.confidenceMasks || [];
    // у selfie_segmenter один канал — «человек»; у многоклассовых моделей 0-й канал — фон
    const person = masks.length > 1 ? null : masks[0];
    const bg = masks.length > 1 ? masks[0] : null;
    const conf = (person || bg).getAsFloat32Array();
    if (out.width !== w || out.height !== h) {
      out.width = w;
      out.height = h;
    }
    const octx = out.getContext('2d', { willReadFrequently: true });
    const img = octx.createImageData(w, h);
    const d = img.data;
    // порог: чем больше сила, тем больше вырезаем (сомнительные пиксели уходят в фон)
    const thr = 0.2 + (Math.min(100, Math.max(1, o.strength)) / 100) * 0.6;
    const soft = 0.02 + (Math.min(100, Math.max(0, o.smooth)) / 100) * 0.3;
    let sum = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const p = person ? conf[i] : 1 - conf[i];
      const a = Math.min(1, Math.max(0, (p - (thr - soft / 2)) / soft));
      sum += a;
      d[i * 4 + 3] = Math.round(a * 255);
    }
    octx.putImageData(img, 0, 0);
    return sum / n;
  } finally {
    res.close?.();
  }
}
