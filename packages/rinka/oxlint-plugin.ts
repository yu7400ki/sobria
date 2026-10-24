import { relative } from "node:path";

/** import 文と export 文を表す。`source` は読み込む先で、`from` の無い export 文では `null` である。 */
interface ModuleDeclaration {
  readonly source: { readonly value: string } | null;
  readonly importKind?: string;
  readonly exportKind?: string;
}

/** 文字列のリテラルと、テンプレートリテラルを表す。 */
interface StringNode {
  readonly type: string;
  readonly value?: unknown;
  readonly quasis?: readonly { readonly value: { readonly cooked: string | null } }[];
  readonly parent?: { readonly type: string };
}

/** 関数とメソッドの呼び出しを表す。 */
interface CallNode {
  readonly callee: {
    readonly type: string;
    readonly name?: string;
    readonly computed?: boolean;
    readonly property?: StringNode & { readonly name?: string };
  };
  readonly arguments: readonly StringNode[];
}

interface Context {
  readonly filename: string;
  report(descriptor: { node: ModuleDeclaration | StringNode | CallNode; message: string }): void;
}

/**
 * 文字列のリテラルのうち、パターンと照合する箇所を表す。
 * - `leading`: 文字列のリテラルの値と、テンプレートリテラルの最初の文字列の部分。読み込む先のリテラルは照合しない
 * - `contained`: 文字列のリテラルの値と、テンプレートリテラルの文字列の部分を、埋め込みの位置に空白を入れて連結した文字列
 * - `path-argument`: 識別子で呼び出す `join` と `resolve` の引数の、`leading` と同じ部分
 */
type Target = "leading" | "contained" | "path-argument";

/** 定数を定義したファイルの外で、文字列のリテラルに記述させない値を表す。パスはパッケージのルートからの相対パスである。 */
interface ConstantLiteral {
  readonly pattern: RegExp;
  readonly target: Target;
  readonly definedIn: string;
  readonly directories: readonly string[];
  readonly message: string;
}

const constantLiterals: readonly ConstantLiteral[] = [
  {
    pattern: /^@/,
    target: "leading",
    definedIn: "src/shared/transfer-keys.ts",
    directories: ["src/client/", "src/server/", "src/shared/"],
    message: "値の受け渡しのキーは、src/shared/transfer-keys.ts の定数と関数で記述してください。",
  },
  {
    pattern: /\$rinka/,
    target: "contained",
    definedIn: "src/server/bootstrap.ts",
    directories: ["src/"],
    message:
      "起動スクリプトの受け口は、src/server/bootstrap.ts の関数を通して記述し、ほかのファイルの文字列に記述しないでください。",
  },
  {
    pattern: /(?<![\w-])data-(o[a-z](?![\w-])|rinka-)/,
    target: "contained",
    definedIn: "src/shared/attributes.ts",
    directories: ["src/"],
    message:
      "rinka が HTML に出力する属性名（data-o に英小文字 1 文字が続く名前と、data-rinka- で始まる名前）は、src/shared/attributes.ts の定数で記述してください。",
  },
  {
    pattern: /\/ob:/,
    target: "contained",
    definedIn: "src/shared/attributes.ts",
    directories: ["src/"],
    message:
      "後送りの境界の終わりの目印は、src/shared/attributes.ts の BOUNDARY_END で記述してください。",
  },
  {
    pattern: /x-rinka-page/,
    target: "contained",
    definedIn: "src/shared/refresh.ts",
    directories: ["src/"],
    message:
      "呼び出したページの URL のヘッダーの名前は、src/shared/refresh.ts の PAGE_HEADER で記述してください。サーバーでは、src/server/endpoint.ts の callerOf で呼び出し元を判定してください。",
  },
  {
    pattern: /\/_rinka\//,
    target: "contained",
    definedIn: "src/shared/wire.ts",
    directories: ["src/"],
    message: "rinka の URL の接頭辞は、src/shared/wire.ts の internalPrefix で記述してください。",
  },
  {
    pattern: /^\0?rinka\//,
    target: "leading",
    definedIn: "src/build/entries.ts",
    directories: ["src/build/"],
    message: "rinka の入口の指定子は、src/build/entries.ts の entries で記述してください。",
  },
  {
    pattern: /^(client|server)(\/|$)/,
    target: "path-argument",
    definedIn: "src/build/settings.ts",
    directories: ["src/build/"],
    message:
      "ビルドの出力先は、src/build/settings.ts の Settings の clientDir と serverDir から作成してください。",
  },
];

