// Анализ громкости: поиск пауз в речи/звуке. Работает с потоком сэмплов,
// поэтому годится и для браузера (decodeAudioData), и для сервера (PCM из ffmpeg).

export const HOP_SEC = 0.05; // шаг анализа: 50 мс

export class LoudnessMeter {
  constructor(sampleRate, hopSec = HOP_SEC) {
    this.hop = Math.max(1, Math.round(sampleRate * hopSec));
    this.hopSec = this.hop / sampleRate;
    this.acc = 0;
    this.n = 0;
    this.db = [];
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      this.acc += v * v;
      if (++this.n === this.hop) this.flush();
    }
  }

  flush() {
    if (!this.n) return;
    const rms = Math.sqrt(this.acc / this.n);
    this.db.push(rms > 1e-6 ? 20 * Math.log10(rms) : -120);
    this.acc = 0;
    this.n = 0;
  }

  result() {
    this.flush();
    return { db: this.db, hopSec: this.hopSec };
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return -120;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * Находит паузы. Порог адаптивный: между «полом» шума и типичной громкостью,
 * поэтому работает и для тихих записей, и для видео с фоновой музыкой.
 * @returns {{start:number,end:number,depth:number}[]}
 */
export function detectSilences(db, hopSec, opts = {}) {
  const minDur = opts.minDuration ?? 0.25;
  if (!db.length) return [];
  const sorted = Float32Array.from(db).sort();
  const floor = percentile(sorted, 0.08);
  const median = percentile(sorted, 0.5);
  if (median - floor < 4) return []; // звук без пауз (музыка / шум) или полная тишина
  const threshold = Math.min(floor + (median - floor) * 0.35, median - 6);

  // лёгкое сглаживание, чтобы отдельные щелчки не рвали паузу
  const smooth = db.map((v, i) => (v + (db[i - 1] ?? v) + (db[i + 1] ?? v)) / 3);

  const out = [];
  let runStart = -1;
  let sum = 0;
  for (let i = 0; i <= smooth.length; i++) {
    const quiet = i < smooth.length && smooth[i] <= threshold;
    if (quiet) {
      if (runStart < 0) {
        runStart = i;
        sum = 0;
      }
      sum += smooth[i];
    } else if (runStart >= 0) {
      const start = runStart * hopSec;
      const end = i * hopSec;
      if (end - start >= minDur) {
        const avg = sum / (i - runStart);
        out.push({
          start: round3(start),
          end: round3(end),
          depth: round3(Math.min(1, Math.max(0, (median - avg) / Math.max(1, median - floor)))),
        });
      }
      runStart = -1;
    }
  }
  return out;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
