import { base, defineConfig, testRelaxations } from "@rinka/config/oxlint";

type Forbid = {
  "no-restricted-imports": ["error", { patterns: { group: string[]; message: string }[] }];
};

/** `src/` の中で、指定したディレクトリからの import を禁止する規則。 */
const forbid = (...dirs: string[]): Forbid => ({
  "no-restricted-imports": [
    "error",
    {
      patterns: dirs.map((dir) => ({
        group: [`**/${dir}/**`],
        message: `src/${dir}/ はこのディレクトリから import できません。`,
      })),
    },
  ],
});

export default defineConfig({
  ...base,
  overrides: [
    { files: ["src/shared/**"], rules: forbid("client", "server") },
    { files: ["src/client/**"], rules: forbid("server") },
    { files: ["src/server/**"], rules: forbid("client") },
    { files: ["test/**"], rules: testRelaxations },
  ],
});
