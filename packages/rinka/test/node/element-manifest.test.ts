import { describe, expect, it } from "vitest";

import { describeElement, manifestOf } from "../../src/build/element-manifest.ts";
import { CompileError } from "../../src/build/errors.ts";

/** `src/elements/card.tsx` の `<x-card>` として `code` を記述する。 */
const describeCard = (code: string) =>
  describeElement(code, { tag: "x-card", file: "src/elements/card.tsx" });

describe("要素の記述", () => {
  it("要素の関数の名前と JSDoc から、名前と説明と非推奨を記述する", () => {
    const declaration = describeCard(`
/**
 * 利用者の情報を表示する。
 *
 * 2 行目の説明である。
 * @summary 利用者のカード
 * @deprecated x-profile を使用する
 */
export default function Card() {
  return <div />;
}`);
    expect(declaration).toEqual({
      kind: "class",
      customElement: true,
      tagName: "x-card",
      name: "Card",
      summary: "利用者のカード",
      description: "利用者の情報を表示する。\n\n2 行目の説明である。",
      deprecated: "x-profile を使用する",
    });
  });

  it("属性で受け取る props を、属性とフィールドに記述し、属性の名前を kebab-case にする", () => {
    const { attributes, members } = describeCard(`
type Props = {
  /** 利用者の ID である。 */
  userId: number;
  label?: string;
  open: boolean;
  tone: "light" | "dark";
  value: string | number;
};
export default function Card(props: Props) {
  return <div />;
}`);
    expect(attributes).toEqual([
      {
        name: "user-id",
        fieldName: "userId",
        type: { text: "number" },
        description: "利用者の ID である。",
      },
      { name: "label", fieldName: "label", type: { text: "string" } },
      { name: "open", fieldName: "open", type: { text: "boolean" } },
      { name: "tone", fieldName: "tone", type: { text: '"light" | "dark"' } },
      { name: "value", fieldName: "value", type: { text: "string | number" } },
    ]);
    expect(members).toEqual([
      {
        kind: "field",
        name: "userId",
        type: { text: "number" },
        description: "利用者の ID である。",
      },
      { kind: "field", name: "label", type: { text: "string" } },
      { kind: "field", name: "open", type: { text: "boolean" } },
      { kind: "field", name: "tone", type: { text: '"light" | "dark"' } },
      { kind: "field", name: "value", type: { text: "string | number" } },
    ]);
  });

  it("onX の関数の props を、detail の型を持つ CustomEvent のイベントとフィールドに記述する", () => {
    const { events, members, attributes } = describeCard(`
type Props = {
  /** いいねを押したときに呼ぶ。 */
  onLikeClick?: (count: number) => void;
  onClose: () => void;
  onPick(item?: string): void;
  onMaybe: (value: number | undefined) => void;
};
export default function Card(props: Props) {
  return <div />;
}`);
    expect(attributes).toBeUndefined();
    expect(events).toEqual([
      {
        name: "like-click",
        type: { text: "CustomEvent<number>" },
        description: "いいねを押したときに呼ぶ。",
      },
      { name: "close", type: { text: "CustomEvent<null>" } },
      { name: "pick", type: { text: "CustomEvent<string | null>" } },
      { name: "maybe", type: { text: "CustomEvent<number | null>" } },
    ]);
    expect(members).toEqual([
      {
        kind: "field",
        name: "onLikeClick",
        type: { text: "(count: number) => void" },
        description: "いいねを押したときに呼ぶ。",
      },
      { kind: "field", name: "onClose", type: { text: "() => void" } },
      { kind: "field", name: "onPick", type: { text: "(item?: string) => void" } },
      { kind: "field", name: "onMaybe", type: { text: "(value: number | undefined) => void" } },
    ]);
  });

  it("ほかの関数とオブジェクトの props は、フィールドだけに記述する", () => {
    const { events, members, attributes } = describeCard(`
type Props = { format: (value: number) => string; items: string[] };
export default function Card(props: Props) {
  return <div />;
}`);
    expect(attributes).toBeUndefined();
    expect(events).toBeUndefined();
    expect(members).toEqual([
      { kind: "field", name: "format", type: { text: "(value: number) => string" } },
      { kind: "field", name: "items", type: { text: "string[]" } },
    ]);
  });

  it("スロットの props をスロットに記述し、children の名前を空文字列にする", () => {
    const { slots, members } = describeCard(`
import type { Slot } from "rinka";
type Props = {
  /** 本文である。 */
  children?: JSX.Element;
  /** 見出しである。 */
  header?: Slot;
};
export default function Card(props: Props) {
  return <div>{props.header}{props.children}</div>;
}`);
    expect(slots).toEqual([
      { name: "", description: "本文である。" },
      { name: "header", description: "見出しである。" },
    ]);
    expect(members).toBeUndefined();
  });

  it("Ctx<M> の M のメソッドとプロパティをメソッドに、getter と setter をフィールドに記述する", () => {
    const { members } = describeCard(`
import type { Ctx } from "rinka";
interface Methods {
  /** ダイアログを開く。 */
  open(reason?: string): void;
  close: () => Promise<void>;
  get value(): number;
  set label(text: string);
}
export default function Card(props: {}, { expose }: Ctx<Methods>) {
  return <div />;
}`);
    expect(members).toEqual([
      {
        kind: "method",
        name: "open",
        parameters: [{ name: "reason", type: { text: "string" }, optional: true }],
        return: { type: { text: "void" } },
        description: "ダイアログを開く。",
      },
      {
        kind: "method",
        name: "close",
        parameters: [],
        return: { type: { text: "Promise<void>" } },
      },
      { kind: "field", name: "value", type: { text: "number" }, readonly: true },
      { kind: "field", name: "label", type: { text: "string" } },
    ]);
  });

  it("ネイティブ要素に文字列で記述した part を、CSS の part に記述する", () => {
    const { cssParts } = describeCard(`
export default function Card() {
  return (
    <div part="frame">
      <span part="label badge" />
      <p part={name} />
      <span part="label" />
    </div>
  );
}`);
    expect(cssParts).toEqual([{ name: "frame" }, { name: "label" }, { name: "badge" }]);
  });

  it("要素の関数の JSDoc の @cssprop を、CSS のカスタムプロパティに記述する", () => {
    const { cssProperties } = describeCard(`
/**
 * @cssprop --card-color - 文字の色である。
 * @cssprop [--card-gap=8px] - 余白である。
 * @cssprop --card-radius
 */
export default function Card() {
  return <div />;
}`);
    expect(cssProperties).toEqual([
      { name: "--card-color", description: "文字の色である。" },
      { name: "--card-gap", default: "8px", description: "余白である。" },
      { name: "--card-radius" },
    ]);
  });

  it("フォームの部品には、name と disabled の属性を記述する", () => {
    const { attributes } = describeCard(`
import type { Ctx } from "rinka";
type Props = { max?: number };
export default function Card(props: Props, { form }: Ctx) {
  form.value(() => "");
  return <div />;
}`);
    expect(attributes).toEqual([
      { name: "max", fieldName: "max", type: { text: "number" } },
      { name: "name", fieldName: "name", type: { text: "string" } },
      { name: "disabled", fieldName: "disabled", type: { text: "boolean" } },
    ]);
  });

  it("フォームの部品が Props の型に name か disabled を記述していれば、その属性を 1 つだけ記述する", () => {
    const { attributes } = describeCard(`
import type { Ctx } from "rinka";
type Props = { name?: string };
export default function Card(props: Props, { form }: Ctx) {
  form.value(() => "");
  return <div />;
}`);
    expect(attributes).toEqual([
      { name: "name", fieldName: "name", type: { text: "string" } },
      { name: "disabled", fieldName: "disabled", type: { text: "boolean" } },
    ]);
  });

  it("detail の型を、getter と setter と、同じファイルの type の関数型からも算出する", () => {
    const { events } = describeCard(`
type Handler = (id: string) => void;
type Props = {
  get onOpen(): (count: number) => void;
  set onShut(fn: (reason: string) => void);
  onSelect: Handler;
};
export default function Card(props: Props) {
  return <div />;
}`);
    expect(events).toEqual([
      { name: "open", type: { text: "CustomEvent<number>" } },
      { name: "shut", type: { text: "CustomEvent<string>" } },
      { name: "select", type: { text: "CustomEvent<string>" } },
    ]);
  });

  it("detail の型は、null を重ねず、括弧と残余引数を DetailOf と同じ規則で扱う", () => {
    const { events } = describeCard(`
type Props = {
  onA: (value: string | null | undefined) => void;
  onB: (value?: string | null) => void;
  onC: (value: (string | undefined)) => void;
  onD: (...values: number[]) => void;
};
export default function Card(props: Props) {
  return <div />;
}`);
    expect(events?.map(({ type }) => type.text)).toEqual([
      "CustomEvent<string | null>",
      "CustomEvent<string | null>",
      "CustomEvent<string | null>",
      "CustomEvent<number>",
    ]);
  });

  it("detail の型は、undefined だけの引数と、同じファイルの type と、呼び出しのシグネチャの interface も扱う", () => {
    const { events } = describeCard(`
type Maybe = string | undefined;
type Plain = string;
interface Handler {
  (count: number): void;
}
type Props = {
  onA: (value: undefined) => void;
  onB: (value: Maybe) => void;
  onC: (value: Plain) => void;
  onD: Handler;
};
export default function Card(props: Props) {
  return <div />;
}`);
    expect(events?.map(({ type }) => type.text)).toEqual([
      "CustomEvent<null>",
      "CustomEvent<string | null>",
      "CustomEvent<Plain>",
      "CustomEvent<number>",
    ]);
  });

  it("Ctx<object> の要素は、公開するメンバーを記述しない", () => {
    const { members } = describeCard(`
import type { Ctx } from "rinka";
export default function Card(props: {}, ctx: Ctx<object>) {
  return <div />;
}`);
    expect(members).toBeUndefined();
  });

  it("Ctx<M> の M が、型リテラルでも同じファイルの type と interface の名前でもなければ、ビルドのエラーにする", () => {
    expect(() =>
      describeCard(`
import type { Ctx } from "rinka";
import type { Methods } from "./methods.ts";
export default function Card(props: {}, { expose }: Ctx<Methods>) {
  return <div />;
}`),
    ).toThrow("Ctx<M> の M には");
  });

  it("@cssprop の {構文} を、CSS のカスタムプロパティの構文に記述する", () => {
    const { cssProperties } = describeCard(`
/** @cssprop {<color>} --card-color - 文字の色である。 */
export default function Card() {
  return <div />;
}`);
    expect(cssProperties).toEqual([
      { name: "--card-color", syntax: "<color>", description: "文字の色である。" },
    ]);
  });

  it("要素のファイルの形が誤っていれば、ビルドのエラーにする", () => {
    expect(() => describeCard("export default () => <div />;")).toThrow(CompileError);
  });
});

describe("マニフェスト", () => {
  it("要素ごとに、自分自身を登録するモジュールと、タグ名の定義を記述する", () => {
    expect(
      manifestOf([
        {
          tag: "x-card",
          file: "src/elements/card.tsx",
          code: "export default function Card() { return <div />; }",
          path: "dist/x-card.js",
        },
      ]),
    ).toEqual({
      schemaVersion: "2.1.0",
      modules: [
        {
          kind: "javascript-module",
          path: "dist/x-card.js",
          declarations: [{ kind: "class", customElement: true, tagName: "x-card", name: "Card" }],
          exports: [
            {
              kind: "custom-element-definition",
              name: "x-card",
              declaration: { name: "Card", module: "dist/x-card.js" },
            },
          ],
        },
      ],
    });
  });
});
