import type { MagicString } from "magic-string";
import type { ESTree } from "vite";

import { walk } from "./ast.ts";
import { CompileError } from "./errors.ts";
import { inside } from "./paths.ts";

/** `with { type: 'css' }` の import の指定子に付与する、シートのモジュールを表すクエリである。 */
export const SHEET_QUERY = "?rinka-sheet";

/** シートのモジュールの ID の接頭辞である。 */
const SHEET_PREFIX = "\0rinka-sheet:";

/** CSS のファイル `path` のシートのモジュールの ID を返す。Vite の CSS の変換の対象にならないように、末尾を `.js` にする。 */
export const sheetId = (path: string): string => `${SHEET_PREFIX}${path}.js`;

/** `id` がシートのモジュールの ID なら、CSS のファイルのパスを返す。 */
export const sheetPath = (id: string): string | undefined =>
  id.startsWith(SHEET_PREFIX) && id.endsWith(".js") ? id.slice(SHEET_PREFIX.length, -3) : undefined;

/**
 * `with { type: 'css' }` の import と、`from` を持つ export の指定子に `SHEET_QUERY` を付与し、属性を削除する。
 * `type: 'css'` を指定した動的な import があれば、`CompileError` を投げる。
 */
export function rewriteSheetImports(
  program: ESTree.Program,
  output: MagicString,
  code: string,
  file: string,
): void {
  for (const statement of program.body) {
    if (
      (statement.type !== "ImportDeclaration" &&
        statement.type !== "ExportNamedDeclaration" &&
        statement.type !== "ExportAllDeclaration") ||
      !statement.source ||
      !statement.attributes.some(isCssType)
    ) {
      continue;
    }
    const end = code[statement.end - 1] === ";" ? statement.end - 1 : statement.end;
    output.overwrite(
      statement.source.start,
      end,
      JSON.stringify(`${statement.source.value}${SHEET_QUERY}`),
    );
  }
  walk(program, (node) => {
    if (node.type !== "ImportExpression" || !node.options) return;
    if (!/type\s*:\s*["']css["']/.test(code.slice(node.options.start, node.options.end))) return;
    throw new CompileError(
      `${file}: type: 'css' を指定した動的な import は使用できません。with { type: 'css' } の import 文で記述してください。`,
    );
  });
}

/** import の属性が `type: 'css'` かどうかを返す。 */
const isCssType = ({ key, value }: ESTree.ImportAttribute): boolean =>
  (key.type === "Identifier" ? key.name : key.value) === "type" && value.value === "css";

/**
 * CSS のファイル `path` のシートのモジュールのコードを返す。`root` はアプリのルートである。
 * クライアントのモジュールは、Vite が処理した CSS から作成した `CSSStyleSheet` を default export し、CSS が更新されたら同じシートの中身を差し替える。
 * サーバーのモジュールは、DSD の `<link>` に出力する URL を、シートの情報として default export する。
 */
export function sheetModule(path: string, root: string, client: boolean): string {
  const url = urlOf(path, root);
  if (!client) {
    const info = JSON.stringify({ href: `${encodeUrl(url)}?direct`, properties: "" });
    return `export default { [Symbol.for("rinka.sheet")]: ${info} };\n`;
  }
  const inline = JSON.stringify(`${url}?inline`);
  return `import css from ${inline};
const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
if (import.meta.hot) {
  import.meta.hot.accept(${inline}, (module) => {
    if (module) sheet.replaceSync(module.default);
  });
}
export default sheet;
`;
}

/**
 * ファイル `path` を開発サーバーが配信するパスを返す。ルートの外のファイルは `/@fs/` のパスにする。
 */
function urlOf(path: string, root: string): string {
  const file = inside(root, path);
  const absolute = path.replaceAll("\\", "/");
  return file === undefined ? `/@fs${absolute.startsWith("/") ? "" : "/"}${absolute}` : `/${file}`;
}

/** パス `path` を、URL に使用できない文字をパーセントエンコードした URL にする。 */
const encodeUrl = (path: string): string =>
  encodeURI(path).replaceAll("#", "%23").replaceAll("?", "%3F");
