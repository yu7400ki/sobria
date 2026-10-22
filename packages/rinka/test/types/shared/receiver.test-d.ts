import { expectTypeOf, test } from "vitest";

import type { Receiver, receiverKeys } from "../../../src/shared/receiver.ts";

test("receiverKeys は、Receiver のメンバーの名前をすべて列挙する", () => {
  expectTypeOf<(typeof receiverKeys)[number]>().toEqualTypeOf<keyof Receiver>();
});
