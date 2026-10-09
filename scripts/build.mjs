import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageRoot = path.join(projectRoot, 'images');
const outputRoot = path.join(projectRoot, 'dist');
const markerName = '.exposition-build';
const extensions = new Map([
  ['.png', 'png'], ['.jpg', 'jpeg'], ['.jpeg', 'jpeg'], ['.gif', 'gif'],
  ['.webp', 'webp'], ['.avif', 'avif'], ['.svg', 'svg'],
]);

function urlPath(relativePath) {
  return `/images/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function dimensionsFor(buffer, format) {
  if (format === 'png' && buffer.length >= 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (format === 'gif' && buffer.length >= 10) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (format === 'jpeg') {
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  if (format === 'webp' && buffer.length >= 30) {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    if (chunk === 'VP8L' && buffer[20] === 0x2f) return {
      width: 1 + buffer[21] + ((buffer[22] & 0x3f) << 8),
      height: 1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10),
    };
    if (chunk === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  }
  if (format === 'svg') {
    const root = buffer.toString('utf8').match(/<svg\b[^>]*>/i)?.[0];
    if (!root) return null;
    const width = Number(root.match(/\bwidth\s*=\s*["']([\d.]+)/i)?.[1]);
    const height = Number(root.match(/\bheight\s*=\s*["']([\d.]+)/i)?.[1]);
    if (width > 0 && height > 0) return { width, height };
    const viewBox = root.match(/\bviewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
    return viewBox ? { width: Number(viewBox[1]), height: Number(viewBox[2]) } : null;
  }
  return null;
}

function formatFor(buffer, extension) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a') return 'gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (extension === '.avif' && buffer.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(buffer.toString('ascii', 8, Math.min(buffer.length, 64)))) return 'avif';
  if (extension === '.svg' && /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(buffer.toString('utf8', 0, Math.min(buffer.length, 4096)))) return 'svg';
  return null;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

const sourceFiles = (await walk(imageRoot)).sort((left, right) => {
  const a = path.relative(imageRoot, left).split(path.sep).join('/');
  const b = path.relative(imageRoot, right).split(path.sep).join('/');
  return a < b ? -1 : a > b ? 1 : 0;
});
const unsupported = [];
const artworks = [];
const routeIds = new Set();

for (const fullPath of sourceFiles) {
  const relativePath = path.relative(imageRoot, fullPath);
  const extension = path.extname(fullPath).toLowerCase();
  const expectedFormat = extensions.get(extension);
  let buffer;
  try {
    buffer = await readFile(fullPath);
  } catch (error) {
    unsupported.push(`${relativePath}: unreadable (${error.message})`);
    continue;
  }
  const format = expectedFormat && formatFor(buffer, extension);
  if (!format) {
    unsupported.push(`${relativePath}: unsupported or unreadable image format`);
    continue;
  }
  if (format !== expectedFormat) {
    unsupported.push(`${relativePath}: file content is ${format}, but its extension is ${extension}`);
    continue;
  }
  const dimensions = dimensionsFor(buffer, format);
  if (['png', 'jpeg', 'gif', 'webp'].includes(format) && (!dimensions || dimensions.width < 1 || dimensions.height < 1)) {
    unsupported.push(`${relativePath}: invalid or unreadable ${format.toUpperCase()} image dimensions`);
    continue;
  }
  const key = relativePath.split(path.sep).join('/');
  const id = `image-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`;
  if (routeIds.has(id)) throw new Error(`Route identifier collision for ${key}.`);
  routeIds.add(id);
  artworks.push({
    id, relativePath, key, format, dimensions, source: urlPath(relativePath),
  });
}

if (unsupported.length) {
  console.error('Unsupported or unreadable files in images/:');
  for (const message of unsupported) console.error(`  - ${message}`);
  process.exitCode = 1;
} else if (!artworks.length) {
  console.error('No supported images were found in images/.');
  process.exitCode = 1;
} else {
  try {
    const existing = await stat(outputRoot).catch(() => null);
    if (existing) {
      await stat(path.join(outputRoot, markerName)).catch(() => {
        throw new Error('dist/ exists without the generated-site marker; move it aside before building to preserve its contents.');
      });
      await rm(outputRoot, { recursive: true, force: true });
    }
    await mkdir(outputRoot, { recursive: true });
    await writeFile(path.join(outputRoot, markerName), 'Generated by scripts/build.mjs\n');
    await copyFile(path.join(projectRoot, 'styles.css'), path.join(outputRoot, 'styles.css'));
    for (const artwork of artworks) {
      const destination = path.join(outputRoot, 'images', artwork.relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(imageRoot, artwork.relativePath), destination);
    }

    for (const artwork of artworks) {
      const dimensions = artwork.dimensions ? ` width="${artwork.dimensions.width}" height="${artwork.dimensions.height}"` : '';
      const detailPage = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <link rel="stylesheet" href="/styles.css">
</head>
<body><img class="artwork-image" src="${artwork.source}" alt=""${dimensions} decoding="async" fetchpriority="high"></body>
</html>`;
      const pageDirectory = path.join(outputRoot, 'images', artwork.id);
      await mkdir(pageDirectory, { recursive: true });
      await writeFile(path.join(pageDirectory, 'index.html'), detailPage);
    }

    await writeFile(path.join(outputRoot, '404.html'), '<!doctype html><html><head></head><body></body></html>');
    console.log(`Built ${artworks.length} independent image pages from ${sourceFiles.length} files in images/.`);
    for (const artwork of artworks) {
      const dimensions = artwork.dimensions ? `${artwork.dimensions.width} × ${artwork.dimensions.height}` : 'dimensions unavailable';
      console.log(`  /images/${artwork.id}/  ${artwork.key}  ${dimensions}`);
    }
    console.log(`Static output: ${path.relative(projectRoot, outputRoot)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}