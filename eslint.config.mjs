/**
 * ESLint flat config — loa-finn
 *
 * Enforces no-restricted-imports to prevent referencing deleted local package
 * paths or deep imports into loa-hounfour dist internals.
 */
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    extends: [tseslint.configs.base],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['**/packages/loa-hounfour/*'],
            message: 'Local package deleted in cycle-026. Use @0xhoneyjar/loa-hounfour from npm.',
          },
          {
            group: ['@0xhoneyjar/loa-hounfour/dist/*'],
            message: 'Deep imports into dist/ are fragile. Use public exports from @0xhoneyjar/loa-hounfour.',
          },
        ],
      }],
    },
  },
);
