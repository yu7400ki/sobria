// TypeScript の DOM の型定義から、props と expose に使えない名前の一覧を生成する。
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { API, SymbolFlags } from "typescript/unstable/sync";

const root = resolve(import.meta.dirname, "..");
const config = resolve(root, "tsconfig.json");
const output = resolve(root, "src/shared/dom-names.generated.ts");

const names = (symbols: readonly { name: string }[]) => symbols.map((s) => s.name);

const setLiteral = (list: readonly string[]) =>
  ["new Set([", ...[...new Set(list)].toSorted().map((name) => `  "${name}",`), "])"].join("\n");

const api = new API({ cwd: root });
try {
  const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
  if (!project) throw new Error(`${config} を読み込めません。`);
  const { checker } = project;
  const location = { document: import.meta.filename, position: 0 };

  const members = (name: string) => {
    const symbol = checker.resolveName(name, SymbolFlags.Type, location);
    if (!symbol) throw new Error(`DOM の型定義に ${name} がありません。`);
    return checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol));
  };
  const methods = (name: string) =>
    names(members(name).filter((s) => (s.flags & SymbolFlags.Method) !== 0));

  const htmlElement = names(members("HTMLElement"));
  const structural = [
    ...names(members("EventTarget")),
    ...methods("Node"),
    ...methods("ChildNode"),
    ...methods("ParentNode"),
    ...names(members("Element")).filter((name) => name.includes("Attribute")),
    "attachShadow",
    "shadowRoot",
  ];

  writeFileSync(
    output,
    [
      "// scripts/generate-dom-names.ts が生成する。手動で編集しない。",
      "",
      "/** `HTMLElement` のメンバーの名前。継承したメンバーを含む。 */",
      `export const htmlElementMembers: ReadonlySet<string> = ${setLiteral(htmlElement)};`,
      "",
      "/** ノードの構造、属性、イベント、Shadow DOM を操作する、`HTMLElement` のメンバーの名前。 */",
      `export const structuralMembers: ReadonlySet<string> = ${setLiteral(structural)};`,
      "",
    ].join("\n"),
  );
} finally {
  api.close();
}
