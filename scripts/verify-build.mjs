import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const sourceRoot = path.join(root, 'images');
const sourceFiles = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(fullPath);
    else if (entry.isFile()) sourceFiles.push(path.relative(sourceRoot, fullPath));
  }
}

function parseCsv(contents) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (quoted) {
      if (character === '"' && contents[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"' && value === '') quoted = true;
    else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      value = '';
    } else value += character;
  }
  if (quoted) throw new Error('Unterminated quoted field in QR manifest.');
  if (row.length || value) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

await walk(sourceRoot);
sourceFiles.sort((left, right) => {
  const a = left.split(path.sep).join('/');
  const b = right.split(path.sep).join('/');
  return a < b ? -1 : a > b ? 1 : 0;
});

await assert.rejects(stat(path.join(output, 'index.html')), 'The generated site must not contain a homepage.');
await assert.rejects(stat(path.join(output, 'images', 'index.html')), 'The image directory must not contain an index page.');
const notFound = await readFile(path.join(output, '404.html'), 'utf8');
assert.doesNotMatch(notFound, /<title|<img|<a\b|<nav\b|images\//i, 'The root fallback must not contain artwork, titles, or navigation.');
assert.match(notFound, /<body>\s*<\/body>/i, 'The root fallback must be blank.');

const routeDirectories = (await readdir(path.join(output, 'images'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^image-[a-f\d]{16}$/.test(entry.name))
  .map((entry) => entry.name);
assert.equal(routeDirectories.length, sourceFiles.length, 'Every original must have exactly one generated route.');
assert.equal(new Set(routeDirectories).size, routeDirectories.length, 'All generated route IDs must be unique.');

for (const relativePath of sourceFiles) {
  const key = relativePath.split(path.sep).join('/');
  const id = `image-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`;
  assert.ok(routeDirectories.includes(id), `${key} must have its stable filename-derived route.`);
  const page = await readFile(path.join(output, 'images', id, 'index.html'), 'utf8');
  const images = [...page.matchAll(/<img\b[^>]*>/gi)];
  assert.equal(images.length, 1, `${id} must contain exactly one image.`);
  assert.doesNotMatch(page, /<title|<script\b|<a\b|<nav\b|<header\b|<footer\b|<h[1-6]\b|<p\b|<button\b|<figcaption\b/i, `${id} must not contain titles or UI.`);
  assert.match(page, /<body[^>]*>\s*<img\b[^>]*>\s*<\/body>/i, 'The image should be the entire body content.');
  const source = images[0][0].match(/\bsrc="([^"]+)"/)?.[1];
  assert.ok(source, `${id} must reference its image directly.`);
  const decodedSource = decodeURIComponent(source.replace(/^\/images\//, '')).split('/').join(path.sep);
  assert.equal(decodedSource, relativePath, `${id} must reference exactly its corresponding original.`);
  assert.equal((page.match(/\/images\//g) || []).length, 1, `${id} must not reference any other image.`);

  const original = await readFile(path.join(sourceRoot, relativePath));
  const copied = await readFile(path.join(output, 'images', relativePath));
  assert.ok(original.equals(copied), `${relativePath} must be copied without modification.`);
}

const manifestPath = path.join(root, 'qrcodes', 'manifest.csv');
const manifestText = await readFile(manifestPath, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (manifestText) {
  const rows = parseCsv(manifestText);
  assert.deepEqual(rows[0], ['image_filename', 'page_path', 'full_url', 'qr_filename', 'qr_status']);
  assert.equal(rows.length - 1, sourceFiles.length, 'The QR manifest must contain one row per source image.');
  const manifestEntries = new Map(rows.slice(1).map((row) => [row[0], row]));
  assert.equal(manifestEntries.size, sourceFiles.length, 'Manifest source filenames must be unique.');
  for (const relativePath of sourceFiles) {
    const key = relativePath.split(path.sep).join('/');
    const id = `image-${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`;
    const [filename, pagePath, fullUrl, qrFilename, status] = manifestEntries.get(key) || [];
    assert.equal(filename, key, `${key} must appear in the manifest.`);
    assert.equal(pagePath, `/images/${id}/`, `${key} must map to its independent page.`);
    assert.equal(qrFilename, `${id}.png`, `${key} must map to its stable QR output name.`);
    if (status === 'pending-public-url') assert.equal(fullUrl, '', `${key} must not have a fabricated public URL.`);
    else {
      assert.equal(status, 'generated', `${key} must be pending or generated.`);
      const url = new URL(fullUrl);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.pathname, pagePath);
      const qr = await readFile(path.join(root, 'qrcodes', qrFilename));
      assert.ok(qr.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${qrFilename} must be a PNG.`);
    }
  }
}

console.log(`Verified blank root, no image index, and ${sourceFiles.length} stable image-only pages with unchanged originals.`);