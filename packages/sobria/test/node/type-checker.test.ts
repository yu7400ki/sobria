import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTypeChecker, type TypeChecker } from "../../src/build/type-checker.ts";

const fixture = resolve(import.meta.dirname, "../fixtures/type-checker");
const config = join(fixture, "tsconfig.json");

let checker: TypeChecker;
let count = 0;

beforeAll(() => {
  checker = createTypeChecker({ config });
});

afterAll(() => {
  checker.close();
});

/** `code` の中の、`export default function` で宣言した要素の関数の名前の位置を返す。 */
const nameAt = (code: string) => code.search(/(?<=export default function )\w/);

/** `code` を、ディスクに無い要素のファイルとして、要素の関数の第 1 引数の型を解析する。 */
function analyze(code: string, dir = fixture) {
  const file = join(dir, `element-${count++}.tsx`).replaceAll("\\", "/");
  return checker.param(file, code, nameAt(code));
}

/** `code` を解析し、インデックスシグネチャが無いことを確認して、props の名前ごとの分類を返す。 */
function kinds(code: string, dir = fixture): Record<string, string> {
  const result = analyze(code, dir);
  expect(result?.indexed).toBe(false);
  return Object.fromEntries((result?.props ?? []).map(({ name, kind }) => [name, kind]));
}

