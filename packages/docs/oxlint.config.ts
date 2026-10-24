import { base, defineConfig, testRelaxations } from "@rinka/config/oxlint";

export default defineConfig({
  ...base,
  overrides: [{ files: ["test/**"], rules: testRelaxations }],
});
