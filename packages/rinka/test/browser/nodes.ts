import { build, HTML_NS } from "../../src/client/dom.ts";

/** JSX の値を挿入したノードの列のうち、最初のノードを返す。JSX の値をノードとして使用するテストで使用する。 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function toNode<T extends Node = HTMLElement>(value: unknown): T {
  return build(value, undefined, HTML_NS)[0] as T;
}

/** JSX の値を挿入したノードの列を返す。 */
export function toNodes<T extends Node = HTMLElement>(value: unknown): T[] {
  return build(value, undefined, HTML_NS) as T[];
}
