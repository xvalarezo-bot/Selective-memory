const key = process.env.BRAIN_ACCESS_KEY ?? "";
console.log("key set:", key.length > 0);

try {
  const res = await fetch(`http://localhost:3000/mcp?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  console.log("status:", res.status);
  console.log("headers:", JSON.stringify([...res.headers.entries()]));
  const text = await res.text();
  console.log("body:", text);
} catch (e) {
  console.log("FETCH ERROR:", e);
}
