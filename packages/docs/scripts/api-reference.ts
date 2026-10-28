// rinka の型定義とドキュメントコメントから、API のリファレンスの MDX を作成する。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { format, type Oxfmtrc } from "oxfmt";
import { type Node, SyntaxKind } from "typescript/ast";
import {
  isExportDeclaration,
  isExportSpecifier,
  isStringLiteral,
  isTypeQueryNode,
} from "typescript/ast/is";
import { API, type Checker, type Symbol, SymbolFlags } from "typescript/sync";

const root = resolve(import.meta.dirname, "..");

/** 型定義を適用するファイルの種類である。要素のファイルは、サーバーで描画するときも要素の型定義で型を検査する。 */
type Side = "要素のファイル" | "サーバーのファイル";

/** package.json の exports の条件のうち、型定義を適用するファイルの種類を表すものである。 */
const conditionSides: Readonly<Record<string, Side>> = {
  "rinka-server": "サーバーのファイル",
  "rinka-client": "要素のファイル",
};

/** API のページを作成しないエントリーポイントである。JSX の型は、手で記述するリファレンスのページで扱う。 */
const excludedSubpaths = new Set(["./jsx-runtime"]);

/** エントリーポイントの 1 つの型定義である。`side` は、条件で環境を区別しないときに `undefined` である。 */
interface Source {
  readonly side: Side | undefined;
  readonly path: string;
}

/** API のページを作成するエントリーポイントである。 */
interface Entry {
  readonly specifier: string;
  readonly slug: string;
  readonly sources: readonly Source[];
}

/** 1 つの環境での、export の説明と宣言である。`code` の最初の要素は export の宣言で、残りは宣言が参照する型の宣言である。 */
interface Variant {
  readonly side: Side | undefined;
  readonly doc: string;
  readonly code: readonly [string, ...string[]];
}

/** 1 つの export の内容である。ほかのパッケージから再 export した値は、`from` に再 export の元のモジュールの指定子を持つ。 */
type Item =
  | { readonly kind: "external"; readonly name: string; readonly from: string }
  | { readonly kind: "local"; readonly name: string; readonly variants: readonly Variant[] };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** package.json の exports の 1 つの値から、型定義の一覧を作成する。型定義が無ければ空の配列を返す。 */
function sourcesOf(subpath: string, value: unknown): Source[] {
  if (!isRecord(value) || typeof value.types !== "string") return [];
  const conditional = Object.entries(value).flatMap(([condition, nested]): Source[] => {
    if (!isRecord(nested)) return [];
    const side = conditionSides[condition];
    if (side === undefined) throw new Error(`${subpath} の条件 ${condition} の環境が不明です。`);
    return typeof nested.types === "string" ? [{ side, path: nested.types }] : [];
  });
  if (conditional.length > 1) throw new Error(`${subpath} の条件が 2 つ以上あります。`);
  // 条件が無い型定義は、条件の環境と異なる種類のファイルに適用する。
  const side: Side | undefined =
    conditional[0]?.side === "サーバーのファイル"
      ? "要素のファイル"
      : conditional[0]?.side === "要素のファイル"
        ? "サーバーのファイル"
        : undefined;
  return [{ side, path: value.types }, ...conditional];
}

/** パッケージのディレクトリ `packageDir` の package.json の exports から、API のページを作成するエントリーポイントを列挙する。 */
export function entriesOf(packageDir: string): Entry[] {
  const pkg: unknown = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
  if (!isRecord(pkg) || typeof pkg.name !== "string" || !isRecord(pkg.exports)) {
    throw new Error(`${packageDir} の package.json に name と exports がありません。`);
  }
  const { name } = pkg;
  return Object.entries(pkg.exports).flatMap(([subpath, value]): Entry[] => {
    if (excludedSubpaths.has(subpath)) return [];
    const sources = sourcesOf(subpath, value);
    if (sources.length === 0) return [];
    const slug = subpath === "." ? name : subpath.slice(2);
    return [{ specifier: `${name}${subpath.slice(1)}`, slug, sources }];
  });
}

