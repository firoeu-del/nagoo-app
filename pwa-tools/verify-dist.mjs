import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const distRoot = resolve(process.argv[2] ?? 'dist');

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(root, absolute));
    else if (entry.isFile()) output.push(relative(root, absolute).split(sep).join('/'));
  }
  return output;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function urlForPath(path) {
  return `/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const files = (await walkFiles(distRoot)).sort();
assert(files.includes('index.html'), 'index.html is missing from the ZIP root.');
assert(files.includes('manifest.webmanifest'), 'PWA manifest is missing.');
assert(files.includes('sw.js'), 'Service worker is missing.');
assert(files.includes('_headers'), 'Cloudflare Pages _headers file is missing.');
assert(files.includes('nagoo-icon-512.png'), 'iPhone home-screen icon is missing.');

const index = await readFile(resolve(distRoot, 'index.html'), 'utf8');
assert(index.includes('lang="fa" dir="rtl"'), 'Persian/RTL document metadata is missing.');
assert(index.includes('apple-mobile-web-app-capable'), 'iPhone standalone metadata is missing.');
assert(index.includes('/manifest.webmanifest'), 'Manifest link is missing from index.html.');
assert(index.includes('/pwa-register.js'), 'Service-worker registration is missing from index.html.');

const manifest = JSON.parse(await readFile(resolve(distRoot, 'manifest.webmanifest'), 'utf8'));
assert(manifest.display === 'standalone', 'Manifest must launch in standalone mode.');
assert(manifest.start_url === '/', 'Manifest start_url must be the site root.');
assert(manifest.orientation === 'portrait', 'Manifest orientation must remain portrait.');

const worker = await readFile(resolve(distRoot, 'sw.js'), 'utf8');
assert(worker.includes("request.headers.has('range')"), 'Offline audio range handling is missing.');
assert(worker.includes("cache.match('/')"), 'Offline navigation fallback is missing.');

const cacheableFiles = files.filter((path) => !['sw.js', '_headers', '_redirects'].includes(path));
for (const path of cacheableFiles) {
  assert(worker.includes(JSON.stringify(urlForPath(path))), `Service worker does not precache ${path}.`);
}

const wavFiles = files.filter((path) => path.endsWith('.wav'));
assert(wavFiles.length >= 8, `Expected bundled game audio, found only ${wavFiles.length} WAV files.`);
for (const path of wavFiles) {
  assert(worker.includes(JSON.stringify(urlForPath(path))), `Audio is not available offline: ${path}`);
}

let totalBytes = 0;
let largest = { path: '', size: 0 };
for (const path of files) {
  const info = await stat(resolve(distRoot, path));
  totalBytes += info.size;
  if (info.size > largest.size) largest = { path, size: info.size };
  assert(info.size <= 25 * 1024 * 1024, `Cloudflare drag-and-drop rejects files over 25 MiB: ${path}`);
}
assert(files.length <= 1000, `Cloudflare drag-and-drop limit exceeded: ${files.length} files.`);

console.log(JSON.stringify({
  files: files.length,
  wavFiles: wavFiles.length,
  totalBytes,
  largestFile: largest,
  offlineCacheEntries: cacheableFiles.length + 1,
}, null, 2));
