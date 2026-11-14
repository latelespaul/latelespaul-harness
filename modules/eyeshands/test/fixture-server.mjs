// The live fixture server (design part 18, run step 3): serves test/fixture/form.html on 127.0.0.1
// at a random port and keeps the page's latest report (POST /report from the page's own script).
// It listens on the loopback address only and serves nothing else.
//   const fx = await startFixture();   // { url, port, report(), reports(), waitFor(pred, ms), close() }
// report() is the latest report: { seq, values, contact, agree, file, log }, or null before the
// first one.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FORM = fileURLToPath(new URL('./fixture/form.html', import.meta.url));
const MAX_BODY = 4 * 1024 * 1024;

export async function startFixture({ host = '127.0.0.1', port = 0 } = {}) {
  const html = readFileSync(FORM);
  let latest = null, count = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/form.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'POST' && req.url === '/report') {
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body && typeof body === 'object' && (!latest || !(body.seq < latest.seq))) latest = body;
          count += 1;
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}/`,
    port: actual,
    report: () => latest,
    reports: () => count,
    // Resolves with the first report that pred(report) accepts, or null after ms.
    async waitFor(pred, ms = 5000) {
      const end = Date.now() + ms;
      for (;;) {
        if (latest && pred(latest)) return latest;
        if (Date.now() >= end) return null;
        await new Promise(r => setTimeout(r, 50));
      }
    },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
