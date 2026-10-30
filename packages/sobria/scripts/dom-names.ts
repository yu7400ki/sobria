// TypeScript の DOM の型定義から、props と expose に使用できない名前の一覧の内容を作成する。
import { resolve } from "node:path";

import { API, SymbolFlags } from "typescript/sync";

const root = resolve(import.meta.dirname, "..");

/** ノードの構造を変更するメソッドの名前を列挙する。DOM の型定義に無い名前があれば、生成は失敗する。 */
const mutatingMethods = [
  "after",
  "append",
  "appendChild",
  "before",
  "insertAdjacentElement",
  "insertAdjacentHTML",
  "insertAdjacentText",
  "insertBefore",
  "moveBefore",
  "normalize",
  "prepend",
  "remove",
  "removeChild",
  "replaceChild",
  "replaceChildren",
  "replaceWith",
  "setHTML",
  "setHTMLUnsafe",
];

const names = (symbols: readonly { name: string }[]) => symbols.map((s) => s.name);

const arrayLiteral = (list: readonly string[]) =>
  ["[", ...[...new Set(list)].toSorted().map((name) => `  "${name}",`), "] as const"].join("\n");

const file = (doc: string, name: string, list: readonly string[]) =>
  [
    "// pnpm --filter sobria generate で生成する。手動で編集しない。",
    "",
    `/** ${doc} */`,
    `export const ${name} = ${arrayLiteral(list)};`,
    "",
  ].join("\n");

/** 生成するファイルごとに、パッケージからの相対パスと内容を返す。 */
export function domNameSources(): Record<string, string> {
  const config = resolve(root, "scripts/tsconfig.dom.json");
  const api = new API({ cwd: root });
  try {
    const project = api.createSnapshot({ openProjects: [config] }).getConfiguredProject(config);
    if (!project) throw new Error(`${config} を読み込めません。`);
    const { checker } = project;
    const location = { document: resolve(root, "scripts/dom-names.ts"), position: 0 };
    const members = (name: string) => {
      const symbol = checker.resolveName(name, SymbolFlags.Type, location);
      if (!symbol) throw new Error(`DOM の型定義に ${name} がありません。`);
      return names(checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol)));
    };
    const element = members("HTMLElement");
    const required = (list: readonly string[]) => {
      const missing = list.filter((name) => !element.includes(name));
      if (missing.length > 0) {
        throw new Error(`HTMLElement に ${missing.join("、")} がありません。`);
      }
      return list;
    };
    return {
      "src/shared/html-element-members.generated.ts": file(
        "`HTMLElement` のメンバーの名前を列挙する。`Object` から継承したメンバーも含む。",
        "htmlElementMembers",
        [...element, ...members("Object"), "__proto__"],
      ),
      "src/shared/structural-members.generated.ts": file(
        "`HTMLElement` のメンバーのうち、ノードの構造、属性、イベント、Shadow DOM、ElementInternals を操作するものの名前を列挙する。",
        "structuralMembers",
        [
          ...members("EventTarget"),
          ...required(mutatingMethods),
          ...members("Element").filter((name) => name.includes("Attribute")),
          ...required(["attachShadow", "shadowRoot", "attachInternals"]),
        ],
      ),
    };
  } finally {
    api.close();
  }
}
