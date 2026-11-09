import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, buildCandidates } from '../public/js/core/plan.js';
import { normalizeSettings } from '../public/js/core/settings.js';

const silencesEvery = (step, until, len = 0.6) => {
  const out = [];
  for (let t = 7; t < until; t += step) out.push({ start: t, end: t + len, depth: 0.8 });
  return out;
};

test('короткое видео остаётся одной частью', () => {
  const p = buildPlan({ duration: 90, settings: {}, banners: [{ kind: 'image' }] });
  assert.equal(p.parts.length, 1);
  assert.equal(p.parts[0].srcStart, 0);
  assert.equal(p.parts[0].srcEnd, 90);
  assert.equal(p.parts[0].ads.length, 1);
  // 90 с видео + 5 с рекламы
  assert.equal(p.parts[0].duration, 95);
});

test('строгий режим: ни одна часть не длиннее заданной длины', () => {
  const analysis = { silences: silencesEvery(11.3, 2000), scenes: [{ t: 170, score: 0.9 }] };
  for (const targetLen of [60, 120, 180, 300]) {
    const p = buildPlan({
      duration: 1000,
      analysis,
      settings: { split: { targetLen, strict: true } },
      banners: [{ kind: 'image' }, { kind: 'video', duration: 12 }],
    });
    for (const part of p.parts) assert.ok(part.duration <= targetLen + 0.05, `часть ${part.index} = ${part.duration} > ${targetLen}`);
  }
});

test('каждая следующая часть начинается с повтора конца предыдущей', () => {
  const p = buildPlan({ duration: 600, settings: { split: { targetLen: 120, overlap: 15, smart: false } }, banners: [] });
  assert.ok(p.parts.length > 1);
  for (let i = 1; i < p.parts.length; i++) {
    const prev = p.parts[i - 1];
    const cur = p.parts[i];
    assert.equal(cur.newStart, prev.srcEnd, 'новое начинается там, где кончилась прошлая часть');
    assert.ok(Math.abs(cur.newStart - cur.srcStart - 15) < 0.05, 'повтор ~15 секунд');
    assert.ok(cur.recapLen > 14.9);
  }
  assert.equal(p.parts.at(-1).srcEnd, 600);
  assert.equal(p.parts[0].srcStart, 0);
});

test('без повтора части идут встык и покрывают всё видео', () => {
  const p = buildPlan({ duration: 777, settings: { split: { targetLen: 100, overlap: 0 } }, banners: [] });
  for (let i = 1; i < p.parts.length; i++) assert.equal(p.parts[i].srcStart, p.parts[i - 1].srcEnd);
  assert.equal(p.parts.at(-1).srcEnd, 777);
});

test('умная нарезка режет в паузах', () => {
  const silences = [{ start: 150.2, end: 151.4, depth: 0.9 }, { start: 300.1, end: 301.3, depth: 0.9 }];
  const p = buildPlan({ duration: 420, analysis: { silences }, settings: { split: { targetLen: 160, overlap: 0, tolerance: 20, strict: false } }, banners: [] });
  const cuts = p.parts.slice(0, -1).map((x) => x.srcEnd);
  for (const c of cuts) assert.ok(silences.some((s) => c >= s.start && c <= s.end), `разрез ${c} не в паузе`);
});

test('реклама: нужное количество, не в повторе и не у краёв', () => {
  const p = buildPlan({
    duration: 900,
    settings: { split: { targetLen: 180 }, ads: { perPart: 3, minFromStart: 20, minFromEnd: 15 } },
    banners: [{ kind: 'image' }],
  });
  for (const part of p.parts) {
    assert.equal(part.ads.length, 3);
    for (const ad of part.ads) {
      assert.ok(ad.srcTime >= part.srcStart + 20 - 0.05);
      assert.ok(ad.srcTime >= part.newStart);
      assert.ok(ad.srcTime <= part.srcEnd - 15 + 0.05);
    }
  }
});

test('режим паузы: сегменты непрерывны, длительность = видео + реклама', () => {
  const p = buildPlan({ duration: 400, settings: { split: { targetLen: 150 }, ads: { perPart: 2 } }, banners: [{ kind: 'image' }] });
  for (const part of p.parts) {
    let t = 0;
    for (const s of part.segments) {
      assert.ok(Math.abs(s.outStart - t) < 1e-6);
      t = s.outEnd;
    }
    assert.ok(Math.abs(t - part.duration) < 1e-6);
    const content = part.segments.filter((s) => s.type === 'content').reduce((a, s) => a + s.srcEnd - s.srcStart, 0);
    assert.ok(Math.abs(content - (part.srcEnd - part.srcStart)) < 0.01);
    assert.ok(Math.abs(part.duration - content - 2 * 5) < 0.01);
  }
});

