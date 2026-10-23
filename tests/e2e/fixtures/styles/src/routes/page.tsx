import "../styles/global.css";
import "./page.css";
import Badge from "../elements/badge.tsx";
import Card from "../elements/card.tsx";

import raw from "../styles/raw.css?inline";

export default function Page() {
  return (
    <html lang="ja">
      <title>styles</title>
      <main class="mt-4" data-raw={raw.length}>
        <Card />
        <Badge />
      </main>
    </html>
  );
}
