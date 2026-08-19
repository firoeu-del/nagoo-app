import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const appRoot = resolve(process.argv[2] ?? 'app');
const compiledWordsPath = join(appRoot, '.qa-words/data/words.js');
const runtimeRequire = createRequire(import.meta.url);
const database = runtimeRequire(compiledWordsPath);

const {
  words,
  categoryCounts,
  categoryDifficultyCounts,
  categoryLabels,
} = database;

if (!Array.isArray(words) || words.length !== 19520) {
  throw new Error(`Expected 19,520 verified runtime words; found ${words?.length ?? 'none'}.`);
}
if (Object.keys(categoryCounts ?? {}).length !== 35) {
  throw new Error(`Expected 35 built-in categories; found ${Object.keys(categoryCounts ?? {}).length}.`);
}

const previewCategories = ['general', 'cinema', 'sports', 'food', 'objects', 'places'];
const homePreviewWords = Array.from(new Set([
  'پرسپولیس',
  ...previewCategories.flatMap((category) =>
    words
      .filter((word) => word.category === category && word.difficulty === 'normal' && word.text.length <= 14)
      .slice(0, 14)
      .map((word) => word.text),
  ),
]));

const wordsJson = JSON.stringify(words);
const snapshotDigest = createHash('sha256').update(wordsJson).digest('hex');
const wordsSource = `import type { GameWord } from '../types';

// Generated from the fully audited v1.37.1 pipeline during the Android build.
// sha256(JSON): ${snapshotDigest}
const WORDS_JSON = ${JSON.stringify(wordsJson)};
export const words = JSON.parse(WORDS_JSON) as GameWord[];
export { builtInWordCount, categoryCounts, categoryDifficultyCounts, categoryLabels } from './wordMeta';
`;

const metadataSource = `import type { WordCategory, WordDifficulty } from '../types';

export const categoryCounts: Partial<Record<WordCategory, number>> = ${JSON.stringify(categoryCounts)};
export const categoryDifficultyCounts: Partial<Record<WordCategory, Partial<Record<WordDifficulty, number>>>> = ${JSON.stringify(categoryDifficultyCounts)};
export const categoryLabels: Record<WordCategory, string> = ${JSON.stringify(categoryLabels)};
export const builtInWordCount = ${words.length};
export const HOME_PREVIEW_WORDS: string[] = ${JSON.stringify(homePreviewWords)};
`;

const runtimeLoaderSource = `import type { GameWord } from '../types';

declare const require: (path: string) => { words: GameWord[] };
let cachedWords: GameWord[] | null = null;

export function loadBuiltInWords(): GameWord[] {
  if (!cachedWords) cachedWords = require('./words').words;
  return cachedWords;
}
`;

await Promise.all([
  writeFile(join(appRoot, 'src/data/words.ts'), wordsSource, 'utf8'),
  writeFile(join(appRoot, 'src/data/wordMeta.ts'), metadataSource, 'utf8'),
  writeFile(join(appRoot, 'src/data/wordRuntime.ts'), runtimeLoaderSource, 'utf8'),
]);

console.log(`Generated verified ${words.length}-word Android snapshot ${snapshotDigest}.`);
