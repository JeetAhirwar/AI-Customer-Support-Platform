// ESLint flat config — Gate A's last unwired row (TESTING_STRATEGY.md §8).
//
// Scope: source and spec files of the workspace (apps/api, apps/worker,
// packages/shared) plus this repo's own scripts. Vendored Postgres/pgAdmin
// binaries under Infrastructure/local-development/bin are explicitly ignored —
// they are a downloaded distribution, not this codebase.
//
// Rule tier: `typescript-eslint` **recommended** (syntactic + type-shape rules
// that do not need type information) so the whole workspace lints in a couple of
// seconds inside `pnpm lint`. The type-aware tier (`recommendedTypeChecked`,
// which catches floating promises and unsafe `any` flows) is a deliberate
// follow-up — it needs `projectService` and a separate baseline pass.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.d.ts',
      'Infrastructure/local-development/bin/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // `_`-prefixed params/vars are deliberate (unused injectors, placeholders)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // node-pg-migrate loads migration files as CommonJS modules — require() is
    // the execution contract here, not a style preference, so converting them
    // to ESM would change how they are loaded at migrate time.
    files: ['apps/api/migrations/**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // ADR-008: one structured log stream through pino (correlation context +
    // redaction). Raw console output in library/app code would bypass both.
    // The single allowed exception is main.ts's pre-logger startup failure
    // path, disabled inline where pino does not exist yet.
    files: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // Specs assert against loosely-typed HTTP payloads on purpose; the strong
    // typing lives in src, and `tsconfig.spec.json` still typechecks these files.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
