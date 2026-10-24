import { transformMdast } from "@ox-content/napi";
import { codeToHast } from "shiki";
import type { Plugin } from "vite";

/** MDX の変換の設定である。 */
export interface MdxOptions {
  /** コードブロックを描画するコンポーネントを default export するモジュールの指定子。コンポーネントは、元のコード `code`、言語 `lang`、色付けした `<pre>` の子を受け取る。 */
  readonly codeBlock: string;
}

/** 目次の項目である。 */
export interface TocItem {
  readonly depth: number;
  readonly id: string;
  readonly text: string;
}

/** mdast と hast のノードの型のうち、TSX に変換するときに参照する欄だけを持つものである。 */
interface Node {
  readonly type: string;
  readonly value?: string | null;
  readonly depth?: number;
  readonly ordered?: boolean;
  readonly start?: number | null;
  readonly spread?: boolean;
  readonly checked?: boolean | null;
  readonly url?: string;
  readonly title?: string | null;
  readonly alt?: string | null;
  readonly lang?: string | null;
  readonly align?: readonly (string | null)[];
  readonly name?: string | null;
  readonly attributes?: readonly Node[];
  readonly tagName?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly children?: readonly Node[];
}

/** 本文のコンポーネントの中で、コードブロックのコンポーネントを参照する名前である。 */
const CODE_BLOCK = "MdxCodeBlock";

/** 目次に含める見出しの深さである。 */
const TOC_DEPTHS = new Set([2, 3]);

