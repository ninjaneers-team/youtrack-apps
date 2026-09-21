/**
 * Installs the current build into the instance in `.env`, so a change can be
 * retested where it will actually run.
 *
 * Two things a plain upload does not do. The version in the uploaded manifest gets
 * a build number, because YouTrack keeps serving the widget HTML it has cached
 * until the version changes - an upload with an unchanged version looks like it did
 * nothing. And host and token come from YT_BASE_URL / YT_TOKEN, so there is one
 * place that knows where the instance is.
 *
 * Only the copy in `dist/` is stamped. The manifest in the repository keeps the
 * version the app is released under.
 *
 *   npm run deploy
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A YouTrack version carries between its parts, and the bases are not the same.
 *
 * Measured against 2026.2: `1.0.99999` and `1.99.99999` arrive as they were sent,
 * `1.0.100000` arrives as `1.1.0`, and `1.100.0` as `2.0.0`. So the last part counts
 * to a hundred thousand and the middle one to a hundred. Minutes since the start of
 * 2026 passed the first mark in June, which is why a stamped `1.0.353672` was served
 * as `1.3.53672` - a mismatch that lands in exactly the moment it is read, when a
 * change looks as though it never arrived.
 *
 * So the counter is written in those bases from the start, and what is stamped is
 * what the instance stores. Still one number per minute, and it stays inside the
 * middle part for nineteen years.
 */
const EPOCH_2026 = Date.UTC(2026, 0, 1);
const MINUTE_MS = 60_000;
const BUILD_BASE = 100_000;

const dist = resolve(import.meta.dirname, '../dist');
const manifestPath = resolve(dist, 'manifest.json');

const host = process.env.YT_BASE_URL;
const token = process.env.YT_TOKEN;
if (!host || !token) {
  console.error('YT_BASE_URL and YT_TOKEN must be set (see .env.example).');
  process.exit(1);
}

let manifest: { version: string; name?: string };
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
} catch {
  console.error(`No build in ${dist}. Run npm run build first.`);
  process.exit(1);
}

// major.minor.build - YouTrack rejects anything but three numbers.
const [major] = manifest.version.split('.');
const minutes = Math.floor((Date.now() - EPOCH_2026) / MINUTE_MS);
const version = [
  major,
  Math.floor(minutes / BUILD_BASE),
  minutes % BUILD_BASE,
].join('.');
writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

const upload = spawnSync('npx', ['youtrack-app', 'app', 'upload', '--directory', dist], {
  stdio: 'inherit',
  env: { ...process.env, YOUTRACK_HOST: host, YOUTRACK_API_TOKEN: token },
});
if (upload.status !== 0) {
  process.exit(upload.status ?? 1);
}
console.log(`\nInstalled ${manifest.name ?? 'the app'} ${version} into ${host}`);
