/** Svelte のコンポーネントに渡す、値を変更すると再描画される props を作成する。 */
export function counterProps(onlike: (detail: unknown) => void): {
  count: number;
  onlike: (detail: unknown) => void;
} {
  const props = $state({ count: 1, onlike });
  return props;
}
