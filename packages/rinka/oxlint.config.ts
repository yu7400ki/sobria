import { base, defineConfig, testRelaxations } from "@rinka/config/oxlint";

type Pattern = { regex: string; message: string };

type Restrict = { "no-restricted-imports": ["error", { patterns: Pattern[] }] };

const restrict = (...patterns: Pattern[]): Restrict => ({
  "no-restricted-imports": ["error", { patterns }],
});

/** `src/` の中の、指定したディレクトリからの import に一致するパターンを返す。 */
const directory = (dir: string): Pattern => ({
  regex: String.raw`^(\.\./)+${dir}/`,
  message: `このディレクトリのファイルは、src/${dir}/ を import できません。`,
});

/** props の名前の検査と、HTMLElement のメンバーの一覧の import に一致するパターンを表す。 */
const propNameList: Pattern = {
  regex: String.raw`/(prop-names|html-element-members\.generated)(\.[jt]s)?$`,
  message:
    "クライアントのランタイムは、props の名前の検査と、HTMLElement のメンバーの一覧を import できません。",
};

export default defineConfig({
  ...base,
  overrides: [
    { files: ["src/shared/**"], rules: restrict(directory("client"), directory("server")) },
    { files: ["src/client/**"], rules: restrict(directory("server"), propNameList) },
    { files: ["src/server/**"], rules: restrict(directory("client")) },
    { files: ["test/**"], rules: testRelaxations },
  ],
});
