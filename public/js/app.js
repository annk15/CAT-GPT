const cat = document.getElementById("cat");
const statusEl = document.getElementById("status");
const talkButton = document.getElementById("talkButton");
const talkButtonLabel = document.getElementById("talkButtonLabel");

const State = {
  IDLE: "idle",
  PREPARING: "preparing",
  LISTENING: "listening",
  THINKING: "thinking",
  TALKING: "talking",
};

let state = State.IDLE;
let busy = false;
let audioUnlocked = false;
let micAccessPromise = null;
let recordingSession = 0;
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingMimeType = "audio/webm";
const SILENT_MP3_DATA_URL =
  "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhAC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAA4T/CAAA//sQZAAP8AAAf4AAB/gAAA/0AAAH+AAAA=";

let audioContext = null;
let primedAudio = null;
let currentAudio = null;
let currentAudioUrl = null;
let currentAudioSource = null;
let interactionCounter = 0;
let activeInteractionId = null;
const VOICE_DEBUG_PREFIX = "[voice-debug]";

function createVoiceInteractionId() {
  interactionCounter += 1;
  return `voice-${Date.now()}-${interactionCounter}`;
}

function toLogError(err) {
  if (!err) return null;
  return {
    name: err.name || "Error",
    message: typeof err.message === "string" ? err.message : String(err),
    fromGetUserMedia: err.fromGetUserMedia === true,
  };
}

function isLikelyTimeoutError(err) {
  const message = String(err?.message || "").toLowerCase();
  return err?.name === "TimeoutError" || message.includes("timeout") || message.includes("svarade inte");
}

function isLikelyAutoplayBlockedError(err) {
  return (
    err?.name === "NotAllowedError" ||
    err?.name === "PermissionDeniedError" ||
    err?.cause?.name === "NotAllowedError" ||
    err?.cause?.name === "PermissionDeniedError"
  );
}

function wrapPlaybackError(err) {
  const wrapped = new Error(typeof err?.message === "string" ? err.message : "Audio playback failed");
  wrapped.name = "PlaybackError";
  wrapped.fromPlayback = true;
  wrapped.cause = err;
  return wrapped;
}

function getPlaybackFailureMessage(err) {
  if (isLikelyAutoplayBlockedError(err)) {
    return "Misse svarade! Tryck knappen igen om du inte hörde mig.";
  }
  return "Misse svarade men ljudet strulade. Försök igen!";
}

function voiceDebug(event, details = {}, level = "log") {
  const logger = typeof console[level] === "function" ? console[level] : console.log;
  logger(`${VOICE_DEBUG_PREFIX} ${event}`, {
    event,
    timestamp: new Date().toISOString(),
    ...details,
  });
}

function isIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function getRecorderMimeCandidates() {
  const desktop = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  const mobile = [
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  return isIOS() ? mobile : desktop;
}

function checkCapabilities() {
  if (!window.isSecureContext) {
    return "Mikrofonen behöver en säker sida (HTTPS). Be en vuxin fixa det!";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "Här funkar inte mikrofonen. Prova en annan webbläsare!";
  }
  if (typeof MediaRecorder === "undefined") {
    return "Här kan vi inte spela in ljud. Prova en annan webbläsare!";
  }
  return null;
}

function setState(next) {
  state = next;
  cat.classList.remove("is-listening", "is-thinking", "is-talking");
  talkButton.classList.remove("is-listening", "is-active");

  if (next === State.PREPARING) {
    statusEl.textContent = "Startar mikrofonen…";
    talkButtonLabel.textContent = "Vänta lite…";
    talkButton.disabled = true;
  } else if (next === State.LISTENING) {
    cat.classList.add("is-listening");
    talkButton.classList.add("is-listening", "is-active");
    statusEl.textContent = "Jag lyssnar… prata nu!";
    talkButtonLabel.textContent = "Tryck igen när du är klar!";
    talkButton.disabled = false;
  } else if (next === State.THINKING) {
    cat.classList.add("is-thinking");
    statusEl.textContent = "Misse tänker…";
    talkButtonLabel.textContent = "Vänta lite…";
    talkButton.disabled = true;
  } else if (next === State.TALKING) {
    cat.classList.add("is-talking");
    statusEl.textContent = "Misse pratar!";
    talkButtonLabel.textContent = "Lyssna…";
    talkButton.disabled = true;
  } else {
    statusEl.textContent = "Tryck knappen och prata!";
    talkButtonLabel.textContent = "Prata med Misse!";
    talkButton.disabled = false;
  }
}

function showStatusMessage(message) {
  statusEl.textContent = message;
}

function isMicrophonePermissionDenied(err) {
  return (
    err?.fromGetUserMedia === true &&
    (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError")
  );
}

function isStrongMicDisabledSignal(err, permissionState) {
  if (!isMicrophonePermissionDenied(err)) return false;
  if (permissionState === "denied") return true;

  const message = String(err?.message || "").toLowerCase();
  return (
    message.includes("permission denied") ||
    message.includes("permission denied by system") ||
    message.includes("user denied") ||
    message.includes("microphone access denied")
  );
}

function userFacingError(err, options = {}) {
  const { showMicDisabledHelp = false } = options;
  if (isMicrophonePermissionDenied(err) && showMicDisabledHelp) {
    if (isIOS()) {
      return "Mikrofonen är avstängd. Be en vuxin gå till Inställningar → Safari → Mikrofon och tillåt den.";
    }
    return "Tillåt mikrofonen i inställningarna!";
  }
  if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
    return "Det funkade inte riktigt. Försök igen med ett nytt tryck!";
  }
  if (err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError") {
    return "Hittar ingen mikrofon. Be en vuxin hjälpa!";
  }
  if (err?.name === "NotSupportedError") {
    return "Mikrofonen funkar inte här. Prova HTTPS eller en annan webbläsare!";
  }
  if (err?.message?.includes("Inspelningen") || err?.message?.includes("Mikrofonen startade")) {
    return err.message;
  }
  if (err?.message?.includes("OPENROUTER") || err?.message?.includes("failed")) {
    return "Misse är trött just nu. Försök igen!";
  }
  return "Oj då! Försök igen om en stund.";
}

async function getMicrophonePermissionState() {
  if (isIOS()) {
    return null;
  }
  if (!navigator.permissions?.query) {
    return null;
  }

  try {
    const permissionStatus = await navigator.permissions.query({ name: "microphone" });
    return permissionStatus?.state ?? null;
  } catch {
    return null;
  }
}

async function shouldShowMicDisabledWarning(err) {
  if (!isMicrophonePermissionDenied(err)) {
    return false;
  }

  const permissionState = await getMicrophonePermissionState();
  return isStrongMicDisabledSignal(err, permissionState);
}

async function getDisplayErrorMessage(err, context = {}) {
  const { attemptedStart = false, interactionId = null } = context;
  const finalize = (message, reason, extra = {}) => {
    voiceDebug("error.mapping.decision", {
      interactionId,
      attemptedStart,
      reason,
      mappedMessage: message,
      likelyTimeout: isLikelyTimeoutError(err),
      error: toLogError(err),
      ...extra,
    });
    return message;
  };
  let showMicDisabledHelp = false;
  const hasShortMessage = typeof err?.message === "string" && err.message.length < 120;
  if (hasShortMessage && !isMicrophonePermissionDenied(err) && attemptedStart) {
    return finalize(err.message, "short_message_passthrough");
  }

  if (attemptedStart && isMicrophonePermissionDenied(err)) {
    showMicDisabledHelp = await shouldShowMicDisabledWarning(err);
    if (!showMicDisabledHelp) {
      return finalize("Inspelningen kunde inte starta. Försök igen!", "mic_permission_start_transient");
    }
  }

  if (!attemptedStart && isMicrophonePermissionDenied(err)) {
    return finalize("Det funkade inte riktigt. Försök igen med ett nytt tryck!", "mic_permission_after_start");
  }

  return finalize(userFacingError(err, { showMicDisabledHelp }), "default_user_facing", {
    showMicDisabledHelp,
  });
}

async function unlockAudio() {
  voiceDebug("playback.unlock.start", {
    audioUnlocked,
    audioContextState: audioContext?.state ?? null,
  });

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      audioContext = audioContext || new AudioCtx();
      if (audioContext.state === "suspended") {
        await Promise.race([
          audioContext.resume(),
          new Promise((resolve) => setTimeout(resolve, 400)),
        ]);
      }
      const buffer = audioContext.createBuffer(1, 1, 22050);
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      source.start(0);
      voiceDebug("playback.unlock.webaudio_primed", {
        audioContextState: audioContext.state,
      });
    }

    if (!primedAudio) {
      primedAudio = new Audio(SILENT_MP3_DATA_URL);
      primedAudio.volume = 0.01;
      primedAudio.setAttribute("playsinline", "");
      primedAudio.setAttribute("webkit-playsinline", "");
    }
    primedAudio.currentTime = 0;
    await primedAudio.play();
    audioUnlocked = true;
    voiceDebug("playback.unlock.success", {
      audioContextState: audioContext?.state ?? null,
    });
  } catch (err) {
    voiceDebug(
      "playback.unlock.failure",
      { error: toLogError(err), audioContextState: audioContext?.state ?? null },
      "warn"
    );
  }
}

