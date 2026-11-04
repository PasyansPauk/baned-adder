// Временный локальный HTTP-прокси для yt-dlp.
// Зачем: yt-dlp для TikTok работает через curl_cffi, а у него свой DNS-клиент (c-ares). Он не видит DNS,
// который на macOS раздают VPN и сетевые расширения (основной резолвер без серверов) — и пишет
// «Could not resolve host … Could not contact DNS servers», хотя Safari и curl сайт открывают.
// Через прокси имена разрешает Node.js (системный getaddrinfo), а curl подключается к 127.0.0.1.
// Прокси слушает только 127.0.0.1, на случайном порту, и живёт только пока идёт скачивание.
import http from 'node:http';
import net from 'node:net';

const allowedPort = (p) => p === 80 || p === 443;

/** Запускает прокси. Возвращает { url, close }. */
export function startLocalProxy() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    // обычные http:// запросы (редко, но yt-dlp может их делать)
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(target.port) || 80;
    if (target.protocol !== 'http:' || !allowedPort(port)) {
      res.writeHead(403).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    const up = http.request({ host: target.hostname, port, method: req.method, path: target.pathname + target.search, headers }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end());
    req.pipe(up);
  });

  // https:// — туннель CONNECT host:443
  server.on('connect', (req, client, head) => {
    const m = String(req.url).match(/^\[?([^\]]+?)\]?:(\d+)$/);
    const port = m ? Number(m[2]) : 0;
    if (!m || !allowedPort(port)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const up = net.connect(port, m[1], () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    const kill = () => {
      up.destroy();
      client.destroy();
    };
    up.on('error', () => {
      if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      kill();
    });
    client.on('error', kill);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}
