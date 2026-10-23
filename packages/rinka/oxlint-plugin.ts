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

/** メソッドの呼び出しを表す。 */
interface CallNode {
  readonly callee: {
    readonly type: string;
    readonly computed?: boolean;
    readonly property?: StringNode & { readonly name?: string };
  };
}

interface Context {
  report(descriptor: { node: ModuleDeclaration | StringNode | CallNode; message: string }): void;
}

/** MagicString の、挿入する位置の左右を選ぶメソッドの名前である。 */
const directionalInserts = new Set(["prependLeft", "prependRight", "appendLeft", "appendRight"]);

/** 文字列のリテラルかテンプレートリテラルの、最初の文字列の部分を返す。 */
const leadingText = (node: StringNode): string | undefined =>
  typeof node.value === "string" ? node.value : (node.quasis?.[0]?.value.cooked ?? undefined);

/** 文字列のリテラルの値か、テンプレートリテラルの文字列の部分をすべて連結した文字列を返す。 */
const fullText = (node: StringNode): string | undefined =>
  typeof node.value === "string"
    ? node.value
    : node.quasis?.map((quasi) => quasi.value.cooked ?? "").join("");

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
    /** `@` で始まる文字列のリテラルと、`@` で始まるテンプレートリテラルを報告する。読み込む先のリテラルは報告しない。 */
    "no-transfer-key-literal": {
      create(context: Context) {
        const message =
          "値の受け渡しのキーは、src/shared/transfer-keys.ts の定数と関数で記述してください。";
        const check = (node: StringNode) => {
          if (!leadingText(node)?.startsWith("@") || isModuleSource(node)) return;
          context.report({ node, message });
        };
        return { Literal: check, TemplateLiteral: check };
      },
    },
    /** `$rinka` か `data-rinka-load` を含む、文字列のリテラルとテンプレートリテラルを報告する。 */
    "no-receiver-literal": {
      create(context: Context) {
        const check = (node: StringNode) => {
          const text = fullText(node);
          if (
            text === undefined ||
            !(text.includes("$rinka") || text.includes("data-rinka-load"))
          ) {
            return;
          }
          context.report({
            node,
            message:
              "起動スクリプトの受け口と、起動のタイミングの属性の名前は、src/server/bootstrap.ts の関数と定数を通して記述し、ほかのファイルの文字列に記述しないでください。",
          });
        };
        return { Literal: check, TemplateLiteral: check };
      },
    },
    /** `data-o` に英小文字 1 文字が続く属性名を含む、文字列のリテラルとテンプレートリテラルを報告する。 */
    "no-marker-attribute-literal": {
      create(context: Context) {
        const check = (node: StringNode) => {
          const text = fullText(node);
          if (text === undefined || !/(?<![\w-])data-o[a-z](?![\w-])/.test(text)) return;
          context.report({
            node,
            message:
              "rinka が HTML に出力する目印の属性名（data-o に英小文字 1 文字が続く名前）は、src/shared/attributes.ts の定数で記述してください。",
          });
        };
        return { Literal: check, TemplateLiteral: check };
      },
    },
    /** MagicString の、挿入する位置の左右を選ぶメソッドの呼び出しを報告する。 */
    "no-directional-insert": {
      create(context: Context) {
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
    /** `rinka/` か、仮想モジュールの印の `\0` と `rinka/` で始まる文字列のリテラルとテンプレートリテラルを報告する。読み込む先のリテラルは報告しない。 */
    "no-entry-literal": {
      create(context: Context) {
        const check = (node: StringNode) => {
          const text = leadingText(node)?.replace(/^\0/, "");
          if (!text?.startsWith("rinka/") || isModuleSource(node)) return;
          context.report({
            node,
            message: "rinka の入口の指定子は、src/build/entries.ts の entries で記述してください。",
          });
        };
        return { Literal: check, TemplateLiteral: check };
      },
    },
  },
};
