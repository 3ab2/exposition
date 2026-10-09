import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'dist');
const qrRoot = path.join(projectRoot, 'qrcodes');
const suppliedUrl = process.env.BASE_URL?.trim();
const argumentIndex = process.argv.indexOf('--base-url');
const baseUrlText = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : suppliedUrl;
const baseUrl = baseUrlText ? new URL(baseUrlText) : null;
if (baseUrl && (baseUrl.protocol !== 'https:' || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password)) {
  throw new Error('The base URL must be a public HTTPS origin with no credentials, path, query, or fragment.');
}
if (baseUrl) {
  const hostname = baseUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname.includes('.') || isIP(hostname) || ['localhost', '.localhost', '.local', '.test', '.invalid', '.example'].some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) {
    throw new Error('Use a public HTTPS domain, not a localhost, reserved, or IP address.');
  }
}

const hasBuildMarker = await readFile(path.join(outputRoot, '.exposition-build'), 'utf8').then(() => true, () => false);
if (!hasBuildMarker) throw new Error('Build the gallery first with npm run build.');

const entries = await readdir(path.join(outputRoot, 'images'), { withFileTypes: true });
const routes = entries.filter((entry) => entry.isDirectory() && /^image-[a-f\d]{16}$/.test(entry.name))
  .map((entry) => entry.name).sort();
if (!routes.length) throw new Error('No generated artwork pages were found.');

await mkdir(qrRoot, { recursive: true });
const manifest = [['image_filename', 'page_path', 'full_url', 'qr_filename', 'qr_status']];
const csv = (value) => `"${String(value).replaceAll('"', '""')}"`;
for (const route of routes) {
  const pagePath = `/images/${route}/`;
  const fullUrl = baseUrl ? new URL(pagePath.slice(1), baseUrl).href : '';
  const qrFilename = `${route}.png`;
  const page = await readFile(path.join(outputRoot, 'images', route, 'index.html'), 'utf8');
  const source = page.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1];
  if (!source) throw new Error(`Could not find the artwork image for ${route}.`);
  const imageFilename = decodeURIComponent(source.replace(/^\/images\//, ''));
  if (baseUrl) {
    await QRCode.toFile(path.join(qrRoot, qrFilename), fullUrl, {
      type: 'png', errorCorrectionLevel: 'H', width: 1200, margin: 4,
      color: { dark: '#101410', light: '#ffffff' },
    });
  }
  manifest.push([imageFilename, pagePath, fullUrl, qrFilename, baseUrl ? 'generated' : 'pending-public-url'].map(csv));
}
manifest.splice(1, manifest.length - 1, ...manifest.slice(1).sort((left, right) => left[0].localeCompare(right[0])));
await writeFile(path.join(qrRoot, 'manifest.csv'), `${manifest.map((row) => row.join(',')).join('\r\n')}\r\n`);
if (baseUrl) console.log(`Generated ${routes.length} QR codes in qrcodes/ and wrote qrcodes/manifest.csv.`);
else console.log(`Wrote qrcodes/manifest.csv for ${routes.length} pages; set BASE_URL to a public HTTPS origin to generate QR images.`);