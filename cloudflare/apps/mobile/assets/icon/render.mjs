// The app's icons and splash, drawn as SVG and rendered to the PNGs app.json uses. The brand's
// tilted 4-2 domino, as in the web app's favicon (apps/web/public/favicon.svg), on walnut.
//
// Run from apps/mobile after changing the drawing:
//   node assets/icon/render.mjs
// It writes each SVG next to this file and renders it with Chromium through Playwright
// (`npx playwright install chromium` once, if it isn't installed).
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..');

// apps/mobile/src/components/theme.ts and Domino.tsx's PIP_COLORS.
const WALNUT = '#3a2a20';
const WALNUT_DEEP = '#241913';
const MAT = '#4b3627';
const BONE = '#f2eadb';
const BONE_EDGE = '#b8a78a';
const SHADOW = '#1a120d';
const FOURS = '#e0915a';
const TWOS = '#3f8f3a';

const SIZE = 1024;
const TILT = -12;

// A 2:1 domino `width` wide, centred, showing 4 | 2. `solid` draws it as one colour with the pips
// and divider cut out (for the monochrome and notification-style silhouettes).
function domino(width, { solid = null } = {}) {
  const h = width / 2;
  const x = (SIZE - width) / 2;
  const y = (SIZE - h) / 2;
  const r = width * 0.11;
  const pip = width * 0.045;
  const half = h; // each half is a square h x h
  const at = (col, row, right) => ({ cx: x + (right ? half : 0) + half * col, cy: y + h * row });
  const fours = [at(0.28, 0.28), at(0.72, 0.28), at(0.28, 0.72), at(0.72, 0.72)];
  const twos = [at(0.72, 0.28, true), at(0.28, 0.72, true)];
  const divider = { x: SIZE / 2 - width * 0.012, y: y + h * 0.12, w: width * 0.024, h: h * 0.76 };

  if (solid) {
    const holes = [...fours, ...twos].map((p) => `<circle cx="${p.cx}" cy="${p.cy}" r="${pip}" fill="black"/>`).join('');
    return `<defs><mask id="cut"><rect width="${SIZE}" height="${SIZE}" fill="white"/>
      <g transform="rotate(${TILT} ${SIZE / 2} ${SIZE / 2})">${holes}
      <rect x="${divider.x}" y="${divider.y}" width="${divider.w}" height="${divider.h}" rx="${divider.w / 2}" fill="black"/></g></mask></defs>
      <rect x="${x}" y="${y}" width="${width}" height="${h}" rx="${r}" fill="${solid}" mask="url(#cut)" transform="rotate(${TILT} ${SIZE / 2} ${SIZE / 2})"/>`;
  }

  const lift = width * 0.035;
  const pips = (points, fill) => points.map((p) => `<circle cx="${p.cx}" cy="${p.cy}" r="${pip}" fill="${fill}"/>`).join('');
  return `<g transform="rotate(${TILT} ${SIZE / 2} ${SIZE / 2})">
    <rect x="${x + lift * 0.4}" y="${y + lift * 1.6}" width="${width}" height="${h}" rx="${r}" fill="${SHADOW}" opacity="0.55"/>
    <rect x="${x}" y="${y + lift}" width="${width}" height="${h}" rx="${r}" fill="${BONE_EDGE}"/>
    <rect x="${x}" y="${y}" width="${width}" height="${h}" rx="${r}" fill="${BONE}"/>
    <rect x="${divider.x}" y="${divider.y}" width="${divider.w}" height="${divider.h}" rx="${divider.w / 2}" fill="${BONE_EDGE}"/>
    ${pips(fours, FOURS)}${pips(twos, TWOS)}
  </g>`;
}

const walnut = `<defs><radialGradient id="wood" cx="50%" cy="42%" r="75%">
  <stop offset="0%" stop-color="${MAT}"/><stop offset="60%" stop-color="${WALNUT}"/><stop offset="100%" stop-color="${WALNUT_DEEP}"/>
</radialGradient></defs><rect width="${SIZE}" height="${SIZE}" fill="url(#wood)"/>`;

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>\n`;

// Android's adaptive icon keeps only the middle 66% (a 683px circle at 1024) safe from the
// launcher's mask, so its domino is smaller than the full icon's.
const files = {
  // iOS, Android's pre-adaptive icon and the store listing: no transparency.
  icon: svg(walnut + domino(720)),
  'android-icon-foreground': svg(domino(520)),
  'android-icon-background': svg(walnut),
  'android-icon-monochrome': svg(domino(520, { solid: 'white' })),
  // Shown centred on the walnut splash background; transparent around the tile.
  'splash-icon': svg(domino(900)),
};

const require = createRequire(import.meta.url);
const { chromium } = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(here, `${name}.svg`), content);
  await page.setContent(`<html><body style="margin:0;background:transparent">${content}</body></html>`);
  const opaque = name === 'icon' || name === 'android-icon-background';
  await page.screenshot({ path: join(assets, `${name}.png`), omitBackground: !opaque });
  console.log(`assets/${name}.png`);
}
await browser.close();
