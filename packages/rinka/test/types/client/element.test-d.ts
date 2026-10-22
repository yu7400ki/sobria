import { defineElement, type Ctx, type ElementRef, type Slot } from "rinka";
import { expectTypeOf, test } from "vitest";

type Props = { label?: string; count?: number; header?: Slot; children?: Slot };
type Methods = { open(): void; focus(): void };

const Dialog = defineElement(
  "type-dialog",
  (_props: Props, { expose }: Ctx<Methods>) => {
    expose({ open: () => {}, focus: () => {} });
    return null;
  },
  { props: ["label", "count", "header", "children"], slots: ["header"] },
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
    { props: [] },
  );
});

test("ElementRef は、Slot 以外の型で宣言した children も持たず、any で宣言した props を持つ", () => {
  const Box = defineElement("type-box", (_props: { value?: any; children?: string }) => null, {
    props: ["value", "children"],
  });
  expectTypeOf<ElementRef<typeof Box>["children"]>().toEqualTypeOf<HTMLCollection>();
  expectTypeOf<ElementRef<typeof Box>>().toHaveProperty("value");
});
