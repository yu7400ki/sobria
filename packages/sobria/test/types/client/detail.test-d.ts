import { defineElement, type ElementRef } from "sobria";
import { expectTypeOf, test } from "vitest";

import Detail, { type Expected } from "./fixtures/detail-events.ts";

const Element = defineElement("type-detail", Detail, {
  props: {
    onNone: "function",
    onOptional: "function",
    onUndefined: "function",
    onNull: "function",
    onBoth: "function",
    onParens: "function",
    onVoid: "function",
    onRest: "function",
    onAlias: "function",
    onCallable: "function",
    onGetter: "function",
    onSetter: "function",
    onNamed: "function",
    onUnion: "function",
    onOverload: "function",
    onGeneric: "function",
  },
});

test("ElementRef のイベントの型は、fixture の Expected に記述した型と一致する", () => {
  const ref = null as unknown as ElementRef<typeof Element>;
  ref.addEventListener("none", (event) => expectTypeOf(event).toEqualTypeOf<Expected["none"]>());
  ref.addEventListener("optional", (event) =>
    expectTypeOf(event).toEqualTypeOf<Expected["optional"]>(),
  );
  ref.addEventListener("undefined", (event) =>
    expectTypeOf(event).toEqualTypeOf<Expected["undefined"]>(),
  );
  ref.addEventListener("null", (event) => expectTypeOf(event).toEqualTypeOf<Expected["null"]>());
  ref.addEventListener("both", (event) => expectTypeOf(event).toEqualTypeOf<Expected["both"]>());
  ref.addEventListener("parens", (event) =>
    expectTypeOf(event).toEqualTypeOf<Expected["parens"]>(),
  );
  ref.addEventListener("void", (event) => expectTypeOf(event).toEqualTypeOf<Expected["void"]>());
  ref.addEventListener("rest", (event) => expectTypeOf(event).toEqualTypeOf<Expected["rest"]>());
  ref.addEventListener("alias", (event) => expectTypeOf(event).toEqualTypeOf<Expected["alias"]>());
  ref.addEventListener("callable", (event) =>
    expectTypeOf(event).toEqualTypeOf<Expected["callable"]>(),
  );
  ref.addEventListener("getter", (event) =>
    expectTypeOf(event).toEqualTypeOf<Expected["getter"]>(),
  );
  ref.addEventListener("setter", (event) =>
    expectTypeOf(event).toEqualTypeOf<Expected["setter"]>(),
  );
  ref.addEventListener("named", (event) => expectTypeOf(event).toEqualTypeOf<Expected["named"]>());
  ref.addEventListener("union", (event) => expectTypeOf(event).toEqualTypeOf<Expected["union"]>());
  ref.addEventListener("overload", (event) =>
    expectTypeOf(event).toEqualTypeOf<Expected["overload"]>(),
  );
  ref.addEventListener("generic", (event) =>
    expectTypeOf(event).toEqualTypeOf<Expected["generic"]>(),
  );
});
