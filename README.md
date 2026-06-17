# CAT-GPT

Magical talking cat web app for toddlers. Tap the big button, speak in Swedish, and **Misse** the cartoon cat answers with short playful Swedish phrases and voice.

## Architecture

```
Browser (iPad Safari)
  ├── Animated cat UI + giant talk button
  ├── MediaRecorder (mic) + Audio unlock on first tap
  └── POST /api/talk (audio blob)
           │
           ▼
Express backend (server.js)
  ├── Transcribe audio → OpenRouter chat (Gemini)
  ├── Cat persona reply → OpenRouter chat (Gemini)
  └── Speak reply → OpenRouter TTS (Gemini) → WAV
```

The OpenRouter API key stays on the server only (loaded from `.env`).

## Setup

1. Add your key to `.env`:

```env
OPENROUTER_API_KEY=sk-or-v1-...
```

2. Install and run (HTTPS for iPhone mic):

```bash
npm install
npm run cert          # one-time: creates certs/ with local CA
npm run start:https   # or npm start once certs exist
```

3. Open on iPad/iPhone (same Wi‑Fi): **https://YOUR-LAN-IP:3456**  
   Port defaults to **3456**. The server prints LAN URLs on startup.

### iPhone microphone (HTTPS)

iOS Safari requires HTTPS for the microphone. One-time setup on the phone:

1. On your Mac/Linux machine, run `npm run cert` and `npm run start:https`.
2. On the iPhone, open Safari → **https://YOUR-LAN-IP:3456/rootCA.pem**  
   (accept the warning the first time, or AirDrop `certs/rootCA.pem` from the project).
3. Install the profile → **Settings → General → VPN & Device Management**.
4. **Settings → General → About → Certificate Trust Settings** → enable trust for **CAT-GPT Local CA**.
5. Open **https://YOUR-LAN-IP:3456** and allow the microphone when Misse asks.

For desktop only, plain HTTP still works: **http://localhost:3456**

## Optional env vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3456` | Server port |
| `HOST` | `0.0.0.0` | Bind address (LAN access for iPhone) |
| `USE_HTTPS` | auto if `certs/` exist | Force HTTPS (`1`) or HTTP (`0`) |
| `SSL_CERT` / `SSL_KEY` | `certs/cert.pem`, `certs/key.pem` | TLS certificate paths |
| `CHAT_MODEL` | `google/gemma-4-31b-it:free` | Cat reply text (free tier) |
| `STT_MODEL` | `google/gemini-2.5-flash-lite` | Speech-to-text via Gemini audio (cheap for short clips) |
| `TTS_MODEL` | `google/gemini-3.1-flash-tts-preview` | Cat voice |
| `TTS_VOICE` | `Kore` | TTS voice id |

## Testing

With the server running:

```bash
npm run test:e2e
```

Runs live OpenRouter calls for health, Swedish chat, and TTS audio.

## Deployment

1. Set `OPENROUTER_API_KEY` (and optional model vars) in your host environment.
2. Run `npm start` behind HTTPS (required for mic on iOS over the network).
3. Use a process manager (systemd, PM2, Docker, Fly.io, Railway, etc.).

Example Docker-style run:

```bash
PORT=3456 node server.js
```

For production, put nginx/Caddy in front with TLS and proxy to the Node app.

## iPad Safari notes

- First tap unlocks audio and requests microphone permission.
- Viewport and `touch-action: manipulation` reduce accidental zoom.
- Talk button is oversized for small fingers (~96px+ tall).
- Recording prefers `audio/mp4` on iOS.

## Key files

| File | Role |
|------|------|
| `server.js` | Express API proxy + HTTPS + cat system prompt |
| `scripts/generate-cert.sh` | Local CA + cert for localhost and LAN IP |
| `public/index.html` | App shell |
| `public/css/styles.css` | Animated cat + toddler UI |
| `public/js/app.js` | Mic, recording, playback, iOS audio unlock |
| `scripts/e2e-test.js` | Live API smoke tests |
