import "dotenv/config";
import express from "express";
import fs from "fs";
import http from "http";
import https from "https";
import multer from "multer";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3456;
const HOST = process.env.HOST || "0.0.0.0";
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, "certs");
const SSL_CERT =
  process.env.SSL_CERT || path.join(CERT_DIR, "cert.pem");
const SSL_KEY = process.env.SSL_KEY || path.join(CERT_DIR, "key.pem");
const USE_HTTPS =
  process.env.USE_HTTPS === "1" ||
  process.env.USE_HTTPS === "true" ||
  (process.env.USE_HTTPS !== "0" &&
    process.env.USE_HTTPS !== "false" &&
    fs.existsSync(SSL_CERT) &&
    fs.existsSync(SSL_KEY));
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const VOICE_DEBUG_PREFIX = "[voice-debug]";

const CHAT_MODEL = process.env.CHAT_MODEL || "google/gemma-4-31b-it:free";
const STT_MODEL = process.env.STT_MODEL || "google/gemini-2.5-flash-lite";
const TTS_MODEL = process.env.TTS_MODEL || "google/gemini-3.1-flash-tts-preview";
const TTS_VOICE = process.env.TTS_VOICE || "Kore";
const CAT_SYSTEM_PROMPT =
  process.env.CAT_SYSTEM_PROMPT ||
  `Du är Misse, en magisk, varm och lekfull tecknad katt som pratar med ett litet barn (4 år).

REGLER:
- Svara ALLTID på svenska.
- Använd EXAKT 1-2 mycket korta meningar (max 15 ord totalt).
- Inkludera gärna katljud som "Mjau!", "Kurr kurr", "Mjav!" eller "Purr purr".
- Var entusiastisk, snäll, lekfull och trygg — som en bästa kattvän.
- Använd enkla ord som ett litet barn förstår.
- Ställ ibland en enkel lekfull fråga tillbaka.
- Var aldrig läskig, elak eller komplicerad.`;
const TTS_INSTRUCTIONS =
  process.env.TTS_INSTRUCTIONS ||
  "Speak in Swedish with a warm, playful, cute cartoon cat voice. Sound friendly and magical, like a pet cat talking to a small child.";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

if (fs.existsSync(path.join(CERT_DIR, "rootCA.pem"))) {
  app.get("/rootCA.pem", (_req, res) => {
    res.set("Content-Type", "application/x-pem-file");
    res.set("Content-Disposition", 'attachment; filename="cat-gpt-rootCA.pem"');
    res.sendFile(path.join(CERT_DIR, "rootCA.pem"));
  });
}

function requireApiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }
  return key;
}

function logVoiceDebug(event, details = {}, level = "log") {
  const logger = typeof console[level] === "function" ? console[level] : console.log;
  logger(`${VOICE_DEBUG_PREFIX} ${event}`, {
    event,
    timestamp: new Date().toISOString(),
    ...details,
  });
}

function toLogError(err) {
  if (!err) return null;
  return {
    name: err.name || "Error",
    message: typeof err.message === "string" ? err.message : String(err),
  };
}

async function openRouterFetch(endpoint, options = {}) {
  const apiKey = requireApiKey();
  const response = await fetch(`${OPENROUTER_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "CAT-GPT",
      ...options.headers,
    },
  });
  return response;
}

function usesDedicatedTranscriptionEndpoint(model) {
  return /whisper|transcribe|voxtral|parakeet|chirp|asr/i.test(model);
}

async function transcribeViaDedicatedEndpoint(base64, audioFormat) {
  const response = await openRouterFetch("/audio/transcriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: STT_MODEL,
      input_audio: { data: base64, format: audioFormat },
      language: "sv",
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Transcription failed (${response.status}): ${err}`);
  }

  const data = await response.json();
  return (data.text || "").trim();
}

