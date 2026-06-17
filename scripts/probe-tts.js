import "dotenv/config";

const BASE = "https://openrouter.ai/api/v1";
const key = process.env.OPENROUTER_API_KEY;

async function testTts(model, voice, response_format = "mp3") {
  const res = await fetch(`${BASE}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: "Mjau! Hej lilla vän!",
      voice: voice || "default",
      response_format,
    }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    model,
    voice,
    format: response_format,
    status: res.status,
    size: buf.length,
    err: buf.length < 300 ? buf.toString() : undefined,
  };
}

const candidates = [
  ["google/gemini-3.1-flash-tts-preview", "Kore", "pcm"],
  ["mistralai/voxtral-mini-tts-2603", "alloy", "mp3"],
  ["hexgrad/kokoro-82m", "af_bella", "mp3"],
  ["microsoft/mai-voice-2", "en-US-Harper:MAI-Voice-2", "mp3"],
];

for (const args of candidates) {
  console.log(await testTts(...args));
}
