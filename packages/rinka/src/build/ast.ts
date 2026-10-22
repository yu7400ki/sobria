import type { ESTree } from "vite";

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