/** 検査するファイルの、パッケージのルートからの相対パスを、区切りを `/` にして返す。 */
const packagePath = ({ filename }: Context): string =>
  relative(import.meta.dirname, filename).replaceAll("\\", "/");

/** パスを結合する `node:path` の関数の名前である。 */
const pathJoins = new Set(["join", "resolve"]);

/** MagicString の、挿入する位置の左右を選ぶメソッドの名前である。 */
const directionalInserts = new Set(["prependLeft", "prependRight", "appendLeft", "appendRight"]);

/** 文字列のリテラルかテンプレートリテラルの、最初の文字列の部分を返す。 */
const leadingText = (node: StringNode): string | undefined =>
  typeof node.value === "string" ? node.value : (node.quasis?.[0]?.value.cooked ?? undefined);

/** 文字列のリテラルの値か、テンプレートリテラルの文字列の部分を、埋め込みの位置に空白を入れて連結した文字列を返す。 */
const fullText = (node: StringNode): string | undefined =>
  typeof node.value === "string"
    ? node.value
    : node.quasis?.map((quasi) => quasi.value.cooked ?? "").join(" ");

/** 呼び出すメソッドの名前を返す。``s["name"]`` と ``s[`name`]`` の形の名前も返す。 */
const methodName = ({ callee }: CallNode): string | undefined =>
  callee.computed && callee.property ? leadingText(callee.property) : callee.property?.name;

/** 読み込む先を表すリテラルの、親のノードの種類である。 */
const moduleSources = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "TSModuleDeclaration",
  "TSExternalModuleReference",
  "TSImportType",
]);

/** `node` が、モジュールの読み込む先を表すかどうかを返す。 */
const isModuleSource = ({ parent }: StringNode): boolean =>
  parent !== undefined && moduleSources.has(parent.type);

/** 文字列のリテラルかテンプレートリテラルの、`target` で照合する文字列を返す。 */
const literalText = (node: StringNode, target: Target): string | undefined => {
  if (target === "contained") return fullText(node);
  return isModuleSource(node) ? undefined : leadingText(node);
};

const wireCodec = /\/wire-codec(\.[jt]s)?$/;

/** rinka のパッケージに固有の lint の規則。 */
export default {
  meta: { name: "rinka" },
  rules: {
    /** `wire-codec` を値として読み込む、静的な import 文と export 文を報告する。 */
    "no-static-wire-codec": {
      create(context: Context) {
        const check = (node: ModuleDeclaration) => {
          if (node.importKind === "type" || node.exportKind === "type") return;
          if (node.source && wireCodec.test(node.source.value)) {
            context.report({
              node,
              message:
                "wire-codec.ts は、ブラウザが読み込む seroval を別のチャンクにするために、動的な import() で読み込んでください。",
            });
          }
        };
        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
        };
      },
    },
    /**
     * `constantLiterals` の各項目について、`directories` の中の、`definedIn` 以外のファイルで、
     * `target` の箇所が `pattern` に一致する文字列のリテラルとテンプレートリテラルを報告する。
     */
    "no-constant-literal": {
      create(context: Context) {
        const path = packagePath(context);
        const applied = constantLiterals.filter(
          ({ definedIn, directories }) =>
            path !== definedIn && directories.some((directory) => path.startsWith(directory)),
        );
        const check = (node: StringNode, target: Target) => {
          for (const constant of applied) {
            if (constant.target !== target) continue;
            const text = literalText(node, target);
            if (text === undefined || !constant.pattern.test(text)) continue;
            context.report({ node, message: constant.message });
          }
        };
        const checkLiteral = (node: StringNode) => {
          check(node, "leading");
          check(node, "contained");
        };
        return {
          Literal: checkLiteral,
          TemplateLiteral: checkLiteral,
          CallExpression(node: CallNode) {
            const { type, name } = node.callee;
            if (type !== "Identifier" || name === undefined || !pathJoins.has(name)) return;
            for (const argument of node.arguments) check(argument, "path-argument");
          },
        };
      },
    },
    /** `src/build/ast.ts` の外で、MagicString の、挿入する位置の左右を選ぶメソッドの呼び出しを報告する。 */
    "no-directional-insert": {
      create(context: Context) {
        if (packagePath(context) === "src/build/ast.ts") return {};
        return {
          CallExpression(node: CallNode) {
            if (node.callee.type !== "MemberExpression") return;
            const name = methodName(node);
            if (name === undefined || !directionalInserts.has(name)) return;
            context.report({
              node,
              message:
                "挿入する位置の左右は、src/build/ast.ts の surround、follow、insertInside で選んでください。",
            });
          },
        };
      },
    },
  },
};
