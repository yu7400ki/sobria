import type { ClientNode, ServerNode, Slot } from "rinka";
import { expectTypeOf, test } from "vitest";

test("ClientNode と ServerNode は互いに代入できない", () => {
  expectTypeOf<ClientNode>().not.toExtend<ServerNode>();
  expectTypeOf<ServerNode>().not.toExtend<ClientNode>();
});

test("Slot は両方のノードと、文字列、数値、真偽値、null、undefined、それらの配列を受け付ける", () => {
  expectTypeOf<ClientNode>().toExtend<Slot>();
  expectTypeOf<ServerNode>().toExtend<Slot>();
  expectTypeOf<[ClientNode, "a", 1, true, null, undefined]>().toExtend<Slot>();
  expectTypeOf<{ a: 1 }>().not.toExtend<Slot>();
});
