import { base, defineConfig, testRelaxations } from "@sobria/config/oxlint";

export default defineConfig({
  ...base,
  rules: { ...base.rules, ...testRelaxations },
});
