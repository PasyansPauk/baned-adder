// Порядок наложения слоёв — общий для браузера и ffmpeg:
// видеобаннеры → надписи и карточки (в порядке плана) → полоски-таймеры.
export function orderLayers(layers) {
  return [
    ...layers.filter((l) => l.kind === 'adVideo'),
    ...layers.filter((l) => l.kind !== 'adVideo' && l.kind !== 'progress'),
    ...layers.filter((l) => l.kind === 'progress'),
  ];
}
