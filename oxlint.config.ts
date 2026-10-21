import { base } from "@onibi/config/oxlint";
import { defineConfig } from "oxlint";

// options はルートの設定にだけ記述できる。
export default defineConfig({
  ...base,
  options: {
    typeAware: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
  },
});
