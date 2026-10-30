import { defineElement, type ElementRef, type Slot } from "sobria";
import { expectTypeOf, test } from "vitest";

declare global {
  // `sobria prepare` が生成する `.sobria/env.d.ts` と同じ宣言である。
  namespace JSX {
    type Element = Slot;
  }
}

const Panel = defineElement(
  "type-global-jsx",
  (_props: { body?: JSX.Element; label?: string }) => null,
  { props: { body: "slot", label: "unknown" } },
);

test("グローバルの JSX.Element で宣言した props は、スロットとして ElementRef から除き、JSX の内容を受け付ける", () => {
  expectTypeOf<ElementRef<typeof Panel>>().not.toHaveProperty("body");
  expectTypeOf<ElementRef<typeof Panel>["label"]>().toEqualTypeOf<string | undefined>();
  void (<Panel body={<p />} label="l" />);
});
