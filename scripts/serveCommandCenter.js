// Zero-dependency static file server for command-center/.
// Needed because the browser's fetch() of .colaberry/*.json is blocked when
// index.html is opened directly via file://. Serves the repo root read-only
// on 127.0.0.1 so command-center/index.html can fetch ../.colaberry/*.json
// with a normal relative path.
//
// Usage: node scripts/serveCommandCenter.js [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.argv[2]) || 4173;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = normalize(join(ROOT, decoded));
  if (!resolved.startsWith(ROOT)) return null; // path traversal guard
  return resolved;
}

// Resolves any request path to a servable file, mapping a directory (root
// "/" or any nested path, with or without a trailing slash — e.g.
// "/command-center" and "/command-center/" both) to its index.html.
async function resolveFile(urlPath) {
  const resolved = safeResolve(urlPath);
  if (!resolved) return null;
  let target = resolved;
  let info;
  try {
    info = await stat(target);
  } catch {
    return null;
  }
  if (info.isDirectory()) {
    target = join(target, 'index.html');
    try {
      info = await stat(target);
    } catch {
      return null;
    }
    if (info.isDirectory()) return null;
  }
  return target;
}

const server = createServer(async (req, res) => {
  const filePath = await resolveFile(req.url);
  if (!filePath) {
    res.writeHead(404, { 'Cache-Control': 'no-store' }).end('Not found');
    return;
  }
  try {
    const body = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(500, { 'Cache-Control': 'no-store' }).end('Server error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Command Center: http://127.0.0.1:${PORT}/command-center/`);
});
