import { test } from "vitest";

declare module "sobria" {
  interface CSSProperties {
    "x-test-client-shape"?: "round" | "bevel";
  }
}

test("CSSProperties に追加したプロパティは、追加した型の値だけを style のオブジェクトで受け付ける", () => {
  void (<div style={{ "x-test-client-shape": "round", color: "red" }} />);
  // @ts-expect-error 追加したプロパティの型に無い値は受け付けない
  void (<div style={{ "x-test-client-shape": "square" }} />);
});
