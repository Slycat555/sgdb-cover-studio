'use strict';
/* Cover Studio — builds retail-style back covers and Steam library art
   from official Steam assets + SteamGridDB, themed with each game's own
   colours and typography. */

/* ================================================================ utils */
const $ = (s, r = document) => r.querySelector(s);
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = encodeURIComponent;
const normName = s => String(s || '').toLowerCase().replace(/[™®©:'’.\-–—!,]/g, '').replace(/\s+/g, ' ').trim();
const slug = s => String(s || 'cover').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cover';

function toast(msg, type = '') {
  const t = el('div', { class: 'toast ' + type, text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 7000 : 4500);
}

class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function api(path, opts) {
  const r = await fetch(path, opts);
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!r.ok || (j && j.success === false)) {
    throw new ApiError((j && j.errors && j.errors[0]) || `Request failed (${r.status})`, r.status);
  }
  return j;
}
async function sgdb(path) {
  try { return (await api('/api/sgdb/' + path)).data; }
  catch (e) { if (e.status === 401) openKeyDialog(); throw e; }
}

/* ---------------------------------------------------------------- color */
const hexToRgb = h => {
  h = String(h).replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
};
const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > .5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${clamp(a, 0, 1)})`; };
const mix = (a, b, t) => { const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(...A.map((v, i) => v + (B[i] - v) * t)); };
const lum = hex => {
  const [r, g, b] = hexToRgb(hex).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const readableOn = hex => lum(hex) > .38 ? '#111318' : '#ffffff';
const withL = (hex, l) => { const [h, s] = rgbToHsl(...hexToRgb(hex)); return hslToHex(h, s, l); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/* ============================================================ constants */
const TEMPLATES = {
  boxback: { label: 'Box back', steam: null },
  case: { label: 'Full case', steam: null },
  cover: { label: 'Steam cover', w: 600, h: 900, steam: 'cover' },
  wide: { label: 'Steam wide', w: 920, h: 430, steam: 'wide' },
  hero: { label: 'Steam hero', w: 1920, h: 620, steam: 'hero' },
};
// Standard case-insert sizes: back panel | spine | front panel, all in mm.
const CASE_SIZES = {
  pc: { name: 'PC DVD case', panel: 129.5, spine: 14, height: 183 },
  bluray: { name: 'Console / Blu-ray case', panel: 130.5, spine: 12, height: 150 },
  handheld: { name: 'Handheld (Switch-style) case', panel: 105, spine: 10, height: 170 },
};
const PX_PER_MM = 300 / 25.4;
const mmPx = mm => Math.round(mm * PX_PER_MM);
const fmtMm = n => String(+n.toFixed(1));
function caseDims() {
  const c = CASE_SIZES[state.fx.caseSize] || CASE_SIZES.pc;
  const spine = state.fx.spineMm || c.spine;
  return { ...c, spine, panelPx: mmPx(c.panel), spinePx: mmPx(spine), heightPx: mmPx(c.height), totalMm: c.panel * 2 + spine };
}
const caseLabel = k => { const c = CASE_SIZES[k]; return `${c.name} · ${fmtMm(c.panel * 2 + c.spine)}×${c.height} mm`; };

const FONT_LIBRARY = [
  // display faces: [family, heading weight, google spec]
  ['Bebas Neue', 400, 'Bebas+Neue'],
  ['Oswald', 700, 'Oswald:wght@500;700'],
  ['Cinzel', 700, 'Cinzel:wght@500;700;900'],
  ['Cinzel Decorative', 700, 'Cinzel+Decorative:wght@700'],
  ['IM Fell English SC', 400, 'IM+Fell+English+SC'],
  ['Orbitron', 800, 'Orbitron:wght@500;800'],
  ['Audiowide', 400, 'Audiowide'],
  ['Black Ops One', 400, 'Black+Ops+One'],
  ['Russo One', 400, 'Russo+One'],
  ['Teko', 600, 'Teko:wght@500;600'],
  ['Press Start 2P', 400, 'Press+Start+2P'],
  ['Silkscreen', 700, 'Silkscreen:wght@400;700'],
  ['Fredoka', 700, 'Fredoka:wght@500;700'],
  ['M PLUS Rounded 1c', 800, 'M+PLUS+Rounded+1c:wght@500;800'],
  ['Rye', 400, 'Rye'],
  ['Syne', 800, 'Syne:wght@500;800'],
  ['Playfair Display', 900, 'Playfair+Display:wght@700;900'],
  ['Creepster', 400, 'Creepster'],
  ['Metal Mania', 400, 'Metal+Mania'],
  ['Montserrat', 800, 'Montserrat:wght@500;800'],
  ['Special Elite', 400, 'Special+Elite'],
  ['Anton', 400, 'Anton'],
  ['Archivo Black', 400, 'Archivo+Black'],
  ['Abril Fatface', 400, 'Abril+Fatface'],
  ['Alfa Slab One', 400, 'Alfa+Slab+One'],
  ['Arvo', 700, 'Arvo:wght@400;700'],
  ['Michroma', 400, 'Michroma'],
  ['Marcellus', 400, 'Marcellus'],
  ['Bodoni Moda', 700, 'Bodoni+Moda:wght@400;700'],
  ['UnifrakturMaguntia', 400, 'UnifrakturMaguntia'],
  ['Righteous', 400, 'Righteous'],
  ['Bangers', 400, 'Bangers'],
  ['Permanent Marker', 400, 'Permanent+Marker'],
  ['Staatliches', 400, 'Staatliches'],
  ['Questrial', 400, 'Questrial'],
  ['Libre Franklin', 800, 'Libre+Franklin:wght@400;800'],
  ['Pirata One', 400, 'Pirata+One'],
  ['VT323', 400, 'VT323'],
].map(([family, weight, spec]) => ({ family, weight, bodyWeight: weight, bold: weight, spec, body: false }));
const BODY_LIBRARY = [
  ['Inter', 800, 400, 700, 'Inter:wght@400;600;700;800'],
  ['Barlow', 700, 400, 600, 'Barlow:wght@400;600;700'],
  ['Crimson Pro', 700, 400, 600, 'Crimson+Pro:wght@400;600;700'],
  ['Exo 2', 700, 400, 600, 'Exo+2:wght@400;600;700'],
  ['Nunito', 700, 400, 700, 'Nunito:wght@400;700'],
  ['Space Grotesk', 700, 400, 600, 'Space+Grotesk:wght@400;600;700'],
  ['Rajdhani', 700, 500, 700, 'Rajdhani:wght@500;700'],
  ['Tinos', 700, 400, 700, 'Tinos:wght@400;700'],
  ['Libre Baskerville', 700, 400, 700, 'Libre+Baskerville:wght@400;700'],
  ['EB Garamond', 700, 400, 600, 'EB+Garamond:wght@400;600;700'],
  ['Libre Caslon Text', 700, 400, 700, 'Libre+Caslon+Text:wght@400;700'],
  ['Courier Prime', 700, 400, 700, 'Courier+Prime:wght@400;700'],
  ['Jost', 700, 400, 600, 'Jost:wght@400;600;700'],
  ['Arimo', 700, 400, 700, 'Arimo:wght@400;700'],
].map(([family, weight, bodyWeight, bold, spec]) => ({ family, weight, bodyWeight, bold, spec, body: true }));

// Typography families matched from a game's Steam tags (earlier tags weigh more).
const FONT_STYLES = [
  { label: 'Retro / pixel', head: 'Press Start 2P', body: 'Space Grotesk', tags: ['Pixel Graphics', 'Retro', '8-bit Music', 'Old School', 'Arcade', '2D Platformer', 'Metroidvania', 'Bullet Hell', 'Shoot \'Em Up'] },
  { label: 'Horror', head: 'IM Fell English SC', body: 'Crimson Pro', tags: ['Horror', 'Psychological Horror', 'Survival Horror', 'Lovecraftian', 'Gore', 'Dark', 'Creepy', 'Thriller', 'Blood'] },
  { label: 'Fantasy', head: 'Cinzel', body: 'Crimson Pro', tags: ['Fantasy', 'Dark Fantasy', 'Medieval', 'Magic', 'Souls-like', 'RPG', 'Action RPG', 'Mythology', 'Dragons', 'Swordplay', 'JRPG', 'Historical', 'CRPG', 'Party-Based RPG'] },
  { label: 'Sci-fi', head: 'Orbitron', body: 'Exo 2', tags: ['Sci-fi', 'Space', 'Cyberpunk', 'Futuristic', 'Robots', 'Mechs', 'Aliens', 'Space Sim', 'Hacking', 'Dystopian', 'Transhumanism'] },
  { label: 'Military', head: 'Black Ops One', body: 'Barlow', tags: ['Military', 'War', 'Tactical', 'Realistic', 'World War II', 'Cold War', 'Shooter', 'FPS', 'Wargame', 'Tactical Shooter'] },
  { label: 'Racing / sports', head: 'Russo One', body: 'Barlow', tags: ['Racing', 'Sports', 'Driving', 'Automobile Sim', 'Football (Soccer)', 'Basketball', 'Arcade Racing', 'Motorbike', 'Skateboarding'] },
  { label: 'Cozy / cute', head: 'Fredoka', body: 'Nunito', tags: ['Cute', 'Family Friendly', 'Colorful', 'Casual', 'Cozy', 'Farming Sim', 'Wholesome', 'Cartoony', 'Relaxing', 'Life Sim', 'Hand-drawn', 'Cartoon'] },
  { label: 'Anime', head: 'M PLUS Rounded 1c', body: 'Nunito', tags: ['Anime', 'Visual Novel', 'Dating Sim'] },
  { label: 'Western', head: 'Rye', body: 'Crimson Pro', tags: ['Western'] },
  { label: 'Survival', head: 'Bebas Neue', body: 'Barlow', tags: ['Post-apocalyptic', 'Survival', 'Zombies', 'Open World Survival Craft', 'Crafting', 'Sandbox', 'Base Building'] },
  { label: 'Surreal / art', head: 'Syne', body: 'Space Grotesk', tags: ['Surreal', 'Psychedelic', 'Abstract', 'Experimental', 'Artistic', 'Walking Simulator', 'Minimalist'] },
  { label: 'Action', head: 'Oswald', body: 'Barlow', tags: ['Action', 'Hack and Slash', 'Beat \'em up', 'Fighting', 'Violent', 'Character Action Game'] },
  { label: 'Mystery / noir', head: 'Playfair Display', body: 'Crimson Pro', tags: ['Mystery', 'Detective', 'Noir', 'Story Rich', 'Investigation', 'Choices Matter'] },
];
const DEFAULT_STYLE = { label: 'General', head: 'Bebas Neue', body: 'Inter', tags: [] };

const LAYOUT_DEFAULTS = {
  boxback: { bgZoom: 1, bgX: 0, bgY: 0, showLogo: false, textLogo: false, logoScale: .62, logoX: .5, logoY: .72, logoMaxH: .12 },
  cover: { bgZoom: 1, bgX: 0, bgY: 0, showLogo: true, textLogo: false, logoScale: .8, logoX: .5, logoY: .8, logoMaxH: .26 },
  wide: { bgZoom: 1, bgX: 0, bgY: 0, showLogo: true, textLogo: false, logoScale: .52, logoX: .5, logoY: .5, logoMaxH: .62 },
  hero: { bgZoom: 1, bgX: 0, bgY: 0, showLogo: false, textLogo: false, logoScale: .34, logoX: .26, logoY: .5, logoMaxH: .55 },
  // Full case: pan/zoom apply to the front art (which wraps onto the spine); logo sits on the front panel.
  case: { bgZoom: 1, bgX: 0, bgY: 0, frontCx: .5, frontCy: .5, showLogo: false, textLogo: false, logoScale: .8, logoX: .5, logoY: .8, logoMaxH: .22 },
};
const BOX_LOGO = {
  retail: { logoScale: .62, logoX: .5, logoY: .72, logoMaxH: .12 },  // logoY is relative to the key-art box
  cinematic: { logoScale: .72, logoX: .5, logoY: .12, logoMaxH: .15 },
};
const FX_DEFAULTS = {
  caseSize: 'pc', boxStyle: 'retail',
  autoTheme: true, glassBack: false, themeBg: '#0f121a', themeBand: '#2a3346', accent: '#e9c46a', textColor: '#e9ecf2', lightMode: false,
  autoFonts: true, headFamily: 'Bebas Neue', headWeight: 400, bodyFamily: 'Inter', bodyWeight: 400, bodyBold: 700, headUpper: true,
  showBand: false, showShots: true, shotBorder: true, showFeatures: false, showReqs: true, showRating: true, showBarcode: true, codeKind: 'qr', showLegal: true,
  footerLogo: true, showBadges: true, badgeSingle: false, badgeOnline: false, badgeCoop: false, badgeLocal: false, badgeController: false,
  descAlign: 'justify',
  blur: 0, brightness: 100, saturate: 105, contrast: 104, fade: .8,
  vignette: .3, tintColor: '#000000', tintStrength: 0, tintBlend: 'soft-light', grain: .05, scanlines: 0,
  logoShadow: .6, glowStrength: 0, glowColor: '#ffffff', border: 0, borderColor: '#ffffff',
  spineMm: 14, wrapBand: true, spineContent: 'logo', spineLogoSize: 1, spineLogoPos: .5, spineOutline: 'auto', pcBadge: true, frontRating: true,
  upscaleMode: 'auto', upscaleModel: '',   // auto | auto2 | auto4 | off
  bleed: true, cropMarks: true, pageSize: 'fit', showGuides: true,
};
const TEXT_DEFAULTS = { qrLink: '', title: '', headline: '', description: '', features: '', requirements: '', legal: '', platform: 'PC', players: '', rating: '' };
const SLOTS = [['auto', 'Auto'], ['front', 'Front'], ['bg', 'Key art'], ['logo', 'Logo'], ['shot1', 'Shot 1'], ['shot2', 'Shot 2'], ['shot3', 'Shot 3']];
const KIND_LABEL = { hero: 'Hero', logo: 'Logo', cover: 'Cover', header: 'Header', background: 'Store bg', art: 'Art', screenshot: 'Screenshot', grid: 'Grid', upload: 'Upload' };
// Icon badges for how the game is played, shown on the back cover.
const BADGES = [
  { fx: 'badgeSingle', label: 'Single-player', icon: 'person' },
  { fx: 'badgeOnline', label: 'Online multiplayer', icon: 'globe' },
  { fx: 'badgeCoop', label: 'Co-op', icon: 'people' },
  { fx: 'badgeLocal', label: 'Split screen', icon: 'screen' },
  { fx: 'badgeController', label: 'Controller support', icon: 'pad' },
];

/* ================================================================ state */
const clone = o => JSON.parse(JSON.stringify(o));
const state = {
  tpl: 'boxback',
  hasKey: false,
  library: null,
  game: null,
  store: null,
  tags: [],
  assets: { official: [], heroes: [], logos: [], grids: [] },
  more: {}, pages: {},
  tab: 'official',
  slot: 'auto',
  shotCursor: 0,
  images: { front: null, bg: null, logo: null, shot1: null, shot2: null, shot3: null },
  layouts: clone(LAYOUT_DEFAULTS),
  fx: { ...FX_DEFAULTS },
  text: { ...TEXT_DEFAULTS },
  swatches: [],
  fontDetect: null,
  fontStyle: DEFAULT_STYLE,
  fontReason: '',
  controllerLevel: null,
  hit: {},
  loadToken: 0,
  pending: 0,
  loadingAssets: false,
};

/* ================================================================ fonts */
const FONT_REG = new Map([...FONT_LIBRARY, ...BODY_LIBRARY].map(f => [f.family, { ...f, source: 'library' }]));
const fontsLoaded = new Set(), fontsPending = new Set();

function loadGoogleFonts() {
  // One stylesheet per family, so a single unavailable family can't break the rest.
  for (const f of [...FONT_LIBRARY, ...BODY_LIBRARY]) {
    document.head.append(el('link', { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${f.spec}&display=swap` }));
  }
}
function ensureFont(family, weight) {
  const key = `${weight} ${family}`;
  if (fontsLoaded.has(key) || fontsPending.has(key)) return;
  fontsPending.add(key);
  document.fonts.load(`${weight} 40px "${family}"`).catch(() => {}).finally(() => {
    fontsPending.delete(key); fontsLoaded.add(key); scheduleRender();
  });
}
const fontCss = (weight, size, family) => `${weight} ${Math.max(1, size).toFixed(1)}px "${family}", "Inter", sans-serif`;
function setSpacing(ctx, px) { if ('letterSpacing' in ctx) ctx.letterSpacing = `${px.toFixed(2)}px`; }
const fontReady = (family, weight) => [...document.fonts].some(ff => ff.family.replace(/["']/g, '') === family && ff.status === 'loaded')
  && document.fonts.check(`${weight} 40px "${family}"`);

function setFont(which, family) {
  const f = FONT_REG.get(family) || { weight: 400, bodyWeight: 400, bold: 700 };
  if (which === 'head') { state.fx.headFamily = family; state.fx.headWeight = f.weight; }
  else { state.fx.bodyFamily = family; state.fx.bodyWeight = f.bodyWeight; state.fx.bodyBold = f.bold; }
}

function matchStyle(tags) {
  const scores = new Map();
  tags.forEach((t, i) => {
    const w = Math.max(1, 20 - i), tag = t.trim().toLowerCase();
    for (const s of FONT_STYLES) {
      if (s.tags.some(x => x.toLowerCase() === tag)) scores.set(s, (scores.get(s) || 0) + w);
    }
  });
  let best = DEFAULT_STYLE, bs = 0;
  for (const [s, v] of scores) if (v > bs) { bs = v; best = s; }
  return best;
}

/* ---- resolving font names ------------------------------------------ */
// "FF Trixie HD", "TrixieHD-Plain" and "Trixie" all normalise to "trixie".
const normFont = s => String(s || '').toLowerCase()
  .replace(/\(game\)|\(yours\)/g, '')
  .replace(/\b(ff|itc|lt|mt|ot|std|pro|hd|com|regular|plain|text|book|roman|normal|bold|light|medium|black|heavy|italic|oblique|demi|semi|extra|ultra)\b/g, ' ')
  .replace(/(regular|plain|bold|italic)$/g, '')
  .replace(/[^a-z0-9]/g, '');

// Commercial fonts games often use → the closest free Google Font.
const LOOKALIKES = [
  [/trixie/i, 'Special Elite'],
  [/american typewriter|typewriter|remington/i, 'Special Elite'],
  [/trajan/i, 'Cinzel'],
  [/optima/i, 'Marcellus'],
  [/futura/i, 'Jost'],
  [/eurostile|microgramma/i, 'Michroma'],
  [/helvetica|arial/i, 'Arimo'],
  [/times/i, 'Tinos'],
  [/courier/i, 'Courier Prime'],
  [/\bd-?din\b|\bdin\b/i, 'Barlow'],
  [/impact/i, 'Anton'],
  [/gotham|proxima/i, 'Montserrat'],
  [/avant ?garde/i, 'Questrial'],
  [/garamond/i, 'EB Garamond'],
  [/baskerville/i, 'Libre Baskerville'],
  [/caslon/i, 'Libre Caslon Text'],
  [/bodoni/i, 'Bodoni Moda'],
  [/franklin gothic/i, 'Libre Franklin'],
  [/rockwell/i, 'Arvo'],
  [/old english|blackletter|fraktur/i, 'UnifrakturMaguntia'],
];

const googleCache = new Map();
function googleFamily(name) {
  if (!googleCache.has(name)) {
    googleCache.set(name, (async () => {
      const base = 'https://fonts.googleapis.com/css2?family=' + enc(name).replace(/%20/g, '+');
      const tryLink = href => new Promise(res => {
        const link = el('link', { rel: 'stylesheet', href });
        link.onload = () => res(true);
        link.onerror = () => { link.remove(); res(false); };
        document.head.append(link);
      });
      let weight = 700;
      if (!await tryLink(base + ':wght@400;700&display=swap')) {
        weight = 400;
        if (!await tryLink(base + '&display=swap')) return 0;
      }
      await document.fonts.load(`${weight} 40px "${name}"`).catch(() => {});
      return fontReady(name, weight) ? weight : 0;
    })());
  }
  return googleCache.get(name);
}

// Resolve a font *name* (from the game's files, the known-fonts list, a saved
// choice or typed by you) to something drawable: {family, exact}.
async function resolveFontName(name) {
  const n = normFont(name);
  if (!n) return null;
  for (const f of FONT_REG.values()) {
    const names = [f.family, f.label, ...(f.names || [])].map(normFont);
    if (names.includes(n) || (f.source !== 'library' && n.length >= 4 && names.some(x => x.length >= 4 && (x.includes(n) || n.includes(x))))) {
      return { family: f.family, exact: true };
    }
  }
  const clean = name.replace(/^(FF|ITC|LT)\s+/i, '').replace(/\s+(Std|Pro|HD|MT|LT|OT)\b.*$/i, '').trim();
  const alike = LOOKALIKES.find(([re]) => re.test(name));
  if (!alike) {
    for (const cand of new Set([name.trim(), clean])) {
      const w = await googleFamily(cand);
      if (w) {
        FONT_REG.set(cand, { family: cand, weight: w, bodyWeight: 400, bold: w, source: 'google', label: cand });
        return { family: cand, exact: true };
      }
    }
    return null;
  }
  const fam = alike[1];
  if (!FONT_REG.has(fam)) {
    const w = await googleFamily(fam);
    if (!w) return null;
    FONT_REG.set(fam, { family: fam, weight: w, bodyWeight: 400, bold: w, source: 'google', label: fam });
  }
  return { family: fam, exact: false };
}

/* ---- fonts from the game's files and your uploads -------------------- */
// Some games ship fonts with letters drawn mirrored and flip them at render
// time (or use them for effects). Compare each asymmetric character's ink
// balance with a normal font; a character group that consistently leans the
// other way is mirrored. Groups are checked separately because some fonts
// mirror only their capitals.
const MIRROR_TESTS = { upper: 'LEFCKPRBDJGN', lower: 'cekrpbdhfjgn', digit: '2345679' };
function inkBalance(ch, family) {
  const c = el('canvas'); c.width = c.height = 160;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.font = `100px "${family}"`; x.fillStyle = '#000'; x.textBaseline = 'alphabetic';
  x.fillText(ch, 30, 120);
  const ink = cropInk(c);
  if (!ink || ink.w < 8) return null;
  const d = x.getImageData(ink.x, ink.y, ink.w, ink.h).data;
  let left = 1, right = 1;
  for (let yy = 0; yy < ink.h; yy++) for (let xx = 0; xx < ink.w; xx++) {
    const a = d[(yy * ink.w + xx) * 4 + 3];
    if (xx < ink.w / 2) left += a; else right += a;
  }
  return Math.log(right / left);   // < 0: heavier on the left
}
function mirroredGroups(family) {
  const out = [];
  for (const [group, chars] of Object.entries(MIRROR_TESTS)) {
    let agree = 0, disagree = 0;
    for (const ch of chars) {
      const ref = inkBalance(ch, 'Inter'), got = inkBalance(ch, family);
      if (ref == null || got == null || Math.abs(ref) < .1 || Math.abs(got) < .05) continue;
      if (Math.sign(ref) === Math.sign(got)) agree++; else disagree++;
    }
    if (disagree >= 3 && disagree > agree * 2) out.push(group);
  }
  return out;
}

let opentypeLib = null;
function loadOpentype() {
  return opentypeLib ||= new Promise((res, rej) => {
    const sc = el('script', { src: 'https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js' });
    sc.onload = () => res(window.opentype);
    sc.onerror = () => { opentypeLib = null; rej(new Error('Could not load opentype.js')); };
    document.head.append(sc);
  });
}
// Rebuild a font with the glyphs of the given groups mirrored back (x → advance − x).
async function unmirrorFont(url, groups) {
  const ot = await loadOpentype();
  const font = ot.parse(await (await fetch(url)).arrayBuffer());
  const test = { upper: /\p{Lu}/u, lower: /\p{Ll}/u, digit: /\p{Nd}/u };
  const inGroup = cp => groups.some(gr => test[gr].test(String.fromCodePoint(cp)));
  for (let i = 0; i < font.glyphs.length; i++) {
    const g = font.glyphs.get(i);
    const cps = g.unicodes?.length ? g.unicodes : g.unicode != null ? [g.unicode] : [];
    if (!cps.some(inGroup)) continue;
    const w = g.advanceWidth || 0, path = g.path;
    for (const cmd of path.commands) {
      if ('x' in cmd) cmd.x = w - cmd.x;
      if ('x1' in cmd) cmd.x1 = w - cmd.x1;
      if ('x2' in cmd) cmd.x2 = w - cmd.x2;
    }
    g.path = path;
  }
  return font.toArrayBuffer();
}

// ?fix= changes whenever the server's font repairs do, so browsers drop copies cached before them.
const fontUrl = token => `/api/fontfile/${token}?fix=1`;

async function registerGameFonts(list) {
  // Skip huge CJK families (several MB each); they're never the stylised font.
  const usable = (list || []).filter(f => !f.size || f.size < 6e6).slice(0, 30);
  const faces = await Promise.all(usable.map(async f => {
    const family = `${f.family} (game)`;
    try {
      if (!FONT_REG.has(family)) {
        const url = fontUrl(f.token);
        let face = await new FontFace(family, `url(${url})`).load();
        document.fonts.add(face);
        let fixed = false;
        const groups = mirroredGroups(family);
        if (groups.length) {
          try {
            const flipped = await new FontFace(family, await unmirrorFont(url, groups)).load();
            document.fonts.delete(face);
            document.fonts.add(face = flipped);
            fixed = true;
          } catch { return null; }   // can't fix it — don't offer a backwards font
        }
        FONT_REG.set(family, { family, weight: 400, bodyWeight: 400, bold: 700, source: 'game', label: f.family, names: [f.family, f.full], generic: f.generic, origin: f.path, unmirrored: fixed });
      }
      return FONT_REG.get(family);
    } catch { return null; }
  }));
  const seen = new Set();
  return faces.filter(f => f && !seen.has(f.family) && seen.add(f.family));
}

async function registerUserFont(entry) {
  let family = entry.family || entry.name;
  if (FONT_REG.has(family) && FONT_REG.get(family).source !== 'custom') family += ' (yours)';
  if (!FONT_REG.has(family)) {
    const face = await new FontFace(family, `url(${fontUrl(entry.token)})`).load();
    document.fonts.add(face);
    FONT_REG.set(family, { family, weight: 400, bodyWeight: 400, bold: 700, source: 'custom', label: entry.family || entry.name, names: [entry.family, entry.name] });
  }
  return family;
}

async function loadUserFonts() {
  try {
    const r = await api('/api/userfonts');
    await Promise.all((r.fonts || []).map(f => registerUserFont(f).catch(() => null)));
  } catch { /* none yet */ }
}

const fileToBase64 = file => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.onerror = rej;
  fr.readAsDataURL(file);
});

async function uploadFont(file) {
  try {
    const entry = await api('/api/userfont', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, data: await fileToBase64(file) }) });
    // The browser reports a font it refuses to load as a "network error"; say what actually happened.
    const family = await registerUserFont(entry).catch(() => { throw new Error(`Saved ${file.name}, but the browser couldn't load it — the font file may be damaged.`); });
    // If this is the font the game is known to use, use it everywhere the lookalike was.
    const D = state.fontDetect;
    if (D?.knownRaw && (await resolveFontName(D.knownRaw.head))?.family === family) {
      D.known = await resolveKnown(D.knownRaw);
      state.fx.autoFonts = true;
      applyAutoFonts();
    } else chooseFont('head', family);
    toast(`Added ${entry.family || file.name} — it's saved for next time.`, 'ok');
  } catch (e) {
    toast(e.message || 'That font file could not be read.', 'error');
  }
}

