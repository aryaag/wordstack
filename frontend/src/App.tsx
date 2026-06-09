import { useEffect, useState } from "react";

export function App() {
  const [health, setHealth] = useState("checking…");

  useEffect(() => {
    fetch("/health")
      .then((r) => r.json())
      .then((d: { ts: number }) => setHealth(`ok · ${new Date(d.ts).toLocaleTimeString()}`))
      .catch(() => setHealth("unreachable"));
  }, []);

  return (
    <main className="app">
      <h1>Upwords</h1>
      <p className="tagline">Stack tiles. Change words. Score.</p>
      <p className="health">worker: {health}</p>
    </main>
  );
}
