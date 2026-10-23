import Rating from "../../elements/rating.tsx";

export default function Page() {
  return (
    <html lang="ja">
      <title>review</title>
      <main>
        <h1>review</h1>
        <form>
          <label for="score">score</label>
          <Rating id="score" name="score" required />
          <fieldset disabled>
            <legend>locked</legend>
            <label for="locked">locked score</label>
            <Rating id="locked" name="locked" />
          </fieldset>
          <button>send</button>
        </form>
      </main>
    </html>
  );
}
