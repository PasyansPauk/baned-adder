// Общие утилиты. Модуль чистый (без DOM) — используется и в браузере, и на сервере (Node).

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/** 75.4 → "1:15", 3725 → "1:02:05"; с opts.ms → "1:15.4" */
export function fmtTime(sec, opts = {}) {
  if (!Number.isFinite(sec)) return '–';
  const neg = sec < 0;
  sec = Math.abs(sec);
  if (opts.ms) sec = Math.round(sec * 10) / 10;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = opts.ms ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  return (neg ? '-' : '') + body;
}

/** "1:30" → 90, "90" → 90, "1:02:03.5" → 3723.5, "2м 10с" → 130. Возвращает NaN, если не распознано. */
export function parseTime(input) {
  if (typeof input === 'number') return input;
  const str = String(input ?? '').trim().replace(',', '.');
  if (!str) return NaN;
  const human = str.match(/^(?:(\d+(?:\.\d+)?)\s*(?:м|m|мин|min))?\s*(?:(\d+(?:\.\d+)?)\s*(?:с|s|сек|sec))?$/i);
  if (human && (human[1] || human[2])) return (parseFloat(human[1] || 0) * 60) + parseFloat(human[2] || 0);
  if (!/^\d+(?:\.\d+)?(?::\d+(?:\.\d+)?){0,2}$/.test(str)) return NaN;
  return str.split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

/** "0:45, 2:10; 3:00" → [45, 130, 180] (некорректные значения отбрасываются) */
export function parseTimeList(str) {
  return String(str ?? '')
    .split(/[,;\s]+/)
    .map(parseTime)
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
}

/** Подстановка {переменных} в шаблон. Неизвестные переменные остаются как есть. */
export function fillTemplate(tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Детерминированный ГПСЧ — чтобы «случайная» ротация баннеров была одинаковой в превью и в рендере. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Безопасное имя файла (кириллица разрешена). */
export function sanitizeFileName(name, fallback = 'video') {
  const cleaned = String(name ?? '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Глубокое слияние: значения из patch поверх base (массивы заменяются целиком). */
export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Цвет в формате #rrggbb (всё остальное → fallback). */
export function safeHexColor(c, fallback = '#ff3b5c') {
  return /^#[0-9a-f]{6}$/i.test(String(c ?? '')) ? String(c).toLowerCase() : fallback;
}
