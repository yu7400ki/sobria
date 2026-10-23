import type { EnvironmentModuleNode } from "vite";

/** サーバーコンポーネントの CSS として収集するモジュールの拡張子に一致する正規表現である。 */
const styleExtension = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/;

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
    if (styleExtension.test(node.id)) {
      links.push(`${node.url}?direct`);
    }
  };
  for (const root of roots) visit(root);
  return links;
}
