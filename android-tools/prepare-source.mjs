import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appRoot = resolve(process.argv[2] ?? 'app');
const appPath = join(appRoot, 'App.tsx');

let source = await readFile(appPath, 'utf8');

const replacements = [
  {
    label: 'eager word database import',
    from: "import { words } from './src/data/words';",
    to: "import { loadBuiltInWords } from './src/data/wordRuntime';",
  },
  {
    label: 'eager PNG decoder import',
    from: "import { decodeAllAppPngs } from './src/assets/imageAssets';\n",
    to: '',
  },
  {
    label: 'blocking image preload state and effect',
    from: `  const [imagesReady, setImagesReady] = useState(false);

  useEffect(() => {
    let active = true;
    void decodeAllAppPngs().finally(() => {
      if (active) setImagesReady(true);
    });
    return () => { active = false; };
  }, []);`,
    to: `  const [startupFallbackReady, setStartupFallbackReady] = useState(false);

  useEffect(() => {
    // Bundled PNGs already have safe static sources and are decoded lazily by
    // the native image view. Never keep the first screen hidden behind a
    // full-library decode; lower-memory Android devices can otherwise spend
    // startup continuously collecting bitmap memory.
    const timer = setTimeout(() => setStartupFallbackReady(true), 3500);
    return () => clearTimeout(timer);
  }, []);`,
  },
  {
    label: 'startup readiness gate',
    from: '  const appReady = fontsLoaded && hydrated && imagesReady;',
    to: '  const appReady = startupFallbackReady || (fontsLoaded && hydrated);',
  },
  {
    label: 'built-in word state',
    from: `  const [customWords, setCustomWords] = useState<CustomWord[]>([]);
  const [hydrated, setHydrated] = useState(false);`,
    to: `  const [customWords, setCustomWords] = useState<CustomWord[]>([]);
  const [builtInWords, setBuiltInWords] = useState<GameWord[]>([]);
  const [hydrated, setHydrated] = useState(false);`,
  },
  {
    label: 'post-paint word database loader',
    from: `  const [, setContentTelemetryRevision] = useState(0);

  useEffect(() => {`,
    to: `  const [, setContentTelemetryRevision] = useState(0);

  useEffect(() => {
    // Commit the lightweight home screen first, then hydrate the verified word
    // snapshot on the next task. This avoids executing the 19,520-word database
    // while Android is still creating the first React surface.
    const timer = setTimeout(() => setBuiltInWords(loadBuiltInWords()), 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {`,
  },
  {
    label: 'built-in word memo source',
    from: `  const allWords = useMemo<GameWord[]>(() => [
    ...words,
    ...customWords.map((word) => ({ ...word, category: 'custom' as const })),
  ], [customWords]);`,
    to: `  const allWords = useMemo<GameWord[]>(() => [
    ...builtInWords,
    ...customWords.map((word) => ({ ...word, category: 'custom' as const })),
  ], [builtInWords, customWords]);`,
  },
  {
    label: 'general word fallback source',
    from: "    const fallback = words.filter((word) => word.category === 'general');",
    to: "    const fallback = builtInWords.filter((word) => word.category === 'general');",
  },
  {
    label: 'initial game word',
    from: '  const [currentWord, setCurrentWord] = useState<GameWord>(() => words[0]);',
    to: "  const [currentWord, setCurrentWord] = useState<GameWord>(() => ({ id: 'general-1', text: 'چتر', category: 'general', difficulty: 'normal' }));",
  },
];

for (const { label, from, to } of replacements) {
  const matches = source.split(from).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected exactly one ${label} match in ${appPath}; found ${matches}.`);
  }
  source = source.replace(from, to);
}

await writeFile(appPath, source, 'utf8');

const homePath = join(appRoot, 'src/screens/HomeScreen.tsx');
let homeSource = await readFile(homePath, 'utf8');
const homeReplacements = [
  {
    label: 'home word database import',
    from: "import { words } from '../data/words';",
    to: "import { HOME_PREVIEW_WORDS } from '../data/wordMeta';",
  },
  {
    label: 'runtime home preview scan',
    from: `const HOME_PREVIEW_CATEGORIES = ['general', 'cinema', 'sports', 'food', 'objects', 'places'] as const;
const HOME_PREVIEW_WORDS = Array.from(
  new Set([
    'پرسپولیس',
    ...HOME_PREVIEW_CATEGORIES.flatMap((category) =>
      words
        .filter((word) => word.category === category && word.difficulty === 'normal' && word.text.length <= 14)
        .slice(0, 14)
        .map((word) => word.text),
    ),
  ]),
);
`,
    to: '',
  },
];

for (const { label, from, to } of homeReplacements) {
  const matches = homeSource.split(from).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected exactly one ${label} match in ${homePath}; found ${matches}.`);
  }
  homeSource = homeSource.replace(from, to);
}
await writeFile(homePath, homeSource, 'utf8');

