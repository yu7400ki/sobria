import { isCSSRequest, type EnvironmentModuleNode } from "vite";

import { directUrl } from "./paths.ts";

/**
 * モジュール `roots` から import をたどり、普通の import で読み込んだ CSS を開発サーバーが CSS として配信する URL を返す。
 * 依存先の CSS を、それを import するモジュールの CSS より先に配置し、同じ CSS は 1 回だけ出力する。
 * クエリを付けた import と、仮想のモジュールは、たどらない。
 */
export function routeStyles(roots: readonly EnvironmentModuleNode[]): string[] {
  const visited = new Set<EnvironmentModuleNode>();
  const links: string[] = [];
  const visit = (node: EnvironmentModuleNode): void => {
    if (
      visited.has(node) ||
      node.id === null ||
      node.id.includes("?") ||
      node.id.startsWith("\0")
    ) {
      return;
    }
    visited.add(node);
    for (const imported of node.importedModules) visit(imported);
    if (isCSSRequest(node.id)) {
      links.push(directUrl(node.url));
    }
  };
  for (const root of roots) visit(root);
  return links;
}
