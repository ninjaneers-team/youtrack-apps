import { fixupConfigRules } from "@eslint/compat";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";
import jsonc from "eslint-plugin-jsonc";
import yml from "eslint-plugin-yml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default tseslint.config(
  {
    ignores: ["**/dist", "eslint.config.mjs", "package-lock.json"],
  },
  // The JetBrains stack applies to code only. Without this scope its rules are
  // handed every file the command names, and a React rule asked to read a YAML
  // document fails the whole run.
  {
    files: ["**/*.{js,cjs,ts,tsx}"],
    extends: [
      ...fixupConfigRules(
        compat.extends(
          "@jetbrains",
          "@jetbrains/eslint-config/react",
          "@jetbrains/eslint-config/browser",
          "plugin:react-hooks/recommended",
        ),
      ),
      ...tseslint.configs.recommended,
    ],

    plugins: {
      "react-refresh": reactRefresh,
    },

    languageOptions: {
      globals: {
        ...globals.browser,
      },

      parser: tseslint.parser,
    },

    rules: {
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
        },
      ],
      "react/jsx-no-literals": "off",
      "@typescript-eslint/explicit-function-return-type": "error",

      /* Instance data stays in memory and in the app's own storage, which sits
         behind the instance's permissions. Browser storage does not: the Host API
         documents its storage as not being tied to a YouTrack account, and a widget
         runs on an opaque origin where these APIs throw anyway. */
      "no-restricted-globals": [
        "error",
        ...["localStorage", "sessionStorage", "indexedDB", "caches"].map(name => ({
          name,
          message: "Instance data stays in memory and in the app's own storage.",
        })),
      ],
      "no-restricted-properties": [
        "error",
        ...["localStorage", "sessionStorage", "indexedDB", "caches"].map(property => ({
          object: "window",
          property,
          message: "Instance data stays in memory and in the app's own storage.",
        })),
        {
          object: "host",
          property: "storage",
          message: "Aggregates go to storeCache; instance data goes nowhere.",
        },
      ],
    }
  },
  // The development harness stands in for the app's global storage, which has to
  // survive a reload of the page. It never ships, it runs on an ordinary origin, and
  // what it keeps is what the app's own storage keeps: aggregates. Only that one API
  // is allowed, and only here.
  {
    files: ["src/dev/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["localStorage", "indexedDB", "caches"].map(name => ({
          name,
          message: "The harness keeps its stub state in sessionStorage.",
        })),
      ],
    },
  },
  /* The app's HTTP handler. It is copied into the package as it is - no bundler, no
     type stripping - so it is plain CommonJS, and this is the only tool that reads
     it before an instance does. */
  {
    files: ["src/*.js"],

    languageOptions: {
      globals: {
        ...globals.commonjs,
      },
    },

    rules: {
      /* Every catch here turns unreadable storage into the neutral default, and the
         value that was thrown says nothing a reader of the report could use. The
         binding stays because dropping it is ES2019 syntax, and what the sandbox
         accepts is only known as far as the app has run there: it uses const and
         template literals on the oldest version the manifest allows. */
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
      /* A return type cannot be annotated in a file that ships as JavaScript. What
         this file gets instead is JSDoc that the compiler reads, which is the only
         form of type checking available to it. */
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  // Data files are linted by the same command as the code. A workflow or a manifest
  // that no longer parses breaks a build somewhere far from the edit that broke it,
  // and this is the cheapest place to notice.
  ...yml.configs["flat/standard"],
  ...jsonc.configs["flat/recommended-with-json"],
  // TypeScript reads its own configuration as JSON with comments, and the comments
  // there carry the reasoning behind the compiler options.
  {
    files: ["tsconfig*.json"],
    extends: [jsonc.configs["flat/recommended-with-jsonc"]],
    rules: {
      "jsonc/no-comments": "off",
    },
  },
);
