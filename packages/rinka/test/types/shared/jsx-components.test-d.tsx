import type { ClientNode, ServerNode } from "rinka";
import { test } from "vitest";

const Card = (_props: { title: string }) => null as unknown as ClientNode & ServerNode;

test("共通のコンポーネントの中では、共通のコンポーネントに Props だけを渡せる", () => {
  void (<Card title="t" />);
  // @ts-expect-error ホストの属性は付与できない
  void (<Card title="t" class="wide" />);
});