function createMediaRecorder(stream) {
  if (isIOS()) {
    const candidates = ["audio/mp4", undefined];
    voiceDebug("recording.mime.selection.start", { platform: "ios", candidates });
    for (const type of candidates) {
      try {
        if (
          type &&
          typeof MediaRecorder.isTypeSupported === "function" &&
          !MediaRecorder.isTypeSupported(type)
        ) {
          voiceDebug("recording.mime.selection.skip_unsupported", {
            platform: "ios",
            candidate: type,
          });
          continue;
        }
        const options = type ? { mimeType: type } : undefined;
        const recorder = new MediaRecorder(stream, options);
        const mimeType = recorder.mimeType || type || "audio/mp4";
        voiceDebug("recording.mime.selection.success", {
          platform: "ios",
          selectedMimeType: mimeType,
          selectedCandidate: type || "default",
        });
        return { recorder, mimeType };
      } catch {
        voiceDebug("recording.mime.selection.fallback", {
          platform: "ios",
          candidate: type || "default",
        });
        /* try next format */
      }
    }
    throw new Error("MediaRecorder is not supported in this browser");
  }

  const candidates = getRecorderMimeCandidates();
  voiceDebug("recording.mime.selection.start", { platform: "non-ios", candidates });
  for (const type of candidates) {
    if (type && !MediaRecorder.isTypeSupported(type)) {
      voiceDebug("recording.mime.selection.skip_unsupported", {
        platform: "non-ios",
        candidate: type,
      });
      continue;
    }

    try {
      const options = type ? { mimeType: type } : undefined;
      const recorder = new MediaRecorder(stream, options);
      const mimeType = type || recorder.mimeType || "audio/webm";
      voiceDebug("recording.mime.selection.success", {
        platform: "non-ios",
        selectedMimeType: mimeType,
        selectedCandidate: type || "default",
      });
      return { recorder, mimeType };
    } catch {
      voiceDebug("recording.mime.selection.fallback", {
        platform: "non-ios",
        candidate: type || "default",
      });
      /* try next format */
    }
  }

  throw new Error("MediaRecorder is not supported in this browser");
}

function waitForRecorderStart(recorder, interactionId = null) {
  return new Promise((resolve, reject) => {
    if (recorder.state === "recording") {
      voiceDebug("recording.start.success", { interactionId, via: "already_recording_state" });
      resolve();
      return;
    }

    const timeoutMs = 8000;
    const timeoutStartedAt = Date.now();
    voiceDebug("timeout.start", {
      interactionId,
      timeoutName: "recorder_start",
      timeoutMs,
    });

    const timeout = setTimeout(() => {
      voiceDebug("timeout.trigger", {
        interactionId,
        timeoutName: "recorder_start",
        timeoutMs,
        elapsedMs: Date.now() - timeoutStartedAt,
      });
      reject(new Error("Inspelningen startade inte. Försök igen!"));
    }, timeoutMs);

    recorder.onstart = () => {
      clearTimeout(timeout);
      voiceDebug("timeout.cancel", {
        interactionId,
        timeoutName: "recorder_start",
        timeoutMs,
        reason: "recorder_onstart",
      });
      voiceDebug("recording.start.success", { interactionId, via: "recorder_onstart" });
      resolve();
    };

    recorder.onerror = (event) => {
      clearTimeout(timeout);
      voiceDebug("timeout.cancel", {
        interactionId,
        timeoutName: "recorder_start",
        timeoutMs,
        reason: "recorder_onerror",
      });
      voiceDebug("recording.start.failure", {
        interactionId,
        stage: "recorder_onerror",
        error: toLogError(event.error || new Error("Inspelningen misslyckades")),
      });
      reject(event.error || new Error("Inspelningen misslyckades"));
    };

    try {
      recorder.start(isIOS() ? 250 : 250);
    } catch (err) {
      clearTimeout(timeout);
      voiceDebug("timeout.cancel", {
        interactionId,
        timeoutName: "recorder_start",
        timeoutMs,
        reason: "recorder_start_threw",
      });
      voiceDebug("recording.start.failure", {
        interactionId,
        stage: "recorder_start_threw",
        error: toLogError(err),
      });
      reject(err);
    }
  });
}

