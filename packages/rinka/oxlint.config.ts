import { base, defineConfig, testRelaxations } from "@rinka/config/oxlint";

type Pattern = { regex: string; message: string; allowTypeImports?: boolean };

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

/** seroval の import に一致するパターンを表す。 */
const seroval: Pattern = {
  regex: "^seroval(/|$)",
  message:
    "seroval を import できるのは、src/server/wire.ts と src/client/wire-codec.ts です。src/shared/wire.ts は型だけを import できます。値のシリアライズには、これらのモジュールを使用してください。",
};

const shared = [directory("client"), directory("server")];
const client = [directory("server"), propNameList];
const server = [directory("client")];

export default defineConfig({
  ...base,
  overrides: [
    { files: ["src/shared/**"], rules: restrict(...shared, seroval) },
    {
      files: ["src/shared/wire.ts"],
      rules: restrict(...shared, { ...seroval, allowTypeImports: true }),
    },
    { files: ["src/client/**"], rules: restrict(...client, seroval) },
    { files: ["src/client/wire-codec.ts"], rules: restrict(...client) },
    { files: ["src/server/**"], rules: restrict(...server, seroval) },
    { files: ["src/server/wire.ts"], rules: restrict(...server) },
    { files: ["test/**"], rules: testRelaxations },
  ],
});
