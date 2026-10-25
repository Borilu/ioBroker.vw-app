import ioBrokerConfig from '@iobroker/eslint-config';

// Adopt the ioBroker correctness rules without reformatting the existing,
// tested CommonJS controllers as part of package-publication preparation.
// Formatting and documentation style can be migrated in a separate change.
const styleAndDocumentationRules = {
    'prettier/prettier': 'off',
    curly: 'off',
    'brace-style': 'off',
    'quote-props': 'off',
    'prefer-template': 'off',
    'no-else-return': 'off',
    'no-useless-escape': 'off',
    'jsdoc/require-jsdoc': 'off',
    'jsdoc/require-param': 'off',
    'jsdoc/require-param-description': 'off',
    'jsdoc/require-param-type': 'off',
    'jsdoc/require-returns': 'off',
    'jsdoc/require-returns-description': 'off',
    'jsdoc/require-returns-type': 'off',
    'jsdoc/tag-lines': 'off',
};

export default [
    {
        ignores: ['node_modules/**', 'coverage/**', 'test-results/**', 'runtime/**', 'adb-home/**'],
    },
    ...ioBrokerConfig,
    {
        files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
        rules: {
            ...styleAndDocumentationRules,
            // TypeScript disables these core rules; this project uses plain JS.
            'no-undef': 'error',
            'no-unused-expressions': 'error',
            // CommonJS modules explicitly import Node APIs whose names also
            // exist as globals. Redeclaration inside the module is harmless.
            'no-redeclare': ['error', { builtinGlobals: false }],
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    ignoreRestSiblings: true,
                    argsIgnorePattern: '^_',
                    caughtErrors: 'all',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            // Empty catches intentionally absorb cleanup failures. Empty
            // non-catch blocks and unused bindings still receive lint errors.
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['main.js', 'lib/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'testing/**/*.cjs'],
        languageOptions: { sourceType: 'commonjs' },
    },
    {
        files: [
            'lib/accessibility-view.js',
            'lib/android-ui.js',
            'lib/config.js',
            'lib/departures-adapter.js',
            'lib/departures-controller.js',
            'lib/departures-native.js',
            'lib/departures-ui.js',
            'lib/native-ui.js',
            'lib/ui.js',
            'lib/vehicle-access.js',
            'lib/vehicle-report.js',
        ],
        // These input boundaries deliberately detect and reject control
        // characters. The existing validation tests cover those expressions.
        rules: { 'no-control-regex': 'off' },
    },
    {
        files: ['test/**/*.js'],
        // Adversarial fixtures include sparse arrays to verify their rejection.
        rules: { 'no-sparse-arrays': 'off' },
    },
    {
        files: ['testing/**/*.cjs'],
        languageOptions: {
            globals: {
                after: 'readonly',
                afterEach: 'readonly',
                before: 'readonly',
                beforeEach: 'readonly',
                describe: 'readonly',
                it: 'readonly',
            },
        },
    },
];
