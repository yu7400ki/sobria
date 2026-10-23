import type { MagicString } from "magic-string";
import type { ESTree } from "vite";

import { walk } from "./ast.ts";
import { importInternal } from "./entries.ts";
import { CompileError } from "./errors.ts";
import { directUrl } from "./paths.ts";
import type { Scene } from "./settings.ts";

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

/** `?inline` の指定子 `inline` の CSS から作成したシートを default export し、CSS が更新されたら同じシートを差し替える、クライアントのシートのモジュールのコードを返す。 */
export function clientSheetModule(inline: string): string {
  const specifier = JSON.stringify(inline);
  return `${importInternal("client", "createSheet", "updateSheet")}
import css from ${specifier};
const sheet = createSheet(css);
if (import.meta.hot) {
  import.meta.hot.accept(${specifier}, (module) => {
    if (module) updateSheet(sheet, module.default);
  });
}
export default sheet;
`;
}

/** `?inline` の指定子 `inline` の CSS と、`<link>` に出力する URL `href` から作成したシートの情報を default export する、サーバーのシートのモジュールのコードを返す。 */
export function serverSheetModule(inline: string, href: string): string {
  return `${importInternal("server", "serverSheet")}
import css from ${JSON.stringify(inline)};
export default serverSheet(${JSON.stringify(href)}, css);
`;
}

/** 本番のビルドで、`?url` の指定子 `url` の CSS を fetch して作成したシートを default export する、クライアントのシートのモジュールのコードを返す。 */
export function clientBuildSheetModule(url: string): string {
  return `${importInternal("client", "loadSheet")}
import url from ${JSON.stringify(url)};
export default await loadSheet(url);
`;
}

/** 本番のビルドで、`?url` の指定子 `url` の URL と、`?inline` の指定子 `inline` の CSS から作成したシートの情報を default export する、サーバーのシートのモジュールのコードを返す。 */
export function serverBuildSheetModule(url: string, inline: string): string {
  return `${importInternal("server", "serverSheet")}
import href from ${JSON.stringify(url)};
import css from ${JSON.stringify(inline)};
export default serverSheet(href, css);
`;
}

/** 開発サーバーのパス `path` の CSS から、場面 `scene` の、`client` が真ならクライアントの、偽ならサーバーのシートのモジュールのコードを返す。 */
export function sheetModule(path: string, scene: Scene, client: boolean): string {
  if (scene === "app") {
    return client
      ? clientBuildSheetModule(`${path}?url`)
      : serverBuildSheetModule(`${path}?url`, `${path}?inline`);
  }
  return client
    ? clientSheetModule(`${path}?inline`)
    : serverSheetModule(`${path}?inline`, directUrl(path));
}
