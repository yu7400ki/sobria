import type { MagicString } from "magic-string";
import { parseSync, type ESTree } from "vite";

import { CompileError } from "./errors.ts";

/** 変換するソースの言語を表す。 */
export type Lang = "ts" | "tsx" | "js" | "jsx";

/** oxc のパーサーが返す AST のノードを表す。 */
export type Node = ESTree.Node;

/** 関数のノードを表す。 */
export type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

/** `value` が AST のノードかどうかを返す。 */
function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

/** `node` の子のノードを返す。 */
export function children(node: Node): Node[] {
  const found: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) found.push(item);
    } else if (isNode(value)) {
      found.push(value);
    }
  }
  return found;
}

/** `node` と、その子孫のノードを、親から順に `visit` に渡す。 */
export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

/** `node` が関数のノードかどうかを返す。 */
export function isFunction(node: Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** import と export の名前のノードが表す名前を返す。 */
export function moduleExportName(node: ESTree.ModuleExportName): string {
  return node.type === "Literal" ? node.value : node.name;
}

/** `code` の中の各行の先頭の位置を返す。 */
export function lineStarts(code: string): number[] {
  const starts = [0];
  for (let index = code.indexOf("\n"); index !== -1; index = code.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** `offset` の位置を、1 から数えた `行:列` の文字列にする。 */
export function lineColumn(starts: readonly number[], offset: number): string {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return `${low + 1}:${offset - (starts[low] ?? 0) + 1}`;
}

/** 位置の範囲を持つ値を表す。 */
interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * `node` の範囲を `open` と `close` で囲む。
 * 内側のノードから順に呼び出すと、外側のノードを囲む文字列は、内側のノードを囲む文字列の外に並ぶ。
 */
export function surround(output: MagicString, node: Span, open: string, close: string): void {
  output.prependRight(node.start, open);
  output.appendLeft(node.end, close);
}

/** `node` の直後に `text` を挿入する。`text` は、`node` の末尾に `surround` で挿入した文字列より後ろに並ぶ。 */
export function follow(output: MagicString, node: Span, text: string): void {
  output.appendRight(node.end, text);
}

/** `source` から名前で import した指定子を、import した名前ごとに、ファイルの中の名前の集合にして返す。 */
export function importedNames(
  program: ESTree.Program,
  source: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const names = new Map<string, Set<string>>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== source) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") continue;
      const imported = moduleExportName(specifier.imported);
      const locals = names.get(imported) ?? new Set();
      locals.add(specifier.local.name);
      names.set(imported, locals);
    }
  }
  return names;
}

/** 解析するモジュールを表す。 */
export interface ModuleSource {
  /** モジュールのパスである。ソースマップは、このパスのファイルを指す。 */
  readonly id: string;
  /** ファイルのパスである。プロジェクトのルートからの相対パスを、`/` で区切って記述する。エラーの文言に表示する。 */
  readonly file: string;
  readonly lang: Lang;
}

/** `code` を ES モジュールとして解析する。式を囲む括弧は `ParenthesizedExpression` のノードにする。構文の誤りがあれば `CompileError` を投げる。 */
export function parseModule(code: string, { id, file, lang }: ModuleSource): ESTree.Program {
  const { program, errors } = parseSync(id, code, { lang, sourceType: "module" });
  const [error] = errors;
  if (error) throw new CompileError(`${file} を解析できません: ${error.message}`);
  return program;
}

/** 式を囲む括弧を外したノードを返す。 */
export function unwrap(node: Node): Node {
  let current = node;
  while (current.type === "ParenthesizedExpression") current = current.expression;
  return current;
}
