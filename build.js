import fs from 'node:fs';
import path from 'node:path';

const publicDir = path.resolve('public');
const staticFiles = [
  'index.html',
  'app.js',
  'style.css',
  'sw.js',
  'manifest.json',
  'icon.png',
  'logo.png',
];

fs.rmSync(publicDir, { recursive: true, force: true });
fs.mkdirSync(publicDir, { recursive: true });

for (const file of staticFiles) {
  const src = path.resolve(file);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required static asset: ${file}`);
  }
  fs.copyFileSync(src, path.join(publicDir, file));
}

console.log(`Built ${staticFiles.length} static assets into public/ for Vercel deployment.`);
