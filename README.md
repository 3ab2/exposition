# Independent Exhibition Images

This project builds one image-only static page for each supported source file in `images/`. Original artwork is copied without modification. There is no homepage or gallery; `/` returns a blank 404 page.

The shared `images/favicon.png` is copied byte-for-byte to `dist/favicon.png` and referenced from every artwork page using the root-relative path `/favicon.png`.

## Build and preview

Use Node.js 20 or newer:

```powershell
npm install
npm run check
npm start
```

The preview URL is printed by the server, normally `http://127.0.0.1:4173`. Open an artwork URL directly to view its image. The generated static output is `dist/`; it contains no `index.html`. Each route is a directory containing its own `index.html`, so direct access and refresh do not depend on prior navigation.

Each stable page route is derived from the first 16 hexadecimal characters of the SHA-256 hash of the image's relative filename:

```text
/images/image-<16-character-filename-hash>/
```

The route-to-source and intended QR filename mapping is written to `qrcodes/manifest.csv`. Running `npm run qr` without a base URL records the 13 page paths and marks QR generation as pending; it does not create QR images or use localhost as a destination.

## Generate QR codes

After the site has a real, public HTTPS origin, provide that origin in PowerShell:

```powershell
$env:BASE_URL = Read-Host 'Enter the real public HTTPS origin'
npm run qr
```

Alternatively, pass the same configured origin with `npm run qr -- --base-url $env:BASE_URL`. The script rejects local, reserved, IP, and non-HTTPS destinations. It creates one high-resolution PNG per image page plus an updated CSV manifest containing source filename, route, full URL, and QR filename.

## Vercel settings (manual deployment only)

No deployment is performed by this project. When you explicitly choose to deploy, select the **Other** framework preset, use the project root, set the build command to `npm run build`, and set the output directory to `dist`. The install command is `npm install`. No rewrite is needed: each artwork route is a generated directory with an `index.html`, and `/` resolves to the blank `404.html`.