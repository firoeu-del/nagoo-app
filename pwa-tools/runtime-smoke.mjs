import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const distRoot = resolve(process.argv[2] ?? 'dist');
const projectRoot = resolve(process.argv[3] ?? '.');
const screenshotPath = resolve(process.argv[4] ?? 'pwa-runtime-smoke.png');
const requireFromApp = createRequire(resolve(projectRoot, 'package.json'));
const { chromium } = requireFromApp('playwright');

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function safeFilePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = resolve(distRoot, relativePath);
  if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${sep}`)) return null;
  return candidate;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let filePath = safeFilePath(url.pathname);
    if (!filePath) {
      response.writeHead(400).end('Bad path');
      return;
    }

    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = resolve(filePath, 'index.html');
    } catch {
      // Cloudflare Pages treats this as a single-page app when no 404 exists.
      filePath = resolve(distRoot, 'index.html');
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': filePath.endsWith('sw.js') ? 'no-store' : 'no-cache',
      'Service-Worker-Allowed': '/',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(String(error));
  }
});

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});

const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not start the PWA test server.');
const origin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'allow',
});
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleErrors.push(`[${message.type()}] ${message.text()}`);
  }
});
page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
page.on('requestfailed', (request) => {
  failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
});

async function pageState(label) {
  return page.evaluate(async (stateLabel) => {
    const root = document.getElementById('root');
    const cacheNames = 'caches' in globalThis ? await caches.keys() : [];
    const registrations = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistrations()
      : [];
    return {
      label: stateLabel,
      url: location.href,
      readyState: document.readyState,
      title: document.title,
      bodyText: (document.body.innerText ?? '').trim().slice(0, 1200),
      rootChildren: root?.childElementCount ?? -1,
      rootHtmlLength: root?.innerHTML.length ?? -1,
      rootBounds: root ? root.getBoundingClientRect().toJSON() : null,
      buttons: document.querySelectorAll('button, [role="button"]').length,
      images: document.images.length,
      fontStatus: document.fonts?.status ?? 'unsupported',
      serviceWorkerController: Boolean(navigator.serviceWorker?.controller),
      serviceWorkerRegistrations: registrations.length,
      cacheNames,
    };
  }, label);
}

let onlineState;
let offlineState;
let failure;

try {
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  try {
    await page.waitForFunction(() => {
      const text = (document.body.innerText ?? '').trim();
      const controls = document.querySelectorAll('button, [role="button"]').length;
      return text.length >= 10 && controls >= 1;
    }, { timeout: 20_000 });
  } catch (error) {
    failure = `Online UI stayed blank: ${error.message}`;
  }

  onlineState = await pageState('online');
  await page.screenshot({ path: screenshotPath, fullPage: true });

  if (!failure) {
    try {
      await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) throw new Error('Service workers are unavailable.');
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker readiness timed out.')), 20_000)),
        ]);
      });
      await page.waitForFunction(async () => {
        const names = await caches.keys();
        return names.some((name) => name.startsWith('nagoo-pwa-'));
      }, { timeout: 20_000 });
    } catch (error) {
      failure = `Offline cache was not installed: ${error.message}`;
    }
  }

  if (!failure) {
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    try {
      await page.waitForFunction(() => {
        const text = (document.body.innerText ?? '').trim();
        const controls = document.querySelectorAll('button, [role="button"]').length;
        return text.length >= 10 && controls >= 1;
      }, { timeout: 20_000 });
    } catch (error) {
      failure = `Offline reload stayed blank: ${error.message}`;
    }
    offlineState = await pageState('offline');
  }
} catch (error) {
  failure = error.stack ?? error.message;
} finally {
  await context.setOffline(false).catch(() => undefined);
}

const result = {
  passed: !failure,
  failure: failure ?? null,
  online: onlineState ?? null,
  offline: offlineState ?? null,
  consoleErrors,
  pageErrors,
  failedRequests,
  screenshot: screenshotPath,
};

console.log(JSON.stringify(result, null, 2));
await writeFile(resolve('pwa-runtime-verification.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

await browser.close();
await new Promise((resolveClose) => server.close(resolveClose));

if (failure) throw new Error(failure);
