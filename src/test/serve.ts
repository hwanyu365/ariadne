import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, dir: string) => void;

const TYPES: Record<string, string> = { '.html': 'text/html', '.png': 'image/png' };

/** 디렉터리 주소는 슬래시를 붙이는 301 을 먼저 돌려준다. 실제 서버처럼 리다이렉트 체인을 만든다. */
export function staticFile(gzip = false): Handler {
  return (req, res, dir) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = path.join(dir, decodeURIComponent(url.pathname));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { Location: url.pathname + '/' });
        res.end();
        return;
      }
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = fs.readFileSync(file);
    const headers: Record<string, string> = { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' };
    if (gzip) {
      body = zlib.gzipSync(body);
      headers['Content-Encoding'] = 'gzip';
    }
    res.writeHead(200, headers);
    res.end(body);
  };
}

export async function serve(dir: string, handler: Handler = staticFile()) {
  const server = http.createServer((req, res) => handler(req, res, dir));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-test-'));
}
