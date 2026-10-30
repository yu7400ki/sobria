import {
  For,
  createContext,
  defineElement,
  Errored,
  type ClientNode,
  type Ctx,
  type ElementRef,
  type ServerNode,
  type SharedNode,
  type Slot,
} from "sobria";
import type { JSX } from "sobria/jsx-runtime";
import { expectTypeOf, test } from "vitest";

type DialogProps = { heading?: string; header?: Slot; children?: Slot };
const Dialog = defineElement("type-jsx-dialog", (_props: DialogProps) => null, {
  props: { heading: "unknown", header: "slot", children: "slot" },
});

function TextField(props: { label: string; ref?: (el: HTMLInputElement) => void }) {
  return (
    <label>
      {props.label}
      <input ref={props.ref} />
    </label>
  );
}

const Card = (_props: { title: string }) => null as unknown as SharedNode;
const ServerPart = (_props: { id: string }) => null as unknown as ServerNode;

test("要素は、Props、スロットの内容、ホストの属性、ElementRef を受け取る ref を受け付ける", () => {
  void (
    <Dialog
      heading="h"
      class="wide"
      header={<p />}
      ref={(el) => expectTypeOf(el.heading).toEqualTypeOf<string | undefined>()}
    >
      body
    </Dialog>
  );
});

test("要素の中で load:* を記述すると型エラーになる", () => {
  // @ts-expect-error load:* はサーバーのファイルでだけ記述できる
  void (<Dialog load:idle />);
});

test("補助コンポーネントは、Props に宣言した ref を受け付け、内側のタグに転送できる", () => {
  void (
    <TextField label="検索" ref={(el) => expectTypeOf(el).toEqualTypeOf<HTMLInputElement>()} />
  );
});

test("共通のコンポーネントには、ref とホストの属性を付与できない", () => {
  void (<Card title="t" />);
  // @ts-expect-error ホストの属性は付与できない
  void (<Card title="t" class="wide" />);
  // @ts-expect-error ref は付与できない
  void (<Card title="t" ref={() => {}} />);
});

test("要素の中でサーバーコンポーネントを使用すると型エラーになる", () => {
  // @ts-expect-error サーバーコンポーネントは要素の JSX に記述できない
  void (<ServerPart id="1" />);
});

test("要素の load:* は、記述できない理由を示すメッセージの型である", () => {
  expectTypeOf<
    JSX.LibraryManagedAttributes<typeof Dialog, DialogProps>["load:idle"]
  >().toEqualTypeOf<"load:* は、サーバーのファイルでだけ記述できます。要素の起動のタイミングは、要素を配置したページで指定してください。">();
});

test("要素には、Props に宣言していないイベントハンドラーを、ホストのリスナーとして付与できる", () => {
  void (
    <Dialog
      onClick={(event) =>
        expectTypeOf(event.currentTarget).toEqualTypeOf<ElementRef<typeof Dialog>>()
      }
    />
  );
});

test("要素の中の SVG と名前に - を含むタグは、タグの要素を受け取る ref とイベントハンドラーを受け付ける", () => {
  void (
    <svg
      ref={(el) => expectTypeOf(el).toEqualTypeOf<SVGSVGElement>()}
      onClick={(event) => expectTypeOf(event.currentTarget).toEqualTypeOf<SVGSVGElement>()}
    />
  );
  void (
    <custom-widget
      ref={(el) => expectTypeOf(el).toEqualTypeOf<HTMLElement>()}
      onClick={(event) => expectTypeOf(event.currentTarget).toEqualTypeOf<HTMLElement>()}
    />
  );
});

declare function Menu(props: { items: string[] }, ctx: Ctx<{ open(): void }>): ClientNode;

test("要素のファイルの default export と同じ形の関数は、ElementRef を受け取る ref とイベントハンドラーを受け付ける", () => {
  void (
    <Menu
      items={[]}
      ref={(el) => expectTypeOf(el).toEqualTypeOf<ElementRef<typeof Menu>>()}
      onClick={(event) => event.currentTarget.open()}
    />
  );
});

test("要素のファイルの default export と同じ形の関数の ElementRef は、expose したメソッドと props を持つ", () => {
  expectTypeOf<ElementRef<typeof Menu>["open"]>().toEqualTypeOf<() => void>();
  expectTypeOf<ElementRef<typeof Menu>["items"]>().toEqualTypeOf<string[]>();
});

function Choice(props: { ref?: (el: HTMLInputElement) => void; a: 1 } | { b: 2 }) {
  return <input ref={"ref" in props ? props.ref : undefined} />;
}

test("Props の union のどれかのメンバーに ref がある関数は、補助コンポーネントとして、Props の ref の型を受け付ける", () => {
  void (<Choice a={1} ref={(el) => expectTypeOf(el).toEqualTypeOf<HTMLInputElement>()} />);
});

test("要素は、Props の型に記述していない name と disabled を受け付ける", () => {
  const Field = defineElement("type-field", (_props: { label?: string }) => null, {
    props: { label: "unknown" },
  });
  void (<Field name="a" disabled label="x" />);
  // @ts-expect-error name は文字列である
  void (<Field name={1} />);
  // @ts-expect-error disabled は真偽値である
  void (<Field disabled="yes" />);
});

test("要素の関数は、スロットの props を JSX の子に配置できる", () => {
  void ((props: DialogProps) => (
    <section>
      <header>{props.header}</header>
      {props.children}
    </section>
  ));
});

test("要素のファイルの Errored は、シェルの中で受け止めたときのステータスを status で受け付ける", () => {
  void (
    <Errored status={200} fallback={(_error, retry) => <button onClick={retry}>再試行</button>}>
      body
    </Errored>
  );
});

test("createContext が返したコンポーネントを、子を包んで記述できる", () => {
  const Theme = createContext("light");
  void (
    <Theme value="dark">
      <Card title="t" />
    </Theme>
  );
});

test("<For> の children は、each の項目の型と、位置を返す関数を受け取り、<For> は共通のノードを返す", () => {
  const rows = [{ id: 1 }];
  const list = (
    <For each={rows}>
      {(row, index) => {
        expectTypeOf(row).toEqualTypeOf<{ id: number }>();
        expectTypeOf(index).toEqualTypeOf<() => number>();
        return <li>{row.id}</li>;
      }}
    </For>
  );
  void list;
  expectTypeOf(For).returns.toEqualTypeOf<import("sobria").SharedNode>();
});
