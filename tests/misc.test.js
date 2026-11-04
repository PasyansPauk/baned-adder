import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, parseTime, parseTimeList, fillTemplate, sanitizeFileName } from '../public/js/core/util.js';
import { cardRect, layerAnim, outputSize } from '../public/js/core/layout.js';
import { LoudnessMeter, detectSilences } from '../public/js/core/audio.js';
import { encodeQR } from '../public/js/qr.js';
import { buildFfmpegArgs } from '../server/ffmpeg-graph.js';

test('время: формат и разбор', () => {
  assert.equal(fmtTime(75), '1:15');
  assert.equal(fmtTime(3725), '1:02:05');
  assert.equal(parseTime('1:30'), 90);
  assert.equal(parseTime('90'), 90);
  assert.equal(parseTime('1:02:03.5'), 3723.5);
  assert.equal(parseTime('2м 10с'), 130);
  assert.ok(Number.isNaN(parseTime('abc')));
  assert.deepEqual(parseTimeList('2:10, 0:45; x'), [45, 130]);
});

test('шаблоны и имена файлов', () => {
  assert.equal(fillTemplate('Часть {n}/{total} {x}', { n: 2, total: 5 }), 'Часть 2/5 {x}');
  assert.equal(sanitizeFileName('Моё видео: финал?.mp4'), 'Моё_видео_финал');
  assert.equal(sanitizeFileName('../../etc/passwd'), 'etc_passwd');
});

test('размер кадра и положение баннера', () => {
  assert.deepEqual(outputSize({ aspect: '9:16', resolution: 1080 }), { W: 1080, H: 1920 });
  assert.deepEqual(outputSize({ aspect: '16:9', resolution: 720 }), { W: 1280, H: 720 });
  assert.deepEqual(outputSize({ aspect: 'source', resolution: 1080 }, 1920, 1080), { W: 1920, H: 1080 });
  const r = cardRect(1080, 1920, 1200 / 628, { size: 80, position: 'center' });
  assert.equal(r.w, 864);
  assert.ok(r.x + r.w <= 1080 && r.y + r.h <= 1920);
});

test('анимация слоя', () => {
  const l = { start: 10, end: 15, anim: 'slide', animDur: 0.4 };
  assert.equal(layerAnim(l, 9, 1920), null);
  assert.equal(layerAnim(l, 10, 1920).alpha, 0);
  assert.equal(layerAnim(l, 12, 1920).alpha, 1);
  assert.equal(layerAnim(l, 12, 1920).dy, 0);
  assert.ok(layerAnim(l, 10.2, 1920).dy > 0);
});

test('поиск пауз в звуке', () => {
  const rate = 8000;
  const m = new LoudnessMeter(rate);
  const sec = (n, loud) => Float32Array.from({ length: rate * n }, (_, i) => (loud ? 0.3 * Math.sin(i / 3) : 0.0005 * Math.sin(i)));
  m.push(sec(3, true));
  m.push(sec(1, false));
  m.push(sec(3, true));
  const { db, hopSec } = m.result();
  const s = detectSilences(db, hopSec);
  assert.equal(s.length, 1);
  assert.ok(Math.abs(s[0].start - 3) < 0.15 && Math.abs(s[0].end - 4) < 0.15);
});

test('QR: размер соответствует версии', () => {
  const q = encodeQR('http://192.168.1.10:8787/');
  assert.equal(q.size, 17 + 4 * q.version);
  assert.equal(q.version, 2);
});

test('ffmpeg: команда собирается и не содержит лишнего', () => {
  const args = buildFfmpegArgs(
    {
      W: 1080, H: 1920, fps: 30, fit: 'blur', accent: '#00ff00', srcStart: 5, srcEnd: 35, duration: 35, audioFade: 0.2,
      segments: [{ type: 'content', start: 0, end: 10 }, { type: 'freeze', t: 10, dur: 5, blur: 14, dim: 0.3 }, { type: 'content', start: 10, end: 30 }],
      adVideos: [],
      layers: [{ file: 'a', x: 10, y: 20, start: 10, end: 15, fade: 0.4, slide: 76 }],
      progress: [{ x: 10, y: 600, w: 800, h: 10, start: 10, end: 15, fade: 0.25 }],
    },
    { src: 'in.mp4', output: 'out.mp4', resolve: (id) => `${id}.png`, srcHasAudio: true, adHasAudio: () => false, encoder: 'x264', quality: 'high' }
  );
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /concat=n=3:v=1:a=1/);
  assert.match(fc, /tpad=stop_mode=clone/);
  assert.match(fc, /0x00ff00/);
  assert.equal(args.at(-1), 'out.mp4');
  assert.throws(() => buildFfmpegArgs({ W: 'x', H: 2, duration: 1, srcStart: 0, srcEnd: 1, segments: [{}] }, {}));
});
