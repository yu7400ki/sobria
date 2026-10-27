import type { MagicString } from "magic-string";
import type { ESTree } from "vite";

import {
  follow,
  importedNames,
  insertInside,
  lineColumn,
  lineStarts,
  surround,
  walk,
  type Node,
} from "./ast.ts";
import { entries } from "./entries.ts";
import { CompileError } from "./errors.ts";
import { SITE_PROP } from "./jsx.ts";

/**
 * `rinka` から import した `memo` の呼び出しに、`{ site: "ファイル:行:列" }` を付与する。
 * コンポーネントの JSX のタグに、呼び出し箇所の ID `"ファイル:行:列"` を値に持つ属性 `__rinka_site` を付与する。
 * JSX の規則を適用する変換が、この属性を `jsx` の第 4 引数に移動する。
 */
export function addSites(
  program: ESTree.Program,
  output: MagicString,
  code: string,
  file: string,
  replaced: ReadonlySet<Node>,
): void {
  const memos = importedNames(program, entries.main).get("memo");
  const starts = lineStarts(code);
  const siteOf = (node: Node) => JSON.stringify(`${file}:${lineColumn(starts, node.start)}`);
  walk(
    program,
    (node) => {
      if (node.type === "CallExpression") {
        if (node.callee.type !== "Identifier" || !memos?.has(node.callee.name)) return;
        const [fn, options] = node.arguments;
        if (!fn || fn.type === "SpreadElement" || options?.type === "SpreadElement") return;
        const site = `site: ${siteOf(node)}`;
        if (!options) {
          follow(output, fn, `, { ${site} }`);
        } else if (options.type === "ObjectExpression") {
          insertInside(output, options, options.properties.length > 0 ? ` ${site},` : ` ${site} `);
        } else {
          surround(output, options, "{ ...", `, ${site} }`);
        }
        return;
      }
      if (node.type !== "JSXElement") return;
      const { name, attributes, typeArguments } = node.openingElement;
      for (const attribute of attributes) {
        if (
          attribute.type === "JSXAttribute" &&
          attribute.name.type === "JSXIdentifier" &&
          attribute.name.name === SITE_PROP
        ) {
          throw new CompileError(
            `${file}: ${SITE_PROP} は rinka が使用する名前なので、props の名前にできません。`,
          );
        }
      }
      if (name.type === "JSXNamespacedName") return;
      if (name.type === "JSXIdentifier" && /^[a-z]|-/.test(name.name)) return;
      follow(output, typeArguments ?? name, ` ${SITE_PROP}={${siteOf(node)}}`);
    },
    (node) => replaced.has(node),
  );
}
