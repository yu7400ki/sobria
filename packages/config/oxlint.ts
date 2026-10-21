import { defineConfig } from "oxlint";

/** すべてのワークスペースに適用する oxlint の設定。 */
export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  categories: {
    correctness: "error",
    perf: "warn",
    suspicious: "error",
  },
  rules: {
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
  options: {
    typeAware: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
  },
  env: {
    builtin: true,
  },
});
