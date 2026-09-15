// Shade library, salon looks and haircut presets.
// Shade hex values are the *mid-tone* of the hair colour; the shader builds
// highlights and shadows around it from the photo's own strand detail.

export const SHADES = [
  { name: 'Jet Black', hex: '#1b1714' },
  { name: 'Soft Black', hex: '#2b2421' },
  { name: 'Blue Black', hex: '#1d2233' },
  { name: 'Espresso', hex: '#3a2921' },
  { name: 'Dark Chocolate', hex: '#4a3126' },
  { name: 'Mocha Brown', hex: '#6e4b35' },
  { name: 'Chestnut', hex: '#7a4630' },
  { name: 'Mushroom Brown', hex: '#7b6a5c' },
  { name: 'Cinnamon', hex: '#9b5a36' },
  { name: 'Caramel', hex: '#a8703f' },
  { name: 'Toffee', hex: '#b08556' },
  { name: 'Honey Blonde', hex: '#c69a5b' },
  { name: 'Golden Blonde', hex: '#d4ac6e' },
  { name: 'Strawberry Blonde', hex: '#d39a6e' },
  { name: 'Ash Blonde', hex: '#b8ab95' },
  { name: 'Beige Blonde', hex: '#d6c09e' },
  { name: 'Platinum', hex: '#e7ddcc' },
  { name: 'Icy Silver', hex: '#cdd1d4' },
  { name: 'Copper', hex: '#b5582e' },
  { name: 'Auburn', hex: '#8a3b26' },
  { name: 'Cherry Cola', hex: '#5a1a24' },
  { name: 'Burgundy', hex: '#6a2233' },
  { name: 'Cherry Red', hex: '#9c1c26' },
  { name: 'Rose Gold', hex: '#d49a8c' },
  { name: 'Pastel Pink', hex: '#e8a9b8' },
  { name: 'Lavender', hex: '#b7a0d4' },
  { name: 'Midnight Blue', hex: '#26386a' },
  { name: 'Teal', hex: '#2c7f86' },
];

const hex = name => SHADES.find(s => s.name === name).hex;

export const COLOR_DEFAULTS = {
  technique: 'solid',
  base: hex('Mocha Brown'),
  light: hex('Caramel'),
  strength: 0,
  coverage: 0.5,
  blend: 0.45,
  root: 0,
  frame: 0,
  shine: 0,
};

const look = (name, group, technique, base, light, extra = {}) => ({
  name,
  group,
  settings: { ...COLOR_DEFAULTS, technique, base: hex(base), light: hex(light ?? base), strength: 0.9, shine: 0.2, ...extra },
});

export const LOOKS = [
  { name: 'Original', group: 'Natural', settings: { ...COLOR_DEFAULTS } },
  look('Mocha Brown', 'Brunette', 'solid', 'Mocha Brown'),
  look('Dark Chocolate', 'Brunette', 'solid', 'Dark Chocolate'),
  look('Espresso', 'Brunette', 'solid', 'Espresso'),
  look('Mushroom Brown', 'Brunette', 'solid', 'Mushroom Brown', null, { shine: 0.1 }),
  look('Chestnut', 'Brunette', 'solid', 'Chestnut'),
  look('Jet Black', 'Brunette', 'solid', 'Jet Black', null, { shine: 0.45 }),

  look('Caramel Balayage', 'Balayage & lights', 'balayage', 'Dark Chocolate', 'Caramel', { root: 0.25, coverage: 0.55 }),
  look('Honey Balayage', 'Balayage & lights', 'balayage', 'Chestnut', 'Honey Blonde', { root: 0.2, coverage: 0.6 }),
  look('Ash Blonde Balayage', 'Balayage & lights', 'balayage', 'Mushroom Brown', 'Beige Blonde', { root: 0.3, coverage: 0.6, blend: 0.4 }),
  look('Bronde', 'Balayage & lights', 'balayage', 'Mocha Brown', 'Toffee', { coverage: 0.7, blend: 0.3 }),
  look('Babylights', 'Balayage & lights', 'babylights', 'Mocha Brown', 'Honey Blonde', { coverage: 0.55 }),
  look('Blonde Babylights', 'Balayage & lights', 'babylights', 'Honey Blonde', 'Platinum', { coverage: 0.45 }),
  look('Chunky Highlights', 'Balayage & lights', 'highlights', 'Espresso', 'Honey Blonde', { coverage: 0.45 }),
  look('Money Piece', 'Balayage & lights', 'solid', 'Dark Chocolate', 'Beige Blonde', { frame: 1 }),
  look('Copper Ombré', 'Balayage & lights', 'ombre', 'Dark Chocolate', 'Copper', { blend: 0.5 }),
  look('Rose Gold Ombré', 'Balayage & lights', 'ombre', 'Mocha Brown', 'Rose Gold', { blend: 0.45 }),

  look('Honey Blonde', 'Blonde', 'solid', 'Honey Blonde'),
  look('Golden Blonde', 'Blonde', 'solid', 'Golden Blonde'),
  look('Ash Blonde', 'Blonde', 'solid', 'Ash Blonde', null, { shine: 0.1 }),
  look('Platinum Blonde', 'Blonde', 'solid', 'Platinum', null, { root: 0.2 }),
  look('Icy Silver', 'Blonde', 'solid', 'Icy Silver', null, { root: 0.15 }),
  look('Strawberry Blonde', 'Blonde', 'solid', 'Strawberry Blonde'),

  look('Copper', 'Red & copper', 'solid', 'Copper'),
  look('Auburn', 'Red & copper', 'solid', 'Auburn'),
  look('Cinnamon', 'Red & copper', 'solid', 'Cinnamon'),
  look('Cherry Cola', 'Red & copper', 'solid', 'Cherry Cola', null, { shine: 0.4 }),
  look('Burgundy', 'Red & copper', 'solid', 'Burgundy'),
  look('Cherry Red', 'Red & copper', 'solid', 'Cherry Red'),

  look('Blue Black', 'Bold & pastel', 'solid', 'Blue Black', null, { shine: 0.45 }),
  look('Pastel Pink', 'Bold & pastel', 'solid', 'Pastel Pink', null, { root: 0.25 }),
  look('Lavender Ombré', 'Bold & pastel', 'ombre', 'Soft Black', 'Lavender', { blend: 0.4 }),
  look('Midnight Blue', 'Bold & pastel', 'solid', 'Midnight Blue'),
  look('Teal Peek-a-boo', 'Bold & pastel', 'highlights', 'Soft Black', 'Teal', { coverage: 0.35 }),
  look('Split Dye', 'Bold & pastel', 'split', 'Jet Black', 'Platinum'),
];

