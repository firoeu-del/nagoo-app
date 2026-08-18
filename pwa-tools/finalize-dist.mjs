import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

const distRoot = resolve(process.argv[2] ?? 'dist');
const projectRoot = resolve(process.argv[3] ?? dirname(distRoot));

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

function urlForPath(path) {
  return `/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const iconSource = resolve(projectRoot, 'assets/icons/raster/bomb.png');
await copyFile(iconSource, resolve(distRoot, 'nagoo-icon-512.png'));

const manifest = {
  id: '/',
  name: 'نگو! — بازی دورهمی',
  short_name: 'نگو!',
  description: 'بازی دورهمی نگو! — نسخه آفلاین آیفون',
  lang: 'fa',
  dir: 'rtl',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  display_override: ['standalone', 'fullscreen'],
  orientation: 'portrait',
  background_color: '#F8F3E8',
  theme_color: '#F8F3E8',
  icons: [
    {
      src: '/nagoo-icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
  ],
};

await writeFile(
  resolve(distRoot, 'manifest.webmanifest'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

const pwaCss = `html, body, #root {
  width: 100%;
  height: 100%;
  min-height: 100%;
  margin: 0;
  background: #F8F3E8;
}

html {
  color-scheme: light;
  overscroll-behavior: none;
  -webkit-text-size-adjust: 100%;
}

body {
  overflow: hidden;
  overscroll-behavior: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
}

#root {
  box-sizing: border-box;
  min-height: 100dvh;
  padding-top: env(safe-area-inset-top, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
}

input, textarea, [contenteditable='true'] {
  -webkit-touch-callout: default;
  -webkit-user-select: text;
  user-select: text;
}
`;
await writeFile(resolve(distRoot, 'pwa.css'), pwaCss, 'utf8');

const registerScript = `(() => {
  const markReady = () => {
    document.documentElement.dataset.offlineReady = 'true';
    window.dispatchEvent(new CustomEvent('nagoo-offline-ready'));
  };

  if ('storage' in navigator && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => undefined);
  }

  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      navigator.serviceWorker.ready.then(markReady).catch(() => undefined);
      if (navigator.onLine) registration.update().catch(() => undefined);
    } catch (error) {
      console.warn('Offline installation could not be completed.', error);
    }
  }, { once: true });
})();
`;
await writeFile(resolve(distRoot, 'pwa-register.js'), registerScript, 'utf8');

const indexPath = resolve(distRoot, 'index.html');
let indexHtml = await readFile(indexPath, 'utf8');
indexHtml = indexHtml.replace(/<html(?:\s[^>]*)?>/i, '<html lang="fa" dir="rtl">');
indexHtml = indexHtml.replace(
  /(<meta\s+name="viewport"\s+content=")([^"]*)("\s*\/?>)/i,
  (_match, prefix, content, suffix) => {
    const values = content.split(',').map((value) => value.trim()).filter(Boolean);
    if (!values.some((value) => value.toLowerCase().startsWith('viewport-fit='))) {
      values.push('viewport-fit=cover');
    }
    return `${prefix}${values.join(', ')}${suffix}`;
  },
);

const headMarkup = `
    <meta name="theme-color" content="#F8F3E8">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="نگو!">
    <meta name="apple-mobile-web-app-status-bar-style" content="default">
    <meta name="format-detection" content="telephone=no">
    <link rel="manifest" href="/manifest.webmanifest">
    <link rel="apple-touch-icon" href="/nagoo-icon-512.png">
    <link rel="stylesheet" href="/pwa.css">
    <script defer src="/pwa-register.js"></script>
`;

if (!indexHtml.includes('</head>')) throw new Error('Exported index.html has no </head>.');
indexHtml = indexHtml.replace('</head>', `${headMarkup}  </head>`);
await writeFile(indexPath, indexHtml, 'utf8');

const initialFiles = (await walkFiles(distRoot))
  .filter((path) => path !== 'sw.js' && path !== '_headers' && path !== '_redirects')
  .sort();

const hash = createHash('sha256');
for (const path of initialFiles) {
  hash.update(path);
  hash.update(await readFile(resolve(distRoot, path)));
}
const buildId = hash.digest('hex').slice(0, 20);
const precacheUrls = Array.from(new Set(['/', ...initialFiles.map(urlForPath)]));

const serviceWorker = `const CACHE_PREFIX = 'nagoo-pwa-';
const CACHE_NAME = CACHE_PREFIX + '${buildId}';
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function parseRange(rangeHeader, size) {
  const match = /^bytes=(\\d*)-(\\d*)$/.exec(rangeHeader || '');
  if (!match) return null;

  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

async function rangeResponse(request, cachedResponse) {
  const bytes = await cachedResponse.arrayBuffer();
  const range = parseRange(request.headers.get('range'), bytes.byteLength);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + bytes.byteLength },
    });
  }

  const headers = new Headers(cachedResponse.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + bytes.byteLength);
  headers.set('Content-Length', String(range.end - range.start + 1));
  return new Response(bytes.slice(range.start, range.end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers,
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    if (request.mode === 'navigate') {
      return (await cache.match('/'))
        || (await cache.match('/index.html'))
        || fetch(request);
    }

    const cached = await cache.match(url.pathname, { ignoreSearch: true });
    if (cached) {
      if (request.headers.has('range')) return rangeResponse(request, cached);
      return cached;
    }

    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        event.waitUntil(cache.put(request, response.clone()));
      }
      return response;
    } catch {
      return (await cache.match('/')) || (await cache.match('/index.html')) || Response.error();
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
`;

await writeFile(resolve(distRoot, 'sw.js'), serviceWorker, 'utf8');
await writeFile(
  resolve(distRoot, 'pwa-build.json'),
  `${JSON.stringify({ version: '1.37.1', cache: `nagoo-pwa-${buildId}`, files: precacheUrls.length }, null, 2)}\n`,
  'utf8',
);

// pwa-build.json is metadata only; include it in the cache too by regenerating
// the worker once with that final path represented.
const finalUrls = [...precacheUrls, '/pwa-build.json'];
await writeFile(
  resolve(distRoot, 'sw.js'),
  serviceWorker.replace(JSON.stringify(precacheUrls, null, 2), JSON.stringify(finalUrls, null, 2)),
  'utf8',
);

console.log(`PWA finalized with cache ${buildId} and ${finalUrls.length} precached URLs.`);
