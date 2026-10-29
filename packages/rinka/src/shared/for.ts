/** `<For>` の props を表す。`children` は、`each` の項目ごとに、その項目と、項目の位置を返す関数を受け取る。 */
export interface ForProps<T, C> {
  readonly each: readonly T[] | null | undefined;
  readonly children: (item: T, index: () => number) => C;
}
