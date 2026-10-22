import { MagicString, type SourceMap } from "magic-string";
import { parseSync, type ESTree } from "vite";

import type { ElementOptions } from "../shared/element.ts";
import {
  children,
  isFunction,
  lineColumn,
  lineStarts,
  moduleExportName,
  walk,
  type FunctionNode,
  type Node,
} from "./ast.ts";
import { analyzeProps, PropsError } from "./props.ts";

/** 変換するファイルの言語を表す。 */
export type Lang = "ts" | "tsx" | "js" | "jsx";

/** 元のソースに適用する変換の設定を表す。 */
export interface SourceOptions {
  /** プロジェクトのルートからの相対パスを `/` で区切ったもの。 */
  readonly file: string;
  readonly lang: Lang;
  /** クライアント向けのコードなら真である。 */
  readonly client: boolean;
  /** 要素のファイルなら、要素のタグ名を持つ。 */
  readonly element?: { readonly tag: string };
}

/** 要素のファイルの、タグ名と、要素を登録するときの設定を表す。 */
export interface ElementInfo {
  readonly tag: string;
  readonly options: ElementOptions;
}

/** 変換したコードと、元のコードへのソースマップを表す。 */
export interface Transformed {
  readonly code: string;
  readonly map: SourceMap;
}

/** 元のソースを変換した結果を表す。 */
export interface SourceResult extends Transformed {
  /** 要素のファイルなら、要素の情報を持つ。 */
  readonly element: ElementInfo | undefined;
}

/** ソースを変換できないことを表す。 */
export class CompileError extends Error {}

/** 関門を取得する関数を、変換したコードの中で呼ぶ名前である。 */
const TAKE_GATE = "__rinka_takeGate";
/** async 関数が取得した関門を保持する変数の名前である。 */
const GATE = "__rinka_gate";
/** 要素を登録する関数を、変換したコードの中で呼ぶ名前である。 */
const DEFINE = "__rinka_defineElement";

/**
 * 元のソースに、`rinka` の `memo` の呼び出し箇所の ID を付与する。
 * クライアント向けのコードでは、async 関数の `await` を関門で包む。
 * 要素のファイルでは、default export した関数を、要素を登録する呼び出しに書き換える。
 */
export function transformSource(code: string, options: SourceOptions): SourceResult {
  const { program, errors } = parseSync(options.file, code, {
    lang: options.lang,
    sourceType: "module",
  });
  const [error] = errors;
  if (error) throw new CompileError(`${options.file} を解析できません: ${error.message}`);
  const output = new MagicString(code);
  addMemoSites(program, output, code, options.file);
  const element =
    options.element && registerElement(program, output, options.element.tag, options.file);
  if (options.client && gateAwaits(program, output)) {
    output.prepend(`import { takeGate as ${TAKE_GATE} } from "rinka/internal";\n`);
  }
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: options.file, includeContent: true }),
    element,
  };
}

/** default export した要素の関数を、`tag` と Props の解析の結果を渡して要素を登録する呼び出しにする。 */
function registerElement(
  program: ESTree.Program,
  output: MagicString,
  tag: string,
  file: string,
): ElementInfo {
  const exported = program.body.find((statement) => statement.type === "ExportDefaultDeclaration");
  const fn = exported?.declaration;
  if (!exported || fn?.type !== "FunctionDeclaration" || !fn.id) {
    throw new CompileError(
      `${file}: 要素のファイルは、export default function 名前(props, ctx) の形で関数を default export してください。`,
    );
  }
  let elementOptions: ElementOptions;
  try {
    elementOptions = analyzeProps(program, fn);
  } catch (error) {
    if (error instanceof PropsError) throw new CompileError(`${file}: ${error.message}`);
    throw error;
  }
  output.remove(exported.start, fn.start);
  output.append(
    `
export default ${DEFINE}(${JSON.stringify(tag)}, ${fn.id.name}, ${JSON.stringify(elementOptions)});
`,
  );
  output.prepend(`import { defineElement as ${DEFINE} } from "rinka";
`);
  return { tag, options: elementOptions };
}

/** `rinka` から import した `memo` の呼び出しに、`{ site: "ファイル:行:列" }` を付与する。 */
function addMemoSites(
  program: ESTree.Program,
  output: MagicString,
  code: string,
  file: string,
): void {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "rinka") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier" && moduleExportName(specifier.imported) === "memo") {
        names.add(specifier.local.name);
      }
    }
  }
  if (names.size === 0) return;
  const starts = lineStarts(code);
  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee.type !== "Identifier" || !names.has(node.callee.name)) return;
    const [fn, options] = node.arguments;
    if (!fn) return;
    const site = `site: ${JSON.stringify(`${file}:${lineColumn(starts, node.start)}`)}`;
    if (!options) {
      output.appendLeft(fn.end, `, { ${site} }`);
    } else if (options.type === "ObjectExpression") {
      output.appendLeft(
        options.start + 1,
        options.properties.length > 0 ? ` ${site},` : ` ${site} `,
      );
    } else {
      output.prependRight(options.start, "{ ...");
      output.appendLeft(options.end, `, ${site} }`);
    }
  });
}

/** async 関数（generator を除く）の直接の `await` を、その関数の関門で包む。包んだら真を返す。 */
function gateAwaits(program: ESTree.Program, output: MagicString): boolean {
  let gated = false;
  // 内側のノードから順に書き換えるので、開く括弧は prependRight で、閉じる括弧は appendLeft で挿入する
  const visit = (node: Node, owner: { used: boolean } | null): void => {
    if (isFunction(node)) {
      const own = node.async && !node.generator ? { used: false } : null;
      for (const child of children(node)) visit(child, own);
      if (own?.used) {
        insertGate(node, output);
        gated = true;
      }
      return;
    }
    for (const child of children(node)) visit(child, owner);
    if (node.type === "AwaitExpression" && owner) {
      owner.used = true;
      output.prependRight(node.argument.start, `${GATE}(`);
      output.appendLeft(node.argument.end, ")");
    }
  };
  visit(program, null);
  return gated;
}

/** 関数の本体の先頭で、関門を取得する。 */
function insertGate(fn: FunctionNode, output: MagicString): void {
  const { body } = fn;
  if (!body) return;
  const declaration = `const ${GATE} = ${TAKE_GATE}();`;
  if (body.type === "BlockStatement") {
    output.appendLeft(body.start + 1, ` ${declaration}`);
  } else {
    output.prependRight(body.start, `{ ${declaration} return `);
    output.appendLeft(body.end, "; }");
  }
}
