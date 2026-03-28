const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const PHOTOS_JSON_PATH = path.join(ROOT, 'photos.json');
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const DEFAULT_MODEL = 'gemini-2.5-flash';

function parseArgs(argv) {
  const args = {
    model: DEFAULT_MODEL,
    onlyMissing: false,
    dryRun: false,
    limit: null,
  };

  for (const arg of argv) {
    if (arg === '--only-missing') {
      args.onlyMissing = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg.startsWith('--model=')) {
      args.model = arg.slice('--model='.length).trim() || DEFAULT_MODEL;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('Invalid --limit value. Use a positive integer.');
      }
      args.limit = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function readPhotosJson() {
  if (!fs.existsSync(PHOTOS_JSON_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(PHOTOS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error('photos.json must be a JSON array.');
  }

  return parsed;
}

function scanPhotosDir() {
  if (!fs.existsSync(PHOTOS_DIR)) {
    throw new Error('photos directory was not found.');
  }

  return fs
    .readdirSync(PHOTOS_DIR)
    .filter((file) => SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort();
}

function guessMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  throw new Error(`Unsupported image extension for ${filename}`);
}

function nextId(entries) {
  const ids = entries
    .map((entry) => Number(entry.id))
    .filter((value) => Number.isFinite(value) && value > 0);

  return ids.length ? Math.max(...ids) + 1 : 1;
}

function hasMeaningfulText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function maybeExtractJson(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_) {
    // Fallback: try to parse first JSON object in mixed text.
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

async function generateMetadata({ apiKey, model, filename }) {
  if (typeof fetch !== 'function') {
    throw new Error('This script requires Node.js with global fetch support (Node 18+).');
  }

  const filePath = path.join(PHOTOS_DIR, filename);
  const imageBytes = fs.readFileSync(filePath);
  const base64Data = imageBytes.toString('base64');
  const mimeType = guessMimeType(filename);

  const prompt = [
    'You are writing metadata for a photo gallery.',
    'Return only strict JSON with keys: title and description.',
    'title rules: 2 to 6 words, no quotes, no trailing punctuation, descriptive but concise.',
    'description rules: 1 sentence, 8 to 24 words, plain language, avoid speculation and avoid naming specific people unless obvious from image.',
    'If content is unclear, keep language neutral and concrete.',
  ].join(' ');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Data,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API request failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    .filter(Boolean)
    .join('\n');

  const parsed = maybeExtractJson(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Could not parse JSON metadata from model output for ${filename}.`);
  }

  const title = hasMeaningfulText(parsed.title) ? parsed.title.trim() : null;
  const description = hasMeaningfulText(parsed.description) ? parsed.description.trim() : null;

  if (!title || !description) {
    throw new Error(`Model output missing title or description for ${filename}.`);
  }

  return { title, description };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY environment variable.');
  }

  const existingEntries = readPhotosJson();
  const byFilename = new Map(existingEntries.map((entry) => [entry.filename, entry]));
  const files = scanPhotosDir();

  let idCounter = nextId(existingEntries);
  const mergedEntries = files.map((filename) => {
    const found = byFilename.get(filename);
    if (found) {
      return found;
    }

    const entry = {
      id: String(idCounter),
      filename,
      title: path.basename(filename, path.extname(filename)),
      description: '',
    };
    idCounter += 1;
    return entry;
  });

  let targets = mergedEntries;
  if (args.onlyMissing) {
    targets = mergedEntries.filter((entry) => !(hasMeaningfulText(entry.title) && hasMeaningfulText(entry.description)));
  }
  if (args.limit) {
    targets = targets.slice(0, args.limit);
  }

  if (targets.length === 0) {
    console.log('No photos need metadata updates.');
    return;
  }

  console.log(`Generating metadata for ${targets.length} photo(s) with model ${args.model}...`);

  let updatedCount = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const entry = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${entry.filename} ... `);

    try {
      const metadata = await generateMetadata({
        apiKey,
        model: args.model,
        filename: entry.filename,
      });
      entry.title = metadata.title;
      entry.description = metadata.description;
      updatedCount += 1;
      process.stdout.write('ok\n');
    } catch (error) {
      process.stdout.write(`failed (${error.message})\n`);
    }
  }

  if (args.dryRun) {
    console.log(`Dry run complete. Would update ${updatedCount} photo(s).`);
    return;
  }

  fs.writeFileSync(PHOTOS_JSON_PATH, `${JSON.stringify(mergedEntries, null, 2)}\n`, 'utf8');
  console.log(`Updated photos.json with ${updatedCount} generated metadata item(s).`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
