/** `value` を default export するモジュールを読み込む関数を返す。返す関数は、`file` にモジュールのファイルのパスを持つ。 */
export const loadOf = <T>(value: T, file = "src/routes/test.tsx") =>
  Object.assign(async () => ({ default: value }), { file });
