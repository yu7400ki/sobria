import "../styles/global.css";
import "./page.css";
import Card from "../elements/card.tsx";

import raw from "../styles/raw.css?inline";

export default function Page() {
  return (
    <html lang="ja">
      <title>styles</title>
      <main data-raw={raw.length}>
        <Card />
      </main>
    </html>
  );
}
