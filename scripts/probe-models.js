import "dotenv/config";

const BASE = "https://openrouter.ai/api/v1";
const key = process.env.OPENROUTER_API_KEY;

async function testChat(model) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Säg hej som katt, 1 kort mening svenska" }],
      max_tokens: 60,
    }),
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 300) };
}

async function testTts(model, voice) {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: "Mjau! Hej lilla vän!",
      voice,
      response_format: "mp3",
    }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, size: buf.length, body: buf.length < 300 ? buf.toString() : "ok" };
}

const chatModel = "google/gemini-2.5-flash";
const ttsModel = "google/gemini-3.1-flash-tts-preview";
const ttsVoice = "Kore";

console.log("chat", await testChat(chatModel));
console.log("tts", await testTts(ttsModel, ttsVoice));