export const TECHNIQUES = [
  { id: 'solid', name: 'All-over', hint: 'One colour, root to tip' },
  { id: 'balayage', name: 'Balayage', hint: 'Hand-painted, lighter towards the ends' },
  { id: 'ombre', name: 'Ombré', hint: 'Smooth fade from roots to ends' },
  { id: 'babylights', name: 'Babylights', hint: 'Many fine, soft strands (pick a highlight close to the main colour)' },
  { id: 'highlights', name: 'Highlights', hint: 'Bolder foil sections' },
  { id: 'split', name: 'Split dye', hint: 'Two colours down the parting' },
];

// Mini swatch preview for a look card, drawn with CSS gradients
export function swatchCss(s) {
  const a = s.base, b = s.light;
  const sheen = 'linear-gradient(115deg, rgba(255,255,255,0) 30%, rgba(255,255,255,.28) 45%, rgba(255,255,255,0) 60%)';
  switch (s.technique) {
    case 'balayage':
      return `${sheen}, repeating-linear-gradient(100deg, transparent 0 7px, ${b}99 7px 11px), linear-gradient(180deg, ${a} 25%, ${b} 100%)`;
    case 'ombre':
      return `${sheen}, linear-gradient(180deg, ${a} 30%, ${b} 85%)`;
    case 'babylights':
      return `${sheen}, repeating-linear-gradient(95deg, ${a} 0 3px, ${b} 3px 4px)`;
    case 'highlights':
      return `${sheen}, repeating-linear-gradient(95deg, ${a} 0 9px, ${b} 9px 14px)`;
    case 'split':
      return `${sheen}, linear-gradient(90deg, ${a} 50%, ${b} 50%)`;
    default:
      if (s.frame > 0) return `${sheen}, linear-gradient(90deg, ${b} 0 18%, ${a} 18% 82%, ${b} 82%)`;
      return `${sheen}, linear-gradient(180deg, ${a}, ${a})`;
  }
}

// Per-photo calibration, kept when switching looks
export const TONE_DEFAULTS = { lift: 0 };

export const STYLE_DEFAULTS = { length: 0, volume: 0, wave: 0, waveSize: 0.35, curl: 0, sleek: 0, bangs: 0 };

// `cutTo` is a target hair length in face-heights below the top of the face (chin ≈ 1.0).
export const STYLES = [
  { name: 'Original', desc: 'As photographed', settings: {} },
  { name: 'Pixie', desc: 'Cropped above the ears', settings: { length: -1, volume: -0.1 } },
  { name: 'Bob', desc: 'Chin length', cutTo: 1.05, settings: {} },
  { name: 'Lob', desc: 'Long bob, grazes shoulders', cutTo: 1.65, settings: {} },
  { name: 'Wavy bob', desc: 'Chin length + texture', cutTo: 1.15, settings: { wave: 0.6, waveSize: 0.55 } },
  { name: 'Longer', desc: 'Extra length', settings: { length: 0.4 } },
  { name: 'Beach waves', desc: 'Soft, undone S-waves', settings: { wave: 0.7, waveSize: 0.4 } },
  { name: 'Glam waves', desc: 'Big loose waves', settings: { wave: 1, waveSize: 0, volume: 0.2 } },
  { name: 'Perm curls', desc: 'Springy ringlets', settings: { curl: 0.85, wave: 0.3, waveSize: 0.6 } },
  { name: 'Blowout', desc: 'Bouncy volume', settings: { volume: 0.8, wave: 0.15, waveSize: 0 } },
  { name: 'Sleek straight', desc: 'Smooth and glossy', settings: { sleek: 1 } },
  { name: 'Curtain bangs', desc: 'Face-framing fringe', settings: { bangs: 0.9 } },
];

// Length slider value that cuts the hair at `cutTo` face-heights (matches the shader's formula)
export function lengthForCut(meta, cutTo) {
  const [, fy0, , fy1] = meta.faceBox;
  const fh = Math.max(fy1 - fy0, 0.03);
  const hb = meta.hairBox[3];
  const ear = fy0 + fh * 0.55;
  const target = fy0 + fh * cutTo;
  if (target >= hb || hb - ear < 0.01) return 0;
  return -Math.min(1, (hb - target) / (hb - ear));
}
