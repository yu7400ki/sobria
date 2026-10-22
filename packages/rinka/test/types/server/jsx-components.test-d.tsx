import { defineElement, type ClientNode, type ServerNode, type Slot } from "rinka";
import { test } from "vitest";

type DialogProps = { heading?: string; header?: Slot; children?: Slot };
const Dialog = defineElement("type-jsx-dialog", (_props: DialogProps) => null, {
  props: ["heading", "header", "children"],
  slots: ["header"],
});

const Card = (_props: { title: string }) => null as unknown as ClientNode & ServerNode;

async function Profile(_props: { id: string }): Promise<ServerNode> {
  return <section />;
}

test("サーバーのファイルでは、要素に Props、スロットの内容、ホストの属性、load:* を付与できる", () => {
  void (
    <Dialog heading="h" class="wide" header={<p />} load:visible>
      body
    </Dialog>
  );
  void (<Dialog load:media="(min-width: 800px)" />);
});

test("サーバーのファイルで ref と存在しない load:* を記述すると型エラーになる", () => {
  // @ts-expect-error ref は要素のファイルでだけ記述できる
  void (<Dialog ref={() => {}} />);
  // @ts-expect-error 存在しない load:* は型エラーになる
  void (<Dialog load:typo />);
});

test("async のサーバーコンポーネントを使用できる", () => {
  void (<Profile id="1" />);
});

test("共通のコンポーネントには、load:* とホストの属性を付与できない", () => {
  void (<Card title="t" />);
  // @ts-expect-error ホストの属性は付与できない
  void (<Card title="t" class="wide" />);
  // @ts-expect-error load:* は付与できない
  void (<Card title="t" load:idle />);
});
