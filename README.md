# sobria

Hono と Vite の上で動作する、サーバーファーストの Web フレームワーク sobria のリポジトリです。使い方は [packages/sobria/README.md](packages/sobria/README.md) と、[ドキュメントサイト](https://yu7400ki.github.io/sobria/) に記述します。

## ディレクトリの構成

| ディレクトリ            | 内容                                               |
| ----------------------- | -------------------------------------------------- |
| `packages/sobria`       | npm に公開するパッケージ `sobria`                  |
| `packages/docs`         | sobria で作成したドキュメントサイト                |
| `packages/config`       | リポジトリの中のパッケージが共有する設定           |
| `tests/e2e`             | ビルドと開発サーバーとブラウザを使用するテスト     |
| `tests/fixture-library` | 要素のライブラリとして使用するテスト用のパッケージ |

## 開発

開発には、Node 24.2 以降と pnpm 12 を使用します。

```sh
pnpm install
pnpm --filter sobria exec playwright install chromium firefox webkit
pnpm build
pnpm test
```

`pnpm test` は、すべてのパッケージをビルドしてから、各パッケージのテストを実行します。lint、整形の検査、型の検査は、それぞれ `pnpm lint`、`pnpm format:check`、`pnpm typecheck` で実行します。`pnpm lint` は、`pnpm test` が生成する `tests/fixture-library` の型の宣言を検査するので、`pnpm test` の後に実行します。

## ライセンス

[MIT](LICENSE)