describe("createTypeChecker", () => {
  it("第 1 引数が無い要素の関数は、props を空にする", () => {
    expect(analyze("export default function X() { return null; }")).toEqual({
      props: [],
      indexed: false,
    });
  });

  it("プリミティブ、関数、オブジェクト、スロットの型を分類する", () => {
    expect(
      kinds(`import type { Slot } from "sobria";
export default function X(props: {
  text: string; count: number; open: boolean; onSelect: (value: string) => void;
  method(): void; data: { id: string }; list: string[]; when: Date;
  icon: Slot; label: JSX.Element; children?: JSX.Element; get size(): number;
}) { return null; }`),
    ).toEqual({
      text: "string",
      count: "number",
      open: "boolean",
      onSelect: "function",
      method: "function",
      data: "object",
      list: "object",
      when: "object",
      icon: "slot",
      label: "slot",
      children: "slot",
      size: "number",
    });
  });

  it("リテラル型、enum、テンプレートのリテラル型を、string、number、boolean に分類する", () => {
    expect(
      kinds(`enum Mode { A = "a", B = "b" }
enum Level { Low, High }
export default function X(props: {
  variant: "a" | "b"; size: 1 | 2; on: true; mode: Mode; level: Level; width: \`\${number}px\`;
}) { return null; }`),
    ).toEqual({
      variant: "string",
      size: "number",
      on: "boolean",
      mode: "string",
      level: "number",
      width: "string",
    });
  });

  it("ユニオン型は、undefined と null を除外した要素の分類が 1 つに揃えばその分類に、混在するか要素が残らなければ unknown にする", () => {
    expect(
      kinds(`export default function X(props: {
  a?: string; b: number | null; c: string | number; d: string | boolean; e: undefined | null;
  f: (() => void) | undefined; g: unknown; h: any; i: bigint; j: symbol;
}) { return null; }`),
    ).toEqual({
      a: "string",
      b: "number",
      c: "unknown",
      d: "unknown",
      e: "unknown",
      f: "function",
      g: "unknown",
      h: "unknown",
      i: "unknown",
      j: "unknown",
    });
  });

  it("呼び出しのシグネチャとプロパティを両方持つ型と、object と、オブジェクトの交差型は、オブジェクトに分類する", () => {
    expect(
      kinds(`interface Handler { (): void }
export default function X(props: {
  a: Handler; b: { (): void; x: number }; c: object; d: { x: 1 } & { y: 2 };
}) { return null; }`),
    ).toEqual({ a: "function", b: "object", c: "object", d: "object" });
  });

  it("プリミティブの型を含む交差型は、そのプリミティブの分類にする", () => {
    expect(
      kinds(`export default function X(props: {
  id: string & { readonly brand: "id" }; count: number & {}; on: boolean & { x?: 1 };
}) { return null; }`),
    ).toEqual({ id: "string", count: "number", on: "boolean" });
  });

  it("型パラメータは、制約の型で分類し、制約が無ければ unknown にする", () => {
    expect(
      kinds(`export default function X<T extends string, U, V extends { a: 1 }>(props: {
  t: T; u: U; v: V;
}) { return null; }`),
    ).toEqual({ t: "string", u: "unknown", v: "object" });
  });

  it("型パラメータを持つ type の別名、負の数、タプル、別名で import した Slot を分類する", () => {
    expect(
      kinds(`import type { Slot as S } from "sobria";
type Id<T> = T;
type Box<T> = { value: T };
export default function X(props: {
  a: Id<string>; b: Box<number>; c: -1 | 1; d: [number, string]; e: string | { a: 1 }; f: S;
}) { return null; }`),
    ).toEqual({ a: "string", b: "object", c: "number", d: "object", e: "unknown", f: "slot" });
  });

  it("名前が children の props は、型によらずスロットに分類する", () => {
    expect(
      kinds("export default function X(props: { children: string }) { return null; }"),
    ).toEqual({ children: "slot" });
  });

  it("引数の型から undefined と null を除外して解析する", () => {
    expect(analyze("export default function X(props?: { a: string }) { return null; }")).toEqual({
      props: [{ name: "a", kind: "string" }],
      indexed: false,
    });
    expect(
      analyze("export default function X(props: { a: number } | null) { return null; }"),
    ).toEqual({ props: [{ name: "a", kind: "number" }], indexed: false });
  });

  it("引数の型が、オブジェクトの型でないときは、undefined を返す", () => {
    for (const type of ["unknown", "never", "string", "{ a: string } | { b: number }"]) {
      expect(analyze(`export default function X(props: ${type}) { return null; }`)).toBeUndefined();
    }
  });

  it("引数の型が any か、解決できない型なら、undefined を返す", () => {
    expect(analyze("export default function X(props: any) { return null; }")).toBeUndefined();
    expect(
      analyze(`import type { Base } from "./missing.ts";
export default function X(props: Base & { z: string }) { return null; }`),
    ).toBeUndefined();
  });

  it("別のファイルから import した型、交差型、Pick、extends を持つ interface を解決する", async () => {
    const dir = await mkdtemp(join(fixture, "import-"));
    try {
      await writeFile(
        join(dir, "shared.ts"),
        `export interface Base { id: string; count: number; tags: string[] }
export type Size = "s" | "m";
export interface Extended extends Base { open: boolean }`,
      );
      expect(
        kinds(
          `import type { Props } from "sobria";
import type { Base, Extended, Size } from "./shared.ts";
type P = Props<Pick<Base, "id" | "count"> & { size?: Size; extended: Extended }>;
export default function X(props: P) { return null; }`,
          dir,
        ),
      ).toEqual({ id: "string", count: "number", size: "string", extended: "object" });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("import した型のファイルの変更を通知すると、変更後の型で分類する", async () => {
    const dir = await mkdtemp(join(fixture, "changed-"));
    const shared = join(dir, "shared.ts").replaceAll("\\", "/");
    const file = join(dir, "element.tsx").replaceAll("\\", "/");
    const code = `import type { Base } from "./shared.ts";
export default function X(props: Base) { return null; }`;
    try {
      await writeFile(shared, "export interface Base { value: number }");
      expect(checker.param(file, code, nameAt(code))?.props).toEqual([
        { name: "value", kind: "number" },
      ]);
      await writeFile(shared, "export interface Base { value: string }");
      checker.notify({ changed: [shared] });
      expect(checker.param(file, code, nameAt(code))?.props).toEqual([
        { name: "value", kind: "string" },
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("import されるファイルの作成を通知すると、要素の props を作成したファイルの型で分類する", async () => {
    const dir = await mkdtemp(join(fixture, "created-"));
    const shared = join(dir, "shared.ts").replaceAll("\\", "/");
    const file = join(dir, "element.tsx").replaceAll("\\", "/");
    const code = `import type { Base } from "./shared.ts";
export default function X(props: Base) { return null; }`;
    try {
      expect(checker.param(file, code, nameAt(code))).toBeUndefined();
      await writeFile(shared, "export interface Base { value: number }");
      checker.notify({ created: [shared] });
      expect(checker.param(file, code, nameAt(code))?.props).toEqual([
        { name: "value", kind: "number" },
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("要素のファイルの削除の通知で中身が空の型のファイルを読み込んだ後でも、型のファイルの作成を通知すると、要素の props を型のファイルの型で分類する", async () => {
    const dir = await mkdtemp(join(fixture, "created-early-"));
    const shared = join(dir, "shared.ts").replaceAll("\\", "/");
    const other = join(dir, "other.tsx").replaceAll("\\", "/");
    const file = join(dir, "element.tsx").replaceAll("\\", "/");
    const otherCode = "export default function O(props: { a: string }) { return null; }";
    const code = `import type { Base } from "./shared.ts";
export default function X(props: Base) { return null; }`;
    try {
      checker.param(other, otherCode, nameAt(otherCode));
      expect(checker.param(file, code, nameAt(code))).toBeUndefined();
      await writeFile(shared, "");
      // 要素のファイルの削除の通知でプログラムを作り直すと、型チェッカーは空の shared.ts を読み込む
      checker.notify({ deleted: [other] });
      await writeFile(shared, "export interface Base { value: number }");
      expect(checker.notify({ created: [shared] })).toEqual([file]);
      expect(checker.param(file, code, nameAt(code))?.props).toEqual([
        { name: "value", kind: "number" },
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("通知を反映すると、解析した要素のファイルのうち、解析の結果が変わったファイルを返す", async () => {
    const dir = await mkdtemp(join(fixture, "notified-"));
    const shared = join(dir, "shared.ts").replaceAll("\\", "/");
    const changed = join(dir, "changed.tsx").replaceAll("\\", "/");
    const kept = join(dir, "kept.tsx").replaceAll("\\", "/");
    const code = `import type { Base } from "./shared.ts";
export default function X(props: Base) { return null; }`;
    const keptCode = "export default function Y(props: { a: string }) { return null; }";
    try {
      await writeFile(shared, "export interface Base { value: number }");
      checker.param(changed, code, nameAt(code));
      checker.param(kept, keptCode, nameAt(keptCode));
      await writeFile(shared, "export interface Base { value: string }");
      expect(checker.notify({ changed: [shared] })).toEqual([changed]);
      expect(checker.param(changed, code, nameAt(code))?.props).toEqual([
        { name: "value", kind: "string" },
      ]);
      expect(checker.notify({ changed: [shared] })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("describe に渡した要素のファイルの削除を通知すると、そのファイルに渡したコードの宣言を解決しない", async () => {
    const dir = await mkdtemp(join(fixture, "described-"));
    const owner = join(dir, "owner.tsx").replaceAll("\\", "/");
    const file = join(dir, "element.tsx").replaceAll("\\", "/");
    const ownerCode = `declare global { interface DescribedGlobal { a: number } }
export default function O(props: { b: string }) { return null; }`;
    const code = "export default function X(props: DescribedGlobal) { return null; }";
    try {
      await writeFile(owner, ownerCode);
      checker.describe(owner, ownerCode, nameAt(ownerCode));
      expect(checker.param(file, code, nameAt(code))?.props).toEqual([
        { name: "a", kind: "number" },
      ]);
      await rm(owner);
      checker.notify({ deleted: [owner] });
      expect(checker.param(file, code, nameAt(code))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("パスの区切りが \\ でも / でも、同じファイルとして扱う", () => {
    const owner = join(fixture, "separated-owner.tsx").replaceAll("\\", "/");
    const file = join(fixture, "separated-element.tsx").replaceAll("\\", "/");
    const ownerCode = `declare global { interface SeparatedGlobal { a: number } }
export default function O(props: { b: string }) { return null; }`;
    const code = "export default function X(props: SeparatedGlobal) { return null; }";
    checker.param(owner.replaceAll("/", "\\"), ownerCode, nameAt(ownerCode));
    expect(checker.param(file, code, nameAt(code))?.props).toEqual([{ name: "a", kind: "number" }]);
    checker.notify({ deleted: [owner] });
    expect(checker.param(file, code, nameAt(code))).toBeUndefined();
  });

  it("解析したファイルの削除を通知すると、そのファイルから import した Props の型を解決しない", async () => {
    const dir = await mkdtemp(join(fixture, "removed-"));
    const shared = join(dir, "shared.tsx").replaceAll("\\", "/");
    const file = join(dir, "element.tsx").replaceAll("\\", "/");
    const sharedCode = `export interface Base { value: number }
export default function S(props: Base) { return null; }`;
    const code = `import type { Base } from "./shared.tsx";
export default function X(props: Base) { return null; }`;
    try {
      await writeFile(shared, sharedCode);
      checker.param(shared, sharedCode, nameAt(sharedCode));
      expect(checker.param(file, code, nameAt(code))?.props).toEqual([
        { name: "value", kind: "number" },
      ]);
      await rm(shared);
      checker.notify({ deleted: [shared] });
      expect(checker.param(file, code, nameAt(code))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("解析したファイルを削除して作り直すと、作り直したディスクの内容で型を解決する", async () => {
    const dir = await mkdtemp(join(fixture, "recreated-"));
    const shared = join(dir, "shared.tsx").replaceAll("\\", "/");
    const file = join(dir, "element.tsx").replaceAll("\\", "/");
    const sharedCode = `export interface Base { value: number }
export default function S(props: Base) { return null; }`;
    const code = `import type { Base } from "./shared.tsx";
export default function X(props: Base) { return null; }`;
    try {
      await writeFile(shared, sharedCode);
      checker.param(shared, sharedCode, nameAt(sharedCode));
      expect(checker.param(file, code, nameAt(code))?.props).toEqual([
        { name: "value", kind: "number" },
      ]);
      await rm(shared);
      checker.notify({ deleted: [shared] });
      const recreated = sharedCode.replace("number", "string");
      await writeFile(shared, recreated);
      checker.notify({ created: [shared] });
      expect(checker.param(file, code, nameAt(code))?.props).toEqual([
        { name: "value", kind: "string" },
      ]);
      const solo = join(dir, "solo.tsx").replaceAll("\\", "/");
      await writeFile(solo, sharedCode);
      checker.param(solo, sharedCode, nameAt(sharedCode));
      await rm(solo);
      checker.notify({ deleted: [solo] });
      await writeFile(solo, recreated);
      checker.notify({ created: [solo] });
      expect(checker.param(solo, recreated, nameAt(recreated))?.props).toEqual([
        { name: "value", kind: "string" },
      ]);
      await rm(shared);
      checker.notify({ deleted: [shared] });
      checker.notify({ created: [shared] });
      expect(checker.param(file, code, nameAt(code))).toBeUndefined();
      await writeFile(shared, sharedCode);
      checker.notify({ created: [shared] });
      expect(checker.param(file, code, nameAt(code))?.props).toEqual([
        { name: "value", kind: "number" },
      ]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("同じファイルの内容が変わると、新しい内容で解析する", () => {
    const file = join(fixture, "edited.tsx").replaceAll("\\", "/");
    const before = "export default function X(props: { a: string }) { return null; }";
    const after = "export default function X(props: { a: number; b: boolean }) { return null; }";
    expect(checker.param(file, before, nameAt(before))?.props).toEqual([
      { name: "a", kind: "string" },
    ]);
    expect(checker.param(file, after, nameAt(after))?.props).toEqual([
      { name: "a", kind: "number" },
      { name: "b", kind: "boolean" },
    ]);
  });

  it("位置は、UTF-16 の単位で数える", () => {
    expect(
      kinds(`// 日本語のコメント 🎉
export default function X(props: { a: string }) { return null; }`),
    ).toEqual({ a: "string" });
  });

  it("インデックスシグネチャを持つ型を報告する", () => {
    const file = join(fixture, "indexed.tsx").replaceAll("\\", "/");
    const code = "export default function X(props: Record<string, string>) { return null; }";
    expect(checker.param(file, code, nameAt(code))).toEqual({ props: [], indexed: true });
  });
});