/** ドキュメントコメントの段落の中の改行を除去する。改行の前後がどちらも ASCII の印字可能な文字のときは、改行を空白にする。 */
function joinLines(doc: string): string {
  return doc
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .reduce((text, line) => {
          if (text === "") return line;
          return /[\x21-\x7e]$/.test(text) && /^[\x21-\x7e]/.test(line)
            ? `${text} ${line}`
            : `${text}${line}`;
        }, ""),
    )
    .join("\n\n");
}

/** インラインコードの外にある、MDX で JSX や式として解析される `<`、`{`、`}` と、文字参照の開始になる `&` を、文字参照にする。 */
function escapeMdx(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll("{", "&#123;")
            .replaceAll("}", "&#125;"),
    )
    .join("");
}

/** 宣言のノードのソースから、`export` と `declare` を除外する。変数の宣言には `const` を付与する。 */
function declarationCode(node: Node): string {
  const text = node
    .getText()
    .replace(/^export\s+/, "")
    .replace(/^declare\s+/, "");
  return node.kind === SyntaxKind.VariableDeclaration ? `const ${text};` : text;
}

/** 宣言が 2 つ以上あり、すべての宣言にドキュメントコメントがあれば、宣言ごとのコメントを段落にして返す。そうでなければ `undefined` を返す。 */
function overloadDocs(declarations: readonly Node[]): string | undefined {
  if (declarations.length < 2) return undefined;
  // コメントのソースから、`/**`、`*/`、行頭の `*` と、最初のタグ以降を除外する。
  const docs = declarations.map((declaration) => {
    const [jsDoc] = declaration.jsDoc ?? [];
    const lines = (jsDoc?.getText() ?? "")
      .replace(/^\/\*\*/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trim());
    const tag = lines.findIndex((line) => line.startsWith("@"));
    return lines
      .slice(0, tag === -1 ? undefined : tag)
      .join("\n")
      .trim();
  });
  return docs.every((doc) => doc !== "") ? docs.join("\n\n") : undefined;
}

/** 再 export の宣言 `node` の、元のモジュールの指定子を返す。 */
function moduleSpecifierOf(node: Node | undefined): string | undefined {
  const declaration = node && isExportSpecifier(node) ? node.parent.parent : undefined;
  return declaration && isExportDeclaration(declaration) && declaration.moduleSpecifier
    ? isStringLiteral(declaration.moduleSpecifier)
      ? declaration.moduleSpecifier.text
      : undefined
    : undefined;
}

/** `symbol` が別名なら、別名を解決したシンボルを返す。 */
const resolveAlias = (checker: Checker, symbol: Symbol): Symbol =>
  symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

/** パッケージの型定義から、宣言とドキュメントコメントを読み取る。 */
class Reader {
  private readonly checker: Checker;
  /** パッケージのディレクトリのパスに、末尾の `/` を付与したものである。 */
  private readonly packagePrefix: string;
  /** すべてのエントリーポイントが export する値と型の、別名を解決したシンボルの ID である。 */
  private readonly exported: ReadonlySet<number>;

  constructor(checker: Checker, packageDir: string, exported: ReadonlySet<number>) {
    this.checker = checker;
    this.packagePrefix = `${packageDir.replaceAll("\\", "/").replace(/\/$/, "")}/`;
    this.exported = exported;
  }

  /** ファイルがパッケージの型定義かどうかを返す。 */
  isPackageFile(file: string): boolean {
    return file.startsWith(this.packagePrefix);
  }

  resolve(symbol: Symbol): Symbol {
    return resolveAlias(this.checker, symbol);
  }

  /** 別名 `symbol` をたどり、パッケージの外の宣言を指す再 export の、元のモジュールの指定子を返す。パッケージの中の値なら `undefined` を返す。 */
  externalModule(symbol: Symbol): string | undefined {
    let current = symbol;
    while (current.flags & SymbolFlags.Alias) {
      const next = this.checker.getImmediateAliasedSymbol(current);
      const file = next?.declarations[0]?.resolve()?.getSourceFile().fileName;
      if (file !== undefined && !this.isPackageFile(file)) {
        const from = moduleSpecifierOf(current.declarations[0]?.resolve());
        if (from === undefined) throw new Error(`${symbol.name} の再 export の元が不明です。`);
        return from;
      }
      if (!next) return undefined;
      current = next;
    }
    return undefined;
  }

