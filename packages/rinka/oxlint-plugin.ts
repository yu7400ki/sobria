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

interface Context {
  report(descriptor: { node: ModuleDeclaration | StringNode; message: string }): void;
}

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
        return {
          Literal(node: StringNode) {
            if (typeof node.value !== "string" || !node.value.startsWith("@")) return;
            if (isModuleSource(node)) return;
            context.report({ node, message });
          },
          TemplateLiteral(node: StringNode) {
            if (!node.quasis?.[0]?.value.cooked?.startsWith("@") || isModuleSource(node)) return;
            context.report({ node, message });
          },
        };
      },
    },
  },
};
