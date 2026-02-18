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
      'no-restricted-syntax': ['error',
        {
          selector: 'TSAsExpression[typeAnnotation.typeName.name="MicroUSD"]',
          message: 'Type assertion "as MicroUSD" banned. Use parseMicroUSD() from wire-boundary.ts.',
        },
        {
          selector: 'TSAsExpression[typeAnnotation.typeName.name="BasisPoints"]',
          message: 'Type assertion "as BasisPoints" banned. Use parseBasisPoints() from wire-boundary.ts.',
        },
        {
          selector: 'TSAsExpression[typeAnnotation.typeName.name="AccountId"]',
          message: 'Type assertion "as AccountId" banned. Use parseAccountId() from wire-boundary.ts.',
        },
      ],
    },
  },
  // Allow type assertions in wire-boundary.ts (sole branded type constructor)
  // and test files (test fixtures need direct branded values).
  {
    files: ['src/hounfour/wire-boundary.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
