import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A widget takes its colours from the instance, and it has no say in which theme
 * that is: YouTrack draws the widget document in the theme the reader chose, and the
 * only thing that arrives is the ring-ui variables. So two mistakes are invisible
 * while a developer looks at one theme and wrong in the other, and both are checked
 * here rather than left to review.
 *
 * A variable ring-ui does not define resolves to nothing, and the literal written
 * beside it takes over - one pale pink block on a dark page, for as long as nobody
 * opens that state in that theme. And a variable that has no dark value is a colour
 * chosen for light alone, whatever it is called.
 */

const WIDGETS = 'src/widgets';
const RING_UI = 'node_modules/@jetbrains/ring-ui-built/components/style.css';

/** The stylesheets a widget ships. Everything a reader sees is coloured by these. */
function widgetStylesheets(): Array<{ file: string; css: string }> {
  return readdirSync(WIDGETS, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry =>
      readdirSync(join(WIDGETS, entry.name))
        .filter(name => name.endsWith('.css'))
        .map(name => {
          const file = join(WIDGETS, entry.name, name);
          return { file, css: readFileSync(file, 'utf8') };
        }),
    );
}

interface Reference {
  file: string;
  name: string;
  fallback: string | null;
}

/** Every `var(--ring-...)` in a stylesheet, with whatever stands beside it. */
function referencesIn(file: string, css: string): Reference[] {
  const found: Reference[] = [];
  for (const match of css.matchAll(/var\(\s*(--ring-[a-z0-9-]+)\s*(?:,([^;]*?))?\)/g)) {
    found.push({ file, name: match[1] ?? '', fallback: match[2]?.trim() ?? null });
  }
  return found;
}

/**
 * The variables ring-ui declares, which of them it declares again for the dark
 * theme, and what each one points at.
 *
 * A colour rarely holds its own value. `--ring-x-color` reads the components of
 * `--ring-x-components`, and a named colour such as `--ring-action-link-color` is a
 * second name for `--ring-link-color`. The dark theme may replace any link in that
 * chain, so following the chain is the only way to tell a colour that stays light
 * from one that arrives at a dark value by another name.
 */
function ringUiVariables(): {
  declared: Set<string>;
  dark: Set<string>;
  pointsAt: Map<string, Set<string>>;
} {
  const css = readFileSync(RING_UI, 'utf8');
  const declared = new Set<string>();
  const pointsAt = new Map<string, Set<string>>();
  for (const match of css.matchAll(/(--ring-[a-z0-9-]+)\s*:([^;}]+)/g)) {
    const name = match[1] ?? '';
    declared.add(name);
    const targets = pointsAt.get(name) ?? new Set<string>();
    for (const reference of (match[2] ?? '').matchAll(/var\(\s*(--ring-[a-z0-9-]+)/g)) {
      targets.add(reference[1] ?? '');
    }
    pointsAt.set(name, targets);
  }
  const dark = new Set<string>();
  const darkBlocks = /\.(?:ring-ui-theme-dark|ring-variables_dark-dark)[^{]*\{([^}]*)\}/g;
  for (const block of css.matchAll(darkBlocks)) {
    for (const match of (block[1] ?? '').matchAll(/(--ring-[a-z0-9-]+)\s*:/g)) {
      dark.add(match[1] ?? '');
    }
  }
  return { declared, dark, pointsAt };
}

const STYLESHEETS = widgetStylesheets();
const REFERENCES = STYLESHEETS.flatMap(({ file, css }) => referencesIn(file, css));
const { declared, dark, pointsAt } = ringUiVariables();

/** Whether a dark value is reachable from this name, directly or through a chain. */
function followsTheTheme(name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) {
    return false;
  }
  seen.add(name);
  if (dark.has(name) || dark.has(name.replace(/-color$/, '-components'))) {
    return true;
  }
  const targets = [
    ...(pointsAt.get(name) ?? []),
    ...(pointsAt.get(name.replace(/-color$/, '-components')) ?? []),
  ];
  return targets.some(target => followsTheTheme(target, seen));
}

test('a widget stylesheet is found and read', () => {
  assert.ok(STYLESHEETS.length >= 2, 'both widgets carry a stylesheet');
  assert.ok(REFERENCES.length > 20, 'the colours come from ring-ui, so there are many');
});

test('every ring-ui variable a widget uses is one ring-ui declares', () => {
  const unknown = REFERENCES.filter(reference => !declared.has(reference.name));
  assert.deepEqual(
    unknown.map(reference => `${reference.file}: ${reference.name}`),
    [],
  );
});

test('every colour a widget uses has a dark value as well as a light one', () => {
  const lightOnly = REFERENCES.filter(
    reference => reference.name.endsWith('-color') && !followsTheTheme(reference.name),
  );
  assert.deepEqual(
    lightOnly.map(reference => `${reference.file}: ${reference.name}`),
    [],
  );
});

test('no colour carries a literal beside it', () => {
  /* Fonts are the exception, and the only one: a stack that steps in for a missing
     family is right in every theme, while a colour that steps in is right in one. */
  const withLiteral = REFERENCES.filter(
    reference => reference.fallback !== null && !reference.name.startsWith('--ring-font-family'),
  );
  assert.deepEqual(
    withLiteral.map(reference => `${reference.file}: ${reference.name}, ${reference.fallback}`),
    [],
  );
});

test('the font stacks keep theirs', () => {
  const fonts = REFERENCES.filter(reference => reference.name.startsWith('--ring-font-family'));
  assert.ok(fonts.length > 0);
  for (const font of fonts) {
    assert.notEqual(font.fallback, null, `${font.file}: ${font.name} needs a stack behind it`);
  }
});