function releaseMicrophone() {
  recordingSession += 1;
  micAccessPromise = null;

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch {
      /* already stopped */
    }
  }
  mediaRecorder = null;
  recordedChunks = [];

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}

function requestMicrophoneSync() {
  if (micAccessPromise) {
    return micAccessPromise;
  }

  // Drop stale stream/recorder from a previous turn; keep active PREPARING requests intact.
  if (mediaRecorder || mediaStream) {
    releaseMicrophone();
  }

  // Must invoke getUserMedia synchronously during the tap/click handler on iOS.
  const request = navigator.mediaDevices.getUserMedia(getAudioConstraints());
  micAccessPromise = request;
  request.finally(() => {
    if (micAccessPromise === request) {
      micAccessPromise = null;
    }
  });
  return request;
}

function waitForLiveAudioTrack(stream, timeoutMs = isIOS() ? 3000 : 1500) {
  return new Promise((resolve, reject) => {
    const track = stream.getAudioTracks()[0];
    if (!track) {
      reject(new Error("Mikrofonen startade inte. Försök igen!"));
      return;
    }
    if (track.readyState === "live") {
      resolve(track);
      return;
    }

    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (track.readyState === "live") {
        resolve(track);
        return;
      }
      if (track.readyState === "ended" || Date.now() >= deadline) {
        reject(new Error("Mikrofonen startade inte. Försök igen!"));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function getAudioConstraints() {
  if (isIOS()) {
    return { audio: true, video: false };
  }
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  };
}

async function startRecording(micPromise, session = recordingSession, interactionId = activeInteractionId) {
  voiceDebug("recording.start.attempt", {
    interactionId,
    session,
    hasExistingMicPromise: Boolean(micPromise),
  });
  const capabilityError = checkCapabilities();
  if (capabilityError) {
    voiceDebug("recording.start.failure", {
      interactionId,
      stage: "capability_check",
      error: { name: "CapabilityError", message: capabilityError },
    });
    throw new Error(capabilityError);
  }

  const pendingMic = micPromise || requestMicrophoneSync();
  const micTimeoutMs = 20000;
  let micTimeoutHandle = null;
  let micTimeoutFired = false;
  const micTimeoutStartedAt = Date.now();
  voiceDebug("timeout.start", {
    interactionId,
    timeoutName: "microphone_get_user_media",
    timeoutMs: micTimeoutMs,
  });

  const micTimeoutPromise = new Promise((_, reject) => {
    micTimeoutHandle = setTimeout(() => {
      micTimeoutFired = true;
      voiceDebug("timeout.trigger", {
        interactionId,
        timeoutName: "microphone_get_user_media",
        timeoutMs: micTimeoutMs,
        elapsedMs: Date.now() - micTimeoutStartedAt,
      });
      reject(new Error("Mikrofonen svarade inte. Försök igen!"));
    }, micTimeoutMs);
  });
  let stream;
  try {
    stream = await Promise.race([pendingMic, micTimeoutPromise]);
    if (!micTimeoutFired && micTimeoutHandle) {
      clearTimeout(micTimeoutHandle);
      voiceDebug("timeout.cancel", {
        interactionId,
        timeoutName: "microphone_get_user_media",
        timeoutMs: micTimeoutMs,
        reason: "microphone_stream_received",
      });
    }
  } catch (err) {
    if (!micTimeoutFired && micTimeoutHandle) {
      clearTimeout(micTimeoutHandle);
      voiceDebug("timeout.cancel", {
        interactionId,
        timeoutName: "microphone_get_user_media",
        timeoutMs: micTimeoutMs,
        reason: "microphone_request_failed_early",
      });
    }
    voiceDebug("recording.start.failure", {
      interactionId,
      stage: "await_get_user_media",
      timeoutFired: micTimeoutFired,
      error: toLogError(err),
    });
    const micError = err instanceof Error ? err : new Error(String(err));
    micError.fromGetUserMedia = true;
    throw micError;
  }

  if (session !== recordingSession) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  mediaStream = stream;
  await waitForLiveAudioTrack(stream);

  if (session !== recordingSession) {
    releaseMicrophone();
    return;
  }

  recordedChunks = [];
  const { recorder, mimeType } = createMediaRecorder(mediaStream);
  recordingMimeType = mimeType;
  mediaRecorder = recorder;
  voiceDebug("recording.start.recorder_ready", {
    interactionId,
    mimeType,
    streamTrackCount: mediaStream.getAudioTracks().length,
  });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data?.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  await waitForRecorderStart(recorder, interactionId);

  if (session !== recordingSession) {
    releaseMicrophone();
    return;
  }

  setState(State.LISTENING);
  voiceDebug("recording.start.success", {
    interactionId,
    state: State.LISTENING,
  });
}

function buildRecordingBlob(recorder) {
  const type = (recordingMimeType || recorder.mimeType || "audio/mp4").split(";")[0];
  return new Blob(recordedChunks, { type });
}

function stopRecording(interactionId = null) {
  voiceDebug("recording.stop.initiated", {
    interactionId,
    recorderState: mediaRecorder?.state || "missing",
  });
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      voiceDebug("recording.stop.noop", { interactionId });
      resolve(null);
      return;
    }

    const recorder = mediaRecorder;

    recorder.onstop = () => {
      const tryFinalize = (attempt = 0) => {
        const blob = buildRecordingBlob(recorder);
        if (blob.size > 0 || attempt >= 8) {
          mediaRecorder = null;
          voiceDebug("recording.stop.finalized", {
            interactionId,
            blobBytes: blob.size,
            attempts: attempt + 1,
            success: blob.size > 0,
          });
          resolve(blob.size > 0 ? blob : null);
          return;
        }
        if (attempt > 0) {
          voiceDebug("recording.stop.retry_wait_for_blob", {
            interactionId,
            attempt: attempt + 1,
          });
        }
        setTimeout(() => tryFinalize(attempt + 1), isIOS() ? 200 : 100);
      };
      setTimeout(() => tryFinalize(), isIOS() ? 150 : 50);
    };

    try {
      if (typeof recorder.requestData === "function" && recorder.state === "recording") {
        voiceDebug("recording.stop.request_data", { interactionId });
        recorder.requestData();
      }
      recorder.stop();
    } catch {
      voiceDebug("recording.stop.failure", {
        interactionId,
        stage: "recorder_stop_threw",
      });
      mediaRecorder = null;
      resolve(null);
    }
  });
}

