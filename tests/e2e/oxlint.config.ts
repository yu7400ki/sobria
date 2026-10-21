import { base, testRelaxations } from "@onibi/config/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...base,
  rules: { ...base.rules, ...testRelaxations },
});