async function useFontName(name) {
  name = name.trim();
  if (!name) return;
  const r = await resolveFontName(name);
  if (!r) return toast(`Couldn't find “${name}”. If it's a commercial font, upload the font file.`, 'error');
  chooseFont('head', r.family);
  if (r.exact) toast(`Using ${name} for headings.`, 'ok');
  else toast(`${name} is a commercial font, so it's using the closest free match, ${r.family}. Upload the real font file to use it exactly.`, 'ok');
}

/* ---- remembering choices per game ----------------------------------- */
function gameKey(g) {
  if (g.shortcut && g.targetId) return `shortcut:${g.targetId}`;
  if (g.storeAppId) return `steam:${g.storeAppId}`;
  if (g.sgdbId) return `sgdb:${g.sgdbId}`;
  return 'name:' + g.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
}
function saveFontChoice(choice) {
  const g = state.game;
  if (!g) return;
  api('/api/gamefonts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: gameKey(g), name: g.name, choice }) }).catch(() => {});
}
function chooseFont(which, family) {
  setFont(which, family);
  const F = state.fx, label = fam => FONT_REG.get(fam)?.label || fam;
  F.autoFonts = false;
  state.fontReason = 'Your pick — it’s remembered for this game.';
  saveFontChoice({ head: { family: F.headFamily, name: label(F.headFamily) }, body: { family: F.bodyFamily, name: label(F.bodyFamily) } });
  syncControls(); scheduleRender();
}
async function resolveKnown(k) {
  const head = k.head ? await resolveFontName(k.head) : null;
  const body = k.body ? (k.body === k.head ? head : await resolveFontName(k.body)) : null;
  return head ? { name: k.head, head, body } : null;
}
async function resolveSaved(s) {
  const one = async c => c && (FONT_REG.has(c.family) ? c.family : (await resolveFontName(c.name || c.family))?.family);
  const head = await one(s.head), body = await one(s.body);
  return head ? { head, body } : null;
}

/* ---- matching the logo's lettering --------------------------------- */
// Render the game's name in each candidate font and compare its shape with
// the logo — finds the closest font when the game's own files aren't available.
const LOGO_MATCH_MIN = .6;
function cropInk(c) {
  const x = c.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = c, d = x.getImageData(0, 0, w, h).data;
  let top = h, left = w, right = -1, bottom = -1;
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    if (d[(y * w + xx) * 4 + 3] > 100) { if (xx < left) left = xx; if (xx > right) right = xx; if (y < top) top = y; bottom = y; }
  }
  return right < 0 ? null : { canvas: c, x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}
function logoInk(img) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const k = Math.min(1, 520 / iw, 220 / ih);
  const w = Math.max(4, Math.round(iw * k)), h = Math.max(4, Math.round(ih * k));
  const c = el('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, w, h);
  let id;
  try { id = x.getImageData(0, 0, w, h); } catch { return null; }
  const d = id.data;
  let clear = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 128) clear++;
  const useAlpha = clear > w * h * .05, bg = [d[0], d[1], d[2]];
  for (let i = 0; i < d.length; i += 4) {
    const ink = useAlpha ? d[i + 3] : (dist([d[i], d[i + 1], d[i + 2]], bg) > 90 ? 255 : 0);
    d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = ink;
  }
  x.putImageData(id, 0, 0);
  return cropInk(c);
}
function textInk(lines, family, weight) {
  const size = 72, pad = 12;
  const c = el('canvas'), x = c.getContext('2d', { willReadFrequently: true });
  x.font = fontCss(weight, size, family);
  c.width = Math.ceil(Math.max(...lines.map(l => x.measureText(l).width))) + pad * 2;
  c.height = Math.ceil(lines.length * size * 1.25) + pad * 2;
  x.font = fontCss(weight, size, family);
  x.fillStyle = '#000'; x.textBaseline = 'top'; x.textAlign = 'center';
  lines.forEach((l, i) => x.fillText(l, c.width / 2, pad + i * size * 1.15));
  return cropInk(c);
}
function inkGrid(ink, gw, gh) {
  const g = el('canvas'); g.width = gw; g.height = gh;
  const x = g.getContext('2d', { willReadFrequently: true });
  x.drawImage(ink.canvas, ink.x, ink.y, ink.w, ink.h, 0, 0, gw, gh);
  const d = x.getImageData(0, 0, gw, gh).data, out = new Float32Array(gw * gh);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] / 255;
  return out;
}
function inkSimilarity(a, b, cache) {
  const ra = a.w / a.h, rb = b.w / b.h;
  const aspect = Math.pow(Math.min(ra, rb) / Math.max(ra, rb), .7);
  let s = 0;
  for (const [gh, wt] of [[10, .4], [26, .6]]) {
    const gw = clamp(Math.round(gh * ra), 4, 260), key = `${gw}x${gh}`;
    const ga = cache[key] || (cache[key] = inkGrid(a, gw, gh)), gb = inkGrid(b, gw, gh);
    let mn = 0, mx = 0;
    for (let i = 0; i < ga.length; i++) { mn += Math.min(ga[i], gb[i]); mx += Math.max(ga[i], gb[i]); }
    s += wt * (mx ? mn / mx : 0);
  }
  return s * aspect;
}
// Returns family → similarity (0–1) between the logo and the game's name set in that font.
function logoScorer() {
  const img = state.images.logo?.img;
  const name = (state.store?.name || state.game?.name || '').replace(/[™®©]/g, '').trim();
  if (!img || !name) return null;
  const target = logoInk(img);
  if (!target || target.w < 8 || target.h < 4) return null;
  const layouts = t => {
    const out = [[t]], w = t.split(/\s+/);
    let best = null;
    for (let i = 1; i < w.length; i++) {
      const a = w.slice(0, i).join(' '), b = w.slice(i).join(' '), d = Math.abs(a.length - b.length);
      if (!best || d < best.d) best = { d, l: [a, b] };
    }
    if (best) out.push(best.l);
    return out;
  };
  const cache = {};
  return (family, weight) => {
    let best = 0;
    for (const t of new Set([name, name.toUpperCase()])) {
      for (const lines of layouts(t)) {
        const ink = textInk(lines, family, weight);
        if (ink) best = Math.max(best, inkSimilarity(target, ink, cache));
      }
    }
    return best;
  };
}
async function matchLogoFonts() {
  const score = logoScorer();
  if (!score) return [];
  const pool = [...FONT_REG.values()].filter(f => f.source === 'library');
  await Promise.all(pool.map(f => document.fonts.load(`${f.weight} 72px "${f.family}"`).catch(() => {})));
  return pool.filter(f => fontReady(f.family, f.weight))
    .map(f => ({ family: f.family, score: score(f.family, f.weight) }))
    .sort((a, b) => b.score - a.score).slice(0, 6);
}
const rematchLogo = debounce(async () => {
  const D = state.fontDetect;
  if (!D) return;
  D.logo = await matchLogoFonts();
  if (state.fontDetect === D) applyAutoFonts();
}, 300);

/* ---- choosing fonts for a game --------------------------------------- */
// Priority: your saved pick › known font for this game › fonts inside the
// game's files › closest match to the logo lettering › Steam-tag typography.
function applyAutoFonts() {
  const D = state.fontDetect;
  if (!D) return;
  if (!state.fx.autoFonts) { syncControls(); return; }
  const style = D.style, top = D.logo[0];
  let head, body, reason;
  if (D.saved?.head) {
    head = D.saved.head; body = D.saved.body || style.body;
    reason = 'Using the fonts you picked for this game last time.';
  } else if (D.known?.head) {
    head = D.known.head.family; body = D.known.body?.family || style.body;
    reason = D.known.head.exact ? `Using ${D.known.name}, the font this game uses.`
      : `This game uses ${D.known.name}, a commercial font — showing the closest free match, ${head}. Upload the real font file to use it exactly.`;
  } else if (D.gameFiles.length) {
    // Heading: the game font closest to its logo lettering (else the first distinctive one).
    const ranked = [...D.gameFiles].sort((a, b) => (b.logoScore || 0) - (a.logoScore || 0));
    const pick = (ranked[0]?.logoScore > .3 ? ranked[0] : null) || D.gameFiles.find(f => !f.generic) || D.gameFiles[0];
    const bodyPick = D.gameFiles.find(f => f !== pick && f.generic)
      || D.gameFiles.find(f => f !== pick && /regular|text|book|body/i.test((f.names || []).join(' ')));
    head = pick.family; body = bodyPick ? bodyPick.family : style.body;
    reason = `Using ${pick.label}, extracted from the game’s own files${pick.unmirrored ? ' (its letters were stored mirrored, so they’ve been flipped back)' : ''}${bodyPick ? `; body text: ${bodyPick.label}` : ''}.`;
  } else if (top && top.score >= LOGO_MATCH_MIN) {
    head = top.family; body = style.body;
    reason = `${head} is the closest match to the lettering in the game’s logo (${Math.round(top.score * 100)}% similar).`;
  } else {
    head = style.head; body = style.body;
    reason = D.scanning ? 'Looking inside the game’s files for its fonts…'
      : `${D.installed ? 'No distinctive font found in the game’s files' : 'The game isn’t installed, so its files can’t be read'} — using “${style.label}” typography from its Steam tags.`;
  }
  setFont('head', head); setFont('body', body);
  state.fontReason = reason;
  syncControls(); scheduleRender();
}

async function detectFonts(token) {
  const g = state.game;
  const alive = () => token === state.loadToken;
  const D = state.fontDetect = {
    style: matchStyle(state.tags.length ? state.tags : (state.store?.genres || [])),
    gameFiles: [], saved: null, known: null, knownRaw: null, logo: [], installed: false, scanning: true,
  };
  state.fontStyle = D.style;
  applyAutoFonts();
  const info = await api(`/api/gamefonts?key=${enc(gameKey(g))}&name=${enc(g.name)}`).catch(() => ({}));
  if (!alive()) return;
  D.knownRaw = info.known || null;
  const resolveChoices = async () => {
    if (info.known) D.known = await resolveKnown(info.known);
    if (info.saved) D.saved = await resolveSaved(info.saved);
  };
  await resolveChoices();
  if (!alive()) return;
  applyAutoFonts();

  const fq = g.shortcut ? `shortcut=${g.targetId}&user=${g.userId}` : g.storeAppId ? `appid=${g.storeAppId}` : null;
  const scan = fq ? api('/api/fonts?' + fq).then(async r => {
    D.installed = !!r.installDir;
    D.gameFiles = await registerGameFonts(r.fonts);
    const score = logoScorer();
    if (score) for (const f of D.gameFiles) f.logoScore = score(f.family, 400);
  }).catch(() => {}) : Promise.resolve();
  D.logo = await matchLogoFonts();
  if (!alive()) return;
  applyAutoFonts();
  await scan;
  if (!alive()) return;
  D.scanning = false;
  await resolveChoices();   // the game's own files may hold the exact font now
  if (alive()) applyAutoFonts();
}

/* =============================================================== images */
const imgCache = new Map();
const proxied = url => (url.startsWith('/') || url.startsWith('blob:')) ? url : '/api/img?u=' + enc(url);
function loadImage(url) {
  if (!imgCache.has(url)) {
    imgCache.set(url, new Promise((res, rej) => {
      const img = new Image(), src = proxied(url);
      let retried = false;
      img.onload = () => res(img);
      img.onerror = () => {
        // Retry once past the browser's cache, which may still hold a broken copy from earlier.
        if (!retried && !src.startsWith('blob:')) { retried = true; img.src = src + (src.includes('?') ? '&' : '?') + 'retry=' + Date.now(); return; }
        imgCache.delete(url); rej(new Error('image failed'));
      };
      img.src = src;
    }));
  }
  return imgCache.get(url);
}

// Crop fully transparent borders (official Steam logos carry a lot of padding).
function trimTransparent(img) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const c = el('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  let d;
  try { d = x.getImageData(0, 0, w, h).data; } catch { return img; }
  let top = h, left = w, right = -1, bottom = -1;
  for (let y = 0; y < h; y++) {
    for (let i = y * w * 4 + 3, xx = 0; xx < w; xx++, i += 4) {
      if (d[i] > 8) { if (xx < left) left = xx; if (xx > right) right = xx; if (y < top) top = y; bottom = y; }
    }
  }
  if (right < 0 || (left === 0 && top === 0 && right === w - 1 && bottom === h - 1)) return img;
  const pad = 2, cw = right - left + 1 + pad * 2, ch = bottom - top + 1 + pad * 2;
  const out = el('canvas'); out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(c, left - pad, top - pad, cw, ch, 0, 0, cw, ch);
  return out;
}

/* ---- automatic Upscayl: sharpen art that would print below its native resolution ---- */
// How much an image gets enlarged at 300 dpi in the layouts it's used in (1 = native size).
function neededScale(slot, img) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, d = caseDims();
  const cover = (rw, rh) => Math.max(rw / iw, rh / ih);
  if (slot === 'front') return cover(d.panelPx, d.heightPx) * (state.layouts.case.bgZoom || 1);
  if (slot === 'bg') return Math.max(cover(d.panelPx, retailArtH(d.panelPx, d.heightPx)),
    state.fx.boxStyle === 'cinematic' ? cover(d.panelPx, d.heightPx) : 0, cover(1920, 620));
  if (slot === 'logo') return d.panelPx * .8 / iw;   // logos can span most of a panel
  return 0;                                          // screenshots print small
}
let upscaleQueue = Promise.resolve();
const upscaleDone = new Map();   // asset url + settings → upscaled image
function autoUpscale(slot, entry) {
  const info = state.upscaylInfo, F = state.fx;
  if (!info?.available || F.upscaleMode === 'off' || !entry?.img || entry.upscaled) return;
  const need = neededScale(slot, entry.img);
  if (need <= 1.1) return;
  const scale = need > 2 ? 4 : 2, key = `${entry.asset.url}|${slot}|${scale}|${F.upscaleModel}`;
  const job = async () => {
    if (state.images[slot] !== entry) return;
    let up = upscaleDone.get(key);
    if (!up) {
      $('#loadingText').textContent = `Sharpening the ${slot === 'bg' ? 'key art' : slot} with Upscayl (${scale}×)…`;
      setBusy(+1);
      try {
        const src = entry.img, c = el('canvas');
        c.width = src.naturalWidth || src.width; c.height = src.naturalHeight || src.height;
        c.getContext('2d').drawImage(src, 0, 0);
        const r = await api('/api/upscale-art', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: c.toDataURL('image/png').split(',')[1], model: F.upscaleModel, scale }) });
        up = await loadImage(r.url);
        upscaleDone.set(key, up);
      } catch { return; } finally {
        setBusy(-1);
        $('#loadingText').textContent = 'Loading artwork…';
      }
    }
    if (state.images[slot] !== entry) return;
    entry.img = up; entry.upscaled = scale;   // same shape, so crops and positions still hold
    scheduleRender(); renderAssets();
  };
  upscaleQueue = upscaleQueue.then(job, job);   // one Upscayl job at a time
}
const upscaleAll = () => { for (const slot of ['front', 'bg', 'logo']) autoUpscale(slot, state.images[slot]); };

function setImage(slot, asset) {
  const entry = { asset, img: null };
  state.images[slot] = entry;
  if (!asset) { renderAssets(); scheduleRender(); return Promise.resolve(); }
  setBusy(+1);
  return loadImage(asset.url).then(img => {
    if (state.images[slot] !== entry) return;
    entry.img = slot === 'logo' ? trimTransparent(img) : img;
    if (slot === 'bg') autoCrop(Object.keys(TEMPLATES).filter(k => k !== 'case' || !state.images.front?.img));
    if (slot === 'front') {
      autoCrop(['case']);
      // Official covers already carry the logo, and a band would cover their top edge.
      const cover = ['cover', 'grid'].includes(asset.kind);
      state.layouts.case.showLogo = !cover;
      state.fx.wrapBand = !cover;
    }
    if (slot === 'logo') for (const L of Object.values(state.layouts)) L.textLogo = false;
    if (slot === 'bg' || slot === 'logo') scheduleAutoTheme();
    if (slot === 'logo' && state.fontDetect) rematchLogo();
    if (slot === 'logo' && frontImg()) autoCrop(['case']);
    syncControls();
    autoUpscale(slot, entry);
  }).catch(() => {
    if (state.images[slot] === entry) state.images[slot] = null;
    toast(`Couldn't load that ${KIND_LABEL[asset.kind] || 'image'}.`, 'error');
  }).finally(() => { setBusy(-1); renderAssets(); scheduleRender(); });
}

function setBusy(d) {
  state.pending = Math.max(0, state.pending + d);
  $('#canvasLoading').hidden = state.pending === 0;
}

/* ========================================================== smart crop */
// Pick the most interesting crop window (detail + colour, avoiding dark voids)
// for each template's aspect ratio, so wide heroes crop well into tall layouts.
const interestCache = new WeakMap();
function interestMap(img) {
  if (interestCache.has(img)) return interestCache.get(img);
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const k = 120 / Math.max(iw, ih);
  const w = Math.max(2, Math.round(iw * k)), h = Math.max(2, Math.round(ih * k));
  const c = el('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, w, h);
  let d;
  try { d = x.getImageData(0, 0, w, h).data; } catch { return null; }
  const L = new Float32Array(w * h), S = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    L[i] = .299 * r + .587 * g + .114 * b;
    S[i] = mx ? (mx - mn) / mx : 0;
  }
  const e = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    const i = y * w + xx;
    const gx = xx < w - 1 ? Math.abs(L[i + 1] - L[i]) : 0, gy = y < h - 1 ? Math.abs(L[i + w] - L[i]) : 0;
    e[i] = (gx + gy + S[i] * 40 + L[i] * .08) * (L[i] < 22 ? .3 : 1);
  }
  const m = { w, h, e, aspect: iw / ih };
  interestCache.set(img, m);
  return m;
}
function smartPan(img, aspect) {
  const m = interestMap(img);
  if (!m || Math.abs(m.aspect - aspect) / aspect < .03) return { x: 0, y: 0 };
  const horizontal = m.aspect > aspect;
  const n = horizontal ? m.w : m.h;
  const win = Math.max(1, Math.round(horizontal ? m.h * aspect : m.w / aspect));
  const maxStart = n - win;
  if (maxStart <= 0) return { x: 0, y: 0 };
  const line = new Float32Array(n);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) line[horizontal ? x : y] += m.e[y * m.w + x];
  let sum = 0;
  for (let i = 0; i < win; i++) sum += line[i];
  let best = -1, bestStart = 0;
  for (let st = 0; st <= maxStart; st++) {
    if (st) sum += line[st + win - 1] - line[st - 1];
    const bias = 1 - .3 * Math.abs(st / maxStart - .5) * 2;  // pull toward the centre
    if (sum * bias > best) { best = sum * bias; bestStart = st; }
  }
  const p = 1 - 2 * bestStart / maxStart;
  return horizontal ? { x: p, y: 0 } : { x: 0, y: p };
}
function retailArtH(W, H) { return Math.min(H * .37, W * .55) * (H / W < 1.3 ? .86 : 1); }
function artAspect(key) {
  const { w, h } = tplSize(key);
  if (key === 'boxback' && state.fx.boxStyle !== 'cinematic') return w / retailArtH(w, h);
  if (key === 'case') { const d = caseDims(); return (d.panelPx + 2 * d.spinePx) / d.heightPx; }   // box centred on the front
  return w / h;
}
const artFor = key => key === 'case' ? state.images.front?.img || state.images.bg?.img : state.images.bg?.img;
function autoCrop(keys = Object.keys(TEMPLATES)) {
  for (const k of keys) {
    const img = artFor(k);
    if (!img) continue;
    if (k === 'case') { autoPlaceFront(); continue; }
    const L = state.layouts[k], p = smartPan(img, artAspect(k));
    L.bgZoom = 1; L.bgX = p.x; L.bgY = p.y;
  }
}

// Where the game's logo sits in a piece of art (as fractions of its height), found by
// correlating the logo's shape with the art at several sizes. null if it isn't in there.
function findLogoIn(img, logo) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const lw0 = logo.naturalWidth || logo.width, lh0 = logo.naturalHeight || logo.height;
  const CW = 72, CH = Math.round(CW * ih / iw);
  const c = el('canvas'); c.width = CW; c.height = CH;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingQuality = 'high'; cx.drawImage(img, 0, 0, CW, CH);
  const cd = cx.getImageData(0, 0, CW, CH).data, lum = new Float32Array(CW * CH);
  for (let i = 0; i < lum.length; i++) lum[i] = .299 * cd[i * 4] + .587 * cd[i * 4 + 1] + .114 * cd[i * 4 + 2];
  let best = { score: 0 };
  for (let frac = .3; frac <= .98; frac += .04) {
    const lw = Math.round(CW * frac), lh = Math.max(2, Math.round(lw * lh0 / lw0));
    if (lh >= CH * .6 || lh < 5 || lw < 14) continue;   // tiny templates match anything
    const m = el('canvas'); m.width = lw; m.height = lh;
    const mx = m.getContext('2d', { willReadFrequently: true });
    mx.imageSmoothingQuality = 'high'; mx.drawImage(logo, 0, 0, lw, lh);
    const md = mx.getImageData(0, 0, lw, lh).data, n = lw * lh, a = new Float32Array(n);
    let am = 0;
    for (let i = 0; i < n; i++) { a[i] = md[i * 4 + 3] / 255; am += a[i]; }
    am /= n;
    let av = 0;
    for (let i = 0; i < n; i++) { a[i] -= am; av += a[i] * a[i]; }
    if (av < 1e-3) continue;
    for (let y = 0; y + lh <= CH; y++) for (let x = 0; x + lw <= CW; x++) {
      let sum = 0, sum2 = 0, cov = 0;
      for (let j = 0; j < lh; j++) {
        const row = (y + j) * CW + x, arow = j * lw;
        for (let i = 0; i < lw; i++) { const v = lum[row + i]; sum += v; sum2 += v * v; cov += a[arow + i] * v; }
      }
      const cvar = sum2 - sum * sum / n;
      if (cvar < 1) continue;
      const score = Math.abs(cov) / Math.sqrt(av * cvar);   // |NCC|: light-on-dark or dark-on-light
      if (score > best.score) best = { score, y0: y / CH, y1: (y + lh) / CH };
    }
  }
  return best.score >= .5 ? best : null;
}

/* ---- the case front: position and size ---- */
// The art must always cover the spine + front (it wraps round the fold). Size 100% is the
// smallest that does; the position is the art's centre as a fraction of the front panel.
function frontPlacement() {
  const img = frontImg();
  if (!img) return null;
  const d = caseDims(), L = state.layouts.case;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const fx = d.panelPx + d.spinePx, R = { x: fx, y: 0, w: d.panelPx, h: d.heightPx };   // the front panel
  const s = Math.max(R.w / iw, R.h / ih) * Math.max(1, L.bgZoom || 1);
  const w = iw * s, h = ih * s;
  const cx = clamp(fx + d.panelPx * (L.frontCx ?? .5), R.x + R.w - w / 2, R.x + w / 2);
  const cy = clamp(d.heightPx * (L.frontCy ?? .5), R.h - h / 2, h / 2);
  return { x: cx - w / 2, y: cy - h / 2, w, h, fx: (cx - fx) / d.panelPx, fy: cy / d.heightPx };
}
// New front art: smallest size that covers the front, centred; if it has to be cropped top and
// bottom, the height keeps the game's logo (or the most interesting part) in view.
function autoPlaceFront() {
  const img = frontImg();
  if (!img) return;
  const d = caseDims(), L = state.layouts.case;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const sMin = Math.max(d.panelPx / iw, d.heightPx / ih);
  L.bgZoom = 1; L.frontCx = .5; L.frontCy = .5;
  const h = ih * sMin, v = Math.min(1, d.heightPx / h);   // visible fraction of the art's height
  let top = (1 - v) / 2;
  if (v < .995) {
    const logo = state.images.logo?.img, found = logo && findLogoIn(img, logo), m = .025;
    if (found) top = clamp(top, found.y1 + m - v, found.y0 - m);   // never cut the logo
    else top = (1 - v) / 2 * (1 - smartPan(img, d.panelPx / d.heightPx).y);
    top = clamp(top, 0, 1 - v);
  }
  L.frontCy = (h / 2 - top * h) / d.heightPx;
}
// Snap a position (fraction of the front) onto the 50% line when it's close.
const SNAP = .025;
const snapHalf = v => Math.abs(v - .5) < SNAP ? .5 : v;

/* ========================================================== auto theme */
function samplePalette(img, max = 84) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, max / Math.max(iw, ih));
  const c = el('canvas');
  c.width = Math.max(1, Math.round(iw * s)); c.height = Math.max(1, Math.round(ih * s));
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, c.width, c.height);
  let d;
  try { d = x.getImageData(0, 0, c.width, c.height).data; } catch { return []; }
  const buckets = new Map();
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 170) continue;
    const k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4);
    let b = buckets.get(k);
    if (!b) buckets.set(k, b = { n: 0, r: 0, g: 0, b: 0 });
    b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; total++;
  }
  if (!total) return [];
  const cols = [...buckets.values()].sort((a, b) => b.n - a.n).map(b => {
    const rgb = [b.r / b.n, b.g / b.n, b.b / b.n];
    const [h, sat, l] = rgbToHsl(...rgb);
    return { hex: rgbToHex(...rgb), rgb, n: b.n / total, h, s: sat, l };
  });
  const merged = [];
  for (const col of cols) {
    const m = merged.find(o => dist(o.rgb, col.rgb) < 44);
    if (m) m.n += col.n; else if (merged.length < 16) merged.push({ ...col });
  }
  return merged.sort((a, b) => b.n - a.n);
}

