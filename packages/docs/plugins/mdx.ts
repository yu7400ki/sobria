import { transformMdast } from "@ox-content/napi";
import type { Plugin } from "vite";

/** mdast のノードのうち、TSX に変換するときに参照する欄である。 */
interface Node {
  readonly type: string;
  readonly value?: string;
  readonly depth?: number;
  readonly children?: readonly Node[];
}

/** `.mdx` のファイルを、本文のコンポーネントを default export する TSX のソースに変換する Vite のプラグインを返す。 */
export function mdx(): Plugin {
  return {
    name: "docs:mdx",
    transform(source, id) {
      if (!id.endsWith(".mdx")) return null;
      const result = transformMdast(source, { mdx: true, gfm: true });
      if (result.errors.length > 0) throw new Error(`${id}: ${result.errors.join("\n")}`);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const root = JSON.parse(result.astJson) as Node;
      return [
        `export const frontmatter = ${result.frontmatter || "{}"};`,
        `export default function Content() {`,
        `  return <>${children(root)}</>;`,
        `}`,
      ].join("\n");
    },
  };
}

/** ノード `node` の子を、JSX の子のソースにして連結する。 */
const children = (node: Node): string => (node.children ?? []).map(element).join("");

/** ノード `node` を、JSX のソースにする。 */
function element(node: Node): string {
  switch (node.type) {
    case "heading":
      return `<h${node.depth}>${children(node)}</h${node.depth}>`;
    case "paragraph":
      return `<p>${children(node)}</p>`;
    case "text":
      return `{${JSON.stringify(node.value)}}`;
    default:
      throw new Error(`MDX の ${node.type} のノードは変換できません。`);
  }
}
