import type { ClientNode } from "../shared/nodes.ts";
import type { Child } from "./dom.ts";

export { jsx, jsx as jsxs } from "./dom.ts";

/** 子をそのまま返す。 */
export function Fragment(props: { children?: Child }): ClientNode {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return props.children as ClientNode;
}
