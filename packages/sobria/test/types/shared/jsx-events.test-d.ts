import { expectTypeOf, test } from "vitest";

import type { EventNames } from "../../../src/shared/jsx-events.ts";

test("イベントハンドラーの名前の on の後ろを小文字にした名前は、対応させたイベントの名前と一致する", () => {
  type Mismatched = {
    [K in keyof EventNames]: K extends `on${infer Rest}`
      ? Lowercase<Rest> extends EventNames[K]
        ? never
        : K
      : K;
  }[keyof EventNames];
  expectTypeOf<Mismatched>().toEqualTypeOf<never>();
});

test("HTMLElementEventMap のすべてのイベントに、イベントハンドラーの名前がある", () => {
  expectTypeOf<
    Exclude<keyof HTMLElementEventMap, EventNames[keyof EventNames]>
  >().toEqualTypeOf<never>();
});
