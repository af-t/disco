import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  // Base recommended rules
  js.configs.recommended,

  // Prettier — must be last to override stylistic rules
  prettier,

  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },

  // Project-specific overrides
  {
    rules: {
      // Allow console statements (debug logs, etc.)
      'no-console': 'off',

      // Unused vars: warn, but allow underscore-prefixed (e.g. _unused)
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Prefer const over let
      'prefer-const': 'error',

      // No var
      'no-var': 'error',

      // Allow async functions without await (intentional fire-and-forget)
      'require-await': 'off',

      // Allow empty catch blocks when intentional
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },

  // Global ignores
  {
    ignores: ['node_modules/', '.git/', 'workspaces/', 'coverage/'],
  },
];
