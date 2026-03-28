const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const PHOTOS_JSON_PATH = path.join(ROOT, 'photos.json');
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_PROVIDER = 'gemini';

function parseArgs(argv) {
  const args = {
    provider: DEFAULT_PROVIDER,
    model: null,
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
    if (arg.startsWith('--provider=')) {
      const val = arg.slice('--provider='.length).trim();
      if (val !== 'gemini' && val !== 'claude') {
        throw new Error('--provider must be "gemini" or "claude".');
      }
      args.provider = val;
      continue;
    }
    if (arg.startsWith('--model=')) {
      args.model = arg.slice('--model='.length).trim() || null;
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

  // Default model depends on provider
  if (!args.model) {
    args.model = args.provider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_GEMINI_MODEL;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPhotoExif(filename) {
  const filePath = path.join(PHOTOS_DIR, filename);
  const buf = fs.readFileSync(filePath);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xe1) {
      const len = buf.readUInt16BE(i + 2);
      const app1 = buf.slice(i + 4, i + 2 + len);
      if (app1.slice(0, 6).toString() === 'Exif\x00\x00') {
        return parseTiffExif(app1.slice(6));
      }
    }
    if (marker === 0xda || marker === 0xd9) break;
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

function parseTiffExif(buf) {
  const little = buf.slice(0, 2).toString() === 'II';
  const ru16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const ru32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ri32 = (o) => (little ? buf.readInt32LE(o) : buf.readInt32BE(o));

  const tags = {};
  const readIFD = (offset) => {
    try {
      const count = ru16(offset);
      for (let i = 0; i < count; i++) {
        const e = offset + 2 + i * 12;
        const tag = ru16(e);
        const type = ru16(e + 2);
        const n = ru32(e + 4);

        if (tag === 0x8769) {
          readIFD(ru32(e + 8));
          continue;
        }

        let val;
        if (type === 2) {
          const vOffset = n > 4 ? ru32(e + 8) : e + 8;
          val = buf.slice(vOffset, vOffset + n).toString('ascii').replace(/\x00/g, '').trim();
        } else if (type === 3) {
          val = ru16(e + 8);
        } else if (type === 4) {
          val = ru32(e + 8);
        } else if (type === 5) {
          const vOffset = ru32(e + 8);
          val = [ru32(vOffset), ru32(vOffset + 4)];
        } else if (type === 9) {
          val = ri32(e + 8);
        } else if (type === 10) {
          const vOffset = ru32(e + 8);
          val = [ri32(vOffset), ri32(vOffset + 4)];
        }
        tags[tag] = val;
      }
    } catch (_) {}
  };

  const ifdOffset = ru32(4);
  readIFD(ifdOffset);
  return tags;
}

function formatExifData(tags) {
  if (!tags) return null;

  const make = tags[0x010f];
  const model = tags[0x0110];
  const exposureRaw = tags[0x829a];
  const fnumberRaw = tags[0x829d];
  const iso = tags[0x8827];
  const focalLengthRaw = tags[0x920a];
  const focalLength35 = tags[0xa405];
  const lensModelRaw = tags[0xa434];

  if (!make && !model) return null;

  // Clean up camera model
  let camera = (model || '').trim();
  camera = camera.replace(/^NIKON\s+/i, 'Nikon ');
  camera = camera.replace(/Z50_2/i, 'Z50 II');

  // Lens model: skip base64 garbage
  let lens = null;
  if (typeof lensModelRaw === 'string' && lensModelRaw && !/^[A-Za-z0-9+/]{20,}={0,2}$/.test(lensModelRaw)) {
    // Skip iPhone "back camera X.Xmm f/X.X" style labels for non-Apple
    const isApple = typeof make === 'string' && make.toLowerCase().includes('apple');
    if (!isApple) {
      // Clean up Nikon lens names
      lens = lensModelRaw.replace(/\s+E$/, '').trim();
    }
  }

  // Aperture
  let aperture = null;
  if (Array.isArray(fnumberRaw) && fnumberRaw[1] !== 0) {
    const f = fnumberRaw[0] / fnumberRaw[1];
    aperture = 'f/' + (f % 1 === 0 ? f.toFixed(0) : f.toFixed(1).replace(/\.0$/, ''));
  }

  // Shutter speed
  let shutter = null;
  if (Array.isArray(exposureRaw) && exposureRaw[1] !== 0) {
    const num = exposureRaw[0];
    const den = exposureRaw[1];
    if (den === 1 || num === 1) {
      shutter = `${num}/${den}`;
    } else {
      // Simplify fraction
      const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
      const g = gcd(num, den);
      shutter = `${num / g}/${den / g}`;
    }
  }

  // Focal length — use 35mm equivalent for phones, actual for dedicated cameras
  let focalLength = null;
  const isApple = typeof make === 'string' && make.toLowerCase().includes('apple');
  if (isApple && focalLength35) {
    focalLength = `${focalLength35}mm`;
  } else if (Array.isArray(focalLengthRaw) && focalLengthRaw[1] !== 0) {
    const fl = Math.round(focalLengthRaw[0] / focalLengthRaw[1]);
    focalLength = `${fl}mm`;
  }

  const result = { camera };
  if (lens) result.lens = lens;
  if (aperture) result.aperture = aperture;
  if (shutter) result.shutter = shutter;
  if (iso) result.iso = iso;
  if (focalLength) result.focalLength = focalLength;

  return result;
}

async function generateMetadata({ apiKey, model, filename }, retries = 3) {
  if (typeof fetch !== 'function') {
    throw new Error('This script requires Node.js with global fetch support (Node 18+).');
  }

  const filePath = path.join(PHOTOS_DIR, filename);
  const imageBytes = fs.readFileSync(filePath);
  const base64Data = imageBytes.toString('base64');
  const mimeType = guessMimeType(filename);

  const prompt = [
    'You are writing metadata for a wildlife and pet photo gallery.',
    'Your tone is vivid, evocative, and dryly humorous — like a nature documentary narrated by someone with a very dry wit.',
    'Return only strict JSON with keys: title and description.',
    'title rules: exactly 4 words, no quotes, no trailing punctuation, creative and unexpected — avoid generic descriptions.',
    'description rules: 1 sentence, 8 to 24 words, vivid and specific, with subtle dry humor where it fits naturally.',
    'Avoid speculation about specific people unless obvious from the image.',
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
        temperature: 0.8,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (response.status === 429) {
    if (retries <= 0) {
      throw new Error(`Gemini API rate limit exceeded for ${filename}, no retries left.`);
    }
    let retryAfterMs = 30000;
    try {
      const body = await response.clone().json();
      const delay = body?.error?.details?.find((d) => d.retryDelay)?.retryDelay;
      if (delay) retryAfterMs = (parseInt(delay, 10) + 2) * 1000;
    } catch (_) {}
    process.stdout.write(`rate limited, retrying in ${Math.round(retryAfterMs / 1000)}s... `);
    await sleep(retryAfterMs);
    return generateMetadata({ apiKey, model, filename }, retries - 1);
  }

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

const CLAUDE_MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

function resizeImageIfNeeded(imageBytes, mimeType) {
  // Re-encode as JPEG at decreasing quality until under the limit
  const { execSync } = require('child_process');
  const os = require('os');
  const tmpIn = path.join(os.tmpdir(), `wwl-resize-in-${Date.now()}.jpg`);
  const tmpOut = path.join(os.tmpdir(), `wwl-resize-out-${Date.now()}.jpg`);

  try {
    fs.writeFileSync(tmpIn, imageBytes);
    // Scale to max 2400px on longest side, which keeps quality high but cuts file size dramatically
    execSync(`sips -Z 2400 --setProperty format jpeg "${tmpIn}" --out "${tmpOut}"`, { stdio: 'pipe' });
    const resized = fs.readFileSync(tmpOut);
    return resized;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
  }
}

async function generateMetadataWithClaude({ apiKey, model, filename }) {
  const filePath = path.join(PHOTOS_DIR, filename);
  let imageBytes = fs.readFileSync(filePath);
  const mimeType = guessMimeType(filename);

  // Check base64 size (not raw bytes) — Claude's 5 MB limit applies after encoding
  let base64Data = imageBytes.toString('base64');
  if (base64Data.length > CLAUDE_MAX_IMAGE_BYTES) {
    imageBytes = resizeImageIfNeeded(imageBytes, mimeType);
    base64Data = imageBytes.toString('base64');
  }

  const prompt = [
    'You are writing metadata for a wildlife and pet photo gallery.',
    'Your tone is vivid, evocative, and dryly humorous — like a nature documentary narrated by someone with a very dry wit.',
    'Return only strict JSON with keys: title and description.',
    'title rules: exactly 4 words, no quotes, no trailing punctuation, creative and unexpected — avoid generic descriptions.',
    'description rules: 1 sentence, 8 to 24 words, vivid and specific, with subtle dry humor where it fits naturally.',
    'Avoid speculation about specific people unless obvious from the image.',
  ].join(' ');

  const client = new Anthropic.default({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
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

  const apiKey = args.provider === 'claude'
    ? process.env.ANTHROPIC_API_KEY
    : process.env.GEMINI_API_KEY;

  const envVar = args.provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
  if (!apiKey) {
    throw new Error(`Missing ${envVar} environment variable.`);
  }

  const existingEntries = readPhotosJson();
  const byFilename = new Map(existingEntries.map((entry) => [entry.filename, entry]));
  const files = scanPhotosDir();

  let idCounter = nextId(existingEntries);
  const mergedEntries = files.map((filename) => {
    const found = byFilename.get(filename);
    let exif = null;
    try {
      exif = formatExifData(readPhotoExif(filename));
    } catch (_) {}

    if (found) {
      if (exif) {
        found.exif = exif;
      } else {
        delete found.exif;
      }
      return found;
    }

    const entry = {
      id: String(idCounter),
      filename,
      title: path.basename(filename, path.extname(filename)),
      description: '',
    };
    if (exif) entry.exif = exif;
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

  console.log(`Generating metadata for ${targets.length} photo(s) with ${args.provider}/${args.model}...`);

  const generate = args.provider === 'claude' ? generateMetadataWithClaude : generateMetadata;

  let updatedCount = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const entry = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${entry.filename} ... `);

    try {
      const metadata = await generate({
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
