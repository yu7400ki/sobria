/** `value` を、`<script>` の中に埋め込める JSON にする。 */
export const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll("<", "\\u003c");
