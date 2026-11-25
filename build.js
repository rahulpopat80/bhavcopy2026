import fs from 'node:fs';
import path from 'node:path';

const publicDir = path.resolve('public');
const staticFiles = [
  'index.html',
  'app.js',
  'rf-tanstack-grid.js',
  'rf-tradingview-charts.js',
  'rf-terminal-ui.js',
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

// Copy verified local library bundles for Vercel / static deployment
const vendorDir = path.join(publicDir, 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

const vendorFiles = [
  ['node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js', 'lightweight-charts.standalone.production.js'],
  ['node_modules/echarts/dist/echarts.min.js', 'echarts.min.js'],
  ['node_modules/lucide/dist/umd/lucide.min.js', 'lucide.min.js'],
];

for (const [srcRel, destName] of vendorFiles) {
  const src = path.resolve(srcRel);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required vendor asset: ${srcRel}`);
  }
  fs.copyFileSync(src, path.join(vendorDir, destName));
}

fs.cpSync(path.resolve('node_modules/@tanstack/table-core/dist'), path.join(vendorDir, 'tanstack-table-core'), { recursive: true });
fs.cpSync(path.resolve('node_modules/@tanstack/store/dist'), path.join(vendorDir, 'tanstack-store'), { recursive: true });

console.log(`Built ${staticFiles.length} static assets + vendor libraries into public/ for deployment.`);
