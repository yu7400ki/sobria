import type { MagicString } from "magic-string";
import type { ESTree } from "vite";

import {
  children,
  insertInside,
  isFunction,
  surround,
  type FunctionNode,
  type Node,
} from "./ast.ts";

/** 変換したコードで `stopIfSeeding` を呼ぶときの名前である。 */
export const STOP_IF_SEEDING = "__sobria_stopIfSeeding";
/** async 関数が開始した時点で受け取った `stopIfSeeding` の戻り値を保持する変数の名前である。 */
const STOP = "__sobria_stop";

/**
 * async 関数（generator を除く）の本体にある `await` が待つ値を、その関数が開始した時点で受け取った `stopIfSeeding` の戻り値に渡す。
 * 内側の関数の `await` は、内側の関数の戻り値に渡す。1 つでも書き換えたら真を返す。
 * `for await` の文は、反復する値をその戻り値の `iterate` に渡す。
 */
export function stopAwaits(
  program: ESTree.Program,
  output: MagicString,
  replaced: ReadonlySet<Node>,
): boolean {
  let stopped = false;
  const visit = (node: Node, owner: { used: boolean } | null): void => {
    if (replaced.has(node)) return;
    if (isFunction(node)) {
      const own = node.async && !node.generator ? { used: false } : null;
      for (const child of children(node)) visit(child, own);
      if (own?.used) {
        insertStop(node, output);
        stopped = true;
      }
      return;
    }
    for (const child of children(node)) visit(child, owner);
    if (!owner) return;
    if (node.type === "AwaitExpression") {
      owner.used = true;
      surround(output, node.argument, `${STOP}(`, ")");
    } else if (node.type === "ForOfStatement" && node.await) {
      owner.used = true;
      surround(output, node.right, `${STOP}.iterate(`, ")");
    }
  };
  visit(program, null);
  return stopped;
}

/** 関数の本体の先頭で `stopIfSeeding` を呼び、戻り値を `STOP` の名前の変数に保持する。 */
function insertStop(fn: FunctionNode, output: MagicString): void {
  const { body } = fn;
  if (!body) return;
  const declaration = `const ${STOP} = ${STOP_IF_SEEDING}();`;
  if (body.type === "BlockStatement") {
    insertInside(output, body, ` ${declaration}`);
  } else {
    surround(output, body, `{ ${declaration} return `, "; }");
  }
}
