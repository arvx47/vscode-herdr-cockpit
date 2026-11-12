// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', 'media/codicons/**', 'media/agent-icons.js', 'media/sidebar.js', 'src/herdrTypes.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Socket payloads and VS Code API callbacks are loosely typed at the edges.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // House style: `try { ... } catch {}` for best-effort cleanup, `ok ? a() : b()` and `x && f()` as statements.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    files: ['media/**/*.js'],
    // Plain browser JS with // @ts-check for editor hints; it isn't compiled, so @ts-ignore is fine.
    rules: { '@typescript-eslint/ban-ts-comment': 'off' },
    languageOptions: { globals: { CSS: 'readonly', window: 'readonly', document: 'readonly', acquireVsCodeApi: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', requestAnimationFrame: 'readonly', HTMLElement: 'readonly', Element: 'readonly', Node: 'readonly', navigator: 'readonly', getComputedStyle: 'readonly', Date: 'readonly' } },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