function deriveTheme(logoCols, artCols) {
  const vivid = c => c.s * Math.sqrt(c.n) * (c.l > .18 && c.l < .86 ? 1 : .15);
  const pick = cols => cols.filter(c => c.s >= .28 && c.n > .01).sort((a, b) => vivid(b) - vivid(a))[0];
  const accentSrc = pick(logoCols) || pick(artCols);
  const artDom = artCols[0];
  const wsum = artCols.reduce((a, c) => a + c.n, 0) || 1;
  const avgL = artCols.length ? artCols.reduce((a, c) => a + c.l * c.n, 0) / wsum : .3;
  const light = avgL > .66;
  const hue = artDom && artDom.s > .1 ? artDom.h : accentSrc ? accentSrc.h : .6;
  const sat = artDom && artDom.s > .1 ? Math.min(artDom.s, .45) : .12;
  const themeBg = light ? hslToHex(hue, Math.min(sat, .35), .93) : hslToHex(hue, sat * .9, .075);
  let accent = light ? '#1b1f2a' : '#f1f1ee';
  if (accentSrc) {
    accent = light
      ? hslToHex(accentSrc.h, Math.max(accentSrc.s, .5), clamp(accentSrc.l, .3, .45))
      : hslToHex(accentSrc.h, Math.max(accentSrc.s, .45), clamp(accentSrc.l, .52, .7));
  }
  const bandSrc = accentSrc || artDom;
  const themeBand = bandSrc && bandSrc.s > .12
    ? hslToHex(bandSrc.h, clamp(bandSrc.s, .35, .8), light ? .4 : .3)
    : hslToHex(hue, .08, light ? .3 : .2);
  const textColor = light ? hslToHex(hue, .22, .12) : hslToHex(hue, .1, .92);
  const swatches = [];
  for (const c of [...logoCols.slice(0, 6), ...artCols.slice(0, 10)]) {
    if (!swatches.some(s => dist(hexToRgb(s), c.rgb) < 30)) swatches.push(c.hex);
  }
  return { themeBg, themeBand, accent, textColor, lightMode: light, swatches: swatches.slice(0, 14) };
}

const scheduleAutoTheme = debounce(() => applyAutoTheme(false), 60);
function applyAutoTheme(force) {
  const logo = state.images.logo?.img, art = state.images.bg?.img;
  if (!logo && !art) return;
  const t = deriveTheme(logo ? samplePalette(logo) : [], art ? samplePalette(art) : []);
  state.swatches = t.swatches;
  if (state.fx.autoTheme || force) {
    const { swatches, ...colors } = t;
    Object.assign(state.fx, colors);
    state.fx.autoTheme = true;
  }
  syncControls(); scheduleRender();
}

function themeColors(F) {
  const bg = F.themeBg;
  // In automatic mode, keep headings and text readable against the background. Once you pick
  // colours yourself they're used exactly as picked.
  let headline = F.accent, text = F.textColor;
  if (F.autoTheme && contrast(headline, bg) < 3) headline = F.lightMode ? withL(headline, .28) : withL(headline, .7);
  if (F.autoTheme && contrast(text, bg) < 4.5) text = F.lightMode ? '#15171c' : '#eef0f4';
  return {
    light: F.lightMode, bg, band: F.themeBand, bandText: readableOn(F.themeBand),
    accent: F.accent, headline, text,
    muted: mix(text, bg, .32),
    footer: mix(bg, F.lightMode ? '#ffffff' : '#000000', F.lightMode ? .55 : .5),
    panel: mix(bg, text, F.lightMode ? .05 : .045),
  };
}

/* ======================================================== text content */
function trimToLength(s, max) {
  s = String(s || '').replace(/\s+\n/g, '\n').trim();
  if (s.length <= max) return s;
  const sentences = s.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [s];
  let out = '';
  for (const sn of sentences) { if ((out + sn).length > max) break; out += sn; }
  return (out || s.slice(0, max).replace(/\s+\S*$/, '') + '…').trim();
}
function formatRequirements(txt) {
  return String(txt || '').split('\n').map(l => l.trim())
    .filter(l => l.includes(':') && !/^(minimum|recommended)\s*:?$/i.test(l))
    .filter(l => !/^OS\b/i.test(l))   // the OS line is left off by default
    .map(l => l.replace(/\s*\*\s*:/, ':').replace(/^Additional Notes:.*/i, '').trim())
    .filter(Boolean).slice(0, 7).join('\n');
}
// Key features are written from the game's own store description: its bullet
// lists first, then its feature headings, then action phrases from its prose.
const FEATURE_VERBS = new Set(('explore discover build craft fight battle engage master customize customise create join team ' +
  'uncover survive collect upgrade unlock play experience choose lead command travel face solve defend conquer forge recruit ' +
  'manage design race hunt befriend navigate dive cook feed shape influence trade compete venture escape investigate meet ride ' +
  'drive fly pilot tame farm grow restore rebuild defeat wield use harness enjoy immerse align remain embark roam delve slip set ' +
  'deploy download install ramp take protect live earn work spread sow stabilize stabilise tailor outwit outsmart gather assemble ' +
  'train raise breed fish mine dig sail rule rise descend climb sneak infiltrate hack steal shoot blast slash wage complete ' +
  'challenge personalize personalise decorate romance date talk listen touch help save rescue guide plan strategize expand ' +
  'colonize colonise settle scavenge loot dominate brave battle hone learn evolve mix match unleash wreak reshape transform').split(' '));
const FEATURE_JUNK = /discord|twitter|facebook|instagram|tiktok|youtube|reddit|wishlist|follow us|newsletter|join (our|the) (community|server)|subscribe|https?:|www\.|©|copyright|all rights reserved|^(pc |key |game |main |new |special |additional )?features:?$|system requirements|about (the|this) game|early access|patreon|kickstarter|mailing list|press kit|coming soon|is now free|\((base game|dlc|soundtrack)\)|edition (includes|contains)|includes the following|season pass|\bbundle\b|artbook|soundtrack|\bdlc\b|^(buy|get|pre-?order|available now|out now)\b|^(minimum|recommended|requires)\b|ultimate edition|deluxe edition|gold edition/i;
// Store tags that describe a feature (not a genre, rating or platform) — last-resort features.
const TAG_NOT_FEATURE = /^(action|adventure|rpg|indie|casual|simulation|strategy|sports|racing|singleplayer|multiplayer|single-player|free to play|early access|fps|shooter|3d|2d|first-person|third person|third-person|puzzle|platformer|arcade|massively multiplayer|mmorpg|horror|psychological horror|survival horror|sci-fi|fantasy|dark fantasy|anime|cute|funny|comedy|violent|gore|blood|nudity|sexual content|mature|nsfw|hentai|controller|vr|great soundtrack|classic|masterpiece|addictive|difficult|family friendly|e-sports|competitive|pvp|pve|co-op|online co-op|local co-op|split screen|psychological|realistic|stylized|colorful|beautiful|atmospheric|immersive|dark|lore-rich|cinematic|female protagonist|male protagonist|moddable|remake|sequel|dystopian|surreal|psychedelic|cyberpunk|military|war|zombies|post-apocalyptic|medieval|historical|space|singleplayer)$/i;
const tidy = t => t.replace(/\s+/g, ' ').replace(/^[-–—•*·・►▶✓✔▪◆◇➤→\s]+/, '').replace(/[\s.;,:]+$/, '').trim();
const capFirst = t => t.charAt(0).toUpperCase() + t.slice(1);
const unshout = t => t === t.toUpperCase() && /[A-Z]{3}/.test(t) ? t.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : t;
const sentencesOf = t => String(t || '').split(/(?<=[.!?])\s+(?=[A-Z“"‘'(])/).map(x => x.trim()).filter(Boolean);
function verbLed(t) {
  const w = t.trim().toLowerCase().split(/\s+/);
  const first = /ly$/.test(w[0]) && w[1] ? w[1] : w[0];
  return FEATURE_VERBS.has((first || '').replace(/[^a-z]/g, ''));
}
// "Engage in X, navigate Y, and master Z." → three features.
function featureClauses(sentence) {
  const t = sentence.replace(/[.!?]+$/, '');
  const parts = t.split(/(,\s*(?:and\s+|or\s+)?|;\s*|\s+[—–]\s+|\s+(?:and|or)\s+)/);
  const clauses = [parts[0]];
  for (let i = 1; i < parts.length; i += 2) {
    const next = parts[i + 1] || '';
    if (verbLed(next)) clauses.push(next); else clauses[clauses.length - 1] += parts[i] + next;
  }
  const verbs = clauses.filter(verbLed);
  return verbs.length ? verbs : [t];
}
function shorten(t, max) {
  if (t.length <= max) return t;
  const cut = Math.max(t.lastIndexOf(', ', max), t.lastIndexOf(' — ', max), t.lastIndexOf('; ', max));
  return cut > max * .45 ? t.slice(0, cut) : '';
}
const sentenceKey = t => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Returns { features, sources } — sources are the sentences that became features,
// so the description can leave them out instead of repeating them.
function buildFeatures(d, headline) {
  const key = sentenceKey;
  const skip = new Set(headline ? [key(headline)] : []);
  const cands = [];
  let order = 0;
  const add = (text, score, src, minLen = 14) => {
    text = capFirst(tidy(shorten(tidy(text), 125)));
    if (text.length < minLen || FEATURE_JUNK.test(text) || /\?$/.test(text)) return;
    if (cands.some(c => key(c.text) === key(text))) return;
    cands.push({ text, score, order: order++, src: src ? key(src) : null });
  };
  const scan = blocks => {
    let para = 0;
    blocks.forEach((b, i) => {
      if (b.type === 'li') add(b.text, 6);
      else if (b.type === 'h') {
        const words = b.text.split(/\s+/).length;
        if (words > 9 || FEATURE_JUNK.test(b.text) || /\?$/.test(b.text)) return;
        const head = tidy(unshout(b.text));
        const next = blocks[i + 1]?.type === 'p' ? sentencesOf(blocks[i + 1].text)[0] || '' : '';
        const detail = next && head.length + next.length < 118 ? tidy(next) : '';
        add(detail ? `${head}: ${detail}` : head, words >= 2 ? 4 : 3, detail ? next : null, 6);
      } else {
        // The opening paragraph is the description's; prefer features from later ones.
        const early = para++ === 0 ? -1.5 : 0;
        for (const sn of sentencesOf(b.text)) {
          if (skip.has(key(sn))) continue;
          for (const c of featureClauses(sn)) add(c, (verbLed(c) ? 3 : c.length <= 100 ? 1 : .5) + early, sn);
        }
      }
    });
  };
  const choose = () => {
    let p = cands.filter(c => c.score >= 3);
    if (p.length < 3) p = cands.filter(c => c.score >= 1);
    if (p.length < 3) p = cands.filter(c => c.score > 0);
    return p.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 5).sort((a, b) => a.order - b.order);
  };
  // Official store page text, most specific first; each step only if we still need more.
  scan(d.blocks || []);
  let picked = choose();
  if (picked.length < 3 && d.extraBlocks?.length) { scan(d.extraBlocks); picked = choose(); }
  if (picked.length < 3) {
    for (const sn of sentencesOf(d.shortDescription)) {
      if (skip.has(key(sn))) continue;
      for (const c of featureClauses(sn)) add(c, verbLed(c) ? 2 : .8, sn);
      for (const part of sn.split(/\s+[—–]\s+|;\s*/).slice(1)) add(part, .7, sn);
    }
    picked = choose();
  }
  if (picked.length < 3) {
    for (const t of state.tags || []) if (!TAG_NOT_FEATURE.test(t.trim())) add(t, .3, null, 4);
    picked = choose();
  }
  return { features: picked.map(c => c.text), sources: new Set(picked.map(c => c.src).filter(Boolean)) };
}
function fillTextFromStore() {
  const d = state.store, X = state.text, name = d?.name || state.game?.name || '';
  X.title = name;
  if (!d) {
    Object.assign(X, { headline: '', description: '', features: '', requirements: '', legal: name ? `© ${name}. All rights reserved.` : '', players: '', rating: '' });
    for (const b of BADGES) state.fx[b.fx] = false;
    state.controllerLevel = null;
    return;
  }
  const sentences = (d.shortDescription || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const punchy = sentences.slice(0, 4).filter(s => s.length >= 10 && s.length <= 60).sort((a, b) => a.length - b.length)[0];
  X.headline = punchy ? punchy.replace(/\.$/, '') : '';
  const { features, sources } = buildFeatures(d, punchy);
  X.features = features.join('\n');
  let desc = d.about && d.about.length > 160 ? d.about : d.shortDescription || d.about || '';
  if (punchy && desc.startsWith(punchy)) desc = desc.slice(punchy.length).trim() || desc;
  // Leave out sentences that became features, so nothing is said twice.
  const kept = desc.split('\n').map(p => sentencesOf(p).filter(sn => !sources.has(sentenceKey(sn))).join(' ')).filter(Boolean).join('\n');
  desc = kept.length >= 120 ? kept : (d.shortDescription && !sources.has(sentenceKey(d.shortDescription)) ? d.shortDescription : kept || desc);
  X.description = trimToLength(desc, 480);
  X.requirements = formatRequirements(d.requirements);
  const year = (String(d.releaseDate || '').match(/\d{4}/) || [''])[0];
  const pubs = (d.publishers || []).join(', '), devs = (d.developers || []).join(', ');
  X.legal = [`© ${year ? year + ' ' : ''}${pubs || devs || name}.`,
    devs ? `${name} developed by ${devs}.` : '', pubs ? `Published by ${pubs}.` : '',
    'All other trademarks are the property of their respective owners.'].filter(Boolean).join(' ');
  // How it's played → icon badges (not feature text).
  const cats = d.categories || [], has = re => cats.some(c => re.test(c)), F = state.fx;
  F.badgeSingle = has(/^Single-player$/i);
  F.badgeOnline = has(/^(Online PvP|Online Co-op|MMO|Cross-Platform Multiplayer)$/i);
  F.badgeCoop = has(/Co-op/i);
  F.badgeLocal = has(/^Shared\/Split Screen/i);
  state.controllerLevel = d.controllerSupport === 'full' || has(/^Full controller support$/i) ? 'full'
    : d.controllerSupport === 'partial' || has(/^Partial Controller Support$/i) ? 'partial' : null;
  F.badgeController = !!state.controllerLevel;
  X.players = '';
  const age = parseInt(d.requiredAge, 10);
  X.rating = age > 0 ? `${age}+` : '';
  X.platform = 'PC';
}

/* ============================================================ rendering */
function tplSize(key) {
  if (key === 'boxback' || key === 'case') {
    const d = caseDims();
    return { w: key === 'case' ? d.panelPx * 2 + d.spinePx : d.panelPx, h: d.heightPx };
  }
  return { w: TEMPLATES[key].w, h: TEMPLATES[key].h };
}

let noisePattern = null, scanPatterns = {};
function noise(ctx) {
  if (!noisePattern) {
    const c = el('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d'), d = x.createImageData(256, 256);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    x.putImageData(d, 0, 0);
    noisePattern = c;
  }
  return ctx.createPattern(noisePattern, 'repeat');
}
function scanlines(ctx, period) {
  if (!scanPatterns[period]) {
    const c = el('canvas'); c.width = 1; c.height = period;
    const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 1, Math.max(1, period / 2));
    scanPatterns[period] = c;
  }
  return ctx.createPattern(scanPatterns[period], 'repeat');
}

function roundRectPath(ctx, r, rad) {
  rad = Math.min(rad, r.w / 2, r.h / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
  ctx.closePath();
}

// Fill rect r with img (object-fit: cover), zoomed and panned. Returns the pan range.
function drawImageCover(ctx, img, r, zoom = 1, px = 0, py = 0, bleed = 0) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.max((r.w + 2 * bleed) / iw, (r.h + 2 * bleed) / ih) * zoom;
  const dw = iw * s, dh = ih * s;
  const ox = (dw - r.w) / 2 - bleed, oy = (dh - r.h) / 2 - bleed;
  ctx.drawImage(img, r.x + (r.w - dw) / 2 + px * ox, r.y + (r.h - dh) / 2 + py * oy, dw, dh);
  return { ox, oy };
}
function containRect(img, cx, cy, maxW, maxH) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(maxW / iw, maxH / ih);
  return { x: cx - iw * s / 2, y: cy - ih * s / 2, w: iw * s, h: ih * s };
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push({ text: '', last: true, blank: true }); continue; }
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (!line || ctx.measureText(test).width <= maxW) line = test;
      else { out.push({ text: line, last: false }); line = w; }
    }
    out.push({ text: line, last: true, paraEnd: true });
  }
  while (out.length && out[out.length - 1].blank) out.pop();
  return out;
}
const lineStep = (l, lh, gap) => l.blank ? lh * .5 : lh + (l.paraEnd ? gap : 0);
const linesHeight = (lines, lh, gap = 0) => lines.reduce((a, l) => a + lineStep(l, lh, gap), 0);
function ellipsize(ctx, t, maxW) {
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}
function drawJustified(ctx, text, x, y, w) {
  const words = text.split(' ');
  const widths = words.map(t => ctx.measureText(t).width);
  const gap = (w - widths.reduce((a, b) => a + b, 0)) / Math.max(1, words.length - 1);
  if (words.length < 2 || gap > ctx.measureText(' ').width * 3.2) { ctx.textAlign = 'left'; ctx.fillText(text, x, y); return; }
  ctx.textAlign = 'left';
  let cx = x;
  words.forEach((t, i) => { ctx.fillText(t, cx, y); cx += widths[i] + gap; });
}
// Word-wrapped text block that shrinks (to minScale) and then ellipsizes to fit r.
function measureParagraph(ctx, text, w, o) {
  if (!String(text).trim()) return 0;
  ctx.font = fontCss(o.weight, o.size, o.family);
  setSpacing(ctx, 0);
  const lines = wrapLines(ctx, text, w), gap = o.size * (o.paraGap ?? 0);
  return linesHeight(lines, o.size * o.lh, gap) - (lines.at(-1)?.paraEnd ? gap : 0);
}
function drawParagraph(ctx, text, r, o) {
  if (!String(text).trim() || r.h <= 4 || r.w <= 4) return 0;
  let size = o.size, lines, lineH, gap = 0;
  const minSize = o.size * (o.minScale ?? .8);
  for (;;) {
    ctx.font = fontCss(o.weight, size, o.family);
    setSpacing(ctx, o.spacing ? size * o.spacing : 0);
    lines = wrapLines(ctx, text, r.w);
    lineH = size * o.lh;
    gap = size * (o.paraGap ?? 0);
    if (linesHeight(lines, lineH, gap) - (lines.at(-1)?.paraEnd ? gap : 0) <= r.h || size <= minSize) break;
    size = Math.max(minSize, size * .95);
  }
  const out = [];
  let used = 0;
  for (const ln of lines) {
    if (used + (ln.blank ? lineH * .5 : lineH) > r.h + .5) break;
    out.push(ln); used += lineStep(ln, lineH, gap);
  }
  if (out.length < lines.length) {
    while (out.length && out[out.length - 1].blank) out.pop();
    if (out.length) {
      const i = out.length - 1;
      let t = out[i].text;
      while (t && ctx.measureText(t + '…').width > r.w) t = t.replace(/\s*\S+$/, '');
      t = (t || out[i].text).replace(/[,;:]$/, '');
      out[i] = { text: /[.!?…]$/.test(t) ? t : t + '…', last: true };
    }
  }
  const total = linesHeight(out, lineH, gap) - (out.at(-1)?.paraEnd ? gap : 0);
  let y = o.valign === 'middle' ? r.y + (r.h - total) / 2 : r.y;
  ctx.fillStyle = o.color;
  ctx.textBaseline = 'top';
  for (const ln of out) {
    if (ln.blank) { y += lineH * .5; continue; }
    const ty = y + (lineH - size) / 2;
    if (o.align === 'justify' && !ln.last) drawJustified(ctx, ln.text, r.x, ty, r.w);
    else if (o.align === 'center') { ctx.textAlign = 'center'; ctx.fillText(ln.text, r.x + r.w / 2, ty); }
    else { ctx.textAlign = 'left'; ctx.fillText(ln.text, r.x, ty); }
    y += lineStep(ln, lineH, gap);
  }
  ctx.textAlign = 'left';
  setSpacing(ctx, 0);
  return total;
}

function logoBox(key, L, W, H) {
  const base = key === 'boxback' ? BOX_LOGO[state.fx.boxStyle].logoScale : LAYOUT_DEFAULTS[key].logoScale;
  return { maxW: W * L.logoScale, maxH: H * L.logoMaxH * (L.logoScale / base) };
}

// Where the logo will land (without drawing it). frame = vertical box logoY is relative to.
function logoRect(key, W, H, L, frame) {
  if (!L.showLogo) return null;
  const img = state.images.logo?.img, { maxW, maxH } = logoBox(key, L, W, H);
  const cx = W * L.logoX, cy = frame.y + frame.h * L.logoY;
  return img && !L.textLogo ? containRect(img, cx, cy, maxW, maxH) : { x: cx - maxW / 2, y: cy - maxH / 2, w: maxW, h: maxH };
}
function drawLogoLayer(ctx, key, W, H, u, L, F, T, frame = { y: 0, h: H }) {
  if (!L.showLogo) return null;
  const img = state.images.logo?.img;
  const { maxW, maxH } = logoBox(key, L, W, H);
  const cx = W * L.logoX, cy = frame.y + frame.h * L.logoY;
  if (img && !L.textLogo) {
    const r = containRect(img, cx, cy, maxW, maxH);
    if (F.glowStrength > 0) {
      ctx.save();
      ctx.shadowColor = F.glowColor; ctx.shadowBlur = 70 * u * F.glowStrength;
      ctx.globalAlpha = Math.min(1, F.glowStrength * 1.2);
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
      ctx.restore();
    }
    ctx.save();
    if (F.logoShadow > 0) {
      ctx.shadowColor = `rgba(0,0,0,${.35 + F.logoShadow * .55})`;
      ctx.shadowBlur = 42 * u * F.logoShadow; ctx.shadowOffsetY = 10 * u * F.logoShadow;
    }
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    ctx.restore();
    return r;
  }
  const text = state.text.title || state.game?.name;
  if (!text) return null;
  return drawTextLogo(ctx, text, cx, cy, maxW, maxH, F, T, u);
}

// The game's name set in its heading font — used when there's no logo image.
function drawTextLogo(ctx, text, cx, cy, maxW, maxH, F, T, u) {
  ensureFont(F.headFamily, F.headWeight);
  const t = F.headUpper ? text.toUpperCase() : text;
  let size = maxH, lines = [], widest = 0;
  for (let i = 0; i < 60; i++) {
    ctx.font = fontCss(F.headWeight, size, F.headFamily);
    setSpacing(ctx, size * .03);
    lines = wrapLines(ctx, t, maxW).map(l => l.text);
    widest = Math.max(...lines.map(l => ctx.measureText(l).width));
    if (lines.length <= 3 && lines.length * size * 1.02 <= maxH && widest <= maxW) break;
    size *= .94;
  }
  const lh = size * 1.02, h = lines.length * lh, y = cy - h / 2;
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, mix(T.headline, '#ffffff', T.light ? .1 : .45));
  g.addColorStop(1, T.headline);
  ctx.fillStyle = g;
  ctx.shadowColor = F.glowStrength > 0 ? F.glowColor : `rgba(0,0,0,${.4 + F.logoShadow * .5})`;
  ctx.shadowBlur = (F.glowStrength > 0 ? 60 * F.glowStrength : 30 * F.logoShadow) * u;
  ctx.shadowOffsetY = F.glowStrength > 0 ? 0 : 8 * u * F.logoShadow;
  lines.forEach((l, i) => ctx.fillText(l, cx, y + i * lh));
  ctx.restore();
  setSpacing(ctx, 0);
  return { x: cx - widest / 2, y, w: widest, h };
}

