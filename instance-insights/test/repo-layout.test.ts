import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { CHECKS } from '../src/checks/catalog.ts';
import { APP_NAME, REPORT_WIDGET } from '../src/report-shared.ts';

/**
 * Guards the layout and the public documentation, so a mistake in either fails a
 * build instead of relying on someone noticing during review.
 *
 * This app is one npm project and one YouTrack app: the manifest sits next to a
 * single package.json at the root of the app. A nested npm project (as in a
 * generator being run into a subfolder) splits the toolchain in two and silently
 * diverges from the layout the JetBrains tooling expects.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const IGNORED = new Set(['node_modules', '.git', 'dist']);

/** Every source file under a directory, as paths relative to the repository root. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.(ts|tsx|js|mjs|json|md)$/.test(entry.name)) {
      found.push(relative(ROOT, full));
    }
  }
  return found;
}

function findFiles(name: string, dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(name, full, found);
    } else if (entry.name === name) {
      found.push(relative(ROOT, full));
    }
  }
  return found;
}

test('exactly one package.json - no npm project inside an npm project', () => {
  const manifests = findFiles('package.json', ROOT);
  assert.deepEqual(
    manifests,
    ['package.json'],
    'Found a nested package.json. This app is a single npm project; move the ' +
      'files up and merge the dependencies instead of nesting a second project.',
  );
});

test('no nested node_modules directory', () => {
  const nested: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'dist') {
        continue;
      }
      if (entry.name === 'node_modules') {
        if (dir !== ROOT.replace(/\/$/, '')) {
          nested.push(relative(ROOT, join(dir, entry.name)));
        }
        continue;
      }
      walk(join(dir, entry.name));
    }
  };
  walk(ROOT.replace(/\/$/, ''));
  assert.deepEqual(nested, [], 'Only the root may have a node_modules directory.');
});

test('the app manifest sits at the repo root, where YouTrack expects it', () => {
  assert.ok(
    existsSync(join(ROOT, 'manifest.json')),
    'manifest.json must stay at the repo root.',
  );
});

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf8')) as Record<string, unknown>;
}

test('the app version and the package version are the same', () => {
  // YouTrack reads the manifest, npm reads package.json. A drift between them is
  // invisible locally and shows up as a wrong version number at the customer.
  assert.equal(
    readJson('manifest.json').version,
    readJson('package.json').version,
    'Bump the version in manifest.json and package.json together.',
  );
});

test('every widget has a name of its own', () => {
  // The manifest requires it - and the two names land in different places, the
  // main menu and the list a dashboard offers, where "Instance Insights" twice
  // would be a choice between two identical entries.
  const widgets = readJson('manifest.json').widgets as Array<{name: string}>;
  const names = widgets.map((widget) => widget.name);
  assert.equal(new Set(names).size, names.length, `duplicate widget name: ${names}`);
});

test('a widget asks for exactly the one permission that gates it', () => {
  /* Widget permissions are OR-joined: YouTrack shows the widget to anyone holding
     *any* of them. Listing READ_ISSUE alongside the admin permission would put a
     report about the whole instance in front of every user who can read an issue -
     and it would grant the app nothing, since a widget's REST calls always run with
     the permissions of whoever is looking at it. */
  const widgets = readJson('manifest.json').widgets as Array<{
    key: string;
    permissions?: string[];
  }>;
  assert.ok(widgets.length > 0, 'the app has widgets');
  for (const widget of widgets) {
    assert.deepEqual(
      widget.permissions,
      ['ADMIN_UPDATE_APP'],
      `widget ${widget.key} must be visible to administrators only`,
    );
  }
});

test('the README check table matches the catalog', () => {
  // The table is the public description of the scoring model, and a customer can
  // recompute the score from it. A weight that moves in the code and not in the
  // table would make the app contradict its own documentation.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const rows = new Map<string, string>();
  for (const line of readme.split('\n')) {
    const row = /^\| `([\w.-]+)` \|([^|]+)\|([^|]+)\|$/.exec(line);
    if (row?.[1]) {
      rows.set(row[1], `${row[3]?.trim()}`);
    }
  }

  const expected = new Map(CHECKS.map((c) => [c.id, `${c.weight}`]));
  assert.deepEqual(
    [...rows.keys()].sort(),
    [...expected.keys()].sort(),
    'The README lists other checks than the catalog does.',
  );
  for (const [id, cells] of expected) {
    assert.equal(rows.get(id), cells, `README row for ${id} states other numbers`);
  }
});