  /**
   * 宣言のノードの中で参照する型のうち、パッケージの型定義で宣言され、どのエントリーポイントも export しない型の宣言を、参照した順に収集する。
   * `typeof` で参照する、export しない const の宣言も収集する。`@internal` のタグを付与した型は、その型も、その中で参照する型も収集しない。
   */
  collectLocals(node: Node, seen: Set<number>, out: Node[]): void {
    const visit = (child: Node): void => {
      const symbol = this.checker.getSymbolAtLocation(child);
      const target = symbol && this.resolve(symbol);
      const local =
        target &&
        (target.flags & (SymbolFlags.Interface | SymbolFlags.TypeAlias) ||
          (target.flags & SymbolFlags.BlockScopedVariable && isTypeQueryNode(child.parent)));
      if (target && local && !this.exported.has(target.id) && !seen.has(target.id)) {
        seen.add(target.id);
        const internal = this.checker
          .getJsDocTagsOfSymbol(target)
          .some((tag) => tag.name === "internal");
        const declarations = target.declarations
          .map((handle) => handle.resolve())
          .filter((declaration) => declaration !== undefined)
          .filter((declaration) => this.isPackageFile(declaration.getSourceFile().fileName));
        if (!internal) {
          for (const declaration of declarations) {
            out.push(declaration);
            this.collectLocals(declaration, seen, out);
          }
        }
      }
      child.forEachChild(visit);
    };
    node.forEachChild(visit);
  }

  /** export の `symbol` を、環境 `side` での説明と宣言にする。 */
  item(side: Side | undefined, symbol: Symbol): Item {
    const from = this.externalModule(symbol);
    if (from !== undefined) return { kind: "external", name: symbol.name, from };
    const target = this.resolve(symbol);
    const tags = this.checker.getJsDocTagsOfSymbol(target).map((tag) => tag.name);
    if (tags.length > 0) {
      throw new Error(
        `${symbol.name} のドキュメントコメントのタグ ${tags.join("、")} は、リファレンスに出力できません。`,
      );
    }
    const declarations = target.declarations
      .map((handle) => handle.resolve())
      .filter((node) => node !== undefined);
    if (declarations.length === 0) throw new Error(`${symbol.name} の宣言がありません。`);
    const doc = overloadDocs(declarations) ?? this.checker.getDocumentationCommentOfSymbol(target);
    if (doc === "") throw new Error(`${symbol.name} にドキュメントコメントがありません。`);
    const locals: Node[] = [];
    const seen = new Set([target.id]);
    for (const declaration of declarations) this.collectLocals(declaration, seen, locals);
    const code: Variant["code"] = [
      declarations.map(declarationCode).join("\n\n"),
      ...locals.map(declarationCode),
    ];
    return { kind: "local", name: symbol.name, variants: [{ side, doc: joinLines(doc), code }] };
  }
}

/** 同じ名前の export の、環境ごとの内容を 1 つにまとめる。 */
function merge(a: Item, b: Item): Item {
  if (a.kind === "external" && b.kind === "external" && a.from === b.from) return a;
  if (a.kind === "local" && b.kind === "local") {
    return { ...a, variants: [...a.variants, ...b.variants] };
  }
  throw new Error(`${a.name} は、環境によって再 export の元が異なります。`);
}

/** 環境 `side` のラベルを返す。 */
function label(side: Side | undefined, name: string): string {
  if (side === undefined) throw new Error(`${name} の環境が不明です。`);
  return side;
}

/** 1 つの export の、見出しと本文の MDX である。`sideCount` は、エントリーポイントの環境の数である。 */
function itemMdx(item: Item, specifier: string, sideCount: number): string {
  const heading = `## ${item.name}`;
  if (item.kind === "external") {
    return `${heading}\n\n\`${item.from}\` の \`${item.name}\` を、\`${specifier}\` から再 export する。\n`;
  }
  const { variants } = item;
  const [first] = variants;
  if (!first) throw new Error(`${item.name} の宣言がありません。`);
  // 一部の環境にだけある export は、説明と宣言に環境を明記する。
  const complete = variants.length === sideCount;
  const docs =
    complete && variants.every((v) => v.doc === first.doc)
      ? escapeMdx(first.doc)
      : variants.map((v) => `- ${label(v.side, item.name)}：${escapeMdx(v.doc)}`).join("\n");
  if (complete && variants.every((v) => v.code.join() === first.code.join())) {
    return `${heading}\n\n${docs}\n\n\`\`\`ts\n${first.code.join("\n\n")}\n\`\`\`\n`;
  }
  // 宣言が参照する型の宣言は、前の環境で表示していれば、後の環境では表示しない。
  const shown = new Set<string>();
  const code = variants
    .map(({ side, code: [declaration, ...locals] }) => {
      const fresh = locals.filter((local) => !shown.has(local));
      for (const local of fresh) shown.add(local);
      return [`// ${label(side, item.name)}\n${declaration}`, ...fresh].join("\n\n");
    })
    .join("\n\n");
  return `${heading}\n\n${docs}\n\n\`\`\`ts\n${code}\n\`\`\`\n`;
}