function drawKeyArt(ctx, r, L, F, T, u, hit, img = state.images.bg?.img, opts = {}) {
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  if (img) {
    const b = F.blur * u;
    ctx.filter = `blur(${b.toFixed(1)}px) brightness(${F.brightness}%) saturate(${F.saturate}%) contrast(${F.contrast}%)`;
    const o = drawImageCover(ctx, img, r, L.bgZoom, L.bgX, L.bgY, b * 2.2);
    ctx.filter = 'none';
    hit.bg = { rect: r, ox: o.ox, oy: o.oy };
  } else {
    const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
    g.addColorStop(0, mix(T.band, T.bg, .2)); g.addColorStop(1, T.bg);
    ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  if (F.tintStrength > 0) {
    ctx.save();
    ctx.globalCompositeOperation = F.tintBlend; ctx.globalAlpha = F.tintStrength;
    ctx.fillStyle = F.tintColor; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }
  if (F.vignette > 0 && opts.vignette !== false) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const g = ctx.createRadialGradient(cx, cy, Math.min(r.w, r.h) * .3, cx, cy, Math.hypot(r.w, r.h) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${F.vignette * .85})`);
    ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  if (F.scanlines > 0) {
    ctx.save();
    ctx.globalAlpha = F.scanlines * .55; ctx.fillStyle = scanlines(ctx, Math.max(2, Math.round(4 * u)));
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }
  ctx.restore();
}

function drawGrain(ctx, W, H, F) {
  if (F.grain <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = F.grain;
  ctx.fillStyle = noise(ctx); ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function render(ctx, key) {
  const { w: W, h: H } = tplSize(key);
  const L = state.layouts[key], F = state.fx, X = state.text;
  const u = Math.sqrt(W * H) / 1000;
  const T = themeColors(F);
  const hit = {};
  ensureFont(F.headFamily, F.headWeight);
  ensureFont(F.bodyFamily, F.bodyWeight);
  ensureFont(F.bodyFamily, F.bodyBold);
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (!state.game) { drawEmpty(ctx, W, H, u, T, F); ctx.restore(); return hit; }
  if (key === 'boxback') drawBack(ctx, W, H, u, L, F, X, T, hit);
  else if (key === 'case') drawCase(ctx, W, H, L, F, X, T, hit);
  else drawSteamArt(ctx, key, W, H, u, L, F, T, hit);
  ctx.restore();
  return hit;
}

const frontImg = () => state.images.front?.img || state.images.bg?.img;

/* --------------------------------------------------------- full case */
// Back | spine | front, laid out flat as a printed insert. The back is the Box
// back template; the front art runs continuously across the spine.
let backCache = { key: '', canvas: null };
function backPanel() {
  const key = JSON.stringify([state.fx, state.text, state.layouts.boxback, state.game?.name,
    Object.values(state.images).map(v => (v?.asset?.id || '') + (v?.img ? '+' : '') + (v?.upscaled || '')), fontsLoaded.size, !!window.qrcode]);
  if (backCache.key !== key) {
    const { w, h } = tplSize('boxback');
    const c = el('canvas'); c.width = w; c.height = h;
    render(c.getContext('2d'), 'boxback');
    backCache = { key, canvas: c };
  }
  return backCache.canvas;
}

// The front art as placed (position, size, adjustments) — the artwork only, no logo or badges.
function drawFrontArt(ctx, art, F, T, u) {
  ctx.fillStyle = T.bg; ctx.fillRect(art.x, art.y, art.w, art.h);
  const pl = frontPlacement(), img = frontImg();
  if (!pl) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(art.x, art.y, art.w, art.h); ctx.clip();
  ctx.filter = `blur(${(F.blur * u).toFixed(1)}px) brightness(${F.brightness}%) saturate(${F.saturate}%) contrast(${F.contrast}%)`;
  // frontPlacement() is in case coordinates (front panel at panel + spine); shift it onto art.
  const d = caseDims(), ox = art.x - (d.panelPx + d.spinePx), oy = art.y;
  ctx.drawImage(img, pl.x + ox, pl.y + oy, pl.w, pl.h);
  ctx.filter = 'none';
  if (F.tintStrength > 0) {
    ctx.globalCompositeOperation = F.tintBlend; ctx.globalAlpha = F.tintStrength;
    ctx.fillStyle = F.tintColor; ctx.fillRect(art.x, art.y, art.w, art.h);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }
  if (F.scanlines > 0) {
    ctx.globalAlpha = F.scanlines * .55; ctx.fillStyle = scanlines(ctx, Math.max(2, Math.round(4 * u)));
    ctx.fillRect(art.x, art.y, art.w, art.h); ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawCase(ctx, W, H, L, F, X, T, hit) {
  const d = caseDims(), back = d.panelPx, spine = d.spinePx, front = d.panelPx;
  const u = Math.sqrt(back * H) / 1000;           // same scale as the back panel
  const bandH = H * .04, line = Math.max(2, 3 * u);
  ctx.drawImage(backPanel(), 0, 0);

  // Front art: on the front panel only — centred by default, movable (snaps to the centre).
  const art = { x: back + spine, y: 0, w: front, h: H };
  drawFrontArt(ctx, art, F, T, u);
  hit.bg = { rect: art, ox: 0, oy: 0 };
  drawSpineBackground(ctx, { x: back, y: 0, w: spine, h: H }, F, T);
  ctx.save();
  ctx.beginPath(); ctx.rect(art.x, art.y, art.w, art.h); ctx.clip();
  drawGrain(ctx, W, H, F);
  ctx.restore();
  if (L.showLogo && F.fade > 0) {   // our own logo on the front: settle it on a soft fade (front only)
    const g = ctx.createLinearGradient(0, H * .5, 0, H);
    g.addColorStop(0, rgba(T.bg, 0)); g.addColorStop(1, rgba(T.bg, .85 * F.fade));
    ctx.fillStyle = g; ctx.fillRect(back + spine, 0, front, H);
  }
  const sp = { x: back, y: 0, w: spine, h: H };

  // Platform band: only when it also runs across the front, so it reads as one strip.
  const wrapBand = F.showBand && F.wrapBand;
  if (wrapBand) {
    ctx.fillStyle = T.band; ctx.fillRect(back, 0, spine + front, bandH);
    ctx.fillStyle = contrast(T.accent, T.band) > 1.6 ? T.accent : mix(T.band, T.bandText, .5);
    ctx.fillRect(back, bandH, spine + front, line);
    ctx.fillStyle = T.bandText; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = fontCss(F.headWeight, bandH * .56, F.headFamily); setSpacing(ctx, bandH * .1);
    ctx.fillText((X.platform || '').toUpperCase(), back + spine + W * .02, bandH * .54);
    setSpacing(ctx, 0);
  }

  // Front logo (when the front art doesn't already carry one).
  if (L.showLogo) {
    ctx.save(); ctx.translate(back + spine, 0);
    const lr = drawLogoLayer(ctx, 'case', front, H, u, L, F, T);
    ctx.restore();
    if (lr) hit.logo = { x: lr.x + back + spine, y: lr.y, w: lr.w, h: lr.h };
  }
  hit.logoFrameW = front; hit.logoFrameH = H;

  // Front age box, bottom-left like a retail cover.
  if (F.frontRating && F.showRating && X.rating.trim()) {
    const s = H * .06, x = back + spine + front * .05, y = H - s - H * .03;
    ctx.fillStyle = '#fff'; roundRectPath(ctx, { x, y, w: s, h: s }, s * .08); ctx.fill();
    ctx.strokeStyle = '#111'; ctx.lineWidth = s * .05;
    roundRectPath(ctx, { x: x + s * .07, y: y + s * .07, w: s * .86, h: s * .86 }, s * .05); ctx.stroke();
    ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = fontCss(800, s * .4, 'Inter'); ctx.fillText(X.rating.trim(), x + s / 2, y + s / 2);
  }

  drawSpine(ctx, sp, wrapBand ? bandH + line : 0, X, F, T);
}

/* ---- AI spine: Gemini continues the front artwork round onto the spine ---- */
// The painted spine belongs to the front exactly as placed; moving, resizing or adjusting it
// (or changing the spine width) means it should be painted again.
const spineKey = () => {
  const F = state.fx, L = state.layouts.case, d = caseDims();
  return JSON.stringify([state.game?.name, (state.images.front || state.images.bg)?.asset?.id, L.bgZoom, L.frontCx, L.frontCy,
    F.blur, F.brightness, F.saturate, F.contrast, F.tintColor, F.tintStrength, F.tintBlend, F.scanlines, d.spinePx, d.panelPx, d.heightPx]);
};
const currentSpine = () => state.spine && state.spine.key === spineKey() ? state.spine : null;
function spineStatus() {
  if (!state.game) return '';
  if (!state.hasGemini) return 'Spine: the theme colour. Add a Gemini key in Settings to continue the front onto it with AI.';
  if (currentSpine()) return `Spine: the front artwork continued round the fold by Gemini${state.spine.cached ? ' (saved — no charge)' : ''}.`;
  if (state.spine) return 'The front changed since the spine was painted — continue it again to match.';
  return 'Spine: the theme colour. “Continue front onto spine” has Gemini extend the front artwork round the fold (about $0.13 each; repeats are free).';
}
// The logo's main colour (its most common opaque colour).
function logoColour() {
  const logo = state.images.logo?.img;
  return logo ? samplePalette(logo)[0]?.hex || '#ffffff' : state.fx.accent;
}
// An outline colour for the spine logo when parts of what's behind it are too close to the logo's
// colour to read (null when it stands out everywhere). bg: sampled background colours.
function spineOutline(fg, bg) {
  if (state.fx.spineOutline === 'off') return null;
  const clash = bg.filter(c => contrast(fg, c) < 2.2).length / bg.length;
  if (state.fx.spineOutline !== 'on' && clash < .1) return null;
  const avg = rgbToHex(...[0, 1, 2].map(i => bg.reduce((a, c) => a + hexToRgb(c)[i], 0) / bg.length));
  const score = c => Math.min(contrast(c, fg), contrast(c, avg));
  return score('#0b0b0f') >= score('#f4f4f4') ? '#0b0b0f' : '#f4f4f4';
}
// Per-row colour at an edge of an image (a few px in), smoothed down the height.
function edgeColours(src, x0, band, H, radius) {
  const c = el('canvas'); c.width = 1; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, x0, 0, band, src.height, 0, 0, 1, H);
  const d = x.getImageData(0, 0, 1, H).data, out = new Float32Array(H * 3);
  for (let y = 0; y < H; y++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = Math.max(0, y - radius); k <= Math.min(H - 1, y + radius); k++) { r += d[k * 4]; g += d[k * 4 + 1]; b += d[k * 4 + 2]; n++; }
    out[y * 3] = r / n; out[y * 3 + 1] = g / n; out[y * 3 + 2] = b / n;
  }
  return out;
}
// Blend the painted strip into the front's colours at the fold (broad colour only, fading out
// a few mm from the fold), so the join is invisible.
function matchSeam(front, strip) {
  const sw = strip.width, H = strip.height, band = Math.max(4, Math.round(sw / 12)), radius = Math.max(8, Math.round(H / 60));
  const edge = edgeColours(front, 0, band, H, radius), near = edgeColours(strip, sw - band, band, H, radius);
  const x = strip.getContext('2d', { willReadFrequently: true }), img = x.getImageData(0, 0, sw, H), d = img.data;
  for (let y = 0; y < H; y++) for (let xx = 0; xx < sw; xx++) {
    const ramp = Math.max(0, 1 - (sw - 1 - xx) / (sw * .4));
    if (!ramp) continue;
    const i = (y * sw + xx) * 4;
    for (let ch = 0; ch < 3; ch++) d[i + ch] = clamp(d[i + ch] + (edge[y * 3 + ch] - near[y * 3 + ch]) * ramp, 0, 255);
  }
  x.putImageData(img, 0, 0);
  return strip;
}
const GEMINI_RATIOS = [['9:16', 9 / 16], ['2:3', 2 / 3], ['3:4', .75], ['4:5', .8], ['1:1', 1], ['5:4', 1.25], ['4:3', 4 / 3], ['3:2', 1.5], ['16:9', 16 / 9]];
async function continueSpine(force = false) {
  if (!state.game) return toast('Pick a game first.');
  if (!frontImg()) return toast('Pick front art first.');
  const d = caseDims(), F = state.fx, key = spineKey(), sw = d.spinePx;
  // The front artwork alone (no logo, age box or band), as it prints.
  const front = el('canvas'); front.width = d.panelPx; front.height = d.heightPx;
  drawFrontArt(front.getContext('2d'), { x: 0, y: 0, w: d.panelPx, h: d.heightPx }, F, themeColors(F), Math.sqrt(d.panelPx * d.heightPx) / 1000);
  // The front on the right of a canvas whose left strip (a little wider than the spine) is flat grey.
  const need = (front.width + sw * 1.4) / front.height;
  const [aspect, ratio] = GEMINI_RATIOS.find(([, r]) => r >= need) || GEMINI_RATIOS.at(-1);
  const ch = 2048, fw = Math.round(front.width * ch / front.height), cw = Math.round(ch * ratio);
  const c = el('canvas'); c.width = cw; c.height = ch;
  const cx = c.getContext('2d');
  cx.fillStyle = 'rgb(128,128,128)'; cx.fillRect(0, 0, cw, ch);
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(front, cw - fw, 0, fw, ch);
  const body = extra => JSON.stringify({ image: c.toDataURL('image/jpeg', .93).split(',')[1], aspect, force, extra });
  $('#loadingText').textContent = 'Continuing the front onto the spine with Gemini…';
  setBusy(+1);
  try {
    let result = null, extra = '';
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      if (attempt) $('#loadingText').textContent = 'Continuing the front onto the spine with Gemini (second try)…';
      const r = await api('/api/spine/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(extra) });
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = r.url; });
      // Back to print size; the spine is the strip right next to the front's left edge.
      const outW = Math.round(img.naturalWidth * d.heightPx / img.naturalHeight), greyW = outW - front.width;
      const scaled = el('canvas'); scaled.width = outW; scaled.height = d.heightPx;
      const sx = scaled.getContext('2d'); sx.imageSmoothingQuality = 'high'; sx.drawImage(img, 0, 0, outW, d.heightPx);
      const strip = el('canvas'); strip.width = sw; strip.height = d.heightPx;
      strip.getContext('2d', { willReadFrequently: true }).drawImage(scaled, Math.max(0, greyW - sw), 0, sw, d.heightPx, 0, 0, sw, d.heightPx);
      // Checks: the front must still be there, unchanged, where it was (else Gemini redrew the
      // whole picture — e.g. as a photo of a case), and the strip must actually be painted.
      const small = (src, sx, sw2, sh) => {
        const k = el('canvas'); k.width = 24; k.height = 48;
        const x = k.getContext('2d', { willReadFrequently: true });
        x.drawImage(src, sx, 0, sw2, sh, 0, 0, 24, 48);
        return x.getImageData(0, 0, 24, 48).data;
      };
      const a1 = small(c, cw - fw, fw, ch), a2 = small(img, img.naturalWidth * (cw - fw) / cw, img.naturalWidth * fw / cw, img.naturalHeight);
      // Structure match (correlation of brightness) — a flat or redrawn picture fails even when dark.
      const lumA = [], lumB = [];
      for (let i = 0; i < a1.length; i += 4) { lumA.push(a1[i] + a1[i + 1] + a1[i + 2]); lumB.push(a2[i] + a2[i + 1] + a2[i + 2]); }
      const mean = v => v.reduce((x, y) => x + y, 0) / v.length, ma = mean(lumA), mb = mean(lumB);
      let cov = 0, va = 0, vb = 0;
      lumA.forEach((v, i) => { cov += (v - ma) * (lumB[i] - mb); va += (v - ma) ** 2; vb += (lumB[i] - mb) ** 2; });
      const corr = va && vb ? cov / Math.sqrt(va * vb) : 0;
      const diff = corr > .75 && Math.abs(ma - mb) / 3 < 30 ? 0 : 99;
      const px = strip.getContext('2d').getImageData(0, 0, sw, d.heightPx).data;
      let grey = 0, n = 0;
      for (let i = 0; i < px.length; i += 64) { if (Math.abs(px[i] - 128) < 8 && Math.abs(px[i + 1] - 128) < 8 && Math.abs(px[i + 2] - 128) < 8) grey++; n++; }
      if (diff < 28 && grey / n < .25) result = { strip: matchSeam(front, strip), r };
      else {
        force = true;
        extra = diff >= 28
          ? ' IMPORTANT: a previous attempt replaced the whole picture. Return the SAME cover artwork, unchanged and in the same place, with only the grey strip on the left filled in.'
          : ' IMPORTANT: a previous attempt left the grey strip unpainted. Paint all of it, right to its left edge.';
      }
    }
    if (!result) throw new Error('Gemini didn’t continue the artwork properly this time (nothing was changed) — try again.');
    if (key !== spineKey()) return;
    state.spine = { key, strip: result.strip, cached: result.r.cached };
    toast(result.r.cached ? 'Spine loaded from your saved paintings (no charge).' : 'Front artwork continued onto the spine.', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setBusy(-1);
    $('#loadingText').textContent = 'Loading artwork…';
    syncControls(); scheduleRender();
  }
}

// The universal "PC GAME" badge (public domain, by Dave Bleja), upright at the top of the spine.
// QR code library (MIT, Kazuhiko Arase), bundled with the app.
document.head.append(el('script', { src: '/static/assets/qrcode.js', onload: () => scheduleRender() }));

const PC_BADGE = new Image();
PC_BADGE.onload = () => scheduleRender();
PC_BADGE.src = '/static/assets/pc-game-logo.png';

// The spine's background: Gemini's design, or (until one is made) the theme colour with grain.
function drawSpineBackground(ctx, r, F, T) {
  const ai = currentSpine();
  if (ai) return ctx.drawImage(ai.strip, r.x, r.y, r.w, r.h);
  ctx.fillStyle = T.bg; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  drawGrain(ctx, r.x + r.w, r.h, F);
  ctx.restore();
}

function drawSpine(ctx, r, top, X, F, T) {
  const len = r.h, thick = r.w;
  if (F.pcBadge && PC_BADGE.naturalWidth) {
    // Full width of the spine, flush with its top edge (or with the band, when it runs across).
    const size = thick, x = r.x, y = top || 0;
    ctx.drawImage(PC_BADGE, x, y, size, size);
    top = y + size + mmPx(2);   // the spine logo starts below it
  }
  ctx.save();
  // Rotate so text runs top-to-bottom (the usual spine direction).
  ctx.translate(r.x + r.w / 2, 0); ctx.rotate(Math.PI / 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // Size (1 = 82% of the spine's width) and position down the spine are adjustable.
  const S = F.spineLogoSize ?? 1, P = F.spineLogoPos ?? .5;
  const start = top + len * .04, end = len * .87, span = end - start;
  const maxLen = span * clamp(.82 * S, .25, 1), maxThick = thick * clamp(.82 * S, .25, .96);
  const place = l => start + l / 2 + (span - l) * P;   // centre of an item of length l
  const logo = state.images.logo?.img;
  const longLogo = logo && (logo.naturalWidth || logo.width) / (logo.naturalHeight || logo.height) >= 3.2;
  // What's behind the logo: the part of the spine's background it sits on.
  const bgUnder = (at, l) => {   // colours sampled across the area the logo covers
    const ai = currentSpine();
    if (!ai) return [T.bg];
    const k = ai.strip.height / len, c = el('canvas'); c.width = 8; c.height = 48;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(ai.strip, 0, Math.max(0, (at - l / 2) * k), ai.strip.width, Math.max(1, l * k), 0, 0, 8, 48);
    const d = x.getImageData(0, 0, 8, 48).data, out = [];
    for (let i = 0; i < d.length; i += 4) out.push(rgbToHex(d[i], d[i + 1], d[i + 2]));
    return out;
  };
  const ow = Math.max(2, mmPx(.35));
  if (logo && (F.spineContent === 'logo' || (F.spineContent === 'auto' && longLogo))) {
    const box = containRect(logo, 0, 0, maxLen, maxThick);
    const c = containRect(logo, place(box.w), 0, maxLen, maxThick);
    const edge = spineOutline(logoColour(), bgUnder(place(box.w), box.w));
    if (edge) {   // a crisp outline (not a shadow): the logo's silhouette, drawn around it
      const sil = el('canvas'); sil.width = Math.ceil(c.w); sil.height = Math.ceil(c.h);
      const sx = sil.getContext('2d');
      sx.drawImage(logo, 0, 0, sil.width, sil.height);
      sx.globalCompositeOperation = 'source-in'; sx.fillStyle = edge; sx.fillRect(0, 0, sil.width, sil.height);
      for (let a = 0; a < 16; a++) ctx.drawImage(sil, c.x + Math.cos(a * Math.PI / 8) * ow, c.y + Math.sin(a * Math.PI / 8) * ow, c.w, c.h);
    }
    ctx.drawImage(logo, c.x, c.y, c.w, c.h);
  } else {
    const t = F.headUpper ? (X.title || state.game?.name || '').toUpperCase() : (X.title || state.game?.name || '');
    let size = thick * clamp(.62 * S, .2, .9);
    ctx.font = fontCss(F.headWeight, size, F.headFamily); setSpacing(ctx, size * .05);
    while (ctx.measureText(t).width > maxLen && size > 6) { size *= .94; ctx.font = fontCss(F.headWeight, size, F.headFamily); setSpacing(ctx, size * .05); }
    const tw = ctx.measureText(t).width, edge = spineOutline(T.headline, bgUnder(place(tw), tw));
    if (edge) { ctx.lineJoin = 'round'; ctx.lineWidth = ow * 2; ctx.strokeStyle = edge; ctx.strokeText(t, place(tw), thick * .03); }
    ctx.fillStyle = T.headline; ctx.fillText(t, place(tw), thick * .03);
    setSpacing(ctx, 0);
  }
  ctx.restore();
}

// On-screen only: fold lines and the safe area (never exported).
function drawCaseGuides(ctx) {
  const d = caseDims(), H = d.heightPx, W = d.panelPx * 2 + d.spinePx, safe = mmPx(4);
  ctx.save();
  ctx.lineWidth = 3; ctx.setLineDash([18, 12]);
  ctx.strokeStyle = 'rgba(255,255,255,.75)';
  for (const x of [d.panelPx, d.panelPx + d.spinePx]) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.setLineDash([8, 10]);
  for (const [x0, w] of [[0, d.panelPx], [d.panelPx + d.spinePx, d.panelPx]]) ctx.strokeRect(x0 + safe, safe, w - 2 * safe, H - 2 * safe);
  const fx = d.panelPx + d.spinePx, pl = frontPlacement(), snap = state.frontSnap || {};
  const onX = pl && Math.abs(pl.fx - .5) < 1e-3, onY = pl && Math.abs(pl.fy - .5) < 1e-3;
  for (const [lit, draw] of [[onX, () => { ctx.moveTo(fx + d.panelPx / 2, 0); ctx.lineTo(fx + d.panelPx / 2, H); }],
                             [onY, () => { ctx.moveTo(fx, H / 2); ctx.lineTo(fx + d.panelPx, H / 2); }]]) {
    const active = lit && snap.dragging;
    ctx.strokeStyle = active ? '#4ee6ff' : lit ? 'rgba(78,230,255,.55)' : 'rgba(255,255,255,.22)';
    ctx.lineWidth = active ? 5 : 3; ctx.setLineDash(active || lit ? [] : [6, 10]);
    ctx.beginPath(); draw(); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = fontCss(700, H * .018, 'Inter'); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  for (const [label, x] of [['BACK', d.panelPx / 2], ['SPINE', d.panelPx + d.spinePx / 2], ['FRONT', d.panelPx * 1.5 + d.spinePx]]) {
    const tw = ctx.measureText(label).width + 24, y = H - 14;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; roundRectPath(ctx, { x: x - tw / 2, y: y - H * .026, w: tw, h: H * .026 }, 8); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillText(label, x, y - 4);
  }
  ctx.restore();
}

function drawEmpty(ctx, W, H, u, T, F) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1a2030'); g.addColorStop(1, '#0c0e14');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 3 * u;
  ctx.setLineDash([14 * u, 12 * u]);
  roundRectPath(ctx, { x: W * .06, y: H * .06, w: W * .88, h: H * .88 }, 24 * u); ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.font = fontCss(700, Math.min(W * .06, H * .08), 'Inter');
  ctx.fillText('Pick a game to begin', W / 2, H / 2 - H * .02);
  ctx.fillStyle = 'rgba(255,255,255,.45)';
  ctx.font = fontCss(400, Math.min(W * .028, H * .04), 'Inter');
  ctx.fillText('Search above — your installed games are listed first', W / 2, H / 2 + H * .035);
}

function drawSteamArt(ctx, key, W, H, u, L, F, T, hit) {
  ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
  drawKeyArt(ctx, { x: 0, y: 0, w: W, h: H }, L, F, T, u, hit);
  if (key !== 'hero' && F.fade > 0) {
    const g = ctx.createLinearGradient(0, H * (key === 'cover' ? .42 : .3), 0, H);
    g.addColorStop(0, rgba(T.bg, 0)); g.addColorStop(1, rgba(T.bg, (key === 'cover' ? .92 : .6) * F.fade));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  drawGrain(ctx, W, H, F);
  const lr = drawLogoLayer(ctx, key, W, H, u, L, F, T);
  if (lr) hit.logo = lr;
  if (F.border > 0) {
    const bw = F.border * u;
    ctx.strokeStyle = F.borderColor; ctx.lineWidth = bw;
    ctx.strokeRect(bw / 2, bw / 2, W - bw, H - bw);
  }
}

/* ------------------------------------------------------- the box back */
function drawBack(ctx, W, H, u, L, F, X, T, hit) {
  const cine = F.boxStyle === 'cinematic';
  const m = W * .065;
  const bgImg = state.images.bg?.img;

  // Base: the background colour exactly as chosen. The glassy look (a blurred wash of the key
  // art over it) is optional.
  ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
  if (bgImg && !cine && F.glassBack) {
    ctx.save();
    ctx.globalAlpha = T.light ? .2 : .3;
    ctx.filter = `blur(${Math.round(50 * u)}px) saturate(130%)`;
    drawImageCover(ctx, bgImg, { x: 0, y: 0, w: W, h: H }, 1, 0, 0, 110 * u);
    ctx.restore();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgba(T.bg, .2)); g.addColorStop(1, rgba(T.bg, .78));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  const bandH = F.showBand ? H * .04 : 0;
  const footerH = H * .092, footerY = H - footerH;
  const cw = W - 2 * m;
  const baseGap = H * .02;           // one spacing rhythm for every section

  // ---- measure every section
  const descOpts = { family: F.bodyFamily, weight: F.bodyWeight, size: W * .0196, lh: 1.46, paraGap: .55, color: T.text, align: F.descAlign, minScale: .8 };
  const head = X.headline.trim() ? fitHeadline(ctx, X.headline, cw, W * .054, F) : null;
  const descFull = X.description.trim() ? measureParagraph(ctx, X.description, cw, descOpts) + 1 : 0;
  const descMin = Math.min(descFull, descOpts.size * descOpts.lh * 4);
  const shotGap = W * .02, shotW = (cw - 2 * shotGap) / 3, shotH = F.showShots ? shotW * 9 / 16 : 0;
  let feats = F.showFeatures ? X.features.split('\n').map(t => t.trim()).filter(Boolean) : [];
  const reqs = F.showReqs ? X.requirements.split('\n').map(t => t.trim()).filter(Boolean) : [];
  const badges = F.showBadges ? activeBadges() : [];
  const badgeH = badges.length ? W * .042 : 0;
  // With no key features, the requirements get a box sized to their text — beside the feature
  // icons (icons stacked on the left, requirements on the right), or centred on their own.
  const iconH = W * .042, groupGap = W * .035;
  const compact = () => !feats.length && reqs.length > 0;
  const iconGrid = badges.length ? drawBadges(ctx, badges, 0, 0, cw * .55, iconH, F, T, u, 'grid', true) : { w: 0, h: 0 };
  const reqBox = reqs.length ? measureReqBox(ctx, reqs, F, W, badges.length ? cw - iconGrid.w - groupGap : cw) : null;
  const iconStackH = iconGrid.h;
  const measureInfoH = () => compact() ? Math.max(reqBox.h, iconStackH)
    : feats.length || reqs.length ? measureInfo(ctx, feats, reqs, F, W, cw) : 0;
  let infoH = measureInfoH(), descH = descFull;
  const stackH = g => {
    const parts = [head ? head.height : 0, descH, shotH, infoH, compact() ? 0 : badgeH].filter(h => h > 0);
    return parts.reduce((a, h) => a + h, 0) + g * Math.max(0, parts.length - 1);
  };
  const partCount = () => [head, descH, shotH, infoH, badgeH].filter(Boolean).length;

  // ---- decide where the stack goes and how tall the key art is
  let art, contentTop, gap = baseGap;
  const fit = room => {   // too tall: shorten the description, then drop features
    if (stackH(gap) > room) descH = Math.max(descMin, descH - (stackH(gap) - room));
    while (stackH(gap) > room && feats.length > 1) { feats = feats.slice(0, -1); infoH = measureInfoH(); }
    if (stackH(gap) > room) descH = Math.max(descOpts.size * descOpts.lh * 2, descH - (stackH(gap) - room));
  };
  if (!cine) {
    const padTop = baseGap * .7, padBottom = baseGap * 1.1;
    const artMin = H * .26, artMax = H * .52;
    let artH = retailArtH(W, H);
    const room = () => footerY - padBottom - (bandH + artH) - padTop;
    if (stackH(gap) > room()) artH = Math.max(artMin, artH - (stackH(gap) - room()));
    fit(room());
    // Space to spare: the key art takes it, then the gaps loosen slightly.
    let extra = room() - stackH(gap);
    if (extra > 0) { const grow = Math.min(extra, artMax - artH); artH += grow; extra -= grow; }
    if (extra > 0 && partCount() > 1) gap += Math.min(extra / (partCount() - 1), baseGap * .6);
    art = { x: 0, y: bandH, w: W, h: artH };
    contentTop = bandH + artH + padTop;
  } else {
    art = { x: 0, y: 0, w: W, h: H };
    const lr0 = logoRect('boxback', W, H, L, { y: 0, h: H });
    const minTop = Math.max(H * .34, lr0 ? lr0.y + lr0.h + baseGap * 1.5 : 0);
    const bottom = footerY - baseGap * 1.1;
    fit(bottom - minTop);
    contentTop = bottom - stackH(gap);   // sits on the footer; the art shows above it
  }

  drawKeyArt(ctx, art, L, F, T, u, hit);

  // Fade the art into the theme colour.
  if (cine) {
    const t0 = clamp((contentTop - H * (.1 + .12 * F.fade)) / H, .05, .9), t1 = clamp(contentTop / H, t0 + .02, .95);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgba(T.bg, .45)); g.addColorStop(Math.min(.14, t0), rgba(T.bg, 0));
    g.addColorStop(t0, rgba(T.bg, 0)); g.addColorStop(t1, rgba(T.bg, .9)); g.addColorStop(1, rgba(T.bg, .97));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  } else {
    const y0 = art.y + art.h * (1 - .62 * F.fade - .06);
    const g = ctx.createLinearGradient(0, y0, 0, art.y + art.h);
    g.addColorStop(0, rgba(T.bg, 0)); g.addColorStop(.65, rgba(T.bg, .72)); g.addColorStop(1, rgba(T.bg, 1));
    ctx.fillStyle = g; ctx.fillRect(0, y0, W, art.y + art.h - y0 + 1);
  }

  // Platform band
  if (F.showBand) {
    ctx.fillStyle = cine ? rgba(T.band, .92) : T.band;
    ctx.fillRect(0, 0, W, bandH);
    ctx.fillStyle = contrast(T.accent, T.band) > 1.6 ? T.accent : mix(T.band, T.bandText, .5);
    ctx.fillRect(0, bandH, W, Math.max(2, 3 * u));
    ctx.fillStyle = T.bandText; ctx.textBaseline = 'middle';
    ctx.font = fontCss(F.headWeight, bandH * .56, F.headFamily); setSpacing(ctx, bandH * .1);
    ctx.textAlign = 'left';
    ctx.fillText(ellipsize(ctx, (X.platform || '').toUpperCase(), W * .4), m, bandH * .54);
    ctx.font = fontCss(F.bodyBold, bandH * .34, F.bodyFamily); setSpacing(ctx, bandH * .06);
    ctx.textAlign = 'right';
    ctx.fillText(ellipsize(ctx, (X.players || '').toUpperCase(), W * .5), W - m, bandH * .52);
    setSpacing(ctx, 0); ctx.textAlign = 'left';
  }

  // Grain on the key art only, so the plain background stays exactly the chosen colour.
  ctx.save();
  if (!cine && !F.glassBack) { ctx.beginPath(); ctx.rect(art.x, art.y, art.w, art.h); ctx.clip(); }
  drawGrain(ctx, W, H, F);
  ctx.restore();

  const frame = cine ? { y: 0, h: H } : { y: art.y, h: art.h };
  const lr = drawLogoLayer(ctx, 'boxback', W, H, u, L, F, T, frame);
  if (lr) hit.logo = lr;
  hit.logoFrameH = frame.h;

  // ---- draw the stack top to bottom with even spacing
  let y = contentTop;
  if (head) { drawHeadline(ctx, head, W / 2, y, F, T, u); y += head.height + gap; }
  if (descH > 0) y += drawParagraph(ctx, X.description, { x: m, y, w: cw, h: descH }, descOpts) + gap;
  if (shotH) {
    for (let i = 0; i < 3; i++) {
      drawShot(ctx, state.images['shot' + (i + 1)]?.img, { x: m + i * (shotW + shotGap), y, w: shotW, h: shotH }, T, u);
    }
    y += shotH + gap;
  }
  if (infoH && compact()) {
    // Requirements box locked to the left margin (in line with the screenshots and text above),
    // icons (two per row) just to its right with a small gap; top edges level.
    const gx = m;
    drawInfo(ctx, { x: gx, y, w: reqBox.w, h: reqBox.h }, [], reqs, F, T, W, u);
    if (badges.length) drawBadges(ctx, badges, gx + reqBox.w + groupGap, y, iconGrid.w, iconH, F, T, u, 'grid');
  } else {
    if (infoH) { drawInfo(ctx, { x: m, y, w: cw, h: infoH }, feats, reqs, F, T, W, u); y += infoH + gap; }
    if (badgeH) drawBadges(ctx, badges, m, y, cw, badgeH, F, T, u);
  }
  drawFooter(ctx, { x: 0, y: footerY, w: W, h: footerH }, X, F, T, W, u, m);
}

function fitHeadline(ctx, text, maxW, size, F) {
  const t = F.headUpper ? text.toUpperCase() : text;
  let sz = size, lines;
  for (;;) {
    ctx.font = fontCss(F.headWeight, sz, F.headFamily);
    setSpacing(ctx, sz * .035);
    lines = wrapLines(ctx, t, maxW);
    const widest = Math.max(...lines.map(l => ctx.measureText(l.text).width));
    if ((lines.length <= 2 && widest <= maxW) || sz < size * .45) break;
    sz *= .93;
  }
  setSpacing(ctx, 0);
  lines = lines.slice(0, 2);
  const lh = sz * 1.12;
  return { lines, size: sz, lh, height: lines.length * lh };
}
function drawHeadline(ctx, fit, cx, y, F, T, u) {
  ctx.save();
  ctx.font = fontCss(F.headWeight, fit.size, F.headFamily);
  setSpacing(ctx, fit.size * .035);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillStyle = T.headline;
  ctx.shadowColor = T.light ? 'rgba(0,0,0,.15)' : rgba(T.accent, .35);
  ctx.shadowBlur = 22 * u;
  fit.lines.forEach((l, i) => ctx.fillText(l.text, cx, y + i * fit.lh));
  ctx.restore();
  setSpacing(ctx, 0);
}

// A soft drop shadow under a rounded rect, blurred on its own padded canvas. (Chrome's
// shadowBlur on rounded rects leaves a stray 1 px bright line along the shadow's left edge.)
function drawRoundShadow(ctx, r, rad, blur, dy, color) {
  const pad = Math.ceil(blur * 2) + 2;   // shadowBlur b ≈ a Gaussian of σ = b/2; 4σ keeps the edges clear
  const c = el('canvas'); c.width = Math.ceil(r.w) + 2 * pad; c.height = Math.ceil(r.h) + 2 * pad;
  const x = c.getContext('2d');
  x.filter = `blur(${(blur / 2).toFixed(1)}px)`;
  roundRectPath(x, { x: pad, y: pad, w: r.w, h: r.h }, rad); x.fillStyle = color; x.fill();
  ctx.drawImage(c, r.x - pad, r.y - pad + dy);
}

function drawShot(ctx, img, r, T, u) {
  const rad = 8 * u;
  drawRoundShadow(ctx, r, rad, 26 * u, 9 * u, 'rgba(0,0,0,.5)');
  ctx.save();
  roundRectPath(ctx, r, rad); ctx.fillStyle = T.bg; ctx.fill();
  ctx.restore();
  ctx.save();
  roundRectPath(ctx, r, rad); ctx.clip();
  if (img) drawImageCover(ctx, img, r);
  else {
    ctx.fillStyle = T.panel; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = fontCss(400, r.h * .1, 'Inter');
    ctx.fillText('Screenshot', r.x + r.w / 2, r.y + r.h / 2);
  }
  ctx.restore();
  if (state.fx.shotBorder) {   // accent-coloured frame around each screenshot (optional)
    ctx.save();
    roundRectPath(ctx, r, rad);
    ctx.lineWidth = Math.max(1.5, 2.5 * u); ctx.strokeStyle = rgba(T.accent, .8); ctx.stroke();
    ctx.restore();
  }
}

// Shared metrics for the features / requirements panel.
function infoMetrics(W, rw) {
  const fs = W * .0152, rs = W * .0122, hs = W * .0172;
  return { pad: rw * .035, hs, headH: hs * 1.65, fs, flh: fs * 1.3, fgap: fs * .35, indent: fs * 1.25, rs, rlh: rs * 1.55 };
}
// Split a feature into words; a short "Label:" prefix is set in bold.
function wrapFeature(ctx, f, maxW, F, fs) {
  const i = f.indexOf(':'), labelled = i >= 3 && i <= 48 && i < f.length - 3;
  const words = [
    ...(labelled ? f.slice(0, i + 1) : '').split(/\s+/).filter(Boolean).map(t => ({ t, b: true })),
    ...(labelled ? f.slice(i + 1) : f).split(/\s+/).filter(Boolean).map(t => ({ t, b: false })),
  ];
  const reg = fontCss(F.bodyWeight, fs, F.bodyFamily), bold = fontCss(F.bodyBold, fs, F.bodyFamily);
  ctx.font = reg;
  const space = ctx.measureText(' ').width;
  const lines = [[]];
  let x = 0;
  for (const w of words) {
    ctx.font = w.b ? bold : reg;
    const ww = ctx.measureText(w.t).width;
    if (x > 0 && x + space + ww > maxW) { lines.push([]); x = 0; }
    if (x > 0) x += space;
    lines.at(-1).push({ ...w, x, w: ww, font: w.b ? bold : reg });
    x += ww;
  }
  return lines;
}
// A requirements-only box just big enough for its text (drawInfo pads 3.5% of the box width a side).
function measureReqBox(ctx, reqs, F, W, maxW) {
  const M = infoMetrics(W, 1);
  ctx.font = fontCss(F.headWeight, M.hs, F.headFamily); setSpacing(ctx, M.hs * .1);
  const title = 'Minimum System Requirements';
  let tw = ctx.measureText(F.headUpper ? title.toUpperCase() : title).width;
  setSpacing(ctx, 0);
  for (const line of reqs) {
    const i = line.indexOf(':'), label = i > 0 ? line.slice(0, i).trim() : '', val = i > 0 ? line.slice(i + 1).trim() : line;
    ctx.font = fontCss(F.bodyBold, M.rs, F.bodyFamily);
    const lw = label ? ctx.measureText(label.toUpperCase() + '  ').width : 0;
    ctx.font = fontCss(F.bodyWeight, M.rs, F.bodyFamily);
    tw = Math.max(tw, lw + ctx.measureText(val).width);
  }
  const w = Math.min(maxW, (tw + 4) / (1 - .07));
  return { w, h: measureInfo(ctx, [], reqs, F, W, w) };
}

function measureInfo(ctx, feats, reqs, F, W, rw) {
  const M = infoMetrics(W, rw), inner = rw - 2 * M.pad;
  const featW = feats.length && reqs.length ? inner * .55 : inner;
  ctx.font = fontCss(F.bodyWeight, M.fs, F.bodyFamily);
  const fh = feats.length ? M.headH + feats.reduce((a, f) => a + Math.min(2, wrapFeature(ctx, f, featW - M.indent, F, M.fs).length) * M.flh + M.fgap, 0) - M.fgap : 0;
  const rh = reqs.length ? M.headH + reqs.length * M.rlh : 0;
  return Math.max(fh, rh) + M.pad * 1.7;
}

function drawInfo(ctx, r, feats, reqs, F, T, W, u) {
  ctx.save();
  roundRectPath(ctx, r, 10 * u);
  ctx.fillStyle = rgba(T.panel, .82); ctx.fill();
  ctx.lineWidth = Math.max(1, 1.5 * u); ctx.strokeStyle = rgba(T.accent, .28); ctx.stroke();
  ctx.restore();

  const M = infoMetrics(W, r.w), pad = M.pad;
  const inner = { x: r.x + pad, y: r.y + pad * .85, w: r.w - 2 * pad, h: r.h - pad * 1.7 };
  const both = feats.length && reqs.length;
  const featW = both ? inner.w * .55 : inner.w;
  const reqX = both ? inner.x + featW + pad : inner.x;
  const reqW = both ? inner.w - featW - pad : inner.w;
  const hs = M.hs;
  const header = (txt, x, y) => {
    ctx.font = fontCss(F.headWeight, hs, F.headFamily); setSpacing(ctx, hs * .1);
    ctx.fillStyle = T.headline; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(F.headUpper ? txt.toUpperCase() : txt, x, y);
    setSpacing(ctx, 0);
    return y + hs * 1.65;
  };
  const maxY = inner.y + inner.h;

  if (feats.length) {
    let y = header('Key Features', inner.x, inner.y);
    const fs = M.fs, lh = M.flh, indent = M.indent;
    const maxW = featW - indent;
    for (const f of feats) {
      const all = wrapFeature(ctx, f, maxW, F, fs), lines = all.slice(0, 2);
      if (y + lines.length * lh > maxY + 1) break;   // never draw half a feature
      if (all.length > 2) {  // trim the second line to fit an ellipsis
        const last = lines[1];
        ctx.font = last.at(-1).font;
        const ell = ctx.measureText('…').width;
        while (last.length > 1 && last.at(-1).x + last.at(-1).w + ell > maxW) last.pop();
        last[last.length - 1] = { ...last.at(-1), t: last.at(-1).t.replace(/[,;:.]$/, '') + '…' };
      }
      const d = fs * .24, by = y + lh / 2;
      ctx.fillStyle = T.accent;
      ctx.beginPath(); ctx.moveTo(inner.x + d, by - d); ctx.lineTo(inner.x + 2 * d, by); ctx.lineTo(inner.x + d, by + d); ctx.lineTo(inner.x, by); ctx.closePath(); ctx.fill();
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      lines.forEach((ln, i) => {
        if (y + (i + 1) * lh > maxY + 1) return;
        for (const w of ln) {
          ctx.font = w.font; ctx.fillStyle = w.b ? T.headline : T.text;
          ctx.fillText(w.t, inner.x + indent + w.x, y + (lh - fs) / 2 + i * lh);
        }
      });
      y += lines.length * lh + M.fgap;
    }
  }
  if (both) {
    ctx.strokeStyle = rgba(T.text, .14); ctx.lineWidth = Math.max(1, 1.5 * u);
    ctx.beginPath(); ctx.moveTo(inner.x + featW + pad / 2, inner.y); ctx.lineTo(inner.x + featW + pad / 2, maxY); ctx.stroke();
  }
  if (reqs.length) {
    let y = header(both ? 'System Requirements' : 'Minimum System Requirements', reqX, inner.y);
    const rs = M.rs, lh = M.rlh;
    ctx.textBaseline = 'top';
    for (const line of reqs) {
      if (y + lh > maxY) break;
      const i = line.indexOf(':');
      const label = i > 0 ? line.slice(0, i).trim() : '', val = i > 0 ? line.slice(i + 1).trim() : line;
      let x = reqX;
      if (label) {
        ctx.font = fontCss(F.bodyBold, rs, F.bodyFamily); ctx.fillStyle = T.text;
        const lt = label.toUpperCase() + '  ';
        ctx.fillText(lt, x, y); x += ctx.measureText(lt).width;
      }
      ctx.font = fontCss(F.bodyWeight, rs, F.bodyFamily); ctx.fillStyle = T.muted;
      ctx.fillText(ellipsize(ctx, val, reqX + reqW - x), x, y);
      y += lh;
    }
  }
}

function activeBadges() {
  return BADGES.filter(b => state.fx[b.fx]).map(b => b.icon === 'pad' && state.controllerLevel
    ? { ...b, label: state.controllerLevel === 'partial' ? 'Partial controller support' : 'Full controller support' } : b);
}

// Simple pictograms drawn in fg on a bg-coloured tile, centred on (cx, cy), size s.
function drawIcon(ctx, kind, cx, cy, s, fg, bg) {
  ctx.save();
  ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const person = (x, y, k, outline) => {
    const head = () => { ctx.beginPath(); ctx.arc(x, y - .21 * s * k, .17 * s * k, 0, Math.PI * 2); };
    const body = () => { ctx.beginPath(); ctx.ellipse(x, y + .43 * s * k, .33 * s * k, .36 * s * k, 0, Math.PI, 0); ctx.closePath(); };
    for (const shape of [head, body]) {
      shape();
      if (outline) { ctx.save(); ctx.strokeStyle = bg; ctx.lineWidth = .09 * s; ctx.stroke(); ctx.restore(); }
      ctx.fill();
    }
  };
  if (kind === 'person') person(cx, cy - .02 * s, 1.05);
  else if (kind === 'people') { person(cx + .2 * s, cy - .05 * s, .82); person(cx - .12 * s, cy + .02 * s, .95, true); }
  else if (kind === 'globe') {
    const r = .4 * s;
    ctx.lineWidth = .075 * s;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy, r * .42, r, 0, 0, Math.PI * 2); ctx.stroke();
    for (const dy of [-.45, 0, .45]) {
      const hw = Math.sqrt(1 - dy * dy) * r;
      ctx.beginPath(); ctx.moveTo(cx - hw, cy + dy * r); ctx.lineTo(cx + hw, cy + dy * r); ctx.stroke();
    }
  } else if (kind === 'screen') {
    ctx.lineWidth = .075 * s;
    roundRectPath(ctx, { x: cx - .42 * s, y: cy - .32 * s, w: .84 * s, h: .54 * s }, .06 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - .32 * s); ctx.lineTo(cx, cy + .22 * s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - .2 * s, cy + .4 * s); ctx.lineTo(cx + .2 * s, cy + .4 * s); ctx.stroke();
  } else if (kind === 'pad') {
    roundRectPath(ctx, { x: cx - .44 * s, y: cy - .24 * s, w: .88 * s, h: .36 * s }, .16 * s); ctx.fill();
    for (const dx of [-.28, .28]) { ctx.beginPath(); ctx.arc(cx + dx * s, cy + .1 * s, .17 * s, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = bg;
    const px = cx - .24 * s, py = cy - .05 * s;
    ctx.fillRect(px - .1 * s, py - .03 * s, .2 * s, .06 * s);
    ctx.fillRect(px - .03 * s, py - .1 * s, .06 * s, .2 * s);
    for (const [bx, by] of [[.2, -.1], [.3, 0]]) { ctx.beginPath(); ctx.arc(cx + bx * s, cy + by * s, .045 * s, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

// mode 'row': centred in a row; 'grid': two per row, all the same width (measure: size only).
function drawBadges(ctx, list, x, y, maxW, h, F, T, u, mode = 'row', measure = false) {
  const labelLines = t => {
    const w = t.split(' ');
    if (w.length < 2 || t.length < 13) return [t];
    let best = null;
    for (let i = 1; i < w.length; i++) {
      const a = w.slice(0, i).join(' '), b = w.slice(i).join(' '), d = Math.abs(a.length - b.length);
      if (!best || d < best.d) best = { d, l: [a, b] };
    }
    return best.l;
  };
  const layout = hh => {
    ctx.font = fontCss(F.bodyBold, hh * .25, F.bodyFamily); setSpacing(ctx, hh * .25 * .06);
    return list.map(b => {
      const lines = labelLines(b.label.toUpperCase());
      return { b, lines, w: hh * 1.24 + Math.max(...lines.map(l => ctx.measureText(l).width)) + hh * .3 };
    });
  };
  const grid = mode === 'grid', cols = grid ? Math.min(2, list.length) : list.length;
  let hh = h, gap = h * .3, items = layout(hh);
  const tileW = () => Math.max(...items.map(it => it.w));
  const width = () => grid ? cols * tileW() + (cols - 1) * gap : items.reduce((a, it) => a + it.w, 0) + gap * (items.length - 1);
  if (width() > maxW) { hh = h * maxW / width(); gap = hh * .3; items = layout(hh); }
  const rows = grid ? Math.ceil(items.length / 2) : 1, gapY = hh * .28;
  if (measure) { setSpacing(ctx, 0); return { w: width(), h: rows * hh + (rows - 1) * gapY }; }
  if (grid) { const w = tileW(); items.forEach(it => { it.w = w; }); }
  let cx = grid ? x : x + (maxW - width()) / 2, cy = y + (grid ? 0 : (h - hh) / 2);
  const rad = hh * .16, fg = readableOn(T.accent);
  for (const [n, it] of items.entries()) {
    if (grid) { cx = x + (n % 2) * (it.w + gap); cy = y + Math.floor(n / 2) * (hh + gapY); }
    ctx.save();
    roundRectPath(ctx, { x: cx, y: cy, w: it.w, h: hh }, rad);
    ctx.fillStyle = rgba(T.panel, .88); ctx.fill();
    ctx.lineWidth = Math.max(1, 1.5 * u); ctx.strokeStyle = rgba(T.accent, .45); ctx.stroke();
    roundRectPath(ctx, { x: cx, y: cy, w: hh, h: hh }, rad);
    ctx.fillStyle = T.accent; ctx.fill();
    ctx.restore();
    drawIcon(ctx, it.b.icon, cx + hh / 2, cy + hh / 2, hh * .68, fg, T.accent);
    ctx.fillStyle = T.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const lh = hh * .3, ty = cy + hh / 2 - (it.lines.length - 1) * lh / 2 + hh * .01;
    it.lines.forEach((l, i) => ctx.fillText(l, cx + hh * 1.24, ty + i * lh));
    if (!grid) cx += it.w + gap;
  }
  setSpacing(ctx, 0);
}

function drawFooter(ctx, r, X, F, T, W, u, m) {
  ctx.fillStyle = T.footer; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = T.accent; ctx.fillRect(r.x, r.y, r.w, Math.max(2, 3 * u));
  const cy = r.y + r.h / 2 + 1.5 * u;
  const itemH = r.h * .56;   // keeps the age box and barcode inside the 4 mm safe area
  let left = m, right = W - m;
  const gap = r.h * .28;

  if (F.showRating && X.rating.trim()) {
    const s = itemH, x = left, y = cy - s / 2;
    ctx.fillStyle = '#ffffff'; roundRectPath(ctx, { x, y, w: s, h: s }, s * .08); ctx.fill();
    ctx.strokeStyle = '#111'; ctx.lineWidth = s * .05;
    roundRectPath(ctx, { x: x + s * .07, y: y + s * .07, w: s * .86, h: s * .86 }, s * .05); ctx.stroke();
    ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let fs = s * .42;
    ctx.font = fontCss(800, fs, 'Inter');
    while (ctx.measureText(X.rating).width > s * .76 && fs > 6) { fs *= .92; ctx.font = fontCss(800, fs, 'Inter'); }
    ctx.fillText(X.rating.trim(), x + s / 2, y + s / 2 + fs * .04);
    left += s + gap;
  }
  const link = qrTarget();
  if (F.showBarcode && F.codeKind === 'qr' && link && window.qrcode) {
    // A real QR code: scanning it opens your link, or the game's Steam store page.
    const qs = r.h * .8;
    drawQr(ctx, right - qs, cy - qs / 2, qs, link);
    right -= qs + gap;
  } else if (F.showBarcode) {
    const bw = r.h * 1.4, bh = itemH;
    drawBarcode(ctx, right - bw, cy - bh / 2, bw, bh, String(state.game?.storeAppId || state.game?.name || '0'));
    right -= bw + gap;
  }
  const logo = F.footerLogo ? state.images.logo?.img : null;
  if (logo) {
    const lw = W * .15, lh = r.h * .52;
    const c = containRect(logo, right - lw / 2, cy, lw, lh);
    ctx.save(); ctx.globalAlpha = .92; ctx.drawImage(logo, c.x, c.y, c.w, c.h); ctx.restore();
    right -= lw + gap;
  }
  if (F.showLegal && X.legal.trim()) {
    drawParagraph(ctx, X.legal, { x: left, y: r.y + r.h * .12, w: right - left, h: r.h * .78 }, {
      family: F.bodyFamily, weight: F.bodyWeight, size: W * .0104, lh: 1.38, color: T.muted, align: 'left', valign: 'middle', minScale: .75,
    });
  }
}

// Where the QR code points: your custom link, else the game's Steam store page.
function qrTarget() {
  const custom = (state.text.qrLink || '').trim();
  if (custom) return /^[a-z][a-z0-9+.-]*:/i.test(custom) ? custom : 'https://' + custom;
  return state.game?.storeAppId && !state.game.shortcut ? `https://store.steampowered.com/app/${state.game.storeAppId}` : null;
}
function qrStatus() {
  if (state.fx.codeKind !== 'qr') return '';
  const link = qrTarget();
  if (!link) return 'No link for this game yet, so the decorative barcode is shown. Add a link above to get a scannable QR code.';
  const custom = !!(state.text.qrLink || '').trim();
  return `Scanning opens: ${link}${custom ? '' : ' (Steam store page — type a link above to use your own)'}`
    + (link.length > 70 ? '. That’s a long link, so the code is denser — a shorter link scans more easily.' : '');
}

// QR code on a white tile with the standard quiet zone (4 modules), crisp at any size.
function drawQr(ctx, x, y, size, text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text); qr.make();
  const n = qr.getModuleCount(), m = size / (n + 8);
  ctx.save();
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.isDark(r, c)) ctx.fillRect(x + (c + 4) * m, y + (r + 4) * m, m + .5, m + .5);
  }
  ctx.restore();
}

