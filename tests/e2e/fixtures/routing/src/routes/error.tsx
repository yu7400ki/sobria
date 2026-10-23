export default function RootError({ error }: { error: unknown }) {
  return <h1>root error {error instanceof Error ? error.message : ""}</h1>;
}