/** The number the first entry of COUNT_WORDS spells out. */
const SMALLEST_SPELLED_COUNT = 10;

const COUNT_WORDS = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'twenty-one',
  'twenty-two',
  'twenty-three',
  'twenty-four',
  'twenty-five',
  'twenty-six',
  'twenty-seven',
  'twenty-eight',
  'twenty-nine',
  'thirty',
];

test('the shipped texts name as many checks as the catalog holds', () => {
  // The number is spelled out where a reader meets the app before installing it:
  // the manifest and the marketplace listing. A check that leaves the catalog
  // without those texts following turns a description into a wrong promise.
  const spelled = COUNT_WORDS[CHECKS.length - SMALLEST_SPELLED_COUNT];
  assert.ok(spelled, 'The catalog no longer falls in the range these texts spell out.');
  for (const name of ['manifest.json', 'README.md', 'marketplace/LISTING.md']) {
    const text = readFileSync(join(ROOT, name), 'utf8');
    for (const [said, word] of text.matchAll(/([A-Za-z-]+) read-only checks/g)) {
      assert.equal(word?.toLowerCase(), spelled, `${name} says "${said}"`);
    }
  }
});

test('the app ships its own icons, not the generator default', () => {
  // The JetBrains generator drops the YouTrack logo in as icon.svg. Publishing that
  // under our vendor name puts someone else's trademark on this app.
  const icons = [
    'public/icon.svg',
    'src/widgets/report/widget-icon.svg',
    'src/widgets/score/widget-icon.svg',
  ];
  for (const icon of icons) {
    const svg = readFileSync(join(ROOT, icon), 'utf8');
    assert.ok(
      !svg.includes('youtrack_svg__'),
      `${icon} is still JetBrains' YouTrack logo from the generator template.`,
    );
  }
});

test('the dev harness cannot reach the app package', () => {
  // src/dev renders a widget outside YouTrack, with a stubbed Host API. It exists
  // because a widget inside YouTrack lives in a sandboxed iframe with an opaque
  // origin, which some browsers refuse network access to - including the one used
  // to build this app. Nothing of it may ship.
  const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  const inputs = config.slice(config.indexOf('input: {'), config.indexOf('output: {'));
  assert.ok(!inputs.includes('src/dev'), 'the build takes the widget entries only');

  for (const file of widgetSources()) {
    const source = readFileSync(file, 'utf8');
    assert.ok(
      !source.includes("/dev/") && !source.includes("'./dev"),
      `${file} must not import the dev harness`,
    );
  }
});

/** Every TypeScript source under src/widgets. */
function widgetSources(): string[] {
  const root = new URL('../src/widgets/', import.meta.url);
  const found: string[] = [];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        found.push(child.pathname);
      }
    }
  };
  walk(root);
  return found;
}

test('the app talks to nothing but its own instance', () => {
  /* No phone-home, no telemetry: the only hosts in the shipped code are the
     vendor links in the report footer, which are rendered as links, not fetched. */
  const allowed = new Set(['https://ninjaneers.de']);
  const files = [...widgetSources(), join(ROOT, 'src/report-markdown.ts'),
    join(ROOT, 'src/report-print.ts'), join(ROOT, 'src/youtrack-api.ts'),
    join(ROOT, 'src/host-client.ts'), join(ROOT, 'src/app-state.ts'),
    join(ROOT, 'src/backend.js')];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const url of source.match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
      const origin = url.replace(/^(https?:\/\/[^/]+).*$/, '$1');
      assert.ok(
        allowed.has(origin),
        `${file} refers to ${origin}; the app may only talk to its own instance`,
      );
    }
  }
});