test('режим «поверх видео» не удлиняет часть', () => {
  const p = buildPlan({ duration: 300, settings: { split: { enabled: false }, ads: { mode: 'overlay', perPart: 2 } }, banners: [{ kind: 'image' }] });
  assert.equal(p.parts.length, 1);
  assert.equal(p.parts[0].duration, 300);
  assert.equal(p.parts[0].segments.length, 1);
  assert.equal(p.parts[0].ads.length, 2);
});

test('ручные моменты рекламы', () => {
  const p = buildPlan({ duration: 200, settings: { split: { enabled: false }, ads: { placement: 'manual', manualTimes: '0:30, 1:40, 9:00' } }, banners: [{ kind: 'image' }] });
  assert.deepEqual(p.parts[0].ads.map((a) => a.srcTime), [30, 100]);
});

test('ротация баннеров по очереди', () => {
  const p = buildPlan({ duration: 1000, settings: { split: { targetLen: 200 }, ads: { perPart: 1, rotation: 'sequence' } }, banners: [{ kind: 'image' }, { kind: 'image' }, { kind: 'image' }] });
  assert.deepEqual(p.parts.map((x) => x.ads[0].banner), p.parts.map((_, i) => i % 3));
});

test('надписи: номер части, повтор, «продолжение» (кроме последней)', () => {
  const p = buildPlan({ duration: 500, settings: { split: { targetLen: 150 } }, banners: [] });
  const last = p.parts.length - 1;
  p.parts.forEach((part, i) => {
    const kinds = part.layers.map((l) => l.kind);
    assert.ok(kinds.includes('partLabel'));
    assert.equal(kinds.includes('recapLabel'), i > 0);
    assert.equal(kinds.includes('endCard'), i < last);
  });
  assert.equal(p.parts[1].layers.find((l) => l.kind === 'partLabel').text, `Часть 2/${p.parts.length}`);
});

test('кандидаты: смена сцены в паузе ценится выше', () => {
  const c = buildCandidates({ silences: [{ start: 10, end: 11, depth: 1 }], scenes: [{ t: 10.5, score: 0.8 }, { t: 30, score: 0.8 }] }, 60);
  const inSil = c.find((x) => x.kind === 'scene' && x.t === 10.5);
  const alone = c.find((x) => x.kind === 'scene' && x.t === 30);
  assert.ok(inSil.score > alone.score);
});

test('нормализация отбрасывает мусор', () => {
  const s = normalizeSettings({ split: { targetLen: -5, overlap: 'abc' }, look: { accent: 'red;drop', aspect: 'x' }, ads: { mode: 'evil' } });
  assert.equal(s.split.targetLen, 15);
  assert.equal(s.split.overlap, 15);
  assert.equal(s.look.accent, '#ff3b5c');
  assert.equal(s.look.aspect, '9:16');
  assert.equal(s.ads.mode, 'pause');
});

test('несколько видео: сквозная нумерация частей по всей серии', () => {
  const settings = { look: { partLabel: true, endCard: true }, output: {} };
  // 6 коротких видео — 6 частей одной серии
  const plans = Array.from({ length: 6 }, (_, i) => buildPlan({ duration: 60, settings, banners: [], series: { offset: i, total: 6 } }));
  plans.forEach((p, i) => {
    assert.equal(p.parts.length, 1);
    assert.equal(p.parts[0].num, i + 1);
    assert.equal(p.parts[0].seriesTotal, 6);
    const label = p.parts[0].layers.find((l) => l.kind === 'partLabel');
    assert.ok(label, 'надпись «Часть n/6» есть даже у видео из одной части');
    assert.match(label.text, new RegExp(`${i + 1}/6`));
    // «Продолжение в следующей части» — у всех, кроме последней части серии
    assert.equal(!!p.parts[0].layers.find((l) => l.kind === 'endCard'), i < 5);
  });
});

test('без серии нумерация как раньше', () => {
  const p = buildPlan({ duration: 600, settings: { split: { targetLen: 120, smart: false } }, banners: [] });
  p.parts.forEach((part, i) => {
    assert.equal(part.num, i + 1);
    assert.equal(part.seriesTotal, p.parts.length);
  });
});
