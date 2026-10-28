import { build } from "../../src/client/dom.ts";

/** HTML の名前空間である。 */
const html = "http://www.w3.org/1999/xhtml";

/** JSX の値を挿入したノードの列のうち、最初のノードを返す。JSX の値をノードとして使用するテストで使用する。 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function toNode<T extends Node = HTMLElement>(value: unknown): T {
  return build(value, undefined, html)[0] as T;
}

/** JSX の値を挿入したノードの列を返す。 */
export function toNodes<T extends Node = HTMLElement>(value: unknown): T[] {
  return build(value, undefined, html) as T[];
}
