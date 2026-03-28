const fs = require('fs');
const path = require('path');

const SITE_URL = 'https://brennenf.github.io/wild_wild_life';

const photosDir = path.join(__dirname, '..', 'photos');
const photosJsonPath = path.join(__dirname, '..', 'photos.json');
const supportedExts = ['.jpg', '.jpeg', '.png'];

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function readPhotosJson() {
  if (!fs.existsSync(photosJsonPath)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(photosJsonPath, 'utf8')) || [];
  } catch (error) {
    console.error('Failed to parse photos.json:', error.message);
    process.exit(1);
  }
}

function formatDisplayDate(date) {
  return `${monthNames[date.getMonth()]} ${String(date.getDate()).padStart(2, '0')}, ${date.getFullYear()}`;
}

function parseExifDateString(value) {
  if (!value) return null;
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (match) {
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseExifTags(buffer) {
  let offset = 2;
  const tags = {};

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1) {
      const start = offset + 4;
      if (buffer.toString('ascii', start, start + 6) === 'Exif\u0000\u0000') {
        return parseTiff(buffer.slice(start + 6));
      }
    }
    offset += 2 + length;
  }

  return tags;
}

function parseTiff(buffer) {
  const byteOrder = buffer.toString('ascii', 0, 2);
  const little = byteOrder === 'II';
  const readUInt16 = little ? buffer.readUInt16LE.bind(buffer) : buffer.readUInt16BE.bind(buffer);
  const readUInt32 = little ? buffer.readUInt32LE.bind(buffer) : buffer.readUInt32BE.bind(buffer);

  if (readUInt16(2) !== 0x2a) {
    return {};
  }

  const firstIFDOffset = readUInt32(4);
  const tags = {};
  const exifPointer = readIFD(buffer, firstIFDOffset, readUInt16, readUInt32, tags);
  if (typeof exifPointer === 'number' && exifPointer > 0) {
    readIFD(buffer, exifPointer, readUInt16, readUInt32, tags);
  }
  return tags;
}

function readIFD(buffer, offset, readUInt16, readUInt32, tags) {
  if (offset + 2 > buffer.length) return 0;
  const numEntries = readUInt16(offset);
  let exifOffset = 0;
  for (let i = 0; i < numEntries; i += 1) {
    const entryOffset = offset + 2 + i * 12;
    if (entryOffset + 12 > buffer.length) break;

    const tag = readUInt16(entryOffset);
    const type = readUInt16(entryOffset + 2);
    const count = readUInt32(entryOffset + 4);
    const valueOffset = entryOffset + 8;
    const valuePointer = readUInt32(valueOffset);

    if (tag === 0x8769 && type === 4) {
      exifOffset = valuePointer;
      continue;
    }

    const stringTags = [0x0132, 0x9003, 0x9004];
    if (stringTags.includes(tag) && type === 2) {
      const size = count;
      let raw;
      if (size <= 4) {
        raw = buffer.slice(valueOffset, valueOffset + size);
      } else {
        raw = buffer.slice(valuePointer, valuePointer + size);
      }
      const value = raw.toString('ascii').replace(/\x00.*$/, '');
      if (tag === 0x0132) tags.DateTime = value;
      if (tag === 0x9003) tags.DateTimeOriginal = value;
      if (tag === 0x9004) tags.DateTimeDigitized = value;
    }
  }
  return exifOffset;
}

function scanPhotos() {
  return fs
    .readdirSync(photosDir)
    .filter((file) => supportedExts.includes(path.extname(file).toLowerCase()))
    .sort();
}

function buildPhotoEntry(file, existing) {
  const filePath = path.join(photosDir, file);
  const buffer = fs.readFileSync(filePath);
  const tags = parseExifTags(buffer);
  const dateString = tags.DateTimeOriginal || tags.DateTimeDigitized || tags.DateTime || null;
  const parsedDate = parseExifDateString(dateString);
  const dateTaken = parsedDate ? parsedDate.toISOString() : null;
  const date = parsedDate ? formatDisplayDate(parsedDate) : null;

  const entry = existing || {
    id: null,
    filename: file,
    title: path.basename(file, path.extname(file)),
    description: '',
  };

  entry.filename = file;
  entry.title = entry.title || path.basename(file, path.extname(file));
  entry.description = entry.description || '';
  if (dateTaken) {
    entry.dateTaken = dateTaken;
  }
  if (date) {
    entry.date = date;
  }
  return entry;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rssDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
}

function getPhotoLink(photo) {
  return `${SITE_URL}/?photo=${encodeURIComponent(photo.id)}`;
}

function getPhotoUrl(photo) {
  return `${SITE_URL}/photos/${encodeURIComponent(photo.filename)}`;
}


function generateRss(photos) {
  const sortedPhotos = [...photos].sort((a, b) => {
    const aDate = new Date(a.dateTaken || a.date || 0).getTime();
    const bDate = new Date(b.dateTaken || b.date || 0).getTime();
    return bDate - aDate;
  });

  const lastBuildDate = sortedPhotos.length
    ? rssDate(sortedPhotos[0].dateTaken || sortedPhotos[0].date)
    : new Date().toUTCString();

  const items = sortedPhotos
    .map((photo) => {
      const title = escapeXml(photo.title || path.basename(photo.filename, path.extname(photo.filename)));
      const description = escapeXml(photo.description || '');
      const link = escapeXml(getPhotoLink(photo));
      const guid = escapeXml(photo.id || photo.filename);
      const pubDate = photo.dateTaken ? rssDate(photo.dateTaken) : rssDate(photo.date || new Date());
      const enclosureUrl = getPhotoUrl(photo);

      const imgHtml = `<img src="${enclosureUrl}" alt="${escapeXml(photo.title || '')}" style="max-width:100%;height:auto;" />`;
      const descHtml = description ? `<p>${description}</p>` : '';
      return `    <item>
      <title>${title}</title>
      <link>${link}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[${imgHtml}${descHtml}]]></description>
    </item>`;
    })
    .join('\n');

  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Don't Disturb the Wildlife</title>
    <link>${SITE_URL}/</link>
    <description>Latest images from the wildlife gallery.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <atom:link href="${SITE_URL}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

  fs.writeFileSync(path.join(__dirname, '..', 'rss.xml'), rssXml + '\n', 'utf8');
  console.log(`Generated rss.xml with ${sortedPhotos.length} items.`);
}

function main() {
  const existingPhotos = readPhotosJson();
  const existingByFilename = new Map(existingPhotos.map((photo) => [photo.filename, photo]));
  const ids = existingPhotos
    .map((photo) => Number(photo.id))
    .filter((value) => Number.isFinite(value) && value > 0);
  let nextId = ids.length ? Math.max(...ids) + 1 : 1;

  const files = scanPhotos();
  const updatedPhotos = files.map((file) => {
    const existing = existingByFilename.get(file);
    const photo = buildPhotoEntry(file, existing);
    if (!photo.id) {
      photo.id = String(nextId);
      nextId += 1;
    }
    return photo;
  });

  fs.writeFileSync(photosJsonPath, JSON.stringify(updatedPhotos, null, 2) + '\n', 'utf8');
  console.log(`Updated ${updatedPhotos.length} photo entries in photos.json.`);
  generateRss(updatedPhotos);
}

main();
