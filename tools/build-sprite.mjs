/**
 * build-sprite.mjs — regenerate public/icons/icons.svg from a lucide-static checkout.
 *
 * Run by hand when tools/icon-names.json changes; it is NOT part of `npm start`
 * and lucide-static is NOT a dependency. Vendoring the built sprite is what
 * keeps the app working with no network and no build step.
 *
 *   npm pack lucide-static@1.47.0 && tar xf lucide-static-1.47.0.tgz -C /tmp/lu
 *   node tools/build-sprite.mjs /tmp/lu/package
 *
 * Also copy that checkout's LICENSE verbatim to public/icons/LICENSE.lucide.txt
 * — it carries both the ISC notice and the MIT notice for the Feather-derived
 * icons, and the MIT notice's scope is defined by the icon list inside it.
 */
import fs from 'node:fs';
import path from 'node:path';

const pkg = process.argv[2] || '/tmp/lu/package';
const SRC = path.join(pkg, 'icons');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const NAMES = JSON.parse(fs.readFileSync(path.join(HERE, 'icon-names.json'), 'utf8'));

const missing = NAMES.filter((n) => !fs.existsSync(`${SRC}/${n}.svg`));
if (missing.length) {
  console.error('missing icons in', SRC, missing);
  process.exit(1);
}

const syms = NAMES.map((n) => {
  const raw = fs.readFileSync(`${SRC}/${n}.svg`, 'utf8');
  const body = raw.slice(raw.indexOf('>', raw.indexOf('<svg')) + 1).replace('</svg>', '').trim()
    .replace(/\s*\n\s*/g, '');
  // Presentation attributes live on .icon in CSS, so the symbol carries geometry only.
  return `<symbol id="i-${n}" viewBox="0 0 24 24">${body}</symbol>`;
}).join('');

const out = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${syms}</defs></svg>`;
const dest = path.join(HERE, '..', 'public', 'icons', 'icons.svg');
fs.writeFileSync(dest, out);
console.log(`icons: ${NAMES.length}  bytes: ${out.length}  ->  ${dest}`);
