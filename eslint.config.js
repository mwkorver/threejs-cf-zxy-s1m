import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/cdk.out/**",
      "client/public/**",
      "client/playwright-report/**",
      "client/test-results/**",
      "tiler/**",
    ],
  },
  // Type-aware linting for TypeScript application, tests, e2e, and infra
  {
    files: [
      "client/src/**/*.ts",
      "client/e2e/**/*.ts",
      "infra/bin/**/*.ts",
      "infra/lib/**/*.ts",
    ],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["client/e2e/*.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Four critical type-aware promise and condition safety rules
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",

      // Variable and argument hygiene
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",

      // Disable noisy style/type-assertion presets to keep output focused on safety
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  // Tests reach for `any` legitimately: hand-built worker messages, partial
  // THREE stubs, and spies on private members all describe shapes that exist
  // only for the assertion. Off here rather than 40 inline disables, and rather
  // than leaving warnings nobody reads -- which would also bury the handful in
  // src that are worth arguing about.
  {
    files: ["client/src/**/*.test.ts", "client/e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Untyped linting for plain JS at the repo root (this config file itself)
  {
    files: ["*.js"],
    extends: [...tseslint.configs.recommended],
  }
);