function revokeCurrentAudioUrl() {
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

function stopCurrentPlayback() {
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch {
      /* already stopped */
    }
    try {
      currentAudioSource.disconnect();
    } catch {
      /* already disconnected */
    }
    currentAudioSource = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio = null;
  }
  revokeCurrentAudioUrl();
}

async function ensurePlaybackAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw wrapPlaybackError(new Error("Web Audio not supported"));
  }
  audioContext = audioContext || new AudioCtx();
  if (audioContext.state === "suspended") {
    voiceDebug("playback.play.resume_context", { state: audioContext.state });
    await audioContext.resume();
  }
  return audioContext;
}

async function playResponseViaWebAudio(bytes, mimeType) {
  const ctx = await ensurePlaybackAudioContext();
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } catch (err) {
    throw wrapPlaybackError(err);
  }

  voiceDebug("playback.play.decoded", {
    via: "webaudio",
    mimeType,
    durationSec: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    audioContextState: ctx.state,
  });

  setState(State.TALKING);

  await Promise.race([
    new Promise((resolve, reject) => {
      const source = ctx.createBufferSource();
      currentAudioSource = source;
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = resolve;
      try {
        source.start(0);
        voiceDebug("playback.play.started", { via: "webaudio" });
      } catch (err) {
        reject(wrapPlaybackError(err));
      }
    }),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(wrapPlaybackError(new Error("Audio playback timeout"))),
        90000
      );
    }),
  ]);

  voiceDebug("playback.play.completed", { via: "webaudio" });
}

