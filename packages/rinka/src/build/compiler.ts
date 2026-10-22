import { MagicString, type SourceMap } from "magic-string";
import type { ESTree } from "vite";

import type { ElementInfo, ElementOptions } from "../shared/element.ts";
import {
  children,
  isFunction,
  lineColumn,
  lineStarts,
  follow,
  importedNames,
  parseModule,
  unwrap,
  surround,
  walk,
  type FunctionNode,
  type ModuleSource,
  type Node,
} from "./ast.ts";
import { entries } from "./entries.ts";
import { CompileError } from "./errors.ts";
import { analyzeProps } from "./props.ts";

export { CompileError } from "./errors.ts";

/** 元のソースに適用する変換の設定を表す。 */
export interface SourceOptions extends ModuleSource {
  /** クライアント向けのコードなら真である。 */
  readonly client: boolean;
  /** 要素のファイルなら、要素のタグ名を持つ。 */
  readonly element?: { readonly tag: string };
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

/** 関門を取得する関数を、変換したコードの中で呼ぶ名前である。 */
const TAKE_GATE = "__rinka_takeGate";
/** async 関数が取得した関門を保持する変数の名前である。 */
const GATE = "__rinka_gate";
/** 要素を登録する関数を、変換したコードの中で呼ぶ名前である。 */
const DEFINE = "__rinka_defineElement";

/**
 * 元のソースに、`rinka` の `memo` の呼び出し箇所の ID を付与する。
 * クライアント向けのコードでは、async 関数の `await` を関門で包む。
 * 要素のファイルでは、default export した関数を、要素を登録する呼び出しに書き換え、関数の中の JSX のスロットを `<slot>` にする。
 */
export function transformSource(code: string, options: SourceOptions): SourceResult {
  const program = parseModule(code, options);
  const output = new MagicString(code);
  addMemoSites(program, output, code, options.file);
  const element =
    options.element &&
    registerElement(program, output, options.element.tag, options.file, options.client);
  if (options.client && gateAwaits(program, output)) {
    output.prepend(`import { takeGate as ${TAKE_GATE} } from "${entries.internal}";\n`);
  }
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: options.id, includeContent: true }),
    element,
  };
}

/**
 * default export した要素の関数を、`tag` と Props の解析の結果を渡して要素を登録する呼び出しにする。
 * クライアント向けなら、登録に `import.meta.hot` を渡し、モジュール自身の更新を受け入れる。
 */