/** `.mdx` のファイルを、`toTsx` で TSX のソースに変換する Vite のプラグインを返す。 */
export function mdx(options: MdxOptions): Plugin {
  return {
    name: "docs:mdx",
    async transform(source, id) {
      if (!id.endsWith(".mdx")) return null;
      try {
        return await toTsx(source, options);
      } catch (error) {
        throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    },
  };
}

/**
 * MDX のソース `source` を TSX のソースにする。TSX は、本文のコンポーネントを default export し、frontmatter のオブジェクトを `frontmatter`、深さ 2 と 3 の見出しの `TocItem` の配列を `toc` として export する。
 * MDX の ESM、JSX、式は、ソースの文字列のまま出力する。
 */
export async function toTsx(source: string, options: MdxOptions): Promise<string> {
  const result = transformMdast(source, { mdx: true, gfm: true });
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const root = JSON.parse(result.astJson) as Node;
  const ids = new Map<string, number>();
  const toc: TocItem[] = [];
  const esm: string[] = [];
  const codes: Promise<string>[] = [];

  /** 見出しの文字列 `text` から、ページの中で重複しない ID を作る。 */
  const idOf = (text: string): string => {
    const base = text
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replaceAll(" ", "-");
    const count = ids.get(base) ?? 0;
    ids.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };

  /** ノード `node` の子を JSX にして連結する。隣り合うテキストは 1 つの文字列にする。`tight` が真なら、段落を `<p>` で囲まない。 */
  const children = (node: Node, tight = false): string => {
    const merged: Node[] = [];
    for (const child of node.children ?? []) {
      const last = merged.at(-1);
      if (child.type === "text" && last?.type === "text") {
        merged[merged.length - 1] = {
          type: "text",
          value: `${last.value ?? ""}${child.value ?? ""}`,
        };
      } else {
        merged.push(child);
      }
    }
    return merged.map((child) => element(child, tight)).join("");
  };

  /** ノード `node` を JSX のソースにする。コードブロックは、色付けが完了した後に置換する目印にする。 */
  const element = (node: Node, tight = false): string => {
    switch (node.type) {
      case "root":
        return children(node);
      case "heading": {
        const text = textOf(node);
        const id = idOf(text);
        const depth = node.depth ?? 1;
        if (TOC_DEPTHS.has(depth)) toc.push({ depth, id, text });
        return `<h${depth} id={${literal(id)}}>${children(node)}</h${depth}>`;
      }
      case "paragraph":
        return tight ? children(node) : `<p>${children(node)}</p>`;
      case "text":
        return `{${literal(node.value ?? "")}}`;
      case "emphasis":
        return `<em>${children(node)}</em>`;
      case "strong":
        return `<strong>${children(node)}</strong>`;
      case "delete":
        return `<del>${children(node)}</del>`;
      case "inlineCode":
        return `<code>{${literal(node.value ?? "")}}</code>`;
      case "break":
        return "<br />";
      case "link":
        return `<a href={${literal(node.url ?? "")}}${optional("title", node.title)}>${children(node)}</a>`;
      case "image":
        return `<img src={${literal(node.url ?? "")}} alt={${literal(node.alt ?? "")}}${optional("title", node.title)} />`;
      case "list": {
        const tag = node.ordered === true ? "ol" : "ul";
        const start =
          node.ordered === true && node.start != null && node.start !== 1
            ? ` start={${node.start}}`
            : "";
        const items = (node.children ?? [])
          .map((item) => {
            const check =
              item.checked == null
                ? ""
                : `<input type="checkbox"${item.checked ? " checked" : ""} disabled />{" "}`;
            return `<li>${check}${children(item, node.spread !== true && item.spread !== true)}</li>`;
          })
          .join("");
        return `<${tag}${start}>${items}</${tag}>`;
      }
      case "blockquote":
        return `<blockquote>${children(node)}</blockquote>`;
      case "thematicBreak":
        return "<hr />";
      case "table": {
        const [head, ...rows] = node.children ?? [];
        const row = (tr: Node, cell: string) =>
          `<tr>${(tr.children ?? [])
            .map((td, index) => {
              const align = node.align?.[index];
              const style = align == null ? "" : ` style={${literal(`text-align: ${align}`)}}`;
              return `<${cell}${style}>${children(td)}</${cell}>`;
            })
            .join("")}</tr>`;
        const body =
          rows.length > 0 ? `<tbody>${rows.map((tr) => row(tr, "td")).join("")}</tbody>` : "";
        return `<table>${head === undefined ? "" : `<thead>${row(head, "th")}</thead>`}${body}</table>`;
      }
      case "code": {
        const code = (node.value ?? "").replace(/\n$/, "");
        codes.push(highlight(code, node.lang ?? undefined));
        return `\0${codes.length - 1}\0`;
      }
      case "mdxjsEsm":
        esm.push(node.value ?? "");
        return "";
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement": {
        const name = node.name ?? "";
        const attributes = (node.attributes ?? []).map(attribute).join("");
        return `<${name}${attributes}>${children(node)}</${name}>`;
      }
      case "mdxFlowExpression":
      case "mdxTextExpression":
        return `{${node.value ?? ""}}`;
      case "html":
        throw new Error(
          `${node.value ?? ""} は HTML として解析されるので変換できません。小文字で始まるタグは、大文字で始まるコンポーネントにしてください。`,
        );
      default:
        throw new Error(`MDX の ${node.type} のノードは変換できません。`);
    }
  };

  /** 元のコード `code` を言語 `lang` で色付けし、コードブロックのコンポーネントの JSX にする。 */
  const highlight = async (code: string, lang: string | undefined): Promise<string> => {
    const tree = await codeToHast(code, {
      lang: lang ?? "text",
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    const props = `code={${literal(code)}}${optional("lang", lang)}`;
    return `<${CODE_BLOCK} ${props}>${(tree.children as readonly Node[]).map(hast).join("")}</${CODE_BLOCK}>`;
  };

  const jsx = element(root);
  const highlighted = await Promise.all(codes);
  const content = jsx.replaceAll(/\0(\d+)\0/g, (_, index: string) => highlighted[Number(index)]!);
  return [
    `import ${CODE_BLOCK} from ${literal(options.codeBlock)};`,
    ...esm,
    `export const frontmatter = ${result.frontmatter || "{}"};`,
    `export const toc = ${JSON.stringify(toc)};`,
    `export default function Content() {`,
    `  return <>${content}</>;`,
    `}`,
  ].join("\n");
}

/** 値 `value` を、JS の文字列のリテラルにする。 */
const literal = (value: string): string => JSON.stringify(value);

/** 値 `value` があれば、属性 `name` の JSX のソースにする。 */
const optional = (name: string, value: string | null | undefined): string =>
  value == null ? "" : ` ${name}={${literal(value)}}`;

/** ノード `node` の子孫のテキストとインラインのコードを連結する。 */
const textOf = (node: Node): string =>
  node.type === "text" || node.type === "inlineCode"
    ? (node.value ?? "")
    : (node.children ?? []).map(textOf).join("");

/** MDX の JSX の属性 `node` を、JSX の属性のソースにする。 */
function attribute(node: Node): string {
  if (node.type === "mdxJsxExpressionAttribute") return ` {${node.value ?? ""}}`;
  const value: unknown = node.value;
  if (value === null || value === undefined) return ` ${node.name}`;
  if (typeof value === "string") return ` ${node.name}={${literal(value)}}`;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return ` ${node.name}={${(value as Node).value ?? ""}}`;
}

/** Shiki が出力した hast のノード `node` を、JSX のソースにする。 */
function hast(node: Node): string {
  if (node.type === "text") return `{${literal(node.value ?? "")}}`;
  const tag = node.tagName ?? "";
  const attributes = Object.entries(node.properties ?? {})
    .map(
      ([name, value]) =>
        ` ${name}={${literal(Array.isArray(value) ? value.join(" ") : String(value))}}`,
    )
    .join("");
  return `<${tag}${attributes}>${(node.children ?? []).map(hast).join("")}</${tag}>`;
}
