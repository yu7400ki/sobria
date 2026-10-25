import { defineElement, memo, type Ctx, type ElementRef, type Slot } from "rinka";
import { expectTypeOf, test } from "vitest";

type Props = { label?: string; count?: number; header?: Slot; children?: Slot };
type Methods = { open(): void; focus(): void };

const Dialog = defineElement(
  "type-dialog",
  (_props: Props, { expose }: Ctx<Methods>) => {
    expose({ open: () => {}, focus: () => {} });
    return null;
  },
  { props: { label: "unknown", count: "unknown", header: "slot", children: "slot" } },
);

test("ElementRef は、expose で公開したメンバーと props と、HTMLElement のメンバーを持つ", () => {
  expectTypeOf<ElementRef<typeof Dialog>["open"]>().toEqualTypeOf<() => void>();
  expectTypeOf<ElementRef<typeof Dialog>["label"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ElementRef<typeof Dialog>["count"]>().toEqualTypeOf<number | undefined>();
  expectTypeOf<ElementRef<typeof Dialog>["blur"]>().toEqualTypeOf<HTMLElement["blur"]>();
});

test("ElementRef は、expose で上書きした HTMLElement のメンバーを、公開した側の型にする", () => {
  expectTypeOf<ElementRef<typeof Dialog>["focus"]>().toEqualTypeOf<() => void>();
});

test("ElementRef は、スロットの props を持たず、children は HTMLElement の children である", () => {
  expectTypeOf<ElementRef<typeof Dialog>>().not.toHaveProperty("header");
  expectTypeOf<ElementRef<typeof Dialog>["children"]>().toEqualTypeOf<HTMLCollection>();
});

test("expose に渡すオブジェクトが Ctx の型を満たさなければ、型エラーになる", () => {
  defineElement(
    "type-dialog-2",
    (_props: Props, { expose }: Ctx<Methods>) => {
      // @ts-expect-error focus を渡していないので、型エラーになる
      expose({ open: () => {} });
      return null;
    },
    { props: {} },
  );
});

test("ElementRef は、Slot 以外の型で宣言した children も持たず、any で宣言した props を持つ", () => {
  const Box = defineElement("type-box", (_props: { value?: any; children?: string }) => null, {
    props: { value: "unknown", children: "slot" },
  });
  expectTypeOf<ElementRef<typeof Box>["children"]>().toEqualTypeOf<HTMLCollection>();
  expectTypeOf<ElementRef<typeof Box>>().toHaveProperty("value");
});

test("Ctx は、フォームの部品の form と、ElementInternals の internals を持つ", () => {
  expectTypeOf<Ctx["internals"]>().toEqualTypeOf<ElementInternals>();
  expectTypeOf<Ctx["form"]["disabled"]>().toEqualTypeOf<() => boolean>();
  expectTypeOf<Ctx["form"]["value"]>()
    .parameter(0)
    .returns.toEqualTypeOf<string | null | undefined>();
  expectTypeOf<Ctx["form"]["onRestore"]>()
    .parameter(0)
    .parameters.toEqualTypeOf<
      [state: string | File | FormData | null, mode: "restore" | "autocomplete"]
    >();
});

test("公開の defineElement は、タグ名、要素の関数、登録の設定の 3 つの引数を受け取る", () => {
  // @ts-expect-error 4 つ目の引数は受け取らない
  defineElement("type-four-args", () => null, { props: {} }, { send: () => {} });
});

test("登録の設定の props で、children に分類できるのは slot だけである", () => {
  defineElement("type-children-slot", () => null, { props: { children: "slot" } });
  // @ts-expect-error children は属性から受け取らない
  defineElement("type-children-string", () => null, { props: { children: "string" } });
});

test("ctx の css は、タグ付きテンプレートと CSSStyleSheet を受け取る", () => {
  defineElement(
    "type-styled",
    (_props: object, { css }: Ctx) => {
      css`
        :host {
          order: ${1};
        }
      `;
      css(new CSSStyleSheet());
      // @ts-expect-error 文字列は受け取らない
      css(":host {}");
      return null;
    },
    { props: {} },
  );
});

test("memo の 2 番目の引数には、key だけを記述できる", () => {
  memo(() => 1, { key: "user" });
  // @ts-expect-error 呼び出し箇所の ID は Vite プラグインが付与する
  memo(() => 1, { site: "a.tsx:1:1" });
});

type EventProps = {
  onLikeClick?: (count: number) => void;
  onURLChange?: (url: string) => void;
  onClose?: () => void;
  onToggle?: (open?: boolean) => void;
};
/** `like-click` のイベントを受け取るリスナーである。 */
const listener = (event: CustomEvent<number>) => event;

const Counter = defineElement("type-counter", (_props: EventProps) => null, {
  props: {
    onLikeClick: "function",
    onURLChange: "function",
    onClose: "function",
    onToggle: "function",
  },
});

test("ElementRef の addEventListener は、onX の props から決まるイベント名に、最初の引数を detail に持つ CustomEvent を渡す", () => {
  const counter = null as unknown as ElementRef<typeof Counter>;
  counter.addEventListener("like-click", (event) => {
    expectTypeOf(event).toEqualTypeOf<CustomEvent<number>>();
  });
  counter.addEventListener("url-change", (event) => {
    expectTypeOf(event.detail).toEqualTypeOf<string>();
  });
  counter.addEventListener("close", (event) => {
    expectTypeOf(event).toEqualTypeOf<CustomEvent<null> | Event>();
  });
  counter.addEventListener("toggle", (event) => {
    expectTypeOf(event).toEqualTypeOf<CustomEvent<boolean | null> | ToggleEvent>();
  });
  counter.addEventListener("click", (event) => {
    expectTypeOf(event).toEqualTypeOf<HTMLElementEventMap["click"]>();
  });
  counter.addEventListener("like-click", listener);
  counter.removeEventListener("like-click", listener);
});

type LongProps = {
  onAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghij?: (
    n: number,
  ) => void;
};
const Long = defineElement("type-long", (_props: LongProps) => null, {
  props: {
    onAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghijAbcdefghij:
      "function",
  },
});

test("ElementRef は、100 文字のイベントの props の名前からも、イベント名の型を導出する", () => {
  const long = null as unknown as ElementRef<typeof Long>;
  long.addEventListener(
    "abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdefghij-abcdefghij",
    (event) => expectTypeOf(event.detail).toEqualTypeOf<number>(),
  );
});
