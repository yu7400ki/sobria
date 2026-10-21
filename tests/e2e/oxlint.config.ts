import { base, defineConfig, testRelaxations } from "@onibi/config/oxlint";

export default defineConfig({
  ...base,
  rules: { ...base.rules, ...testRelaxations },
});
