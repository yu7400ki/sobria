import { transformMdast } from "@ox-content/napi";
import { codeToHast } from "shiki";
import type { Plugin } from "vite";

/** MDX の変換の設定である。 */
export interface MdxOptions {
  /** コードブロックを描画するコンポーネントを default export するモジュールの指定子である。コンポーネントは、元のコード `code`、言語 `lang`、色付けした `<pre>` の子を受け取る。 */
  readonly codeBlock: string;
}

/** 目次の項目である。 */
export interface TocItem {
  readonly depth: number;
  readonly id: string;
  readonly text: string;
}

/** MDX の JSX の属性である。`value` は、値の無い属性では `null`、文字列の属性では文字列、式の属性では式のソースを持つオブジェクトである。 */
interface Attribute {
  readonly type: string;
  readonly name?: string;
  readonly value?: string | null | { readonly value: string };
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
  readonly attributes?: readonly Attribute[];
  readonly tagName?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly children?: readonly Node[];
}

/** 色付けする前のコードブロックである。 */
interface CodeBlock {
  readonly code: string;
  readonly lang: string | undefined;
}

/** 本文のコンポーネントの中で、コードブロックのコンポーネントを参照する名前である。 */
const CODE_BLOCK = "MdxCodeBlock";

/** 目次に含める見出しの深さである。 */
const TOC_DEPTHS = new Set([2, 3]);

/** ID にできる文字が無い見出しの ID である。 */
const FALLBACK_ID = "section";

/** `.mdx` のファイルを TSX のソースに変換する Vite のプラグインを返す。 */
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
 * MDX の ESM と式は、ソースの文字列のまま出力する。JSX の属性の式も、ソースの文字列のまま出力する。
 */
export async function toTsx(source: string, options: MdxOptions): Promise<string> {
  const result = transformMdast(source, { mdx: true, gfm: true });
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const root = JSON.parse(result.astJson) as Node;
  const ids = new Set<string>();
  const toc: TocItem[] = [];
  const esm: string[] = [];
  const blocks: CodeBlock[] = [];

  /** 見出しの文字列 `text` から、ページの中で重複しない ID を作る。 */
  const idOf = (text: string): string => {
    const base =
      text
        .toLowerCase()
        .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
        .trim()
        .replaceAll(" ", "-") || FALLBACK_ID;
    let id = base;
    for (let count = 1; ids.has(id); count++) id = `${base}-${count}`;
    ids.add(id);
    return id;
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

  /** リストの項目 `item` を JSX にする。タスクのチェックボックスは、空けたリストでは最初の段落の中に置く。 */
  const listItem = (item: Node, tight: boolean): string => {
    if (item.checked == null) return `<li>${children(item, tight)}</li>`;
    const check = `<input type="checkbox"${item.checked ? " checked" : ""} disabled />{" "}`;
    const [first, ...rest] = item.children ?? [];
    if (tight || first?.type !== "paragraph") return `<li>${check}${children(item, tight)}</li>`;
    return `<li><p>${check}${children(first)}</p>${children({ type: "listItem", children: rest })}</li>`;
  };

  /** ノード `node` を JSX のソースにする。コードブロックは、色付けが完了した後に置換する目印にする。 */
  const element = (node: Node, tight = false): string => {
    switch (node.type) {
      case "root":
        return children(node);
      case "heading": {
        const text = textOf(node).trim();
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
      case "definition":
        return "";
      case "list": {
        const tag = node.ordered === true ? "ol" : "ul";
        const start =
          node.ordered === true && node.start != null && node.start !== 1
            ? ` start={${node.start}}`
            : "";
        const tightList = node.spread !== true;
        const items = (node.children ?? []).map((item) => listItem(item, tightList)).join("");
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
      case "code":
        blocks.push({
          code: (node.value ?? "").replace(/\n$/, ""),
          lang: node.lang ?? undefined,
        });
        return `\0${blocks.length - 1}\0`;
      case "mdxjsEsm": {
        const value = node.value ?? "";
        if (/\bexport\s+default\b/.test(value)) {
          throw new Error(
            "MDX の export default は、本文のコンポーネントと重複するので記述できません。",
          );
        }
        esm.push(value);
        return "";
      }
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

  const jsx = element(root);
  const highlighted = await Promise.all(blocks.map(highlight));
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

/** コードブロック `block` を色付けし、コードブロックのコンポーネントの JSX にする。 */
async function highlight({ code, lang }: CodeBlock): Promise<string> {
  const tree = await codeToHast(code, {
    lang: lang ?? "text",
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
  const props = `code={${literal(code)}}${optional("lang", lang)}`;
  return `<${CODE_BLOCK} ${props}>${(tree.children as readonly Node[]).map(hast).join("")}</${CODE_BLOCK}>`;
}

/** 値 `value` を、JS の文字列のリテラルにする。 */
const literal = (value: string): string => JSON.stringify(value);

/** 値 `value` があれば、属性 `name` の JSX のソースにする。 */
const optional = (name: string, value: string | null | undefined): string =>
  value == null ? "" : ` ${name}={${literal(value)}}`;

/** ノード `node` の子孫のテキスト、インラインのコード、画像の alt を連結する。 */
function textOf(node: Node): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  if (node.type === "image") return node.alt ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/** MDX の JSX の属性 `attribute` を、JSX の属性のソースにする。 */
function attribute({ type, name, value }: Attribute): string {
  if (type === "mdxJsxExpressionAttribute") return ` {${typeof value === "string" ? value : ""}}`;
  if (value == null) return ` ${name}`;
  if (typeof value === "string") return ` ${name}={${literal(value)}}`;
  return ` ${name}={${value.value}}`;
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