async function transcribeViaChat(base64, audioFormat) {
  const response = await openRouterFetch("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: STT_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transkribera exakt vad som sägs på svenska i ljudklippet. Svara bara med transkriptionen, inget annat.",
            },
            {
              type: "input_audio",
              input_audio: { data: base64, format: audioFormat },
            },
          ],
        },
      ],
      max_tokens: 120,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Transcription failed (${response.status}): ${err}`);
  }

  const data = await response.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function transcribeAudio(buffer, format) {
  const base64 = buffer.toString("base64");
  const audioFormat = normalizeAudioFormat(format);

  if (usesDedicatedTranscriptionEndpoint(STT_MODEL)) {
    return transcribeViaDedicatedEndpoint(base64, audioFormat);
  }

  return transcribeViaChat(base64, audioFormat);
}

function normalizeAudioFormat(format) {
  const f = (format || "webm").toLowerCase().replace("audio/", "");
  const map = {
    webm: "webm",
    mp4: "mp4",
    m4a: "mp4",
    mp3: "mp3",
    wav: "wav",
    ogg: "ogg",
    flac: "flac",
    aac: "aac",
  };
  return map[f] || f;
}

async function chatWithCat(userMessage, history = []) {
  const messages = [
    { role: "system", content: CAT_SYSTEM_PROMPT },
    ...history.slice(-6),
    { role: "user", content: userMessage },
  ];

  const response = await openRouterFetch("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      max_tokens: 80,
      temperature: 0.9,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Chat failed (${response.status}): ${err}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("Empty response from chat model");
  }
  return text;
}

async function synthesizeSpeech(text) {
  const response = await openRouterFetch("/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: TTS_VOICE,
      response_format: "pcm",
      instructions: TTS_INSTRUCTIONS,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`TTS failed (${response.status}): ${err}`);
  }

  const pcm = Buffer.from(await response.arrayBuffer());
  return pcmToWav(pcm);
}

function pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(process.env.OPENROUTER_API_KEY),
    models: { chat: CHAT_MODEL, tts: TTS_MODEL, stt: STT_MODEL },
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: "message is required" });
    }
    const text = await chatWithCat(message.trim(), history);
    res.json({ text });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tts", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) {
      return res.status(400).json({ error: "text is required" });
    }
    const audio = await synthesizeSpeech(text.trim());
    res.set("Content-Type", "audio/wav");
    res.send(audio);
  } catch (err) {
    console.error("TTS error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/talk", upload.single("audio"), async (req, res) => {
  const started = Date.now();
  const interactionId = req.get("x-voice-interaction-id") || "unknown";
  try {
    logVoiceDebug("api.talk.start", {
      interactionId,
      requestTimeoutMs: null,
      hasServerRequestTimeout: false,
    });
    if (!req.file?.buffer?.length) {
      logVoiceDebug("api.talk.reject.missing_audio", { interactionId });
      return res.status(400).json({ error: "audio file is required" });
    }

    if (req.file.buffer.length < 64) {
      logVoiceDebug("api.talk.reject.audio_too_small", {
        interactionId,
        audioBytes: req.file.buffer.length,
      });
      return res.status(400).json({
        error: "Kunde inte höra dig, försök igen!",
        transcript: "",
      });
    }

    const format =
      req.body.format ||
      req.file.mimetype?.split("/")[1]?.split(";")[0] ||
      "webm";

    const transcribeStarted = Date.now();
    logVoiceDebug("api.talk.transcribe.start", {
      interactionId,
      audioBytes: req.file.buffer.length,
      format,
    });
    const transcript = await transcribeAudio(req.file.buffer, format);
    logVoiceDebug("api.talk.transcribe.end", {
      interactionId,
      durationMs: Date.now() - transcribeStarted,
      hasTranscript: Boolean(transcript),
    });
    if (!transcript) {
      logVoiceDebug("api.talk.reject.empty_transcript", { interactionId });
      return res.status(400).json({
        error: "Kunde inte höra dig, försök igen!",
        transcript: "",
      });
    }

    const chatStarted = Date.now();
    logVoiceDebug("api.talk.chat.start", { interactionId });
    const reply = await chatWithCat(transcript);
    logVoiceDebug("api.talk.chat.end", {
      interactionId,
      durationMs: Date.now() - chatStarted,
      replyLength: reply.length,
    });

    const ttsStarted = Date.now();
    logVoiceDebug("api.talk.tts.start", { interactionId });
    const audioBuffer = await synthesizeSpeech(reply);
    logVoiceDebug("api.talk.tts.end", {
      interactionId,
      durationMs: Date.now() - ttsStarted,
      audioBytes: audioBuffer.length,
    });
    const latencyMs = Date.now() - started;
    logVoiceDebug("api.talk.success", {
      interactionId,
      totalDurationMs: latencyMs,
    });

    res.json({
      transcript,
      text: reply,
      audioBase64: audioBuffer.toString("base64"),
      audioMimeType: "audio/wav",
      latencyMs,
    });
  } catch (err) {
    logVoiceDebug(
      "api.talk.error",
      {
        interactionId,
        totalDurationMs: Date.now() - started,
        likelyTimeout: err?.name === "AbortError" || /timeout/i.test(String(err?.message || "")),
        error: toLogError(err),
      },
      "error"
    );
    console.error("Talk error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function getLanAddresses() {
  const addrs = new Set();
  for (const [name, nets] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lo)/.test(name)) continue;
    for (const net of nets || []) {
      if (net.family === "IPv4" && !net.internal) {
        addrs.add(net.address);
      }
    }
  }
  return [...addrs];
}

function printUrls(protocol) {
  const lan = getLanAddresses();
  const urls = [`${protocol}://localhost:${PORT}`];
  for (const ip of lan) {
    urls.push(`${protocol}://${ip}:${PORT}`);
  }
  console.log(`CAT-GPT running (${protocol.toUpperCase()}) on ${HOST}:${PORT}`);
  for (const url of urls) {
    console.log(`  → ${url}`);
  }
  if (lan.length === 0) {
    console.log("\n  Warning: no LAN IPv4 address found — use localhost only on this machine.");
  } else if (protocol === "https") {
    console.log(`\n  iPhone (same Wi‑Fi): open ${protocol}://${lan[0]}:${PORT}`);
    console.log(`  First time: install ${protocol}://${lan[0]}:${PORT}/rootCA.pem`);
    console.log("  then enable trust in Settings → Certificate Trust Settings");
  }
}

if (USE_HTTPS) {
  const credentials = {
    cert: fs.readFileSync(SSL_CERT),
    key: fs.readFileSync(SSL_KEY),
  };
  https.createServer(credentials, app).listen(PORT, HOST, () => {
    printUrls("https");
  });
} else {
  http.createServer(app).listen(PORT, HOST, () => {
    printUrls("http");
    console.log("\n  Mic on iPhone needs HTTPS. Run: npm run cert && npm run start:https");
  });
}
