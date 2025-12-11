import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.js', '**/*.cjs'],
  },
  {
    files: ['**/*.ts'],
    rules: {
      // TypeScript handles these
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Prefer explicit types for function returns
      '@typescript-eslint/explicit-function-return-type': 'off',

      // Allow any for MVP, tighten in production
      '@typescript-eslint/no-explicit-any': 'warn',

      // Allow non-null assertions for MVP
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  }
);
