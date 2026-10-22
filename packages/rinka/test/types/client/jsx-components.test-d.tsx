import { defineElement, type ClientNode, type ServerNode, type Slot } from "rinka";
import { expectTypeOf, test } from "vitest";

type DialogProps = { heading?: string; header?: Slot; children?: Slot };
const Dialog = defineElement("type-jsx-dialog", (_props: DialogProps) => null, {
  props: ["heading", "header", "children"],
  slots: ["header"],
});

function TextField(props: { label: string; ref?: (el: HTMLInputElement) => void }) {
  return (
    <label>
      {props.label}
      <input ref={props.ref} />
    </label>
  );
}

const Card = (_props: { title: string }) => null as unknown as ClientNode & ServerNode;
const ServerPart = (_props: { id: string }) => null as unknown as ServerNode;

test("要素は、Props、スロットの内容、ホストの属性、ElementRef を受け取る ref を受け付ける", () => {
  void (
    <Dialog
      heading="h"
      class="wide"
      header={<p />}
      ref={(el) => expectTypeOf(el.heading).toEqualTypeOf<string | undefined>()}
    >
      body
    </Dialog>
  );
});

test("要素の中で load:* を記述すると型エラーになる", () => {
  // @ts-expect-error load:* はサーバーのファイルでだけ記述できる
  void (<Dialog load:idle />);
});

test("補助コンポーネントは、Props に宣言した ref を受け付け、内側のタグに転送できる", () => {
  void (
    <TextField label="検索" ref={(el) => expectTypeOf(el).toEqualTypeOf<HTMLInputElement>()} />
  );
});

test("共通のコンポーネントには、ref とホストの属性を付与できない", () => {
  void (<Card title="t" />);
  // @ts-expect-error ホストの属性は付与できない
  void (<Card title="t" class="wide" />);
  // @ts-expect-error ref は付与できない
  void (<Card title="t" ref={() => {}} />);
});

test("要素の中でサーバーコンポーネントを使用すると型エラーになる", () => {
  // @ts-expect-error サーバーコンポーネントは要素の JSX に記述できない
  void (<ServerPart id="1" />);
});
