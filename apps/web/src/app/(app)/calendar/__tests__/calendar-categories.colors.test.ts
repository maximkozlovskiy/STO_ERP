// Кольори категорій записів календаря (BR-CAL-008, рішення власника 2026-10-16): кожна категорія —
// свій колір смуги й іконки (сім різних), смуга — від 3:1 до фону картки, клітинки (`bg-surface`,
// `bg-secondary` при наведенні) і блоку «Дня» у світлій, темній і системній темній темах; число
// лічильника — від 4,5:1 до `bg-surface`; текст блоку — від 4,5:1 до фону блоку.
//
// Значення токенів читаються з globals.css, а не дублюються тут: зміна токена теми, що зламає
// контраст, валить цей тест.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORY_VIEW, SLOT_CATEGORIES } from '../calendar-categories';

const CSS = readFileSync(resolve(__dirname, '../../../globals.css'), 'utf8');

function block(start: string): string {
  const i = CSS.indexOf(start);
  if (i < 0) throw new Error(`globals.css: немає блоку «${start}»`);
  const open = CSS.indexOf('{', i);
  let depth = 1;
  let k = open + 1;
  while (depth > 0) {
    if (CSS[k] === '{') depth += 1;
    else if (CSS[k] === '}') depth -= 1;
    k += 1;
  }
  return CSS.slice(open + 1, k - 1);
}

function tokens(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = tokens(block('@theme {'));
const dark = { ...light, ...tokens(block('\n.dark {')) };
const systemDark = { ...dark, ...tokens(block('@media (prefers-color-scheme: dark)')) };
const THEMES = { light, dark, systemDark } as const;

function rgb(theme: Record<string, string>, name: string): [number, number, number] {
  const value = theme[name];
  if (!value) throw new Error(`немає токена --color-${name}`);
  const ref = /^var\(--color-([a-z0-9-]+)\)$/.exec(value);
  if (ref) return rgb(theme, ref[1]);
  const m = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(value);
  if (!m) throw new Error(`--color-${name}: не hsl (${value})`);
  const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function contrast(theme: Record<string, string>, fg: string, bg: string): number {
  const lum = (name: string) => {
    const [r, g, b] = rgb(theme, name).map(c =>
      c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const token = (cls: string, prefix: string) => {
  expect(cls.startsWith(prefix), cls).toBe(true);
  return cls.slice(prefix.length);
};

describe('Кольори категорій календаря (BR-CAL-008)', () => {
  // guards: BR-CAL-008
  it('сім категорій — сім різних кольорів смуги, іконки й фону блоку', () => {
    const views = SLOT_CATEGORIES.map(c => CATEGORY_VIEW[c]);
    expect(views).toHaveLength(7);
    expect(new Set(views.map(v => v.barClassName)).size).toBe(7);
    expect(new Set(views.map(v => v.className)).size).toBe(7);
    expect(new Set(views.map(v => v.bgClassName)).size).toBe(7);
  });

  // guards: BR-CAL-008
  it.each(Object.entries(THEMES))(
    '%s: смуга від 3:1, число лічильника й текст блоку від 4,5:1',
    (_theme, theme) => {
      for (const c of SLOT_CATEGORIES) {
        const view = CATEGORY_VIEW[c];
        const bar = token(view.barClassName, 'border-l-');
        const icon = token(view.className, 'text-');
        const bg = token(view.bgClassName, 'bg-');
        for (const under of ['surface', 'secondary', bg]) {
          expect(
            contrast(theme, bar, under),
            `${c}: смуга ${bar} на ${under}`,
          ).toBeGreaterThanOrEqual(3);
          expect(
            contrast(theme, icon, under),
            `${c}: іконка ${icon} на ${under}`,
          ).toBeGreaterThanOrEqual(3);
        }
        expect(contrast(theme, icon, 'surface'), `${c}: число на surface`).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(contrast(theme, 'foreground', bg), `${c}: текст на ${bg}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    },
  );
});