function registerElement(
  program: ESTree.Program,
  output: MagicString,
  tag: string,
  file: string,
  client: boolean,
): ElementInfo {
  const exported = program.body.find((statement) => statement.type === "ExportDefaultDeclaration");
  const fn = exported?.declaration;
  if (!exported || fn?.type !== "FunctionDeclaration" || !fn.id) {
    throw new CompileError(
      `${file}: 要素のファイルは、export default function 名前(props, ctx) の形で関数を default export してください。`,
    );
  }
  const elementOptions = analyzeProps(program, fn, file);
  convertSlots(fn, elementOptions, output, file);
  output.remove(exported.start, fn.start);
  const args = [JSON.stringify(tag), fn.id.name, JSON.stringify(elementOptions)];
  if (client) args.push("import.meta.hot");
  output.append(`
export default ${DEFINE}(${args.join(", ")});
`);
  if (client) output.append("if (import.meta.hot) import.meta.hot.accept();\n");
  output.prepend(`import { defineElement as ${DEFINE} } from "${entries.main}";
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
  const names = importedNames(program, entries.main).get("memo");
  if (!names) return;
  const starts = lineStarts(code);
  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee.type !== "Identifier" || !names.has(node.callee.name)) return;
    const [fn, options] = node.arguments;
    if (!fn || fn.type === "SpreadElement" || options?.type === "SpreadElement") return;
    const site = `site: ${JSON.stringify(`${file}:${lineColumn(starts, node.start)}`)}`;
    if (!options) {
      follow(output, fn, `, { ${site} }`);
    } else if (options.type === "ObjectExpression") {
      output.appendLeft(
        options.start + 1,
        options.properties.length > 0 ? ` ${site},` : ` ${site} `,
      );
    } else {
      surround(output, options, "{ ...", `, ${site} }`);
    }
  });
}

/**
 * async 関数（generator を除く）の直接の `await` を、その関数の関門で包む。包んだら真を返す。
 * `for await` の文は、反復する値を関門に渡す。
 */
function gateAwaits(program: ESTree.Program, output: MagicString): boolean {
  let gated = false;
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
    if (!owner) return;
    if (node.type === "AwaitExpression") {
      owner.used = true;
      surround(output, node.argument, `${GATE}(`, ")");
    } else if (node.type === "ForOfStatement" && node.await) {
      owner.used = true;
      surround(output, node.right, `${GATE}.iterate(`, ")");
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
    surround(output, body, `{ ${declaration} return `, "; }");
  }
}

/**
 * 要素の関数の JSX の子に置いた `{props.children}`、`{props.X}`、`{props.X ?? 既定の中身}` を `<slot>` にする。
 * 要素の関数の中の関数にスロットを置くと、ビルドのエラーにする。props と同じ名前の引数を持つ関数の中は変換しない。
 */
function convertSlots(
  fn: ESTree.Function,
  elementOptions: ElementOptions,
  output: MagicString,
  file: string,
): void {
  const [param] = fn.params;
  if (param?.type !== "Identifier" || !fn.body) return;
  const names = new Set(["children", ...(elementOptions.slots ?? [])]);
  const placed = new Set<string>();
  const visit = (node: Node, nested: boolean): void => {
    if (isFunction(node)) {
      const rebinds = node.params.some(
        (other) => other.type === "Identifier" && other.name === param.name,
      );
      if (!rebinds) for (const child of children(node)) visit(child, true);
      return;
    }
    if (node.type === "JSXElement" || node.type === "JSXFragment") placeSlots(node, nested);
    for (const child of children(node)) visit(child, nested);
  };
  const placeSlots = (node: ESTree.JSXElement | ESTree.JSXFragment, nested: boolean): void => {
    for (const child of node.children) {
      if (
        child.type !== "JSXExpressionContainer" ||
        child.expression.type === "JSXEmptyExpression"
      ) {
        continue;
      }
      const slot = slotOf(child.expression, param.name, names);
      if (!slot) continue;
      if (nested) {
        throw new CompileError(
          `${file}: スロット ${slot.name} は、要素の関数の中の関数に置けません。要素の関数が返す JSX に直接置いてください。`,
        );
      }
      if (placed.has(slot.name)) {
        throw new CompileError(
          `${file}: スロット ${slot.name} を 2 回置いています。スロットは 1 回だけ置いてください。`,
        );
      }
      placed.add(slot.name);
      const name = slot.name === "children" ? "" : ` name=${JSON.stringify(slot.name)}`;
      const { fallback } = slot;
      if (!fallback) {
        output.overwrite(child.start, child.end, `<slot${name} />`);
        continue;
      }
      const jsx = fallback.type === "JSXElement" || fallback.type === "JSXFragment";
      output.overwrite(child.start, fallback.start, `<slot${name}>${jsx ? "" : "{"}`);
      output.overwrite(fallback.end, child.end, `${jsx ? "" : "}"}</slot>`);
    }
  };
  visit(fn.body, false);
}

/** 式が `props` のスロットの参照なら、スロットの名前とデフォルトの中身を返す。式を囲む括弧は外して判定する。 */
function slotOf(
  node: Node,
  props: string,
  names: ReadonlySet<string>,
): { name: string; fallback?: ESTree.Expression } | undefined {
  const expression = unwrap(node);
  if (expression.type === "LogicalExpression" && expression.operator === "??") {
    const slot = slotOf(expression.left, props, names);
    return slot && !slot.fallback ? { ...slot, fallback: expression.right } : undefined;
  }
  if (expression.type !== "MemberExpression" || expression.computed) return undefined;
  const { object, property } = expression;
  if (object.type !== "Identifier" || object.name !== props || property.type !== "Identifier") {
    return undefined;
  }
  return names.has(property.name) ? { name: property.name } : undefined;
}