// Decorative barcode (for the retail look only — not a real product code).
function drawBarcode(ctx, x, y, w, h, seed) {
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
  const pad = w * .08, bx = x + pad, bw = w - pad * 2, top = y + h * .1, barsH = h * .62;
  const bits = [1, 0, 1];
  for (let i = 0; i < 42; i++) bits.push(rand() > .5 ? 1 : 0);
  bits.push(0, 1, 0, 1, 0);
  for (let i = 0; i < 42; i++) bits.push(rand() > .5 ? 1 : 0);
  bits.push(1, 0, 1);
  const unit = bw / bits.length;
  ctx.fillStyle = '#000';
  bits.forEach((b, i) => {
    if (!b) return;
    const guard = i < 3 || i >= bits.length - 3 || (i >= 45 && i < 50);
    ctx.fillRect(bx + i * unit, top, unit + .4, guard ? barsH + h * .08 : barsH);
  });
  const digits = (seed.replace(/\D/g, '') + '0000000000000').slice(0, 12);
  ctx.font = fontCss(500, h * .15, 'Inter'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(`${digits[0]}  ${digits.slice(1, 6)}  ${digits.slice(6, 11)}  ${digits[11]}`, x + w / 2, top + barsH + h * .07);
}

/* ======================================================= stage & canvas */
const canvas = $('#canvas');
let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const { w, h } = tplSize(state.tpl);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    state.hit = render(ctx, state.tpl);
    if (state.tpl === 'case' && state.game && state.fx.showGuides) drawCaseGuides(ctx);
    const status = document.getElementById('spineStatus');
    if (status) status.textContent = spineStatus();
    const qs = document.getElementById('qrStatus');
    if (qs) qs.textContent = qrStatus();
  });
}

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
}
const inside = (p, r) => r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
function hitMode(p) {
  if (inside(p, state.hit.logo)) return 'logo';
  if (state.hit.bg && inside(p, state.hit.bg.rect)) return 'bg';
  return null;
}
let drag = null;
canvas.addEventListener('pointerdown', e => {
  const p = canvasPoint(e), mode = hitMode(p);
  if (!mode || !state.game) return;
  drag = { mode, last: p };
  if (mode === 'bg' && state.tpl === 'case') {
    const pl = frontPlacement();
    if (pl) drag.raw = { x: pl.fx, y: pl.fy };   // unsnapped position, so you can pull out of a snap
    state.frontSnap = { dragging: true };
  }
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', e => {
  const p = canvasPoint(e);
  if (!drag) { canvas.style.cursor = hitMode(p) === 'logo' ? 'move' : hitMode(p) ? 'grab' : 'default'; return; }
  const L = state.layouts[state.tpl], dx = p.x - drag.last.x, dy = p.y - drag.last.y;
  if (drag.mode === 'logo') {
    L.logoX = clamp(L.logoX + dx / (state.hit.logoFrameW || canvas.width), 0, 1);
    L.logoY = clamp(L.logoY + dy / (state.hit.logoFrameH || canvas.height), 0, 1);
  } else if (state.tpl === 'case') {   // the front: free movement, snapping to its 50% lines
    if (drag.raw) {
      const d = caseDims();
      drag.raw.x += dx / d.panelPx; drag.raw.y += dy / d.heightPx;
      L.frontCx = e.altKey ? drag.raw.x : snapHalf(drag.raw.x);
      L.frontCy = e.altKey ? drag.raw.y : snapHalf(drag.raw.y);
      const pl = frontPlacement();   // keep what's stored inside the reachable range
      if (pl) { L.frontCx = pl.fx; L.frontCy = pl.fy; }
    }
  } else {
    const b = state.hit.bg;
    if (b && b.ox > .5) L.bgX = clamp(L.bgX + dx / b.ox, -1, 1);
    if (b && b.oy > .5) L.bgY = clamp(L.bgY + dy / b.oy, -1, 1);
  }
  drag.last = p;
  scheduleRender();
});
const endDrag = () => {
  if (!drag) return;
  drag = null; state.frontSnap = null;
  canvas.classList.remove('dragging'); syncControls(); scheduleRender();
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
const syncSoon = debounce(() => syncControls(), 150);
canvas.addEventListener('wheel', e => {
  const mode = hitMode(canvasPoint(e));
  if (!mode || !state.game) return;
  e.preventDefault();
  const L = state.layouts[state.tpl], f = e.deltaY < 0 ? 1.05 : 1 / 1.05;
  if (mode === 'logo') L.logoScale = clamp(L.logoScale * f, .08, 1.4);
  else L.bgZoom = clamp(L.bgZoom * f, 1, state.tpl === 'case' ? 3 : 5);
  scheduleRender(); syncSoon();
}, { passive: false });

/* ============================================================= controls */
const openGroups = new Map();
let bindings = [];
function getVal(it) {
  if (it.scope === 'back') return state.layouts.boxback[it.k];   // the back panel, from any tab
  if (it.scope === 'layout') return state.layouts[state.tpl][it.k];
  if (it.scope === 'text') return state.text[it.k];
  return state.fx[it.k];
}
function setVal(it, v) {
  if (it.scope === 'back') state.layouts.boxback[it.k] = v;
  else if (it.scope === 'layout') state.layouts[state.tpl][it.k] = v;
  else if (it.scope === 'text') state.text[it.k] = v;
  else state.fx[it.k] = v;
}
const rng = (k, label, min, max, step, extra = {}) => ({ k, label, type: 'range', min, max, step, ...extra });
const pct = v => Math.round(v * 100) + '%';

const GROUPS = [
  { id: 'theme', title: 'Game theme', open: true, custom: renderThemeGroup },
  { id: 'type', title: 'Typography', open: true, custom: renderFontGroup },
  {
    id: 'case', title: 'Full case', only: ['case'], open: true, items: [
      { k: 'caseSize', type: 'select', label: 'Case', options: Object.keys(CASE_SIZES).map(k => [k, caseLabel(k)]), onchange: onCaseSize },
      rng('spineMm', 'Spine width', 6, 30, .5, { unit: ' mm', dp: 1, onchange: () => { autoCrop(['case']); updateTplTabs(); updateHint(); } }),
      rng('bgZoom', 'Front art size', 1, 3, .01, { scope: 'layout', fmt: pct }),
      { row: [rng('frontCx', 'Across', 0, 1, .005, { scope: 'layout', fmt: pct, onchange: clampFront }), rng('frontCy', 'Up / down', 0, 1, .005, { scope: 'layout', fmt: pct, onchange: clampFront })] },
      { row: [{ type: 'button', label: 'Centre', action: () => { Object.assign(state.layouts.case, { frontCx: .5, frontCy: .5 }); clampFront(); } },
              { type: 'button', label: 'Auto', action: () => { autoPlaceFront(); syncControls(); scheduleRender(); } }] },
      { type: 'note', text: 'The front art is centred on the front. Drag it to move it — it snaps back to the 50% lines (hold Alt to move freely); scroll over it to resize.' },
      { row: [{ type: 'button', label: 'Continue front onto spine', action: () => continueSpine(false) },
              { type: 'button', label: 'Try again', action: () => continueSpine(true) }] },
      { type: 'button', label: 'Use plain spine', action: () => { state.spine = null; syncControls(); scheduleRender(); } },
      { type: 'button', label: 'Make 3D box renders (full quality)', action: () => make3DRenders() },
      { type: 'status', id: 'spineStatus', text: spineStatus },
      { row: [{ k: 'showLogo', scope: 'layout', type: 'toggle', label: 'Logo on front' }, { k: 'wrapBand', type: 'toggle', label: 'Band on front' }] },
      { row: [{ k: 'frontRating', type: 'toggle', label: 'Age box on front' }, { k: 'showGuides', type: 'toggle', label: 'Fold guides' }] },
      { k: 'spineContent', type: 'select', label: 'Spine shows', options: [['auto', 'Auto'], ['logo', 'Logo'], ['title', 'Title text']] },
      { row: [rng('spineLogoSize', 'Spine logo size', .4, 1.2, .01, { fmt: pct }), rng('spineLogoPos', 'Position down spine', 0, 1, .01, { fmt: pct })] },
      { row: [{ k: 'pcBadge', type: 'toggle', label: 'PC GAME badge' }, { k: 'spineOutline', type: 'select', label: 'Logo outline', options: [['auto', 'Auto'], ['on', 'Always'], ['off', 'Off']] }] },
    ],
  },
  {
    id: 'print', title: 'Print', only: ['case'], open: true, items: [
      { row: [{ k: 'bleed', type: 'toggle', label: '3 mm bleed' }, { k: 'cropMarks', type: 'toggle', label: 'Crop marks' }] },
      { k: 'pageSize', type: 'select', label: 'PDF page', options: [['fit', 'Exact size (print at 100%)'], ['a4', 'A4 landscape'], ['letter', 'US Letter landscape']] },
      { type: 'button', label: 'Save print-ready PDF', action: () => savePdf() },
      { type: 'note', text: 'The back panel is the Box back design — edit its text and layout on that tab. Print at 100% / “actual size”, then cut on the crop marks.' },
    ],
  },
  {
    id: 'layout', title: () => state.tpl === 'case' ? 'Back layout' : 'Box layout', only: ['boxback', 'case'], open: true, items: [
      { k: 'boxStyle', type: 'select', label: 'Style', options: [['retail', 'Retail — key art on top'], ['cinematic', 'Cinematic — full-bleed art']], onchange: applyBoxStyle },
      { k: 'caseSize', type: 'select', label: 'Case size (300 dpi print)', options: Object.keys(CASE_SIZES).map(k => [k, caseLabel(k)]), onchange: onCaseSize, except: ['case'] },
      { row: [{ k: 'showBand', type: 'toggle', label: 'Platform band' }, { k: 'showShots', type: 'toggle', label: 'Screenshots', onchange: () => renderSlots() }] },
      { k: 'shotBorder', type: 'toggle', label: 'Accent frame around screenshots' },
      { row: [{ k: 'showFeatures', type: 'toggle', label: 'Key features' }, { k: 'showReqs', type: 'toggle', label: 'Requirements' }] },
      { row: [{ k: 'showRating', type: 'toggle', label: 'Age box' }, { k: 'showBarcode', type: 'toggle', label: 'Code' }] },
      { k: 'codeKind', type: 'select', label: 'Code type', options: [['qr', 'QR code (scannable)'], ['barcode', 'Decorative barcode (not scannable)']] },
      { k: 'qrLink', scope: 'text', type: 'text', label: 'QR link (leave empty for the Steam store page)', placeholder: 'e.g. https://gog.com/game/… or itch.io page' },
      { type: 'status', id: 'qrStatus', text: qrStatus },
      { k: 'showLegal', type: 'toggle', label: 'Legal line' },
      { row: [{ k: 'showLogo', scope: 'back', type: 'toggle', label: 'Logo on back' }, { k: 'footerLogo', type: 'toggle', label: 'Small logo in footer' }] },
    ],
  },
  {
    id: 'badges', title: 'Feature icons', only: ['boxback', 'case'], open: true, items: [
      { k: 'showBadges', type: 'toggle', label: 'Show feature icons' },
      { row: [{ k: 'badgeSingle', type: 'toggle', label: 'Single-player' }, { k: 'badgeController', type: 'toggle', label: 'Controller' }] },
      { row: [{ k: 'badgeOnline', type: 'toggle', label: 'Online' }, { k: 'badgeCoop', type: 'toggle', label: 'Co-op' }] },
      { k: 'badgeLocal', type: 'toggle', label: 'Split screen' },
      { type: 'note', text: 'Switched on automatically from what the game supports on Steam.' },
    ],
  },
  {
    id: 'content', title: 'Back cover text', only: ['boxback', 'case'], open: true, items: [
      { k: 'headline', scope: 'text', type: 'text', label: 'Headline' },
      { k: 'description', scope: 'text', type: 'textarea', rows: 7, label: 'Description' },
      { k: 'descAlign', type: 'select', label: 'Paragraph alignment', options: [['justify', 'Justified'], ['left', 'Left'], ['center', 'Centred']] },
      { k: 'features', scope: 'text', type: 'textarea', rows: 6, label: 'Key features', note: 'One per line. “Label: detail” puts the label in bold.' },
      { k: 'requirements', scope: 'text', type: 'textarea', rows: 5, label: 'System requirements', note: 'Label: value — one per line' },
      { row: [{ k: 'platform', scope: 'text', type: 'text', label: 'Platform' }, { k: 'rating', scope: 'text', type: 'text', label: 'Age box', placeholder: 'e.g. 16+' }] },
      { k: 'players', scope: 'text', type: 'text', label: 'Band text (right side)', placeholder: 'Optional' },
      { k: 'legal', scope: 'text', type: 'textarea', rows: 3, label: 'Legal line' },
      { type: 'button', label: 'Refill everything from the Steam store', action: () => { fillTextFromStore(); syncControls(); scheduleRender(); } },
    ],
  },
  {
    id: 'art', title: () => state.tpl === 'case' ? 'Art adjustments' : 'Key art', items: [
      rng('bgZoom', 'Zoom', 1, 5, .01, { scope: 'layout', fmt: v => (+v).toFixed(2) + '×', except: ['case'] }),
      { row: [rng('bgX', 'Pan X', -1, 1, .01, { scope: 'layout' }), rng('bgY', 'Pan Y', -1, 1, .01, { scope: 'layout' })], except: ['case'] },
      rng('fade', 'Fade into theme', 0, 1, .01, { fmt: pct }),
      rng('blur', 'Blur', 0, 40, .5, { unit: 'px', dp: 1 }),
      { row: [rng('brightness', 'Brightness', 30, 170, 1, { unit: '%' }), rng('saturate', 'Saturation', 0, 220, 1, { unit: '%' })] },
      rng('contrast', 'Contrast', 50, 170, 1, { unit: '%' }),
    ],
  },
  {
    id: 'fx', title: 'Effects', items: [
      rng('vignette', 'Vignette', 0, 1, .01, { fmt: pct }),
      rng('grain', 'Film grain', 0, .5, .01, { fmt: pct }),
      rng('scanlines', 'Scanlines', 0, 1, .01, { fmt: pct }),
      { k: 'tintColor', type: 'color', label: 'Tint colour' },
      { row: [rng('tintStrength', 'Tint strength', 0, 1, .01, { fmt: pct }), { k: 'tintBlend', type: 'select', label: 'Blend', options: [['soft-light', 'Soft light'], ['overlay', 'Overlay'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['color', 'Colour'], ['source-over', 'Normal']] }] },
    ],
  },
  {
    id: 'logo', title: () => state.tpl === 'case' ? 'Front logo' : 'Logo', items: [
      { row: [{ k: 'showLogo', type: 'toggle', label: 'Show logo', scope: 'layout' }, { k: 'textLogo', type: 'toggle', label: 'Text logo', scope: 'layout' }] },
      { k: 'title', scope: 'text', type: 'text', label: 'Text logo wording', note: 'Used when there’s no logo image, or “Text logo” is on' },
      rng('logoScale', 'Size', .08, 1.4, .01, { scope: 'layout', fmt: pct }),
      { row: [rng('logoX', 'X', 0, 1, .005, { scope: 'layout', fmt: pct }), rng('logoY', 'Y', 0, 1, .005, { scope: 'layout', fmt: pct })] },
      rng('logoShadow', 'Shadow', 0, 1, .01, { fmt: pct }),
      { row: [rng('glowStrength', 'Glow', 0, 1, .01, { fmt: pct }), { k: 'glowColor', type: 'color', label: 'Glow' }] },
    ],
  },
  {
    id: 'frame', title: 'Frame', except: ['boxback', 'case'], items: [
      rng('border', 'Border', 0, 40, 1, { unit: 'px' }),
      { k: 'borderColor', type: 'color', label: 'Border colour' },
    ],
  },
];

function renderControls() {
  const root = $('#controls');
  root.replaceChildren();
  bindings = [];
  for (const g of GROUPS) {
    if (g.only && !g.only.includes(state.tpl)) continue;
    if (g.except && g.except.includes(state.tpl)) continue;
    const det = el('details', { class: 'group' });
    det.open = openGroups.has(g.id) ? openGroups.get(g.id) : !!g.open;
    det.addEventListener('toggle', () => openGroups.set(g.id, det.open));
    const body = el('div', { class: 'group-body' });
    if (g.custom) g.custom(body); else for (const it of g.items) { const n = buildItem(it); if (n) body.append(n); }
    det.append(el('summary', { text: typeof g.title === 'function' ? g.title() : g.title }), body);
    root.append(det);
  }
}
function syncControls() { for (const f of bindings) f(); }

function buildItem(it) {
  if ((it.only && !it.only.includes(state.tpl)) || (it.except && it.except.includes(state.tpl))) return null;
  if (it.row) return el('div', { class: 'ctl-row' }, it.row.map(buildItem).filter(Boolean));
  if (it.type === 'status') {
    const n = el('div', { class: 'note', id: it.id });
    bindings.push(() => { n.textContent = it.text(); });
    bindings.at(-1)();
    return n;
  }
  if (it.type === 'button') return el('button', { class: 'btn ghost small', text: it.label, onclick: it.action });
  if (it.type === 'note') return el('div', { class: 'note', text: it.text });
  const get = () => getVal(it);
  const set = v => { setVal(it, v); it.onchange?.(v); scheduleRender(); };
  const note = it.note ? el('div', { class: 'note', text: it.note }) : null;
  const head = extra => el('div', { class: 'ctl-head' }, el('span', { text: it.label }), extra);
  switch (it.type) {
    case 'range': {
      const out = el('output');
      const inp = el('input', { type: 'range', min: it.min, max: it.max, step: it.step });
      const fmt = v => it.fmt ? it.fmt(v) : (+v).toFixed(it.dp ?? (it.step >= 1 ? 0 : 2)) + (it.unit || '');
      inp.addEventListener('input', () => { set(+inp.value); out.textContent = fmt(inp.value); });
      bindings.push(() => { inp.value = get(); out.textContent = fmt(get()); });
      bindings.at(-1)();
      return el('label', { class: 'ctl' }, head(out), inp);
    }
    case 'toggle': {
      const inp = el('input', { type: 'checkbox' });
      inp.addEventListener('change', () => set(inp.checked));
      bindings.push(() => { inp.checked = !!get(); });
      bindings.at(-1)();
      return el('label', { class: 'toggle' }, el('span', { text: it.label }), inp);
    }
    case 'select': {
      const sel = el('select', {}, it.options.map(([v, l]) => el('option', { value: v, text: l })));
      sel.addEventListener('change', () => set(sel.value));
      bindings.push(() => { sel.value = get(); });
      bindings.at(-1)();
      return el('label', { class: 'ctl' }, head(), sel);
    }
    case 'color': {
      const inp = el('input', { type: 'color' });
      inp.addEventListener('input', () => set(inp.value));
      bindings.push(() => { inp.value = get(); });
      bindings.at(-1)();
      return el('label', { class: 'color' }, inp, el('span', { text: it.label }));
    }
    default: {
      const inp = it.type === 'textarea' ? el('textarea', { rows: it.rows || 3 }) : el('input', { type: 'text', placeholder: it.placeholder });
      inp.addEventListener('input', () => set(inp.value));
      bindings.push(() => { if (document.activeElement !== inp) inp.value = get() ?? ''; });
      bindings.at(-1)();
      return el('label', { class: 'ctl' }, head(), inp, note);
    }
  }
}

function renderThemeGroup(body) {
  const manual = () => { state.fx.autoTheme = false; syncControls(); };
  body.append(buildItem({ k: 'autoTheme', type: 'toggle', label: 'Match colours to the game’s art', onchange: v => { if (v) applyAutoTheme(true); } }));
  const sw = el('div', { class: 'swatches' });
  bindings.push(() => {
    sw.replaceChildren(...state.swatches.map(hex => el('button', {
      title: `Use ${hex} as the accent colour`, style: `background:${hex}`,
      onclick: () => { state.fx.accent = hex; manual(); scheduleRender(); },
    })));
    swWrap.hidden = !state.swatches.length;
  });
  const swWrap = el('div', { class: 'ctl' }, el('div', { class: 'ctl-head' }, el('span', { text: 'Colours from the logo & art — click for accent' })), sw);
  bindings.at(-1)();
  body.append(swWrap);
  body.append(el('div', { class: 'color-row' },
    [['accent', 'Accent'], ['themeBand', 'Band'], ['themeBg', 'Background'], ['textColor', 'Text']]
      .map(([k, label]) => buildItem({ k, type: 'color', label, onchange: manual }))));
  body.append(buildItem({ k: 'glassBack', type: 'toggle', label: 'Glassy background (blurred key art behind the back)' }));
}

function fontOptions(which) {
  const all = [...FONT_REG.values()];
  const game = state.fontDetect?.gameFiles || [];
  const groups = [];
  if (game.length) groups.push(['From the game’s files', game]);
  const custom = all.filter(f => f.source === 'custom');
  if (custom.length) groups.push(['Your uploaded fonts', custom]);
  const web = all.filter(f => f.source === 'google');
  if (web.length) groups.push(['Google Fonts', web]);
  const display = all.filter(f => f.source === 'library' && !f.body), text = all.filter(f => f.source === 'library' && f.body);
  if (which === 'head') groups.push(['Display', display], ['Text', text]);
  else groups.push(['Text', text], ['Display', display]);
  return groups.map(([label, fonts]) => el('optgroup', { label }, fonts.map(f => el('option', { value: f.family, text: f.label || f.family }))));
}
function fontPicker(label, which) {
  const sel = el('select');
  const prev = el('div', { class: 'font-preview' });
  sel.addEventListener('change', () => chooseFont(which, sel.value));
  bindings.push(() => {
    const F = state.fx, fam = which === 'head' ? F.headFamily : F.bodyFamily;
    sel.replaceChildren(...fontOptions(which));
    sel.value = fam;
    prev.style.fontFamily = `"${fam}", Inter, sans-serif`;
    prev.style.fontWeight = which === 'head' ? F.headWeight : F.bodyWeight;
    prev.style.textTransform = which === 'head' && F.headUpper ? 'uppercase' : 'none';
    prev.style.fontSize = which === 'head' ? '22px' : '15px';
    prev.textContent = which === 'head' ? (state.text.title || state.game?.name || 'The legend begins') : 'Explore a vast world full of secrets and danger.';
  });
  bindings.at(-1)();
  return el('div', { class: 'ctl' }, el('div', { class: 'ctl-head' }, el('span', { text: label })), sel, prev);
}
// Everything the detector found, as one-click options.
function fontCandidates() {
  const D = state.fontDetect;
  if (!D) return [];
  const out = [];
  if (D.known?.head) out.push({ family: D.known.head.family, title: D.known.name, sub: D.known.head.exact ? 'the game’s font' : `game uses this · free lookalike: ${D.known.head.family}` });
  for (const f of D.gameFiles.slice(0, 6)) out.push({ family: f.family, title: f.label, sub: 'from the game’s files' });
  for (const m of D.logo.slice(0, 4)) out.push({ family: m.family, title: m.family, sub: `logo lettering · ${Math.round(m.score * 100)}%` });
  out.push({ family: D.style.head, title: D.style.head, sub: `Steam tags · ${D.style.label}` });
  const seen = new Set();
  return out.filter(c => !seen.has(c.family) && seen.add(c.family));
}
function renderFontGroup(body) {
  body.append(buildItem({
    k: 'autoFonts', type: 'toggle', label: 'Match fonts to the game',
    onchange: v => {
      if (!v) return;
      saveFontChoice(null);
      if (state.fontDetect) state.fontDetect.saved = null;
      applyAutoFonts();
    },
  }));
  const src = el('div', { class: 'font-source' });
  const chips = el('div', { class: 'chips' });
  const chipWrap = el('div', { class: 'ctl' }, el('div', { class: 'ctl-head' }, el('span', { text: 'Detected for this game — click to use for headings' })), chips);
  bindings.push(() => {
    src.textContent = state.game ? (state.fontReason || '') : 'Fonts are detected once you pick a game.';
    const cands = fontCandidates();
    chipWrap.hidden = !cands.length;
    chips.replaceChildren(...cands.map(c => el('button', {
      class: 'chip' + (c.family === state.fx.headFamily ? ' on' : ''), title: c.sub, onclick: () => chooseFont('head', c.family),
    }, el('b', { text: c.title, style: `font-family:"${c.family}", Inter, sans-serif` }), el('small', { text: c.sub }))));
  });
  bindings.at(-1)();
  body.append(src, chipWrap, fontPicker('Headings', 'head'), fontPicker('Body text', 'body'));
  body.append(buildItem({ k: 'headUpper', type: 'toggle', label: 'Uppercase headings' }));

  const nameIn = el('input', { type: 'text', placeholder: 'Font name, e.g. FF Trixie HD' });
  const use = () => { useFontName(nameIn.value); nameIn.value = ''; };
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') use(); });
  const file = el('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2', hidden: true });
  file.addEventListener('change', () => { if (file.files[0]) uploadFont(file.files[0]); file.value = ''; });
  body.append(
    el('div', { class: 'ctl' },
      el('div', { class: 'ctl-head' }, el('span', { text: 'Know the game’s font? Type its name' })),
      el('div', { class: 'ctl-row' }, nameIn, el('button', { class: 'btn ghost small', text: 'Use', onclick: use })),
      el('div', { class: 'note', text: 'Google Fonts load directly; commercial fonts use the closest free lookalike.' })),
    el('label', { class: 'btn ghost small file-btn' }, 'Upload the real font file (.ttf / .otf / .woff)…', file),
  );
}

function clampFront() {
  const L = state.layouts.case, pl = frontPlacement();
  if (pl) { L.frontCx = pl.fx; L.frontCy = pl.fy; }
  syncControls(); scheduleRender();
}
function onCaseSize() {
  state.fx.spineMm = CASE_SIZES[state.fx.caseSize].spine;
  autoCrop(['boxback', 'case']);
  syncControls(); updateTplTabs(); updateHint();
}
function applyBoxStyle() {
  Object.assign(state.layouts.boxback, BOX_LOGO[state.fx.boxStyle]);
  autoCrop(['boxback']);
  syncControls();
}

/* ============================================================ templates */
function updateTplTabs() {
  const wrap = $('#tplTabs');
  wrap.replaceChildren(...Object.entries(TEMPLATES).map(([k, t]) => {
    const d = caseDims();
    const size = k === 'boxback' ? `${d.panel}×${d.height} mm` : k === 'case' ? `${fmtMm(d.totalMm)}×${d.height} mm` : `${t.w}×${t.h}`;
    return el('button', { class: k === state.tpl ? 'on' : '', onclick: () => switchTpl(k) }, t.label, el('small', { text: size }));
  }));
}
function updateHint() {
  const d = caseDims();
  $('#stageHint').textContent = state.tpl === 'boxback'
    ? `Drag the logo or key art to move it · scroll over them to resize · exports ${d.panelPx}×${d.heightPx} px = ${d.panel}×${d.height} mm at 300 dpi`
    : state.tpl === 'case'
      ? `Back · spine · front — the front art is centred (drag to move, it snaps back to centre; scroll to resize) · ${fmtMm(d.totalMm)}×${d.height} mm at 300 dpi, spine ${fmtMm(d.spine)} mm`
      : 'Drag the logo or background to move it · scroll over them to resize';
  $('#pdfBtn').hidden = state.tpl !== 'case';
  $('#applyBtn').disabled = !TEMPLATES[state.tpl].steam;
  $('#applyBtn').title = TEMPLATES[state.tpl].steam ? '' : 'Case art is for printing — switch to a Steam template to set it in Steam';
}
function switchTpl(k) {
  state.tpl = k;
  updateTplTabs(); updateHint(); renderControls(); renderSlots(); scheduleRender();
}

/* =============================================================== assets */
const ASSET_TABS = [['official', 'Official'], ['heroes', 'Heroes'], ['logos', 'Logos'], ['grids', 'Covers']];
function renderAssetTabs() {
  $('#assetTabs').replaceChildren(...ASSET_TABS.map(([k, label]) => el('button', {
    role: 'tab', 'aria-selected': String(state.tab === k),
    onclick: () => { state.tab = k; renderAssetTabs(); renderAssets(); },
  }, label, state.assets[k].length ? el('span', { class: 'count', text: ` ${state.assets[k].length}` }) : null)));
}
function renderSlots() {
  const shotsOn = state.tpl === 'boxback' && state.fx.showShots;
  $('#slotSeg').replaceChildren(...SLOTS.filter(([k]) => (shotsOn || !k.startsWith('shot')) && (k !== 'front' || state.tpl === 'case')).map(([k, label]) =>
    el('button', { class: state.slot === k ? 'on' : '', text: label, onclick: () => { state.slot = k; renderSlots(); } })));
}
function slotsUsing(a) {
  const tags = { front: 'Front', bg: 'Art', logo: 'Logo', shot1: '1', shot2: '2', shot3: '3' };
  return Object.entries(state.images).filter(([, v]) => v?.asset === a).map(([k]) => tags[k]);
}
function renderAssets() {
  const grid = $('#assetGrid');
  const list = state.assets[state.tab] || [];
  grid.replaceChildren();
  const note = t => grid.append(el('div', { class: 'asset-note', text: t }));
  if (!state.game) note('Artwork shows up here once you pick a game.');
  else if (state.loadingAssets && !list.length) note('Loading artwork…');
  else if (!list.length) {
    note(state.tab === 'official' ? 'No official Steam artwork found for this game — try the SteamGridDB tabs.'
      : state.hasKey ? 'SteamGridDB has nothing of this type for this game yet.'
        : 'Add your SteamGridDB API key (top right) to browse community artwork.');
  }
  for (const a of list) {
    const used = slotsUsing(a);
    const cls = ['asset'];
    if (a.kind === 'logo') cls.push('logo');
    if (a.kind === 'grid' || a.kind === 'cover') cls.push('tall');
    if (used.length) cls.push('sel');
    grid.append(el('button', { class: cls.join(' '), title: a.label || KIND_LABEL[a.kind], onclick: () => assignAsset(a) },
      el('img', { src: a.thumb || a.url, loading: 'lazy', alt: '', onerror: e => e.target.closest('.asset')?.remove() }),
      used.length ? el('span', { class: 'badges' }, used.map(t => el('span', { class: 'badge', text: t }))) : null,
      el('span', { class: 'kind', text: KIND_LABEL[a.kind] || a.kind })));
  }
  $('#moreBtn').hidden = !(state.game && state.more[state.tab]);
  renderAssetTabs();
}
function assignAsset(a) {
  let slot = state.slot;
  if (slot === 'auto') {
    if (a.kind === 'logo') slot = 'logo';
    else if (a.kind === 'screenshot' && state.tpl === 'boxback') { slot = 'shot' + (state.shotCursor % 3 + 1); state.shotCursor++; }
    else slot = state.tpl === 'case' ? 'front' : 'bg';
  }
  setImage(slot, a);
}

const sgdbNorm = kind => x => ({ id: `${kind}-${x.id}`, url: x.url, thumb: x.thumb, kind, label: [x.style, x.width && `${x.width}×${x.height}`].filter(Boolean).join(' · ') });
async function loadSgdbKind(tab, page) {
  const g = state.game;
  const kind = { heroes: 'hero', logos: 'logo', grids: 'grid' }[tab];
  const extra = tab === 'grids' ? '&dimensions=600x900,342x482,660x930' : '';
  try {
    const data = await sgdb(`${tab}/game/${g.sgdbId}?types=static&nsfw=false&humor=false&page=${page}${extra}`);
    if (state.game !== g) return;
    const items = (data || []).map(sgdbNorm(kind));
    state.assets[tab] = page ? [...state.assets[tab], ...items] : items;
    state.pages[tab] = page;
    state.more[tab] = items.length >= 20;
  } catch (e) {
    if (e.status !== 401 && e.status !== 404) toast(`SteamGridDB: ${e.message}`, 'error');
  }
}

/* ========================================================= game loading */
async function selectGame(entry) {
  const token = ++state.loadToken;
  closeResults();
  $('#searchInput').value = entry.name;
  const g = state.game = {
    name: entry.name, sgdbId: entry.sgdbId || null, storeAppId: entry.appid || null,
    targetId: entry.shortcutId || entry.appid || '', shortcut: entry.source === 'shortcut', userId: entry.userId || null,
  };
  state.store = null; state.tags = []; state.fontDetect = null; state.spine = null;
  state.assets = { official: [], heroes: [], logos: [], grids: [] };
  state.more = {}; state.pages = {}; state.shotCursor = 0;
  state.images = { front: null, bg: null, logo: null, shot1: null, shot2: null, shot3: null };
  state.text = { ...TEXT_DEFAULTS, title: entry.name };
  state.loadingAssets = true;
  $('#targetId').value = g.targetId;
  if (g.userId) $('#steamUser').value = g.userId;
  updateGameCard(); renderAssets(); setBusy(+1);

  try {
    if (!g.sgdbId && g.storeAppId && state.hasKey) {
      try { g.sgdbId = (await sgdb(`games/steam/${g.storeAppId}`))?.id || null; } catch { /* not on SGDB */ }
    }
    if (!g.sgdbId && state.hasKey) {
      try { const r = await sgdb(`search/autocomplete/${enc(g.name)}`); if (r?.length) g.sgdbId = r[0].id; } catch { /* ignore */ }
    }
    if (token !== state.loadToken) return;
    if (g.sgdbId && !g.storeAppId && state.hasKey) {
      try {
        const d = await sgdb(`games/id/${g.sgdbId}?platformdata=steam`);
        const s = d?.external_platform_data?.steam?.[0];
        if (s?.id) g.storeAppId = String(s.id);
      } catch { /* ignore */ }
    }
    if (!g.storeAppId) {
      try {
        const r = await api('/api/storesearch?term=' + enc(g.name));
        const hit = (r.items || []).find(i => normName(i.name) === normName(g.name));
        if (hit) g.storeAppId = String(hit.id);
      } catch { /* ignore */ }
    }
    if (token !== state.loadToken) return;
    if (!g.shortcut && !g.targetId) { g.targetId = g.storeAppId || ''; $('#targetId').value = g.targetId; }
    updateGameCard();

    const jobs = [];
    if (g.storeAppId) {
      jobs.push(api('/api/store/' + g.storeAppId).then(r => {
        state.store = r.details; state.tags = r.tags || [];
        if (/^App \d+$/.test(g.name) && r.details?.name) { g.name = r.details.name; $('#searchInput').value = g.name; }
        state.assets.official = (r.official || []).map((a, i) => ({ ...a, id: `official-${i}` }));
      }).catch(() => {}));
    }
    if (g.sgdbId) for (const k of ['heroes', 'logos', 'grids']) jobs.push(loadSgdbKind(k, 0));
    await Promise.all(jobs);
    if (token !== state.loadToken) return;

    state.loadingAssets = false;
    if (!g.sgdbId && !state.assets.official.length) {
      toast(state.hasKey ? `Couldn't find “${g.name}” on SteamGridDB or Steam.` : 'Add a SteamGridDB API key to find art for games outside Steam.', 'error');
    }
    state.tab = state.assets.official.length ? 'official' : 'heroes';
    fillTextFromStore();
    state.fx.autoTheme = true; state.fx.autoFonts = true;
    state.fontStyle = matchStyle(state.tags.length ? state.tags : (state.store?.genres || []));
    setFont('head', state.fontStyle.head); setFont('body', state.fontStyle.body);
    state.fontReason = 'Detecting the game’s fonts…';
    updateGameCard(); renderAssets(); renderControls();
    await autoPick();
    detectFonts(token);
  } finally {
    if (token === state.loadToken) state.loadingAssets = false;
    setBusy(-1); renderAssets(); scheduleRender();
  }
}

function autoPick() {
  const off = state.assets.official, A = state.assets;
  const bg = off.find(a => a.kind === 'hero') || A.heroes[0] || off.find(a => a.kind === 'background') || off.find(a => a.kind === 'header') || A.grids[0];
  const logo = off.find(a => a.kind === 'logo') || A.logos[0];
  const shots = off.filter(a => a.kind === 'screenshot');
  const shotPicks = shots.length >= 3 ? [shots[0], shots[Math.floor(shots.length / 2)], shots[shots.length - 1]]
    : [...shots, ...A.heroes.slice(1)].slice(0, 3);
  // Front of the case: the official cover art when its shape suits the case, else key art.
  const d = caseDims(), frontAspect = (d.panelPx + d.spinePx) / d.heightPx;
  const covers = [...off.filter(a => a.kind === 'cover'), ...A.grids];
  const front = frontAspect <= .86 ? covers[0] || bg : bg || covers[0];
  if (!logo) for (const L of Object.values(state.layouts)) L.textLogo = true;
  return Promise.all([setImage('front', front || null), setImage('bg', bg || null), setImage('logo', logo || null),
    ...[0, 1, 2].map(i => setImage('shot' + (i + 1), shotPicks[i] || null))]);
}

function shuffleArt() {
  if (!state.game) return;
  const off = state.assets.official;
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const bgs = [...off.filter(a => ['hero', 'background'].includes(a.kind)), ...state.assets.heroes];
  if (bgs.length) setImage('bg', pick(bgs.filter(a => a !== state.images.bg?.asset)) || bgs[0]);
  const shots = off.filter(a => a.kind === 'screenshot');
  const pool = shots.length >= 3 ? shots : [...shots, ...state.assets.heroes];
  const chosen = [...pool].sort(() => Math.random() - .5).slice(0, 3);
  chosen.forEach((a, i) => setImage('shot' + (i + 1), a));
}

function updateGameCard() {
  const g = state.game, card = $('#gameCard');
  card.classList.toggle('empty', !g);
  if (!g) return;
  $('#gameName').textContent = g.name;
  const meta = [];
  if (g.shortcut) meta.push(`Non-Steam shortcut ${g.targetId}`);
  if (g.storeAppId) meta.push(`Steam app ${g.storeAppId}`);
  if (g.sgdbId) meta.push(`SGDB #${g.sgdbId}`);
  if (state.store?.releaseDate) meta.push(state.store.releaseDate);
  $('#gameMeta').textContent = meta.join(' · ') || 'Looking up…';
  $('#gameTags').replaceChildren(...state.tags.slice(0, 8).map(t => el('span', { class: 'tag', text: t })));
}

/* =============================================================== search */
let results = [], activeResult = -1;
function libraryEntries() {
  const lib = state.library;
  if (!lib) return [];
  const out = lib.games.map(gm => ({ name: gm.name, appid: gm.appid, source: 'steam' }));
  for (const u of lib.users) for (const s of u.shortcuts) out.push({ name: s.name, shortcutId: s.id, userId: u.id, source: 'shortcut' });
  return out;
}
function closeResults() { $('#searchResults').hidden = true; activeResult = -1; }
function showResults(local, remote, term) {
  const box = $('#searchResults');
  results = [...local, ...remote];
  activeResult = -1;
  const row = (r, i) => el('button', {
    class: 'result', 'data-i': i, onmousedown: e => { e.preventDefault(); selectGame(r); },
  }, el('span', { class: 'r-name', text: r.name }),
  r.source === 'steam' ? el('span', { class: 'pill', text: 'Installed' }) : null,
  r.source === 'shortcut' ? el('span', { class: 'pill shortcut', text: 'Non-Steam' }) : null,
  r.year ? el('span', { class: 'r-meta', text: r.year }) : null);
  const kids = [];
  if (local.length) kids.push(el('h4', { text: 'Your library' }), ...local.map((r, i) => row(r, i)));
  if (remote.length) kids.push(el('h4', { text: 'SteamGridDB' }), ...remote.map((r, i) => row(r, local.length + i)));
  if (!kids.length) kids.push(el('div', { class: 'empty', text: term ? (state.hasKey ? 'No matches.' : 'No library matches — add a SteamGridDB API key to search every game.') : 'Type a game name.' }));
  box.replaceChildren(...kids);
  box.hidden = false;
}
const runSearch = debounce(async term => {
  const t = term.trim().toLowerCase();
  const local = libraryEntries().filter(e => !t || e.name.toLowerCase().includes(t)).slice(0, t ? 6 : 12);
  showResults(local, [], term);
  if (!t || !state.hasKey) return;
  try {
    const data = await sgdb(`search/autocomplete/${enc(term.trim())}`);
    if ($('#searchInput').value !== term) return;
    const seen = new Set(local.map(l => normName(l.name)));
    const remote = (data || []).filter(d => !seen.has(normName(d.name))).slice(0, 12).map(d => ({
      name: d.name, sgdbId: d.id, source: 'sgdb', year: d.release_date ? new Date(d.release_date * 1000).getFullYear() : '',
    }));
    showResults(local, remote, term);
  } catch { /* shown via dialog/toast */ }
}, 220);

$('#searchInput').addEventListener('input', e => runSearch(e.target.value));
$('#searchInput').addEventListener('focus', e => runSearch(e.target.value === state.game?.name ? '' : e.target.value));
$('#searchInput').addEventListener('blur', () => setTimeout(closeResults, 120));
$('#searchInput').addEventListener('keydown', e => {
  const box = $('#searchResults');
  if (box.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeResult = clamp(activeResult + (e.key === 'ArrowDown' ? 1 : -1), 0, results.length - 1);
    box.querySelectorAll('.result').forEach(b => b.classList.toggle('active', +b.dataset.i === activeResult));
    box.querySelector('.result.active')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const r = results[activeResult >= 0 ? activeResult : 0];
    if (r) selectGame(r);
  } else if (e.key === 'Escape') closeResults();
});

/* =============================================================== export */
function renderToCanvas(key) {
  const { w, h } = tplSize(key);
  const c = el('canvas'); c.width = w; c.height = h;
  render(c.getContext('2d'), key);
  return c;
}
const toBlob = c => new Promise(r => c.toBlob(r, 'image/png'));
function fileName(key) {
  const base = slug(state.game?.name);
  return key === 'boxback' ? `${base}-back-cover-${state.fx.caseSize}.png`
    : key === 'case' ? `${base}-full-case-${state.fx.caseSize}.png` : `${base}-steam-${key}.png`;
}

// The full case at print resolution, with bleed: the outer 3 mm of the artwork mirrored
// outward, so bands, backgrounds and art carry on past the trim without streaks.
function caseArt(bleed = state.fx.bleed) {
  const core = renderToCanvas('case');
  const b = bleed ? mmPx(3) : 0;
  if (!b) return { canvas: core, bleedPx: 0 };
  const [w, h] = [core.width, core.height];
  const c = el('canvas'); c.width = w + 2 * b; c.height = h + 2 * b;
  const x = c.getContext('2d');
  x.drawImage(core, b, b);
  // [source x, y, w, h] → mirrored into the strip whose inner edge touches the trim at (tx, ty)
  const mirror = (sx, sy, sw, sh, tx, ty, fx, fy, dx, dy) => {
    x.save(); x.translate(tx, ty); x.scale(fx, fy);
    x.drawImage(core, sx, sy, sw, sh, dx, dy, sw, sh);
    x.restore();
  };
  mirror(0, 0, b, h, b, 0, -1, 1, 0, b);                  // left
  mirror(w - b, 0, b, h, 2 * b + w, 0, -1, 1, 0, b);      // right
  mirror(0, 0, w, b, 0, b, 1, -1, b, 0);                  // top
  mirror(0, h - b, w, b, 0, 2 * b + h, 1, -1, b, 0);      // bottom
  mirror(0, 0, b, b, b, b, -1, -1, 0, 0);                 // corners
  mirror(w - b, 0, b, b, 2 * b + w, b, -1, -1, 0, 0);
  mirror(0, h - b, b, b, b, 2 * b + h, -1, -1, 0, 0);
  mirror(w - b, h - b, b, b, 2 * b + w, 2 * b + h, -1, -1, 0, 0);
  // Above a PC GAME badge flush with the top, the bleed is the badge's black, not mirrored letters.
  if (state.fx.pcBadge && !(state.fx.showBand && state.fx.wrapBand)) {
    const d = caseDims();
    x.fillStyle = '#000'; x.fillRect(b + d.panelPx, 0, d.spinePx, b + 1);
  }
  return { canvas: c, bleedPx: b };
}

// Put artwork (at k × 300 dpi) on a sheet with cut marks (solid) and fold marks (dashed).
function withCropMarks(art, bleedPx, k = 1) {
  const d = caseDims(), px = mm => Math.round(mm * PX_PER_MM * k);
  const mk = px(8), off = bleedPx + mk;
  const c = el('canvas'); c.width = art.width + 2 * mk; c.height = art.height + 2 * mk;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(art, mk, mk);
  const coreW = art.width - 2 * bleedPx, coreH = art.height - 2 * bleedPx;
  const gap = bleedPx + px(1.5), len = px(5), right = off + coreW, bottom = off + coreH;
  x.strokeStyle = '#000'; x.lineWidth = Math.max(2, px(.25));
  const seg = (x1, y1, x2, y2) => { x.beginPath(); x.moveTo(x1, y1); x.lineTo(x2, y2); x.stroke(); };
  for (const vx of [off, right]) { seg(vx, off - gap, vx, off - gap - len); seg(vx, bottom + gap, vx, bottom + gap + len); }
  for (const hy of [off, bottom]) { seg(off - gap, hy, off - gap - len, hy); seg(right + gap, hy, right + gap + len, hy); }
  x.setLineDash([px(1), px(1)]);
  const panel = coreW * d.panel / d.totalMm, spine = coreW * d.spine / d.totalMm;
  for (const fx of [off + panel, off + panel + spine]) { seg(fx, off - gap, fx, off - gap - len); seg(fx, bottom + gap, fx, bottom + gap + len); }
  x.setLineDash([]);
  x.fillStyle = '#555'; x.font = fontCss(400, px(2.4), 'Inter'); x.textBaseline = 'middle'; x.textAlign = 'left';
  x.fillText(`${state.game?.name || ''} — ${d.name}, ${fmtMm(d.totalMm)} × ${d.height} mm (spine ${fmtMm(d.spine)} mm). Print at 100% · solid marks = cut, dashed = fold.`,
    off + px(4), bottom + gap + len / 2);
  return { canvas: c, markPx: mk };
}

function casePrint({ bleed = state.fx.bleed, marks = false } = {}) {
  const art = caseArt(bleed);
  const sheet = marks ? withCropMarks(art.canvas, art.bleedPx) : { canvas: art.canvas, markPx: 0 };
  return { canvas: sheet.canvas, wMm: sheet.canvas.width / PX_PER_MM, hMm: sheet.canvas.height / PX_PER_MM,
    trimInsetMm: (art.bleedPx + sheet.markPx) / PX_PER_MM, bleedInsetMm: sheet.markPx / PX_PER_MM };
}

/* ---- Upscayl: AI-upscale the final render before saving ---- */
async function upscayl(canvas, scale) {
  const F = state.fx;
  $('#loadingText').textContent = `Upscaling ${canvas.width}×${canvas.height} with Upscayl (${scale}×, ${F.upscaleModel})…`;
  setBusy(+1);
  try {
    const data = canvas.toDataURL('image/png').split(',')[1];
    const r = await api('/api/upscale', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, model: F.upscaleModel, scale }) });
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = r.url; });
    const c = el('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return { canvas: c, url: r.url };
  } finally {
    setBusy(-1);
    $('#loadingText').textContent = 'Loading artwork…';
  }
}
// Print layouts are already 300 dpi; 2× (600 dpi) is plenty and keeps files manageable.
const upscaleFor = key => {
  const n = { auto2: 2, auto4: 4 }[state.fx.upscaleMode] || 0;   // optional extra pass on the finished render
  return state.upscaylInfo?.available && n ? (['case', 'boxback'].includes(key) ? Math.min(n, 2) : n) : 0;
};

