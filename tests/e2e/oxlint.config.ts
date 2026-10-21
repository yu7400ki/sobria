import { base, defineConfig, testRelaxations } from "@rinka/config/oxlint";

export default defineConfig({
  ...base,
  rules: { ...base.rules, ...testRelaxations },
});
