import {resolve} from 'node:path';
import {defineConfig, loadEnv} from 'vite';
import {viteStaticCopy} from 'vite-plugin-static-copy';
import react from '@vitejs/plugin-react';

/*
      See https://vitejs.dev/config/
*/

/** Every widget entry point. One HTML file per widget, as the app layout expects. */
const WIDGET_ENTRIES = {
  score: resolve(import.meta.dirname, 'src/widgets/score/index.html'),
  report: resolve(import.meta.dirname, 'src/widgets/report/index.html'),
};

/** Chunk names this configuration gives out itself. The rest Rollup derives. */
const NAMED_CHUNKS = ['react', 'engine'];

/**
 * True when a chunk holds nothing but code from dependencies.
 *
 * The modules a bundler injects itself are not part of that judgement: a helper
 * like `commonjsHelpers` or the module-preload polyfill has no directory to live
 * in, and counting it made every third-party chunk look like a mixed one.
 */
function vendorOnly(moduleIds: readonly string[]): boolean {
  const real = moduleIds.filter(id => !id.startsWith('\0'));
  return real.length > 0 && real.every(id => id.includes('node_modules'));
}

export default defineConfig(({mode}) => {
  /* Read by the dev server only, so the token stays in this process and never in a
     bundle. YouTrack runs in Docker, so YT_BASE_URL is the published port on the
     host - the same address `npm run scan` uses. */
  const env = loadEnv(mode, process.cwd(), '');

  return {
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: '../manifest.json',
          dest: '.'
        },
        /* The backend handler and the extension-property declaration belong at the
           root of the app package, and YouTrack runs the handler as plain JS, so
           they are copied rather than bundled. Named explicitly: the template's
           'src/*.*' glob would also copy the engine's TypeScript sources into the
           upload package. */
        {
          src: 'backend.js',
          dest: '.'
        },
        {
          src: 'entity-extensions.json',
          dest: '.'
        },
        {
          src: '../public/*.*',
          dest: '.'
        },
        /* The compiled bundles carry copies of ring-ui, the icon set and React,
           and both of those licences ask that a copy travel with the code. An
           installed app has no repository behind it, so the notices ship. */
        {
          src: '../THIRD-PARTY-NOTICES.md',
          dest: '.'
        }
      ]
    }),
    viteStaticCopy({
      targets: [
        // Widget icons and configurations
        {
          src: 'widgets/**/*.{svg,png,jpg,json}',
          dest: '.'
        }
      ],
      structured: true
    })
  ],
  /* One React for everything. ring-ui's components use hooks, and Vite's dev-time
     pre-bundling gave one of its chunks a React copy of its own - a Checkbox then
     died on `useMemo` of a null React while Button and Loader were fine. The
     production build never had two copies; this keeps the dev entry honest. */
  resolve: {
    dedupe: ['react', 'react-dom']
  },
  root: './src',
  base: '',
  publicDir: 'public',
  /* Dev only: src/dev renders a widget in a page with a real origin, because in
     YouTrack it lives in a sandboxed iframe with an opaque origin, which some
     browsers refuse network access to entirely. The proxy attaches the token. */
  server: {
    proxy: {
      '/yt': {
        target: env.YT_BASE_URL ?? 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path: string): string => path.replace(/^\/yt/, '/api'),
        headers: env.YT_TOKEN
          ? {Authorization: `Bearer ${env.YT_TOKEN}`}
          : ({} as Record<string, string>)
      }
    }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    copyPublicDir: false,
    target: ['es2022'],
    assetsDir: 'widgets/assets',
    rollupOptions: {
      input: WIDGET_ENTRIES,
      output: {
        /* ring-ui ships one stylesheet for all its components, and both widgets
           import it. Vite names such a shared asset after whichever module pulled
           it in first, which called those 190 kB `loader.css`. A stylesheet that
           belongs to no widget of ours is that one. */
        assetFileNames: (asset): string => {
          const ownStyle = Object.keys(WIDGET_ENTRIES).some(entry =>
            asset.names.includes(`${entry}.css`)
          );
          const css = asset.names.some(name => name.endsWith('.css'));
          return `widgets/assets/${css && !ownStyle ? 'ring-ui' : '[name]'}-[hash][extname]`;
        },
        /* What is left to Rollup still gets a name a reader can place. An
           automatic chunk is named after whichever module it happens to hold first,
           which called 190 kB of ring-ui `loader` and, before that, `trend`. A
           chunk made of nothing but third-party modules is called what it is. */
        chunkFileNames: (chunk): string => {
          const derived = !NAMED_CHUNKS.includes(chunk.name);
          const name = derived && vendorOnly(chunk.moduleIds) ? 'ring-ui' : chunk.name;
          return `widgets/assets/${name}-[hash].js`;
        },
        /* React is named because both widgets are built on it and it is the one
           dependency that is certainly in both. Everything else from node_modules
           is left to Rollup, so each widget carries what it actually imports: the
           report uses a menu, a checkbox and a progress bar, the dashboard tile a
           button and a loader, and one chunk for all of it made the tile download
           the report's list virtualisation - 393 kB where 272 kB are used.

           The exact directory, because `node_modules/react` also matches
           react-virtualized, which only the report has any use for. */
        manualChunks: (id): string | undefined => {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
            return 'react';
          }
          if (id.includes('/src/widgets/') || !id.includes('/src/')) {
            return undefined;
          }
          /* The two renderers that build an export are imported when a reader asks
             for one; naming them here would put them back into the chunk every
             widget loads at once. */
          return /\/src\/report-(print|markdown)\.ts/.test(id) ? undefined : 'engine';
        }
      }
    }
  }
  };
});