/**
 * パッケージのディレクトリ `packageDir` の型定義を、`tsconfig` のプロジェクトで読み込み、エントリーポイントの slug ごとに、整形する前の MDX を返す。
 * export が無い型定義は、その環境ではエントリーポイントを使用できないものとして扱う。
 */
export function referenceSources(packageDir: string, tsconfig: string): Record<string, string> {
  const api = new API({ cwd: root });
  try {
    const project = api.createSnapshot({ openProjects: [tsconfig] }).getConfiguredProject(tsconfig);
    if (!project) throw new Error(`${tsconfig} を読み込めません。`);
    const { program, checker } = project;
    const modules = entriesOf(packageDir).map((entry) => ({
      entry,
      sources: entry.sources.flatMap(({ side, path }) => {
        const file = program.getSourceFile(resolve(packageDir, path));
        const module = file && checker.getSymbolAtLocation(file);
        if (!module) throw new Error(`${path} を読み込めません。`);
        const symbols = checker.getExportsOfModule(module);
        return symbols.length === 0 ? [] : [{ side, symbols }];
      }),
    }));
    const exported = new Set(
      modules.flatMap(({ sources }) =>
        sources.flatMap(({ symbols }) => symbols.map((symbol) => resolveAlias(checker, symbol).id)),
      ),
    );
    const reader = new Reader(checker, packageDir, exported);
    return Object.fromEntries(
      modules.map(({ entry, sources }) => {
        const items = new Map<string, Item>();
        for (const { side, symbols } of sources) {
          for (const symbol of symbols) {
            const item = reader.item(side, symbol);
            const previous = items.get(symbol.name);
            items.set(symbol.name, previous ? merge(previous, item) : item);
          }
        }
        const body = [...items.values()]
          .map((item) => itemMdx(item, entry.specifier, sources.length))
          .join("\n");
        const mdx = [
          "---",
          `title: ${entry.specifier}`,
          "---",
          "",
          "{/* pnpm --filter @rinka/docs generate で生成する。手動で編集しない。 */}",
          "",
          body,
        ].join("\n");
        return [entry.slug, mdx];
      }),
    );
  } finally {
    api.close();
  }
}

/** API のリファレンスの MDX を出力する、パッケージからの相対パスのディレクトリである。 */
export const apiReferenceDir = "src/content/reference/api";

/** リポジトリの oxfmt の設定のファイルを読み込む。 */
const readOxfmtrc = (): Oxfmtrc & { $schema?: string } =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  JSON.parse(readFileSync(resolve(root, "../../.oxfmtrc.json"), "utf8")) as Oxfmtrc & {
    $schema?: string;
  };

/** rinka の API のリファレンスの、パッケージからの相対パスと、リポジトリの oxfmt の設定で整形した内容を返す。 */
export async function apiReferenceSources(): Promise<Record<string, string>> {
  const { $schema: _, ignorePatterns: __, ...options } = readOxfmtrc();
  const sources = referenceSources(
    resolve(root, "node_modules/rinka"),
    resolve(root, "scripts/tsconfig.api.json"),
  );
  const formatted = await Promise.all(
    Object.entries(sources).map(async ([slug, content]) => {
      const path = `${apiReferenceDir}/${slug}.mdx`;
      const { code, errors } = await format(path, content, options);
      if (errors.length > 0) throw new Error(`${path} を整形できません: ${errors[0]?.message}`);
      return [path, code] as const;
    }),
  );
  return Object.fromEntries(formatted);
}
