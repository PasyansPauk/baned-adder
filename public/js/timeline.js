// Визуализация плана: каждая часть — полоса на шкале исходного видео.
// Видно, где части перекрываются (повтор), где реклама и где найдены «умные» точки.
// Сделано на HTML (проценты), чтобы текст оставался читаемым на любой ширине экрана.
import { fmtTime } from './core/util.js';

const pct = (t, D) => `${((t / D) * 100).toFixed(3)}%`;

export function renderTimeline(container, plan, { selected = -1 } = {}) {
  if (!plan?.parts?.length) {
    container.innerHTML = '';
    return;
  }
  const D = plan.duration;
  const tickStep = [10, 30, 60, 120, 300, 600, 1200, 1800].find((s) => D / s <= 6) || 3600;
  let html = '<div class="tl-axis" aria-hidden="true">';
  for (let t = 0; t < D - tickStep * 0.4; t += tickStep) html += `<span class="tl-tick" style="left:${pct(t, D)}">${fmtTime(t)}</span>`;
  html += `<span class="tl-tick tl-tick-end">${fmtTime(D)}</span>`;
  for (const c of plan.candidates || []) html += `<i class="tl-cand tl-cand-${c.kind}" style="left:${pct(c.t, D)}"></i>`;
  html += '</div>';

  plan.parts.forEach((p, i) => {
    const sel = i === selected ? ' is-selected' : '';
    html += `<div class="tl-row${sel}">`;
    html += `<button type="button" class="tl-bar tl-c${i % 2}" data-part="${i}" style="left:${pct(p.srcStart, D)};width:${pct(p.srcEnd - p.srcStart, D)}" aria-label="Часть ${i + 1}: ${fmtTime(p.srcStart)}–${fmtTime(p.srcEnd)}">`;
    if (p.newStart > p.srcStart) {
      html += `<span class="tl-recap" style="width:${(((p.newStart - p.srcStart) / (p.srcEnd - p.srcStart)) * 100).toFixed(2)}%"></span>`;
    }
    html += `<span class="tl-num">${i + 1}</span></button>`;
    for (const a of p.ads) {
      html += `<button type="button" class="tl-ad" data-part="${i}" data-out="${a.outStart}" style="left:${pct(a.srcTime, D)}" title="Реклама: ${fmtTime(a.outStart)} от начала части" aria-label="Превью рекламы в части ${i + 1}, ${fmtTime(a.outStart)}"></button>`;
    }
    html += '</div>';
  });
  container.innerHTML = html;
}
