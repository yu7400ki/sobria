# sobria

sobria は、Hono と Vite の上で動作する、サーバーファーストの Web フレームワークです。ページはサーバーで描画し、ブラウザに JS を送信しません。JS を送信するのは、ページで使用した要素だけです。

- ページは `src/routes/` に配置するサーバーコンポーネントで、async 関数にすればデータを直接 `await` で取得できます
- 要素は `src/elements/` のファイルが default export する関数で、sobria はこの関数から Custom Element を作成します。要素もサーバーで描画し、Declarative Shadow DOM として HTML に含めます
- `defineServerFn` で定義した関数は、要素から呼び出すとサーバーで実行されます。この関数は、フォームの送信先にも指定できます

## アプリを作成する

```sh
pnpm dlx sobria create my-app
cd my-app
pnpm install
pnpm dev
```

## 必要な環境

| ソフトウェア | 版                        |
| ------------ | ------------------------- |
| Node         | 24.2 以降                 |
| Vite         | 8.3 以降                  |
| Hono         | 5.0.0-rc.1 だけ           |
| TypeScript   | 7.1.0-beta 以降、7.2 未満 |

sobria は 0.x の版です。版が上がると、API が互換性の無い形に変化することがあります。

## ドキュメント

https://yu7400ki.github.io/sobria/

ドキュメントの本文の MDX は、パッケージの `docs/` にも同梱します。インストールした版の `node_modules/sobria/docs/` を参照できます。

## ライセンス

MIT
