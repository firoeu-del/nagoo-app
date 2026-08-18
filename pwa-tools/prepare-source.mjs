import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(process.argv[2] ?? '.');
const appJsonPath = resolve(projectRoot, 'app.json');
const storagePath = resolve(projectRoot, 'src/storage.ts');
const storageWebPath = resolve(projectRoot, 'src/storage.web.ts');
const appPath = resolve(projectRoot, 'App.tsx');
const audioWebPath = resolve(projectRoot, 'src/audio/sfxEngine.web.ts');
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

// Expo Audio's web preload helper currently returns void rather than a Promise.
// The native engine intentionally chains Promise methods from it, which crashes
// before React mounts on the web. Keep the native engine untouched and provide
// a browser-native implementation with the same public API for Metro's .web
// platform resolution.
const webAudioEngine = `import { Asset } from 'expo-asset';

export const SFX_SOURCE = {
  tick: require('../../assets/sounds/tick.wav'),
  correct: require('../../assets/sounds/correct.wav'),
  skip: require('../../assets/sounds/skip.wav'),
  hint: require('../../assets/sounds/hint.wav'),
  boom: require('../../assets/sounds/boom.wav'),
  win: require('../../assets/sounds/win.wav'),
  modeClassic: require('../../assets/sounds/mode-classic.wav'),
  modeMystery: require('../../assets/sounds/mode-mystery.wav'),
  modeTurbo: require('../../assets/sounds/mode-turbo.wav'),
  modeStreak: require('../../assets/sounds/mode-streak.wav'),
  modeRoulette: require('../../assets/sounds/mode-roulette.wav'),
  modeSurvival: require('../../assets/sounds/mode-survival.wav'),
  turn: require('../../assets/sounds/turn.wav'),
  combo: require('../../assets/sounds/combo.wav'),
  time04: require('../../assets/sounds/time-04.wav'),
  time08: require('../../assets/sounds/time-08.wav'),
  time12: require('../../assets/sounds/time-12.wav'),
  time16: require('../../assets/sounds/time-16.wav'),
  time20: require('../../assets/sounds/time-20.wav'),
} as const;

export type GameplaySfxCue = 'tick' | 'correct' | 'skip' | 'hint' | 'boom' | 'win' | 'turn' | 'combo';
export type SoundSource = (typeof SFX_SOURCE)[keyof typeof SFX_SOURCE];

type Slot = {
  cue: GameplaySfxCue;
  player: HTMLAudioElement;
  lastPlayAt: number;
};

const FIXED_CUES: GameplaySfxCue[] = ['tick', 'correct', 'skip', 'hint', 'boom', 'win', 'turn', 'combo'];
const CUE_WINDOW_MS: Record<GameplaySfxCue, number> = {
  tick: 105,
  correct: 285,
  skip: 215,
  hint: 340,
  boom: 700,
  win: 520,
  turn: 380,
  combo: 555,
};
const MIN_RETRIGGER_MS: Record<GameplaySfxCue, number> = {
  tick: 650,
  correct: 110,
  skip: 120,
  hint: 180,
  boom: 500,
  win: 600,
  turn: 220,
  combo: 260,
};
const PRIORITY: Record<GameplaySfxCue, number> = {
  tick: 0,
  turn: 1,
  combo: 2,
  correct: 3,
  skip: 3,
  hint: 2,
  win: 4,
  boom: 5,
};

let slots: Partial<Record<GameplaySfxCue, Slot>> = {};
let previewPlayer: HTMLAudioElement | null = null;
let warmPromise: Promise<void> | null = null;
let activeCue: { cue: GameplaySfxCue; until: number } | null = null;
let pendingBeforeWarm: { cue: GameplaySfxCue; expiresAt: number } | null = null;

function sourceUrl(source: SoundSource) {
  try {
    const asset = Asset.fromModule(source);
    return asset.localUri ?? asset.uri;
  } catch {
    return String(source);
  }
}

function createPlayer(source?: SoundSource) {
  if (typeof Audio === 'undefined') return null;
  const player = new Audio(source === undefined ? undefined : sourceUrl(source));
  player.preload = 'auto';
  player.setAttribute('playsinline', '');
  return player;
}

function primePlayer(player: HTMLAudioElement) {
  return new Promise<void>((resolvePrime) => {
    if (player.readyState >= HTMLMediaElement.HAVE_METADATA) {
      resolvePrime();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      player.removeEventListener('loadedmetadata', finish);
      player.removeEventListener('canplaythrough', finish);
      player.removeEventListener('error', finish);
      resolvePrime();
    };
    player.addEventListener('loadedmetadata', finish, { once: true });
    player.addEventListener('canplaythrough', finish, { once: true });
    player.addEventListener('error', finish, { once: true });
    try { player.load(); } catch { finish(); }
    setTimeout(finish, 2500);
  });
}

function parkSlot(slot: Slot) {
  try {
    slot.player.pause();
    slot.player.currentTime = 0;
  } catch {}
}

function shouldSuppress(cue: GameplaySfxCue, now: number) {
  if (!activeCue || now >= activeCue.until) return false;
  const activePriority = PRIORITY[activeCue.cue];
  const nextPriority = PRIORITY[cue];
  if (cue === 'tick' || cue === 'turn') return true;
  if (cue === 'combo' && activePriority >= PRIORITY.combo) return true;
  return nextPriority < activePriority;
}

function preemptLowerPriority(cue: GameplaySfxCue, now: number) {
  if (!activeCue || now >= activeCue.until) return;
  if (PRIORITY[cue] < PRIORITY[activeCue.cue] || activeCue.cue === cue) return;
  const previous = slots[activeCue.cue];
  if (previous) parkSlot(previous);
  activeCue = null;
}

function playPrepared(slot: Slot, now = Date.now()) {
  if (now - slot.lastPlayAt < MIN_RETRIGGER_MS[slot.cue]) return false;
  slot.lastPlayAt = now;
  try {
    slot.player.currentTime = 0;
    const playback = slot.player.play();
    void Promise.resolve(playback).catch(() => undefined);
    activeCue = { cue: slot.cue, until: now + CUE_WINDOW_MS[slot.cue] };
    return true;
  } catch {
    return false;
  }
}

export function warmSfxEngine() {
  if (warmPromise) return warmPromise;

  warmPromise = (async () => {
    if (typeof Audio === 'undefined') return;
    const priming: Promise<void>[] = [];
    for (const cue of FIXED_CUES) {
      if (slots[cue]) continue;
      const player = createPlayer(SFX_SOURCE[cue]);
      if (!player) continue;
      player.loop = false;
      player.volume = cue === 'tick' ? 0.72 : 1;
      const slot: Slot = { cue, player, lastPlayAt: 0 };
      player.addEventListener('ended', () => parkSlot(slot));
      slots[cue] = slot;
      priming.push(primePlayer(player));
    }
    if (!previewPlayer) previewPlayer = createPlayer();
    await Promise.all(priming);

    const pending = pendingBeforeWarm;
    pendingBeforeWarm = null;
    if (pending && Date.now() <= pending.expiresAt) playGameplaySfx(pending.cue, true);
  })().catch(() => undefined);

  return warmPromise;
}

export function playGameplaySfx(cue: GameplaySfxCue, enabled = true) {
  if (!enabled) return false;
  const now = Date.now();
  const slot = slots[cue];
  if (!slot) {
    const current = pendingBeforeWarm;
    if (!current || PRIORITY[cue] >= PRIORITY[current.cue]) {
      pendingBeforeWarm = { cue, expiresAt: now + 450 };
    }
    void warmSfxEngine();
    return false;
  }
  if (shouldSuppress(cue, now)) return false;
  preemptLowerPriority(cue, now);
  return playPrepared(slot, now);
}

export function stopGameplaySfx() {
  for (const cue of FIXED_CUES) {
    const slot = slots[cue];
    if (slot) parkSlot(slot);
  }
  activeCue = null;
  pendingBeforeWarm = null;
}

export function playPreviewSfx(source: SoundSource, enabled = true) {
  if (!enabled || typeof Audio === 'undefined') return;
  void warmSfxEngine().then(() => {
    if (!previewPlayer) previewPlayer = createPlayer();
    if (!previewPlayer) return;
    try {
      previewPlayer.pause();
      previewPlayer.src = sourceUrl(source);
      previewPlayer.currentTime = 0;
      const playback = previewPlayer.play();
      void Promise.resolve(playback).catch(() => undefined);
    } catch {}
  });
}

export function getSfxEngineDebugState() {
  return {
    warmed: FIXED_CUES.every((cue) => !!slots[cue]),
    fixedPlayers: Object.keys(slots).length,
    activeCue: activeCue?.cue ?? null,
    pendingBeforeWarm: pendingBeforeWarm?.cue ?? null,
  };
}

void warmSfxEngine();
`;

await writeFile(audioWebPath, webAudioEngine, 'utf8');

// The Expo web implementations of these audio-mode calls can also return void.
// Normalizing with Promise.resolve preserves the native behavior while making
// the generated web copy safe across Expo web versions.
let appSource = await readFile(appPath, 'utf8');
appSource = appSource.replace(
  /void setAudioModeAsync\(([\s\S]*?)\)\.catch\(\(\) => undefined\);/,
  'void Promise.resolve(setAudioModeAsync($1)).catch(() => undefined);',
);
appSource = appSource.replaceAll(
  'void setIsAudioActiveAsync(true).catch(() => undefined);',
  'void Promise.resolve(setIsAudioActiveAsync(true)).catch(() => undefined);',
);
await writeFile(appPath, appSource, 'utf8');

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
