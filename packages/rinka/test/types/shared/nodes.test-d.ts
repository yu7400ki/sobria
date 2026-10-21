import type { ClientNode, ServerNode, Slot, SlotContent } from "rinka";
import { expectTypeOf, test } from "vitest";

test("ClientNode と ServerNode は互いに代入できない", () => {
  expectTypeOf<ClientNode>().not.toExtend<ServerNode>();
  expectTypeOf<ServerNode>().not.toExtend<ClientNode>();
});

test("SlotContent は両方のノードと、文字列、数値、真偽値、null、undefined、それらの配列を受け付ける", () => {
  expectTypeOf<ClientNode>().toExtend<SlotContent>();
  expectTypeOf<ServerNode>().toExtend<SlotContent>();
  expectTypeOf<[ClientNode, "a", 1, true, null, undefined]>().toExtend<SlotContent>();
  expectTypeOf<{ a: 1 }>().not.toExtend<SlotContent>();
});

test("Slot は、ノードとも SlotContent とも互いに代入できない", () => {
  expectTypeOf<Slot>().not.toExtend<SlotContent>();
  expectTypeOf<SlotContent>().not.toExtend<Slot>();
  expectTypeOf<Slot>().not.toExtend<ClientNode>();
  expectTypeOf<ClientNode>().not.toExtend<Slot>();
  expectTypeOf<Slot>().not.toExtend<ServerNode>();
  expectTypeOf<ServerNode>().not.toExtend<Slot>();
  expectTypeOf<string>().not.toExtend<Slot>();
});
