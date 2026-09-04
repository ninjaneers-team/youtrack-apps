import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The package an instance receives is compiled, and those files carry copies of
 * ring-ui, the JetBrains icon set and React. Apache-2.0 and MIT both ask the same
 * thing of anyone who passes the code on: a copy of the licence travels with it.
 *
 * So THIRD-PARTY-NOTICES.md is part of the app rather than documentation about it,
 * and it has to keep up with what the app actually depends on. A library added a
 * year from now is a licence nobody remembered to add, and the place that goes
 * unnoticed is a compiled bundle.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const NOTICES = 'THIRD-PARTY-NOTICES.md';

/** Runs of whitespace collapsed, so a line keeps its wording and loses its layout. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface Dependency {
  name: string;
  licence: string;
}

/** What ships: the runtime dependencies, and the licence text each one carries. */
function shippedDependencies(): Dependency[] {
  const { dependencies } = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  ) as { dependencies: Record<string, string> };

  return Object.keys(dependencies).map(name => {
    const candidates = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].map(file =>
      join(ROOT, 'node_modules', name, file),
    );
    const file = candidates.find(existsSync);
    assert.ok(file, `${name} ships no licence file, so none can be passed on`);
    return { name, licence: readFileSync(file, 'utf8') };
  });
}

const DEPENDENCIES = shippedDependencies();
const NOTICES_TEXT = readFileSync(join(ROOT, NOTICES), 'utf8');

test('the notices name every library that ships, and no other', () => {
  const named = [...NOTICES_TEXT.matchAll(/\*\*([@a-z0-9/-]+)\*\*/g)].map(match => match[1]);
  assert.deepEqual(
    [...new Set(named)].sort(),
    DEPENDENCIES.map(dependency => dependency.name).sort(),
  );
});

test('each licence appears in full, word for word from the library itself', () => {
  const notices = flat(NOTICES_TEXT);
  for (const { name, licence } of DEPENDENCIES) {
    const missing = licence
      .split('\n')
      .map(flat)
      .filter(Boolean)
      .filter(line => !notices.includes(line));
    assert.deepEqual(missing, [], `${NOTICES} drops lines of ${name}'s licence`);
  }
});

test('the notices travel inside the package, not only in the repository', () => {
  /* An installed app is the copy that matters: someone who receives it has the
     compiled libraries and no repository to look the licences up in. */
  const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
  assert.ok(config.includes(NOTICES), `the build has to copy ${NOTICES} into dist`);
});
