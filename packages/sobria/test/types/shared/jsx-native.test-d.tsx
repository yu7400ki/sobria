import { test } from "vitest";

test("共通のコンポーネントのネイティブのタグは、属性を受け付ける", () => {
  void (<label for="name" class="field" />);
});

test("style は、CSS のプロパティ名と CSS 変数をキーにしたオブジェクトを受け付ける", () => {
  void (<div style="color: red" />);
  void (<div style={{ color: "red", "--gap": 4, "--accent": "#f00", opacity: 0.5 }} />);
  void (<div style={{ width: null, height: undefined, margin: false }} />);
  void (<div style={() => ({ color: "red" })} />);
  // @ts-expect-error 未知のプロパティは受け付けない
  void (<div style={{ colr: "red" }} />);
  // @ts-expect-error 長さの数値は 0 だけを受け付ける
  void (<div style={{ width: 10 }} />);
  // @ts-expect-error CSS 変数の値にオブジェクトは渡せない
  void (<div style={{ "--gap": {} }} />);
  // @ts-expect-error プロパティの値に関数は渡せない
  void (<div style={{ color: () => "red" }} />);
});

test("子を持てないタグに子を渡すと型エラーになり、子を持てるタグには子を渡せる", () => {
  // @ts-expect-error input は子を持てない
  void (<input>text</input>);
  // @ts-expect-error br は子を持てない
  void (<br>{1}</br>);
  void (<img src="a.png" alt="" />);
  void (<p>text</p>);
});

test("タグごとの属性を受け付け、タグに無い属性は型エラーになる", () => {
  void (<canvas width={300} height="150" />);
  void (<embed src="a.swf" type="application/x-shockwave-flash" />);
  void (<object data="a.pdf" type="application/pdf" width={100} />);
  void (<map name="m" />);
  void (<input type="image" alt="送信" src="a.png" capture="user" />);
  // @ts-expect-error canvas は src を受け付けない
  void (<canvas src="a.png" />);
});

test("共通のコンポーネントのネイティブのタグに、イベントハンドラーと ref を記述すると型エラーになる", () => {
  // @ts-expect-error イベントハンドラーは要素の中でだけ記述できる
  void (<button onClick={() => {}} />);
  // @ts-expect-error ref は要素の中でだけ記述できる
  void (<input ref={() => {}} />);
});
