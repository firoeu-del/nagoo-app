import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(process.argv[2] ?? '.');
const appJsonPath = resolve(projectRoot, 'app.json');
const storagePath = resolve(projectRoot, 'src/storage.ts');
const storageWebPath = resolve(projectRoot, 'src/storage.web.ts');
const publicDir = resolve(projectRoot, 'public');

const appConfig = JSON.parse(await readFile(appJsonPath, 'utf8'));
const expo = appConfig.expo ?? {};

expo.platforms = Array.from(new Set([...(expo.platforms ?? ['ios', 'android']), 'web']));
expo.web = {
  ...(expo.web ?? {}),
  bundler: 'metro',
  output: 'single',
  favicon: './assets/icons/raster/bomb.png',
};
appConfig.expo = expo;

await writeFile(appJsonPath, `${JSON.stringify(appConfig, null, 2)}\n`, 'utf8');

const nativeStorageSource = await readFile(storagePath, 'utf8');
const sqliteImport = "import Storage from 'expo-sqlite/kv-store';";
if (!nativeStorageSource.startsWith(sqliteImport)) {
  throw new Error('Unexpected src/storage.ts header; refusing to create an unsafe web override.');
}

const browserStorageBackend = `const Storage = {
  async getItem(key: string): Promise<string | null> {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      globalThis.localStorage.setItem(key, value);
    } catch {
      // Safari can reject writes in private mode or under storage pressure.
      // The game must remain playable even when persistence is unavailable.
    }
  },
  async removeItem(key: string): Promise<void> {
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      // Keep clearing storage best-effort on the web.
    }
  },
};`;

await writeFile(
  storageWebPath,
  nativeStorageSource.replace(sqliteImport, browserStorageBackend),
  'utf8',
);

await mkdir(publicDir, { recursive: true });
await copyFile(
  resolve(projectRoot, 'assets/icons/raster/bomb.png'),
  resolve(publicDir, 'nagoo-icon-512.png'),
);

const headers = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/index.html
  Cache-Control: no-cache, must-revalidate

/manifest.webmanifest
  Cache-Control: no-cache, must-revalidate

/sw.js
  Cache-Control: no-cache, no-store, must-revalidate
`;

await writeFile(resolve(publicDir, '_headers'), headers, 'utf8');

console.log('PWA source overrides prepared.');