// Minimal PDF: one page holding the artwork as a JPEG, at exact physical size.
function buildPdf(jpeg, pxW, pxH, page, place, boxes) {
  const pt = mm => (mm * 72 / 25.4).toFixed(3);
  const te = new TextEncoder(), parts = [], offsets = [];
  let len = 0;
  const push = d => { const b = typeof d === 'string' ? te.encode(d) : d; parts.push(b); len += b.length; };
  const obj = (n, ...body) => { offsets[n] = len; push(`${n} 0 obj\n`); body.forEach(push); push('\nendobj\n'); };
  push('%PDF-1.4\n'); push(new Uint8Array([37, 226, 227, 207, 211, 10]));
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const box = r => `[${pt(r.x)} ${pt(page.h - r.y - r.h)} ${pt(r.x + r.w)} ${pt(page.h - r.y)}]`;
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(page.w)} ${pt(page.h)}]` +
    (boxes ? ` /TrimBox ${box(boxes.trim)} /BleedBox ${box(boxes.bleed)}` : '') +
    ' /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream');
  const content = `q ${pt(place.w)} 0 0 ${pt(place.h)} ${pt(place.x)} ${pt(page.h - place.y - place.h)} cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(n => String(offsets[n]).padStart(10, '0') + ' 00000 n \n').join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

