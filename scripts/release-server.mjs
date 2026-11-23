#!/usr/bin/env node
/**
 * A local fake release for the install checks (pnpm test:install, pnpm test:reboot):
 *
 *   node scripts/release-server.mjs <folder> [port]
 *
 * Serves the files directly in <folder> (GET and HEAD, no subfolders), plus /install.sh from the
 * checkout this script sits in, on 127.0.0.1 only. Port 0 (the default) picks a free one. The
 * first line printed is `listening <port>`. Files are read on each request, so a rebuilt release
 * is served at once.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [folder, portArg = '0'] = process.argv.slice(2);
if (!folder) {
  console.error('Usage: node scripts/release-server.mjs <folder> [port]');
  process.exit(2);
}
const root = resolve(folder);
const installSh = join(dirname(fileURLToPath(import.meta.url)), '..', 'install.sh');

const server = createServer(async (req, res) => {
  let name;
  try {
    name = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(1));
  } catch {
    // A malformed URL or escape: not a file of ours.
    res.writeHead(404).end('not found\n');
    return;
  }
  // One plain file name: no folders, no dot files, nothing outside the folder.
  const ok = (req.method === 'GET' || req.method === 'HEAD') && /^[\w.+-]+$/.test(name);
  if (!ok || name.startsWith('.') || basename(name) !== name) {
    res.writeHead(404).end('not found\n');
    return;
  }
  try {
    const body = await readFile(name === 'install.sh' ? installSh : join(root, name));
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end('not found\n');
  }
});

server.listen(Number(portArg), '127.0.0.1', () => {
  const address = server.address();
  console.log(`listening ${typeof address === 'object' && address ? address.port : portArg}`);
});