test('the sources are plain ASCII', () => {
  /*
   * Typographic characters render differently in every terminal, diff tool and CI
   * log, and a reader should not have to fix their locale to read a comment. Two
   * exceptions: a field name that is the content rather than the writing - the
   * duplicate-field check exists for fields spelled Priority and its German twin
   * side by side, and for names written in a script with no Latin letters at all -
   * and the two files whose subject is exactly such characters.
   */
  const allowedNames = [
    'Priorität',
    'Приоритет',
    'приоритет',
    'Статус',
  ];
  const ownSubject = new Set(['internal-references.test.ts', 'export-public.ts']);
  const rootFiles = [
    'README.md',
    'package.json',
    'manifest.json',
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.node.json',
    'tsconfig.handler.json',
    'vite.config.ts',
    'eslint.config.mjs',
  ];
  const offenders: string[] = [];
  const check = (full: string): void => {
    let text = readFileSync(full, 'utf8');
    for (const name of allowedNames) {
      text = text.split(name).join('');
    }
    const found = [...new Set([...text].filter(c => c.charCodeAt(0) > 127))];
    if (found.length > 0) {
      offenders.push(`${relative(ROOT, full)}: ${found.join(' ')}`);
    }
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED.has(entry.name) || ownSubject.has(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|mjs|json|css|md|html|yml)$/.test(entry.name)) {
        check(full);
      }
    }
  };
  /* Not every directory is present in every copy of the app: a repository that
     holds several apps keeps its workflows at its own root, where GitHub reads
     them, so the app folder there has no .github of its own. */
  for (const dir of ['src', 'test', 'scripts', '@types', '.github']) {
    if (existsSync(join(ROOT, dir))) {
      walk(join(ROOT, dir));
    }
  }
  for (const file of rootFiles) {
    if (existsSync(join(ROOT, file))) {
      check(join(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], 'These files carry characters outside ASCII.');
});

test('every check a test or a document names is a check that exists', () => {
  /*
   * A fixture built around a check that was removed goes on passing: the engine
   * takes any id, so the test keeps testing a shape while its comments describe
   * something the app no longer does. Four files still named a check that had been
   * deleted, one of them with two count rules nothing reached any more.
   */
  const ids = new Set(CHECKS.map((check) => check.id));
  const category = '(?:licensing|fields|process|governance|portfolio|instance)';
  /* Quoted, so that reading the length of a variable named for a category is not
     taken for a check id. The public README writes them bare, in its table. */
  const quoted = new RegExp(`['"\`](${category}\\.[a-z][a-z-]+)['"\`]`, 'g');
  const bare = new RegExp(`\\b(${category}\\.[a-z][a-z-]+)`, 'g');
  const offenders: string[] = [];
  const check = (file: string): void => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const [, named] of text.matchAll(file.endsWith('.md') ? bare : quoted)) {
      if (named !== undefined && !ids.has(named)) {
        offenders.push(`${file}: ${named}`);
      }
    }
  };
  for (const dir of ['test', 'src', 'scripts']) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      check(file);
    }
  }
  for (const file of ['README.md', 'manifest.json']) {
    if (existsSync(join(ROOT, file))) {
      check(file);
    }
  }
  assert.deepEqual(offenders, [], 'These name a check the catalog does not have.');
});

test('a sentence the three reports share is written in one place', () => {
  /*
   * The page, the printed document and the Markdown file say a lot of the same
   * things, and every wording kept in three places is a wording that agrees in two
   * of them: the section of marked findings had drifted to three sentences, one of
   * which promised something the other two did not. The vocabulary lives in
   * report-shared.ts; a renderer that spells one of these out again fails here.
   */
  const shared = [
    'look unremarkable',
    'percentage point of before',
    'count as having run',
    'Ninjaneers GmbH',
    'walk through this report',
  ];
  const renderers = [
    'src/report-markdown.ts',
    'src/report-print.ts',
    'src/widgets/report/app.tsx',
    'src/widgets/score/app.tsx',
  ];
  const offenders: string[] = [];
  for (const file of renderers) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const sentence of shared) {
      if (text.includes(sentence)) {
        offenders.push(`${file}: ${sentence}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'These sentences belong in src/report-shared.ts.');
});

test('the app page a widget links to is the one the manifest declares', () => {
  /* The tile links to the report page by name, and the name is the manifest's. A
     renamed app or a renamed widget would leave that link pointing at nothing, and
     nothing in a build would say so. */
  const manifest = readJson('manifest.json');
  assert.equal(manifest['name'], APP_NAME, 'the app name the link is built from');
  const widgets = manifest['widgets'];
  assert.ok(Array.isArray(widgets));
  const keys = widgets.map((widget) => (widget as {key?: string}).key);
  assert.ok(keys.includes(REPORT_WIDGET), `no widget keyed ${REPORT_WIDGET}: ${keys.join(', ')}`);
});
