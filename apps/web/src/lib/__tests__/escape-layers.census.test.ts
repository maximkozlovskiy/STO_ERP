// Сторож стеку шарів Escape (техборг §15.12): Escape отримує лише верхній шар, і тримається це
// одним слухачем у lib/escape-layers. Власний keydown-слухач з Escape чи прапорець «вкладене
// відкрито» повертає клас багів #919–#933: один Escape закриває і вкладене вікно, і вікно під ним.
// Попап / меню / поле в режимі редагування — `useEscapeLayer(active, onEscape, scopeRef?)`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

/** Свідомі винятки: сам стек і палітра команд (capture на window, вища за все — z-300). */
const ALLOWED_KEYDOWN_ESCAPE = new Set([
  'lib/escape-layers.ts',
  'components/ui/command-palette.tsx',
]);

/**
 * React-обробник Escape (`onKeyDown`) у вікні мертвий: стек зупиняє подію в capture на document,
 * до кореня React вона не доходить. Тут — лише поля на сторінках-списках, поза будь-яким вікном.
 * Новий файл з `key === 'Escape'` — або `useEscapeLayer(editing, cancel, inputRef)`, або рядок тут
 * із перевіркою, що компонент ніколи не рендериться у `<Modal>`.
 */
const ALLOWED_REACT_ESCAPE = new Set([
  ...ALLOWED_KEYDOWN_ESCAPE,
  'app/(app)/catalog/UnitsTab.tsx',
  'app/(app)/work-orders/page.tsx',
  'components/ui/NavEditor.tsx',
  'components/ui/saved-filters-bar.tsx',
]);
const REACT_ESCAPE = /key\s*[!=]==?\s*['"]Escape['"]|case\s+['"]Escape['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const files = sourceFiles(SRC).map(full => ({
  path: relative(SRC, full).split(sep).join('/'),
  text: readFileSync(full, 'utf8'),
}));

describe('стек шарів Escape — сторож', () => {
  it('прапорців «вкладене відкрито» і старого перехоплювача немає', () => {
    const offenders = files
      .filter(f => /\b(useNestedOpenFlag|releaseNestedOpen|useEscapeCapture)\b/.test(f.text))
      .map(f => f.path);
    expect(offenders).toEqual([]);
  });

  it('Escape не слухають власним addEventListener(keydown) — лише через useEscapeLayer', () => {
    const offenders = files
      .filter(f => !ALLOWED_KEYDOWN_ESCAPE.has(f.path))
      .filter(
        f => /addEventListener\(\s*['"]keydown['"]/.test(f.text) && /['"]Escape['"]/.test(f.text),
      )
      .map(f => f.path);
    expect(offenders).toEqual([]);
  });

  it('перевірка `key === Escape` — лише у файлах зі списку (поза вікнами)', () => {
    const offenders = files
      .filter(f => !ALLOWED_REACT_ESCAPE.has(f.path))
      .filter(f => REACT_ESCAPE.test(f.text))
      .map(f => f.path);
    expect(offenders).toEqual([]);
  });

  it('сам перелік винятків живий (файли існують і справді слухають Escape)', () => {
    for (const path of ALLOWED_REACT_ESCAPE) {
      const file = files.find(f => f.path === path);
      expect(file, path).toBeDefined();
      expect(file!.text).toMatch(/['"]Escape['"]/);
    }
  });
});