async function savePdf() {
  if (!state.game) return toast('Pick a game first.');
  const F = state.fx;
  // Artwork (+ bleed) → optional Upscayl → crop marks drawn crisp at the final resolution.
  const art = caseArt(F.bleed);
  const k = upscaleFor('case');
  let src = art.canvas;
  if (k) {
    try { src = (await upscayl(src, k)).canvas; } catch (e) { return toast(e.message, 'error'); }
  }
  const pxmm = PX_PER_MM * k || PX_PER_MM, bleedPx = art.bleedPx * (k || 1);
  const sheet = F.cropMarks ? withCropMarks(src, bleedPx, k || 1) : { canvas: src, markPx: 0 };
  const out = { canvas: sheet.canvas, wMm: sheet.canvas.width / pxmm, hMm: sheet.canvas.height / pxmm,
    trimInsetMm: (bleedPx + sheet.markPx) / pxmm, bleedInsetMm: sheet.markPx / pxmm };
  const papers = { a4: [297, 210], letter: [279.4, 215.9] };
  let page = { w: out.wMm, h: out.hMm };
  if (papers[F.pageSize]) {
    const [pw, ph] = papers[F.pageSize];
    if (out.wMm > pw || out.hMm > ph) {
      toast(`The case (${fmtMm(out.wMm)} × ${fmtMm(out.hMm)} mm with ${F.cropMarks ? 'crop marks' : 'bleed'}) is bigger than ${F.pageSize === 'a4' ? 'A4' : 'Letter'} — saving at exact size instead.`, 'error');
    } else page = { w: pw, h: ph };
  }
  const place = { x: (page.w - out.wMm) / 2, y: (page.h - out.hMm) / 2, w: out.wMm, h: out.hMm };
  const d = caseDims(), t = out.trimInsetMm, bl = out.bleedInsetMm;
  const boxes = {
    trim: { x: place.x + t, y: place.y + t, w: d.totalMm, h: d.height },
    bleed: { x: place.x + bl, y: place.y + bl, w: out.wMm - 2 * bl, h: out.hMm - 2 * bl },
  };
  const jpegBlob = await new Promise(r => out.canvas.toBlob(r, 'image/jpeg', .95));
  const pdf = buildPdf(new Uint8Array(await jpegBlob.arrayBuffer()), out.canvas.width, out.canvas.height, page, place, boxes);
  const a = el('a', { href: URL.createObjectURL(pdf), download: `${slug(state.game.name)}-case-${F.caseSize}${k ? `-upscayl-${k}x` : ''}.pdf` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Saved the print-ready PDF. Print at 100% (“actual size”), then cut on the solid marks and fold on the dashed ones.', 'ok');
}

async function download(key) {
  // The full case PNG always includes bleed for printing.
  const canvas = key === 'case' ? caseArt().canvas : renderToCanvas(key);
  const k = upscaleFor(key);
  let blob;
  if (k) {
    try { blob = await (await fetch((await upscayl(canvas, k)).url)).blob(); } catch (e) { return toast(e.message, 'error'); }
  } else blob = await toBlob(canvas);
  const name = k ? fileName(key).replace(/\.png$/, `-upscayl-${k}x.png`) : fileName(key);
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#downloadBtn').addEventListener('click', () => state.game ? download(state.tpl) : toast('Pick a game first.'));
$('#pdfBtn').addEventListener('click', () => savePdf());
$('#downloadAllBtn').addEventListener('click', async () => {
  if (!state.game) return toast('Pick a game first.');
  for (const k of Object.keys(TEMPLATES)) { await download(k); await sleep(400); }
});

function logoPng() {
  const img = state.images.logo?.img;
  if (!img) return null;
  const c = el('canvas'); c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/png').split(',')[1];
}
async function applyToSteam(keys) {
  if (!state.game) return toast('Pick a game first.');
  const userId = $('#steamUser').value, targetId = $('#targetId').value.trim();
  if (!/^\d+$/.test(targetId)) return toast('Enter the game’s Steam app id (or shortcut id) first.', 'error');
  const files = [];
  for (const k of keys) {
    if (k === 'logo') { const d = logoPng(); if (d) files.push({ kind: 'logo', data: d }); }
    else files.push({ kind: TEMPLATES[k].steam, data: renderToCanvas(k).toDataURL('image/png').split(',')[1] });
  }
  try {
    const r = await api('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, targetId, files }) });
    toast(`Saved ${r.written.join(', ')}. Restart Steam to see it${r.backedUp.length ? ' — your previous art was backed up' : ''}.`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}
$('#applyBtn').addEventListener('click', () => applyToSteam([state.tpl]));
$('#applyAllBtn').addEventListener('click', () => applyToSteam(['cover', 'wide', 'hero', 'logo']));
$('#targetId').addEventListener('input', e => { if (state.game) state.game.targetId = e.target.value.trim(); });

/* ============================================================ 3D viewer */
// The case as a real box (CSS 3D): plastic shell with the printed insert on the
// front, spine and back. Drag to turn, scroll to zoom.
const SHELLS = { black: '#141517', clear: 'rgba(222,230,238,.22)', blue: '#1f4fa3', red: '#c8161e', white: '#e8e9eb' };
const v3d = { rx: -6, ry: 24, zoom: 1, spin: false, raf: 0, faces: [], drag: null };
function open3D() {
  if (!state.game) return toast('Pick a game first.');
  const dlg = $('#viewer3d');
  if (!dlg.open) dlg.showModal();
  const d = caseDims(), wrap = renderToCanvas('case');
  const shrink = Math.min(1, 2600 / wrap.width), tex = el('canvas');
  tex.width = Math.round(wrap.width * shrink); tex.height = Math.round(wrap.height * shrink);
  tex.getContext('2d').drawImage(wrap, 0, 0, tex.width, tex.height);
  const url = tex.toDataURL('image/jpeg', .92);
  const stage = $('#v3dStage');
  const s = Math.min(stage.clientHeight * .7, stage.clientWidth * .55 * d.height / d.panel) / d.height;   // px per mm
  const m = 2;                                           // plastic around the insert, mm
  const W = (d.panel + m) * s, H = (d.height + 2 * m) * s, D = d.spine * s;
  const wrapCss = `${d.totalMm * s}px ${d.height * s}px`;
  if (!$('#v3dShell').dataset.touched) $('#v3dShell').value = { pc: 'black', bluray: 'blue', handheld: 'red' }[state.fx.caseSize] || 'black';
  const shell = SHELLS[$('#v3dShell').value];
  const art = (x, w, bgx) => el('div', { class: 'art', style: `left:${x}px;top:${m * s}px;width:${w}px;height:${d.height * s}px;background-image:url(${url});background-size:${wrapCss};background-position:${bgx}px 0` });
  const specs = [
    { n: [0, 0, 1], w: W, h: H, t: `translateZ(${D / 2}px)`, kids: [art(0, d.panel * s, -(d.panel + d.spine) * s)], gloss: true },
    { n: [0, 0, -1], w: W, h: H, t: `rotateY(180deg) translateZ(${D / 2}px)`, kids: [art(m * s, d.panel * s, 0)], gloss: true },
    { n: [-1, 0, 0], w: D, h: H, l: (W - D) / 2, t: `rotateY(-90deg) translateZ(${W / 2}px)`, kids: [art(0, D, -d.panel * s)], gloss: true },
    { n: [1, 0, 0], w: D, h: H, l: (W - D) / 2, t: `rotateY(90deg) translateZ(${W / 2}px)`, kids: [] },
    { n: [0, -1, 0], w: W, h: D, tp: (H - D) / 2, t: `rotateX(90deg) translateZ(${H / 2}px)`, kids: [] },
    { n: [0, 1, 0], w: W, h: D, tp: (H - D) / 2, t: `rotateX(-90deg) translateZ(${H / 2}px)`, kids: [] },
  ];
  const box = $('#v3dBox');
  box.style.width = `${W}px`; box.style.height = `${H}px`;
  v3d.faces = specs.map(f => {
    const shade = el('div', { class: 'shade' }), gloss = f.gloss ? el('div', { class: 'gloss' }) : null;
    const node = el('div', { class: 'v3d-face', style: `width:${f.w}px;height:${f.h}px;left:${f.l || 0}px;top:${f.tp || 0}px;transform:${f.t};background:${shell}` },
      ...f.kids, gloss, shade);
    return { node, n: f.n, shade, gloss };
  });
  box.replaceChildren(...v3d.faces.map(f => f.node));
  $('#v3dFloor').style.width = `${W * 1.4}px`;
  apply3D();
}
function apply3D() {
  const box = $('#v3dBox');
  box.style.transform = `rotateX(${v3d.rx}deg) rotateY(${v3d.ry}deg)`;
  $('#v3dZoom').style.transform = `scale(${v3d.zoom})`;
  const a = v3d.rx * Math.PI / 180, b = v3d.ry * Math.PI / 180;
  const L = [-.35, -.45, 1], ll = Math.hypot(...L);
  for (const f of v3d.faces) {
    const [x, y, z] = f.n;
    const x1 = x * Math.cos(b) + z * Math.sin(b), z1 = -x * Math.sin(b) + z * Math.cos(b);
    const y2 = y * Math.cos(a) - z1 * Math.sin(a), z2 = y * Math.sin(a) + z1 * Math.cos(a);
    const lit = Math.max(0, (x1 * L[0] + y2 * L[1] + z2 * L[2]) / ll);
    f.shade.style.opacity = (.58 * (1 - lit)).toFixed(3);
    if (f.gloss) f.gloss.style.backgroundPosition = `${(50 + ((v3d.ry % 360) + 360) % 360 / 3.6 - 50) * 1.6}% 0`;
  }
}
function set3DView(rx, ry) {
  const box = $('#v3dBox');
  const cur = v3d.ry;   // turn the short way round
  let target = ry;
  while (target - cur > 180) target -= 360;
  while (target - cur < -180) target += 360;
  box.classList.add('animate');
  v3d.rx = rx; v3d.ry = target; apply3D();
  setTimeout(() => box.classList.remove('animate'), 650);
}
function spin3D() {
  cancelAnimationFrame(v3d.raf);
  if (!v3d.spin || !$('#viewer3d').open) return;
  const tick = () => { v3d.ry += .35; apply3D(); v3d.raf = requestAnimationFrame(tick); };
  v3d.raf = requestAnimationFrame(tick);
}
$('#view3dBtn').addEventListener('click', open3D);
document.querySelector('#viewer3d .v3d-tools')?.prepend(el('button', { class: 'btn primary small', text: 'Full-quality renders', onclick: () => { $('#viewer3d').close(); make3DRenders(); } }));
$('#v3dClose').addEventListener('click', () => { $('#viewer3d').close(); });
$('#viewer3d').addEventListener('close', () => { v3d.spin = false; $('#v3dSpin').checked = false; cancelAnimationFrame(v3d.raf); });
$('#v3dSpin').addEventListener('change', e => { v3d.spin = e.target.checked; spin3D(); });
$('#v3dShell').addEventListener('change', e => { e.target.dataset.touched = '1'; open3D(); });
for (const [id, rx, ry] of [['v3dFront', -6, 24], ['v3dSpine', -6, 66], ['v3dBack', -6, 156]]) {
  $('#' + id).addEventListener('click', () => set3DView(rx, ry));
}
$('#v3dStage').addEventListener('pointerdown', e => { v3d.drag = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.classList.add('dragging'); });
$('#v3dStage').addEventListener('pointermove', e => {
  if (!v3d.drag) return;
  v3d.ry += (e.clientX - v3d.drag.x) * .45;
  v3d.rx = clamp(v3d.rx - (e.clientY - v3d.drag.y) * .35, -70, 70);
  v3d.drag = { x: e.clientX, y: e.clientY };
  apply3D();
});
for (const ev of ['pointerup', 'pointercancel']) $('#v3dStage').addEventListener(ev, e => { v3d.drag = null; e.currentTarget.classList.remove('dragging'); });
$('#v3dStage').addEventListener('wheel', e => { e.preventDefault(); v3d.zoom = clamp(v3d.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), .5, 2.4); apply3D(); }, { passive: false });

/* ======================================================= 3D box renders */
// Full-quality product shots of the closed case, like DVD Cover Maker's: the printed insert
// mapped onto the case in true perspective (WebGL), on a studio sweep with a floor shadow.
const R3D_VIEWS = { front: [-265, 80, 390], spine: [-440, 80, 130], back: [-265, 80, -390] };   // camera offsets, mm (for a 190 mm case)
const R3D_SIZES = { hd: [2400, 1800], '4k': [3840, 2880] };
const PLASTIC = { black: '#3a3e46', clear: '#8d949e', blue: '#2458b8', red: '#b3151c', white: '#e2e3e6' };

function shellColour() {
  const v = $('#v3dShell')?.dataset.touched ? $('#v3dShell').value : { pc: 'black', bluray: 'blue', handheld: 'red' }[state.fx.caseSize];
  return PLASTIC[v] || PLASTIC.black;
}

// The insert split into the case's faces (printed art at 300 dpi), plus plain plastic edges.
function caseFaces() {
  const d = caseDims(), full = renderToCanvas('case'), H = d.heightPx;
  const crop = (x, w) => { const c = el('canvas'); c.width = w; c.height = H; c.getContext('2d').drawImage(full, x, 0, w, H, 0, 0, w, H); return c; };
  const ppm = 8, plastic = shellColour(), dark = mix(plastic, '#000000', .35);
  const side = el('canvas'); side.width = Math.round(d.spine * ppm); side.height = Math.round(d.height * ppm);
  let x = side.getContext('2d');
  x.fillStyle = plastic; x.fillRect(0, 0, side.width, side.height);
  x.fillStyle = '#e1e1dc';   // edge of the paper insert seen through the clear sleeve
  for (const px of [1.2 * ppm, side.width - 1.2 * ppm]) x.fillRect(px - 1, 0, 2, side.height);
  x.fillStyle = dark; x.fillRect(side.width / 2 - ppm / 4, 0, ppm / 2, side.height);
  const lid = el('canvas'); lid.width = Math.round(d.panel * ppm); lid.height = Math.round(d.spine * ppm);
  x = lid.getContext('2d');
  x.fillStyle = plastic; x.fillRect(0, 0, lid.width, lid.height);
  x.fillStyle = dark; x.fillRect(3 * ppm, lid.height / 2 - ppm / 4, lid.width - 6 * ppm, ppm / 2);
  return { back: crop(0, d.panelPx), spine: crop(d.panelPx, d.spinePx), front: crop(d.panelPx + d.spinePx, d.panelPx), side, top: lid, bottom: lid };
}

const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3norm = a => { const n = Math.hypot(...a); return a.map(v => v / n); };

function renderBoxShot(faces, view, [OW, OH], ss = 2) {
  const d = caseDims(), Wm = d.panel, Hm = d.height, Dm = d.spine;
  const FACES = {
    front: [[[0, Hm, 0], [Wm, Hm, 0], [Wm, 0, 0], [0, 0, 0]], [0, 0, 1]],
    back: [[[Wm, Hm, -Dm], [0, Hm, -Dm], [0, 0, -Dm], [Wm, 0, -Dm]], [0, 0, -1]],
    spine: [[[0, Hm, -Dm], [0, Hm, 0], [0, 0, 0], [0, 0, -Dm]], [-1, 0, 0]],
    side: [[[Wm, Hm, 0], [Wm, Hm, -Dm], [Wm, 0, -Dm], [Wm, 0, 0]], [1, 0, 0]],
    top: [[[0, Hm, -Dm], [Wm, Hm, -Dm], [Wm, Hm, 0], [0, Hm, 0]], [0, 1, 0]],
    bottom: [[[0, 0, 0], [Wm, 0, 0], [Wm, 0, -Dm], [0, 0, -Dm]], [0, -1, 0]],
  };
  const C = [Wm / 2, Hm / 2, -Dm / 2], k = Hm / 190, off = R3D_VIEWS[view];
  const eye = [C[0] + off[0] * k, C[1] + off[1] * k, C[2] + off[2] * k], target = [C[0], C[1] - 6 * k, C[2]];
  const F = v3norm(v3sub(target, eye)), R = v3norm(v3cross(F, [0, 1, 0])), U = v3cross(R, F);
  const raw = p => { const q = v3sub(p, eye), z = v3dot(q, F); return [v3dot(q, R) / z, -v3dot(q, U) / z]; };
  const W = Math.round(OW * ss), H = Math.round(OH * ss);
  const pts = Object.values(FACES).flatMap(([c]) => c.map(raw));
  const minx = Math.min(...pts.map(p => p[0])), maxx = Math.max(...pts.map(p => p[0]));
  const miny = Math.min(...pts.map(p => p[1])), maxy = Math.max(...pts.map(p => p[1]));
  const scale = Math.min(W * .56 / (maxx - minx), H * .8 / (maxy - miny));
  const ox = W / 2 - (minx + maxx) / 2 * scale, oy = H * .08 - miny * scale;
  const proj = p => { const r = raw(p); return [r[0] * scale + ox, r[1] * scale + oy]; };

  // Studio sweep with a soft light behind the case.
  const out = el('canvas'); out.width = W; out.height = H;
  const cx = out.getContext('2d');
  let g = cx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0e0f12'); g.addColorStop(.62, '#2c2f36'); g.addColorStop(1, '#1d1f24');
  cx.fillStyle = g; cx.fillRect(0, 0, W, H);
  cx.save();
  cx.translate(W / 2, H * .42); cx.scale(1, (H * .4) / (W * .33));
  g = cx.createRadialGradient(0, 0, 0, 0, 0, W * .42);
  g.addColorStop(0, 'rgba(92,98,110,.3)'); g.addColorStop(1, 'rgba(92,98,110,0)');
  cx.fillStyle = g; cx.fillRect(-W, -H * 3, W * 2, H * 6);
  cx.restore();
  // Soft floor shadow under the case.
  const foot = FACES.bottom[0].map(proj), fx = foot.map(p => p[0]), fy = foot.map(p => p[1]);
  cx.save();
  cx.filter = `blur(${(W * .006).toFixed(1)}px)`;
  cx.fillStyle = 'rgba(0,0,0,.47)';
  cx.beginPath(); cx.ellipse((Math.min(...fx) + Math.max(...fx)) / 2, (Math.min(...fy) + Math.max(...fy)) / 2 + H * .003,
    (Math.max(...fx) - Math.min(...fx)) / 2 + W * .02, (Math.max(...fy) - Math.min(...fy)) / 2 + H * .009, 0, 0, Math.PI * 2); cx.fill();
  cx.fillStyle = 'rgba(0,0,0,.9)';
  cx.beginPath(); foot.forEach((p, i) => i ? cx.lineTo(...p) : cx.moveTo(...p)); cx.closePath(); cx.fill();
  cx.restore();

  // The case: WebGL, perspective-correct, mipmapped + anisotropic textures, MSAA.
  const glc = el('canvas'); glc.width = W; glc.height = H;
  const gl = glc.getContext('webgl2', { antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
  if (!gl) throw new Error('WebGL 2 isn’t available in this browser, so 3D renders can’t be made.');
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, `#version 300 es
    in vec3 p; in vec2 t; out vec2 vt;
    uniform vec3 eye, R, U, F; uniform vec3 fit; uniform vec2 size;
    void main() {
      vec3 q = p - eye; float z = dot(q, F);
      vec2 px = vec2(dot(q, R) / z, -dot(q, U) / z) * fit.x + fit.yz;
      vec2 c = vec2(px.x / size.x * 2.0 - 1.0, 1.0 - px.y / size.y * 2.0);
      gl_Position = vec4(c * z, ((z - 1.0) / 10000.0 * 2.0 - 1.0) * z, z);
      vt = t;
    }`));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float; in vec2 vt; out vec4 o; uniform sampler2D tex; uniform float shade;
    void main() { o = vec4(texture(tex, vt).rgb * shade, 1.0); }`));
  gl.linkProgram(prog); gl.useProgram(prog);
  const u = n => gl.getUniformLocation(prog, n);
  gl.uniform3fv(u('eye'), eye); gl.uniform3fv(u('R'), R); gl.uniform3fv(u('U'), U); gl.uniform3fv(u('F'), F);
  gl.uniform3f(u('fit'), scale, ox, oy); gl.uniform2f(u('size'), W, H);
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  // Soft light from over the viewer's shoulder: faces towards the camera keep their printed colours.
  const L = v3norm([-F[0] + U[0] * .45 - R[0] * .3, -F[1] + U[1] * .45 - R[1] * .3, -F[2] + U[2] * .45 - R[2] * .3]);
  const buf = gl.createBuffer(), aP = gl.getAttribLocation(prog, 'p'), aT = gl.getAttribLocation(prog, 't');
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(aT); gl.vertexAttribPointer(aT, 2, gl.FLOAT, false, 20, 12);
  for (const [name, [c, n]] of Object.entries(FACES)) {
    const centre = [0, 1, 2].map(i => c.reduce((a, q) => a + q[i], 0) / 4);
    if (v3dot(n, v3sub(eye, centre)) <= 0) continue;   // facing away
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, faces[name]);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
    const lit = Math.max(0, v3dot(n, L));
    gl.uniform1f(u('shade'), ['front', 'back', 'spine'].includes(name) ? .8 + .2 * lit : .6 + .4 * lit);
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]], v = [0, 1, 2, 0, 2, 3].flatMap(i => [...c[i], ...uv[i]]);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.deleteTexture(tex);
  }
  cx.drawImage(glc, 0, 0);
  gl.getExtension('WEBGL_lose_context')?.loseContext();

  // Down to the output size (supersampled → very smooth edges).
  const fin = el('canvas'); fin.width = OW; fin.height = OH;
  const fc = fin.getContext('2d'); fc.imageSmoothingQuality = 'high';
  fc.drawImage(out, 0, 0, OW, OH);
  fin.caseX = [(minx * scale + ox) / ss, (maxx * scale + ox) / ss];
  return fin;
}

// The three shots side by side, each cropped to its case plus some backdrop.
function showcase(shots) {
  const [w, h] = [shots[0].width, shots[0].height], margin = w * .07;
  const crops = shots.map(s => [Math.max(0, s.caseX[0] - margin), Math.min(w, s.caseX[1] + margin)]);
  const out = el('canvas'); out.width = Math.round(crops.reduce((a, [x0, x1]) => a + x1 - x0, 0)); out.height = h;
  const x = out.getContext('2d');
  let at = 0;
  shots.forEach((s, i) => { const [x0, x1] = crops[i]; x.drawImage(s, x0, 0, x1 - x0, h, at, 0, x1 - x0, h); at += x1 - x0; });
  return out;
}

async function make3DRenders() {
  if (!state.game) return toast('Pick a game first.');
  const dlg = ensureRenderDialog(), size = R3D_SIZES[$('#r3dSize').value] || R3D_SIZES.hd;
  dlg.querySelector('.r3d-grid').replaceChildren(el('div', { class: 'asset-note', text: 'Rendering…' }));
  if (!dlg.open) dlg.showModal();
  await new Promise(r => setTimeout(r, 30));
  try {
    const faces = caseFaces(), shots = [];
    for (const view of ['front', 'spine', 'back']) { shots.push(renderBoxShot(faces, view, size)); await new Promise(r => setTimeout(r, 0)); }
    const all = [['render_front.png', shots[0]], ['render_spine.png', shots[1]], ['render_back.png', shots[2]], ['render_showcase.png', showcase(shots)]];
    state.renders = await Promise.all(all.map(async ([name, c]) => ({ name, blob: await new Promise(r => c.toBlob(r, 'image/png')), w: c.width, h: c.height })));
    dlg.querySelector('.r3d-grid').replaceChildren(...state.renders.map(r => {
      const url = URL.createObjectURL(r.blob);
      return el('figure', { class: 'r3d-item' + (r.name.includes('showcase') ? ' wide' : '') },
        el('img', { src: url, alt: r.name }),
        el('figcaption', {}, el('span', { text: `${r.name.replace(/^render_|\.png$/g, '')} · ${r.w}×${r.h}` }),
          el('a', { class: 'btn ghost small', href: url, download: `${slug(state.game.name)}-${r.name}`, text: 'Download' })));
    }));
  } catch (e) {
    dlg.querySelector('.r3d-grid').replaceChildren(el('div', { class: 'asset-note', text: e.message }));
  }
}
async function saveRenders() {
  if (!state.renders?.length) return;
  try {
    const files = await Promise.all(state.renders.map(async r => ({ name: r.name, data: await fileToBase64(r.blob) })));
    const res = await api('/api/save-renders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: state.game.name, files }) });
    toast(`Saved ${res.saved.length} renders to ${res.folder}`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}
function ensureRenderDialog() {
  let dlg = $('#renders3d');
  if (dlg) return dlg;
  dlg = el('dialog', { id: 'renders3d', class: 'renders3d' },
    el('div', { class: 'v3d-head' }, el('strong', { text: '3D box renders' }),
      el('div', { class: 'v3d-tools' },
        el('label', { class: 'id-field' }, 'Size ', el('select', { id: 'r3dSize', onchange: () => make3DRenders() },
          el('option', { value: 'hd', text: '2400 × 1800' }), el('option', { value: '4k', text: '3840 × 2880 (4K)' }))),
        el('button', { class: 'btn primary small', text: 'Save all to Pictures', onclick: saveRenders }),
        el('button', { class: 'btn ghost small', text: 'Close', onclick: () => dlg.close() }))),
    el('div', { class: 'r3d-grid' }));
  document.body.append(dlg);
  return dlg;
}

/* ============================================================== misc UI */
$('#shuffleBtn').addEventListener('click', shuffleArt);
$('#moreBtn').addEventListener('click', async () => {
  const t = state.tab;
  if (!state.more[t]) return;
  $('#moreBtn').disabled = true;
  await loadSgdbKind(t, (state.pages[t] || 0) + 1);
  $('#moreBtn').disabled = false;
  renderAssets();
});
$('#uploadImg').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!state.game) return toast('Pick a game first.');
  const slot = state.slot === 'auto' ? 'bg' : state.slot;
  setImage(slot, { id: 'upload-' + Date.now(), url: URL.createObjectURL(f), kind: 'upload', label: f.name });
});

// Settings: the SteamGridDB and Gemini keys. The server only ever says whether each is set and
// where from — the keys themselves never come back to the page.
const KEY_SOURCES = { env: 'set by environment variable', file: 'saved', dvdcovermaker: 'from DVD Cover Maker' };
function applyKeyStatus(cfg) {
  state.hasKey = !!cfg.hasKey;
  state.hasGemini = !!cfg.hasGemini;
  $('#keyBtn').textContent = cfg.hasKey ? 'Settings' : 'Settings · add key';
  if (cfg.configFile) $('#configPath').textContent = cfg.configFile;
  for (const [id, has, src] of [['sgdb', cfg.hasKey, cfg.keySource], ['gemini', cfg.hasGemini, cfg.geminiSource]]) {
    const st = $(`#${id}Status`);
    st.textContent = has ? `✓ ${KEY_SOURCES[src] || 'set'}` : 'Not set';
    st.classList.toggle('ok', !!has);
    $(`#${id}Remove`).hidden = src !== 'file';   // env / other-app keys aren't ours to remove
  }
  if (state.game) scheduleRender();
  renderControls();
}
function openKeyDialog() {
  const d = $('#keyDialog');
  if (d.open) return;
  $('#keyError').hidden = true; $('#keyInput').value = ''; $('#geminiInput').value = '';
  d.showModal();
  (state.hasKey ? $('#geminiInput') : $('#keyInput')).focus();
}
async function saveKeys(body, done) {
  const btn = $('#keySave');
  btn.disabled = true; $('#keyError').hidden = true;
  const hadKey = state.hasKey;
  try {
    applyKeyStatus(await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    $('#keyInput').value = ''; $('#geminiInput').value = '';
    toast(done, 'ok');
    if (body.apiKey && state.game && !hadKey) selectGame({ ...state.game, appid: state.game.storeAppId, shortcutId: state.game.shortcut ? state.game.targetId : null, source: state.game.shortcut ? 'shortcut' : 'steam' });
    return true;
  } catch (err) {
    $('#keyError').textContent = err.message; $('#keyError').hidden = false;
    return false;
  } finally { btn.disabled = false; }
}
$('#keyBtn').addEventListener('click', openKeyDialog);
$('#keyCancel').addEventListener('click', () => $('#keyDialog').close());
$('#keyForm').addEventListener('submit', async e => {
  e.preventDefault();
  const apiKey = $('#keyInput').value.trim(), geminiKey = $('#geminiInput').value.trim();
  if (!apiKey && !geminiKey) return $('#keyDialog').close();
  const what = [apiKey && 'SteamGridDB', geminiKey && 'Gemini'].filter(Boolean).join(' and ');
  if (await saveKeys({ apiKey, geminiKey }, `${what} key saved.`)) $('#keyDialog').close();
});
$('#sgdbRemove').addEventListener('click', () => {
  if (confirm('Remove the saved SteamGridDB key from this computer?')) saveKeys({ clear: ['sgdb'] }, 'SteamGridDB key removed.');
});
$('#geminiRemove').addEventListener('click', () => {
  if (confirm('Remove the saved Gemini key from this computer?')) saveKeys({ clear: ['gemini'] }, 'Gemini key removed.');
});

/* ====================================================== interface theme */
// Light / dark only changes the app's own interface. The cover's colours come from the game.
function applyUiTheme(mode) {
  document.documentElement.dataset.ui = mode;
  const btn = $('#uiThemeBtn');
  btn.textContent = mode === 'light' ? '☾ Dark' : '☀ Light';
  btn.title = `Switch the interface to ${mode === 'light' ? 'dark' : 'light'} (doesn’t change the cover)`;
}
(() => {
  let saved = null;
  try { saved = localStorage.getItem('coverStudio.ui'); } catch { /* storage unavailable */ }
  applyUiTheme(saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  $('#uiThemeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.ui === 'light' ? 'dark' : 'light';
    applyUiTheme(next);
    try { localStorage.setItem('coverStudio.ui', next); } catch { /* storage unavailable */ }
  });
})();

/* ================================================================= init */
async function init() {
  loadGoogleFonts();
  updateTplTabs(); updateHint(); renderAssetTabs(); renderSlots(); renderControls(); renderAssets();
  scheduleRender();
  document.fonts.ready.then(scheduleRender);
  setInterval(() => fetch('/api/ping').catch(() => {}), 30000);
  fetch('/api/ping').catch(() => {});
  try {
    applyKeyStatus(await api('/api/config'));
  } catch { /* server offline */ }
  try {
    state.library = await api('/api/library');
    const users = state.library.users || [];
    if (state.library.steamRoot && users.length) {
      $('#steamUser').replaceChildren(...users.map(u => el('option', { value: u.id, text: u.name })));
      $('#steamGroup').hidden = false;
    }
  } catch { /* no Steam */ }
  await loadUserFonts();
  try {
    state.upscaylInfo = await api('/api/upscayl');
    if (state.upscaylInfo.available) {
      const F = state.fx;
      F.upscaleModel = state.upscaylInfo.default;
      $('#upscaleModel').replaceChildren(...state.upscaylInfo.models.map(m => el('option', { value: m, text: m.replace(/-4x$/, '').replace(/-/g, ' ') })));
      $('#upscaleModel').value = F.upscaleModel;
      $('#upscaleGroup').hidden = false;
      $('#upscaleSel').value = F.upscaleMode;
      $('#upscaleSel').addEventListener('change', e => {
        F.upscaleMode = e.target.value;
        $('#upscaleModel').disabled = F.upscaleMode === 'off';
        upscaleAll();
      });
      $('#upscaleModel').addEventListener('change', e => { F.upscaleModel = e.target.value; });
    }
  } catch { /* no Upscayl */ }

  // Deep link: /?appid=<steam app id>&tpl=boxback|cover|wide|hero
  const q = new URLSearchParams(location.search);
  if (TEMPLATES[q.get('tpl')]) switchTpl(q.get('tpl'));
  const appid = q.get('appid');
  if (appid && /^\d+$/.test(appid)) {
    const known = state.library?.games.find(gm => gm.appid === appid);
    selectGame({ name: known?.name || `App ${appid}`, appid, source: 'steam' });
  } else if (!state.hasKey) openKeyDialog();
}
init();
