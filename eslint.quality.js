/**
 * Code quality limits shared by every package's ESLint config, on top of
 * Backstage's defaults. Errors must be fixed; warnings flag code to simplify
 * when it is next touched.
 */
module.exports = {
  tsRules: {
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-non-null-assertion': 'error',
    'no-nested-ternary': 'error',
    complexity: ['warn', 15],
    'max-lines-per-function': [
      'warn',
      { max: 50, skipBlankLines: true, skipComments: true },
    ],
  },
  testRules: {
    // Tests assert on known fixtures, and long scenarios read better whole.
    '@typescript-eslint/no-non-null-assertion': 'off',
    complexity: 'off',
    'max-lines-per-function': 'off',
  },
};
