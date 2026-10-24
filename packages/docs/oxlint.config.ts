import { base, defineConfig, testRelaxations } from "@rinka/config/oxlint";

export default defineConfig({
  ...base,
  jsPlugins: ["./oxlint-panda.ts"],
  rules: {
    ...base.rules,
    "@pandacss/consistent-property-style": ["error", { style: "shorthand" }],
    "@pandacss/extraction-diagnostics": "warn",
    "@pandacss/file-not-included": "error",
    "@pandacss/no-debug": "warn",
    "@pandacss/no-deprecated": "warn",
    "@pandacss/no-invalid-nesting": "error",
    "@pandacss/no-invalid-token-paths": "error",
    "@pandacss/no-shorthand-longhand-mix": "error",
  },
  overrides: [{ files: ["test/**"], rules: testRelaxations }],
});
