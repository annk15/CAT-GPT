import "dotenv/config";

const BASE = process.env.TEST_BASE_URL || "http://localhost:3456";
const results = [];

function log(name, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  const line = `[${status}] ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  results.push({ name, ok, detail });
}

async function waitForServer(maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function testHealth() {
  const res = await fetch(`${BASE}/api/health`);
  const data = await res.json();
  log(
    "Health check",
    res.ok && data.ok && data.hasApiKey,
    `models: ${JSON.stringify(data.models)}`
  );
}

async function testChat() {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Hej Misse! Jag gillar katter!" }),
  });
  const data = await res.json();
  const latency = Date.now() - started;
  const ok =
    res.ok &&
    typeof data.text === "string" &&
    data.text.length > 0 &&
    data.text.length < 200;
  log("Chat (Swedish cat reply)", ok, `"${data.text}" (${latency}ms)`);
  return data.text;
}

async function testTts(text) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text || "Mjau! Jag är Misse katten!" }),
  });
  const latency = Date.now() - started;
  const contentType = res.headers.get("content-type") || "";
  const buffer = Buffer.from(await res.arrayBuffer());
  const ok = res.ok && contentType.includes("audio") && buffer.length > 1000;
  log("TTS (WAV audio)", ok, `${buffer.length} bytes (${latency}ms)`);
}

async function main() {
  console.log(`\nCAT-GPT E2E tests → ${BASE}\n`);

  if (!(await waitForServer())) {
    log("Server reachable", false, "Start server with npm start first");
    process.exit(1);
  }

  await testHealth();
  const reply = await testChat();
  await testTts(reply);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
