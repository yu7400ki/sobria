import { defineConfig } from "oxlint";

export { defineConfig };

/** すべてのパッケージに適用する oxlint の設定。 */
export const base = defineConfig({
  plugins: ["typescript", "unicorn", "oxc", "import"],
  categories: {
    correctness: "error",
    perf: "warn",
    suspicious: "error",
  },
  rules: {
    "import/no-cycle": "error",
    "import/no-unassigned-import": [
      "error",
      { allow: ["**/*.{css,scss,sass,less,styl,stylus,pcss,postcss}"] },
    ],
    "no-unused-expressions": ["error", { allowTaggedTemplates: true }],
    "typescript/consistent-return": "off",
    "typescript/no-unsafe-unary-minus": "off",
    "typescript/no-deprecated": "error",
    "typescript/no-misused-promises": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/only-throw-error": "error",
    "typescript/prefer-promise-reject-errors": "error",
    "typescript/restrict-plus-operands": "error",
    "typescript/return-await": "error",
    "typescript/switch-exhaustiveness-check": "error",
  },
  env: {
    builtin: true,
  },
});

/** テストのコードで無効にする、型の安全性に関する規則。 */
export const testRelaxations = {
  "typescript/no-unsafe-argument": "off",
  "typescript/no-unsafe-assignment": "off",
  "typescript/no-unsafe-call": "off",
  "typescript/no-unsafe-member-access": "off",
  "typescript/no-unsafe-return": "off",
  "typescript/no-unsafe-type-assertion": "off",
} as const;

/** リポジトリのルートに適用する oxlint の設定。 */
export const root = defineConfig({
  ...base,
  options: {
    typeAware: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
  },
});
