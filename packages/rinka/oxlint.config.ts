import { base, defineConfig, testRelaxations } from "@rinka/config/oxlint";

type Pattern = { regex: string; message: string; allowTypeImports?: boolean };

type Path = { name: string; importNames: string[]; message: string };

type Restrict = {
  "no-restricted-imports": ["error", { patterns: Pattern[]; paths: Path[] }];
};

/** パターンと、モジュールの名前で指定した import を禁止する規則の設定を返す。 */
const restrict = (...rules: (Pattern | Path)[]): Restrict => ({
  "no-restricted-imports": [
    "error",
    {
      patterns: rules.filter((rule): rule is Pattern => "regex" in rule),
      paths: rules.filter((rule): rule is Path => "name" in rule),
    },
  ],
});

/** `src/` の中の、指定したディレクトリからの import に一致するパターンを返す。 */
const directory = (dir: string): Pattern => ({
  regex: String.raw`^(\./)?(\.\./)+(src/)?${dir}/`,
  message: `このディレクトリのファイルは、src/${dir}/ を import できません。`,
});

/** props の名前の検査と、HTMLElement のメンバーの一覧の値の import に一致するパターンを表す。 */
const propNameList: Pattern = {
  regex: String.raw`/(prop-names|html-element-members\.generated)(\.[jt]s)?$`,
  message:
    "props の名前の検査と、HTMLElement のメンバーの一覧を値として import できるのは、src/build/ と src/shared/prop-names.ts です。",
  allowTypeImports: true,
};

/** パッケージ自身の名前での import に一致するパターンを表す。 */
const self: Pattern = {
  regex: "^rinka(/|$)",
  message:
    "src/ の中のファイルは、互いを相対パスで import してください。パッケージの名前 rinka は使用できません。",
};

/** Node.js の組み込みモジュールの import に一致するパターンを表す。 */
const nodeBuiltin: Pattern = {
  regex: "^node:",
  message:
    "src/shared/ と src/client/ のファイルはブラウザで実行するので、node: のモジュールを import できません。",
};

/** seroval の import に一致するパターンを表す。 */
const seroval: Pattern = {
  regex: "^seroval(/|$)",
  message:
    "seroval を import できるのは、src/server/wire.ts と src/client/wire-codec.ts です。src/shared/wire.ts は型だけを import できます。値のシリアライズには、これらのモジュールを使用してください。",
};

const shared = [
  directory("client"),
  directory("server"),
  directory("build"),
  self,
  nodeBuiltin,
  propNameList,
];
const client = [directory("server"), directory("build"), self, nodeBuiltin, propNameList];
const server = [directory("client"), directory("build"), self, propNameList];
/** vite の isRunnableDevEnvironment の import に一致する指定を表す。 */
const runnableCheck: Path = {
  name: "vite",
  importNames: ["isRunnableDevEnvironment"],
  message:
    "isRunnableDevEnvironment はクラスで判定するので、アプリと rinka の vite が別のインスタンスに解決されると偽になります。runner の有無で判定してください。",
};

const build = [directory("client"), directory("server"), self, runnableCheck];

export default defineConfig({
  ...base,
  jsPlugins: ["./oxlint-plugin.ts"],
  rules: {
    ...base.rules,
    "unicorn/prefer-node-protocol": "error",
  },
  overrides: [
    {
      files: ["src/client/**", "src/server/**", "src/shared/**"],
      rules: { "rinka/no-transfer-key-literal": "error" },
    },
    {
      files: ["src/**"],
      rules: {
        "rinka/no-receiver-literal": "error",
        "rinka/no-marker-attribute-literal": "error",
      },
    },
    {
      files: ["src/shared/**"],
      env: { "shared-node-browser": true },
      rules: { ...restrict(...shared, seroval), "no-undef": "error" },
    },
    {
      files: ["src/shared/prop-names.ts"],
      rules: restrict(...shared.filter((pattern) => pattern !== propNameList), seroval),
    },
    {
      files: ["src/shared/wire.ts"],
      rules: restrict(...shared, { ...seroval, allowTypeImports: true }),
    },
    {
      files: ["src/client/**"],
      env: { browser: true },
      rules: {
        ...restrict(...client, seroval),
        "no-undef": "error",
        "rinka/no-static-wire-codec": "error",
      },
    },
    { files: ["src/client/wire-codec.ts"], rules: restrict(...client) },
    {
      files: ["src/server/**"],
      env: { node: true },
      rules: { ...restrict(...server, seroval), "no-undef": "error" },
    },
    { files: ["src/server/wire.ts"], rules: restrict(...server) },
    {
      files: ["src/build/**"],
      env: { node: true },
      rules: {
        ...restrict(...build, seroval),
        "no-undef": "error",
        "rinka/no-directional-insert": "error",
        "rinka/no-entry-literal": "error",
        "rinka/no-output-dir-literal": "error",
      },
    },
    { files: ["src/build/ast.ts"], rules: { "rinka/no-directional-insert": "off" } },
    { files: ["src/build/entries.ts"], rules: { "rinka/no-entry-literal": "off" } },
    { files: ["src/build/settings.ts"], rules: { "rinka/no-output-dir-literal": "off" } },
    { files: ["src/shared/transfer-keys.ts"], rules: { "rinka/no-transfer-key-literal": "off" } },
    { files: ["src/server/bootstrap.ts"], rules: { "rinka/no-receiver-literal": "off" } },
    {
      files: ["src/shared/attributes.ts"],
      rules: { "rinka/no-marker-attribute-literal": "off" },
    },
    { files: ["test/**"], rules: testRelaxations },
  ],
});
