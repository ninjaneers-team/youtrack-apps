/**
 * Dev entry point. Not part of the app package: the build only takes the two
 * widget entries (see vite.config.ts), so nothing here can reach an instance.
 *
 * The widget modules call `YTApp.register()` while they are being evaluated, so the
 * stub has to exist before the import - hence the dynamic import below.
 */

import {installHostStub, resetState} from './host-stub.ts';

const params = new URLSearchParams(location.search);

if (params.get('scenario') === 'fresh') {
  resetState();
}

installHostStub();

/* YouTrack applies the user's theme to the widget document; without it the
   ring-ui variables fall back to light values on ring-ui's dark surface, which
   makes every colour judgement here worthless. */
if (params.get('theme') !== 'light') {
  document.documentElement.classList.add('ring-ui-theme-dark');
}

/* A widget keeps its own background transparent: inside YouTrack the host page is
   the ground, in whichever theme the user chose. Here there is no host, so this page
   paints that ground itself - in both themes, or a light theme judged in a browser
   set to dark reads as light text on a dark canvas. */
document.body.style.background = 'var(--ring-content-background-color, #27282c)';

const widget = params.get('widget') === 'score' ? 'score' : 'report';

// Vite resolves both branches at build time only for the dev server; the app
// package is built from the widget entries and never from this file.
if (widget === 'score') {
  await import('../widgets/score/index.tsx');
} else {
  await import('../widgets/report/index.tsx');
}