async function playResponseViaHtmlAudio(bytes, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  currentAudioUrl = URL.createObjectURL(blob);
  currentAudio = new Audio(currentAudioUrl);
  currentAudio.setAttribute("playsinline", "");
  currentAudio.setAttribute("webkit-playsinline", "");

  setState(State.TALKING);

  await Promise.race([
    new Promise((resolve, reject) => {
      currentAudio.onended = resolve;
      currentAudio.onerror = () =>
        reject(wrapPlaybackError(new Error("Audio playback failed")));
      currentAudio.play().catch((err) => reject(wrapPlaybackError(err)));
    }),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(wrapPlaybackError(new Error("Audio playback timeout"))),
        90000
      );
    }),
  ]);

  voiceDebug("playback.play.completed", { via: "htmlaudio" });
}

async function playResponseAudio(base64, mimeType = "audio/wav") {
  stopCurrentPlayback();

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  voiceDebug("playback.play.start", {
    mimeType,
    bytes: bytes.length,
    audioUnlocked,
    audioContextState: audioContext?.state ?? null,
  });

  try {
    await playResponseViaWebAudio(bytes, mimeType);
  } catch (webAudioErr) {
    voiceDebug(
      "playback.play.webaudio_failed",
      { error: toLogError(webAudioErr), mimeType },
      "warn"
    );
    voiceDebug("playback.play.fallback_html", { mimeType });
    await playResponseViaHtmlAudio(bytes, mimeType);
  } finally {
    stopCurrentPlayback();
  }
}

async function sendRecording(blob, interactionId = null) {
  setState(State.THINKING);

  const format = (blob.type || recordingMimeType || "mp4").replace("audio/", "");
  const ext = format.split(";")[0] || "mp4";
  const formData = new FormData();
  formData.append("audio", blob, `recording.${ext}`);
  formData.append("format", ext);

  let response;
  const requestStartedAt = Date.now();
  voiceDebug("send.request.start", {
    interactionId,
    endpoint: "/api/talk",
    method: "POST",
    blobBytes: blob.size,
    blobType: blob.type || null,
    requestTimeoutMs: null,
    hasClientRequestTimeout: false,
  });
  try {
    response = await fetch("/api/talk", {
      method: "POST",
      body: formData,
      headers: {
        "X-Voice-Interaction-Id": interactionId || "unknown",
      },
    });
    voiceDebug("send.request.end", {
      interactionId,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - requestStartedAt,
    });
  } catch (err) {
    voiceDebug("send.request.failure", {
      interactionId,
      durationMs: Date.now() - requestStartedAt,
      requestTimeoutFired: false,
      error: toLogError(err),
    });
    throw new Error("Kunde inte nå servern. Kolla att appen är igång!");
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    voiceDebug("send.response.parse_error", {
      interactionId,
      status: response.status,
      contentType: response.headers.get("content-type") || null,
      error: toLogError(err),
    });
    throw new Error("Servern svarade konstigt. Försök igen!");
  }

  voiceDebug("send.response.parsed", {
    interactionId,
    status: response.status,
    ok: response.ok,
    hasErrorField: Boolean(data?.error),
    hasAudioBase64: Boolean(data?.audioBase64),
    serverLatencyMs: typeof data?.latencyMs === "number" ? data.latencyMs : null,
  });

  if (!response.ok) {
    voiceDebug("send.response.not_ok", {
      interactionId,
      status: response.status,
      hasErrorField: Boolean(data?.error),
    });
    throw new Error(data.error || "Något gick fel");
  }

  if (data.audioBase64) {
    try {
      await playResponseAudio(data.audioBase64, data.audioMimeType || "audio/wav");
      return { playbackOk: true };
    } catch (err) {
      voiceDebug(
        "send.playback.failure",
        {
          interactionId,
          serverSucceeded: true,
          likelyAutoplayBlocked: isLikelyAutoplayBlockedError(err),
          error: toLogError(err),
        },
        "warn"
      );
      return { playbackOk: false, playbackError: err };
    }
  }

  return { playbackOk: true };
}