for (const screenName of ['GameScreen.tsx', 'PacksScreen.tsx', 'ResultsScreen.tsx']) {
  const screenPath = join(appRoot, 'src/screens', screenName);
  const screenSource = await readFile(screenPath, 'utf8');
  const from = "from '../data/words';";
  const matches = screenSource.split(from).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected exactly one word metadata import in ${screenPath}; found ${matches}.`);
  }
  await writeFile(screenPath, screenSource.replace(from, "from '../data/wordMeta';"), 'utf8');
}

const catalogPath = join(appRoot, 'src/data/wordHintCatalog.ts');
const hintEnginePath = join(appRoot, 'src/game/hints.ts');
const splitCatalogRoot = join(appRoot, 'src/data/wordHints');
const loaderPath = join(appRoot, 'src/data/wordHintLoader.ts');
const catalogSource = await readFile(catalogPath, 'utf8');
const catalogLines = catalogSource.split('\n');
const entryPattern = /^  "([^"]+)": \{.*\}, \/\/ /u;
const categoryPattern = /^([A-Za-z]+)-/u;
const expectedEntryCount = 19520;
const entriesByCategory = new Map();

for (const line of catalogLines) {
  const entry = entryPattern.exec(line);
  if (!entry) continue;
  const category = categoryPattern.exec(entry[1])?.[1];
  if (!category) throw new Error(`Could not derive a category from hint key ${entry[1]}.`);
  const entries = entriesByCategory.get(category) ?? [];
  entries.push(line);
  entriesByCategory.set(category, entries);
}

const splitEntryCount = [...entriesByCategory.values()].reduce((total, entries) => total + entries.length, 0);
if (splitEntryCount !== expectedEntryCount) {
  throw new Error(`Expected ${expectedEntryCount} hint records; found ${splitEntryCount}.`);
}

const categories = [...entriesByCategory.keys()].sort();
if (categories.length !== 35) {
  throw new Error(`Expected 35 built-in hint categories; found ${categories.length}.`);
}

await mkdir(splitCatalogRoot, { recursive: true });
await Promise.all(categories.map(async (category) => {
  const entries = entriesByCategory.get(category);
  const moduleSource = `import type { WordHintCopy } from '../wordHintCatalog';

export const WORD_HINTS: Record<string, WordHintCopy> = {
${entries.join('\n')}
};
`;
  await writeFile(join(splitCatalogRoot, `${category}.ts`), moduleSource, 'utf8');
}));

const catalogTypes = `// Android runtime build: the 19,520 authored hints are emitted into
// category modules by android-tools/prepare-source.mjs. Keeping only shared
// types here prevents the entire 6.7 MB catalog from being instantiated before
// the first screen appears.
export type WordHintQuality = 'manual' | 'exact' | 'semantic' | 'taxonomy' | 'fallback' | 'leakSafeFallback';
export type WordHintCopy = { coach: string; concept: string; quality: WordHintQuality };
export const WORD_HINT_CATALOG_COUNT = ${expectedEntryCount};
`;
await writeFile(catalogPath, catalogTypes, 'utf8');

const loaderCases = categories
  .map((category) => `    case '${category}': return require('./wordHints/${category}').WORD_HINTS[word.id];`)
  .join('\n');
const loaderSource = `import type { GameWord } from '../types';
import type { WordHintCopy } from './wordHintCatalog';

declare const require: (path: string) => { WORD_HINTS: Record<string, WordHintCopy> };

// Literal requires stay inside the switch so Metro registers every category in
// the bundle but evaluates only the category needed by the current word.
export function getWordHintCopy(word: GameWord): WordHintCopy | undefined {
  switch (word.category) {
${loaderCases}
    case 'custom': return undefined;
  }
}
`;
await writeFile(loaderPath, loaderSource, 'utf8');

let hintEngine = await readFile(hintEnginePath, 'utf8');
const hintEngineReplacements = [
  {
    label: 'monolithic hint catalog import',
    from: "import { WORD_HINT_CATALOG } from '../data/wordHintCatalog';",
    to: "import { getWordHintCopy } from '../data/wordHintLoader';",
  },
  {
    label: 'monolithic hint lookup',
    from: '  const authored = WORD_HINT_CATALOG[word.id];',
    to: '  const authored = getWordHintCopy(word);',
  },
];

for (const { label, from, to } of hintEngineReplacements) {
  const matches = hintEngine.split(from).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected exactly one ${label} match in ${hintEnginePath}; found ${matches}.`);
  }
  hintEngine = hintEngine.replace(from, to);
}

await writeFile(hintEnginePath, hintEngine, 'utf8');
console.log(`Applied Android startup fix and split ${splitEntryCount} hints across ${categories.length} lazy categories.`);
