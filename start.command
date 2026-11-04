#!/bin/bash
# Двойной клик в Finder запускает Baned Adder и открывает его в браузере.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8787}"
# при запуске из Finder PATH урезан — добавляем папки Homebrew (Apple Silicon и Intel)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Установите его: brew install node  (или с https://nodejs.org)"
  read -r -n 1 -p "Нажмите любую клавишу…"
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg не найден — будет доступен только рендер в браузере."
  echo "Для быстрого рендера установите: brew install ffmpeg"
  echo
fi
if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "yt-dlp не найден — скачивание по ссылкам YouTube/TikTok выключено."
  echo "Установить: brew install yt-dlp"
  echo
fi

(sleep 1.5 && open "http://localhost:${PORT}/") &
PORT="$PORT" exec node server/server.js
