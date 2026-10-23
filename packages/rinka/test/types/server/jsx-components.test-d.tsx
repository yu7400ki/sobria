import {
  defineElement,
  Errored,
  type ClientNode,
  type Ctx,
  type ServerNode,
  type Slot,
} from "rinka";
import type { JSX } from "rinka/jsx-runtime";
import { expectTypeOf, test } from "vitest";

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

test("サーバーのファイルの ref は、記述できない理由を示すメッセージの型である", () => {
  type Message = "ref は、要素のファイルでだけ使用できます。";
  expectTypeOf<JSX.IntrinsicElements["input"]["ref"]>().toEqualTypeOf<Message | undefined>();
  expectTypeOf<JSX.LibraryManagedAttributes<typeof Dialog, DialogProps>["ref"]>().toEqualTypeOf<
    Message | undefined
  >();
});

test("サーバーのファイルの SVG と名前に - を含むタグに、イベントハンドラーと ref を記述すると型エラーになる", () => {
  // @ts-expect-error イベントハンドラーは要素の中でだけ記述できる
  void (<svg onClick={() => {}} />);
  // @ts-expect-error ref は要素の中でだけ記述できる
  void (<custom-widget ref={() => {}} />);
  void (<custom-widget anything={1} on="x" on1="x" on_x="x" once="x" />);
});

test("サーバーのファイルの HTML のタグは、イベントハンドラーの名前を props の候補に含めない", () => {
  expectTypeOf<Extract<keyof JSX.IntrinsicElements["div"], `on${string}`>>().toEqualTypeOf<never>();
});

declare function Chart(props: { data: number[] }, ctx: Ctx): ClientNode;

test("要素のファイルの default export と同じ形の関数にも、load:* を付与できる", () => {
  void (<Chart data={[1]} load:visible />);
  void (<Chart data={[1]} load:media="(min-width: 800px)" />);
});

test("サーバーの Errored の fallback の関数は、エラーだけを受け取る", () => {
  void (
    <Errored fallback={(error) => <p>{String(error)}</p>}>
      <p />
    </Errored>
  );
  void (
    (
      // @ts-expect-error サーバーの fallback は retry を受け取らない
      <Errored fallback={(_error: unknown, retry: () => void) => <p>{String(retry)}</p>}>
        <p />
      </Errored>
    )
  );
});
