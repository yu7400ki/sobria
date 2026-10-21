import { base, defineConfig, testRelaxations } from "@onibi/config/oxlint";

export default defineConfig({
  ...base,
  overrides: [{ files: ["test/**"], rules: testRelaxations }],
});
