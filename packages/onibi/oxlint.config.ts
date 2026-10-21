import { base, testRelaxations } from "@onibi/config/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  ...base,
  overrides: [{ files: ["test/**"], rules: testRelaxations }],
});
