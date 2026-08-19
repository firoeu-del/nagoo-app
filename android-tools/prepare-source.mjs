import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const appRoot = resolve(process.argv[2] ?? 'app');
const appPath = join(appRoot, 'App.tsx');

let source = await readFile(appPath, 'utf8');

const replacements = [
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
];

for (const { label, from, to } of replacements) {
  const matches = source.split(from).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected exactly one ${label} match in ${appPath}; found ${matches}.`);
  }
  source = source.replace(from, to);
}

await writeFile(appPath, source, 'utf8');
console.log(`Applied Android startup fix to ${appPath}`);
