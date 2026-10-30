/** Vite が開発時とビルドのときに設定する `import.meta.env` を表す。 */
interface ImportMeta {
  readonly env?: { readonly DEV?: boolean; readonly BASE_URL?: string };
}