async function handleTalkButton() {
  // Prime audio during the user gesture (required for delayed playback on iOS Safari).
  unlockAudio().catch(() => {});

  if (busy || state === State.THINKING || state === State.TALKING || state === State.PREPARING) {
    voiceDebug("interaction.ignored", {
      reason: "busy_or_locked_state",
      busy,
      state,
      interactionId: activeInteractionId,
    });
    return;
  }

  busy = true;
  let attemptedStart = false;
  let interactionId = activeInteractionId;

  try {
    if (state === State.LISTENING) {
      interactionId = activeInteractionId || createVoiceInteractionId();
      voiceDebug("send.initiated", {
        interactionId,
        fromState: State.LISTENING,
      });
      statusEl.textContent = "Skickar till Misse…";
      talkButton.disabled = true;

      const blob = await stopRecording(interactionId);
      releaseMicrophone();

      if (!blob) {
        voiceDebug("send.aborted.empty_recording", { interactionId });
        setState(State.IDLE);
        showStatusMessage("Jag hörde inget — försök igen!");
        activeInteractionId = null;
        return;
      }
      const sendResult = await sendRecording(blob, interactionId);
      if (sendResult?.playbackOk === false) {
        voiceDebug("interaction.completed", {
          interactionId,
          result: "playback_failed",
          serverSucceeded: true,
        });
        setState(State.IDLE);
        showStatusMessage(getPlaybackFailureMessage(sendResult.playbackError));
      } else {
        voiceDebug("interaction.completed", { interactionId, result: "success" });
        setState(State.IDLE);
      }
      activeInteractionId = null;
    } else {
      // Call getUserMedia before any async work or UI updates (iOS user-gesture requirement).
      attemptedStart = true;
      interactionId = createVoiceInteractionId();
      activeInteractionId = interactionId;
      voiceDebug("recording.start.initiated", {
        interactionId,
        fromState: state,
      });
      const micPromise = requestMicrophoneSync();
      const session = recordingSession;
      setState(State.PREPARING);
      await startRecording(micPromise, session, interactionId);
    }
  } catch (err) {
    voiceDebug("interaction.error", {
      interactionId,
      attemptedStart,
      likelyTimeout: isLikelyTimeoutError(err),
      error: toLogError(err),
    }, "error");
    console.error(err);
    releaseMicrophone();
    setState(State.IDLE);
    const message = await getDisplayErrorMessage(err, { attemptedStart, interactionId });
    showStatusMessage(message);
    activeInteractionId = null;
  } finally {
    busy = false;
  }
}

function bindTalkActivation() {
  let lastActivation = 0;

  const activate = (event) => {
    event.preventDefault();
    const now = Date.now();
    if (now - lastActivation < 300) return;
    lastActivation = now;
    handleTalkButton();
  };

  if (isIOS()) {
    // touchend keeps the user-gesture chain for getUserMedia on iPhone Safari.
    talkButton.addEventListener(
      "touchend",
      (event) => {
        if (event.cancelable) {
          event.preventDefault();
        }
        activate(event);
      },
      { passive: false }
    );
  } else {
    talkButton.addEventListener("click", activate, { passive: false });
  }
  talkButton.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      activate(event);
    }
  });
}

async function checkServerHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    if (!response.ok || !data.ok) {
      showStatusMessage("Servern är inte redo. Be en vuxin starta appen!");
      talkButton.disabled = true;
      return;
    }
    if (!data.hasApiKey) {
      showStatusMessage("Misse saknar sin magi (API-nyckel). Be en vuxin fixa!");
      talkButton.disabled = true;
    }
  } catch {
    showStatusMessage("Kan inte nå servern. Starta appen och försök igen!");
    talkButton.disabled = true;
  }
}

function init() {
  if (!cat || !statusEl || !talkButton || !talkButtonLabel) {
    if (statusEl) {
      statusEl.textContent = "Appen är trasig. Ladda om sidan!";
    }
    return;
  }

  const capabilityError = checkCapabilities();
  if (capabilityError) {
    setState(State.IDLE);
    showStatusMessage(capabilityError);
    talkButton.disabled = true;
    return;
  }

  bindTalkActivation();
  setState(State.IDLE);
  checkServerHealth();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioContext?.state === "suspended") {
    audioContext.resume().catch(() => {});
  }
});

window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;

  releaseMicrophone();
  busy = false;
  if (state === State.PREPARING || state === State.LISTENING) {
    setState(State.IDLE);
  }
  if (audioContext?.state === "suspended") {
    audioContext.resume().catch(() => {});
  }
});

window.addEventListener("beforeunload", () => {
  releaseMicrophone();
  revokeCurrentAudioUrl();
});

init();
