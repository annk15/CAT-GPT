/**
 * Client talk-button state machine contract (mirrors public/js/app.js guards).
 * Run: node scripts/test-recording-state.js
 */

const State = {
  IDLE: "idle",
  PREPARING: "preparing",
  LISTENING: "listening",
  THINKING: "thinking",
  TALKING: "talking",
};

function canActivateTalkButton({ busy, state }) {
  return (
    !busy &&
    state !== State.THINKING &&
    state !== State.TALKING &&
    state !== State.PREPARING
  );
}

function actionOnTap(state) {
  if (state === State.LISTENING) return "stop-and-send";
  if (state === State.IDLE) return "start-recording";
  return null;
}

function isRecordingUsable(blob) {
  return Boolean(blob && blob.size > 0);
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

function deriveDisplayErrorMessage({ err, attemptedStart, permissionState }) {
  if (attemptedStart && isMicrophonePermissionDenied(err)) {
    if (!isStrongMicDisabledSignal(err, permissionState)) {
      return "Inspelningen kunde inte starta. Försök igen!";
    }
    return "Mikrofonen är avstängd.";
  }

  if (!attemptedStart && isMicrophonePermissionDenied(err)) {
    return "Det funkade inte riktigt. Försök igen med ett nytt tryck!";
  }

  if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
    return "Det funkade inte riktigt. Försök igen med ett nytt tryck!";
  }

  return "Other";
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

function getPlaybackFailureMessage(err) {
  if (isLikelyAutoplayBlockedError(err)) {
    return "Misse svarade! Tryck knappen igen om du inte hörde mig.";
  }
  return "Misse svarade men ljudet strulade. Försök igen!";
}

function classifySendResult({ serverOk, playbackOk, playbackError }) {
  if (!serverOk) return "server_failed";
  if (playbackOk === false) return "playback_failed";
  return "success";
}

const tests = [
  {
    name: "IDLE tap starts recording",
    run: () => canActivateTalkButton({ busy: false, state: State.IDLE }) && actionOnTap(State.IDLE) === "start-recording",
  },
  {
    name: "LISTENING tap stops and sends",
    run: () => canActivateTalkButton({ busy: false, state: State.LISTENING }) && actionOnTap(State.LISTENING) === "stop-and-send",
  },
  {
    name: "THINKING ignores tap",
    run: () => !canActivateTalkButton({ busy: false, state: State.THINKING }),
  },
  {
    name: "TALKING ignores tap",
    run: () => !canActivateTalkButton({ busy: false, state: State.TALKING }),
  },
  {
    name: "PREPARING ignores tap",
    run: () => !canActivateTalkButton({ busy: false, state: State.PREPARING }),
  },
  {
    name: "busy ignores tap in LISTENING",
    run: () => !canActivateTalkButton({ busy: true, state: State.LISTENING }),
  },
  {
    name: "after turn completes, IDLE accepts tap again",
    run: () => {
      let state = State.IDLE;
      let busy = false;
      if (!canActivateTalkButton({ busy, state })) return false;
      state = State.LISTENING;
      busy = true;
      busy = false;
      if (!canActivateTalkButton({ busy, state })) return false;
      state = State.THINKING;
      busy = true;
      state = State.TALKING;
      state = State.IDLE;
      busy = false;
      return canActivateTalkButton({ busy, state }) && actionOnTap(state) === "start-recording";
    },
  },
  {
    name: "any non-empty blob is accepted",
    run: () => isRecordingUsable({ size: 1 }) && !isRecordingUsable(null) && !isRecordingUsable({ size: 0 }),
  },
  {
    name: "mic release allows fresh start (no cached stream contract)",
    run: () => {
      let mediaStream = { tracks: [{ stop() {} }] };
      const release = () => {
        mediaStream = null;
      };
      release();
      return mediaStream === null;
    },
  },
  {
    name: "mic-disabled warning only for strong denied signal",
    run: () => {
      const deniedError = { fromGetUserMedia: true, name: "NotAllowedError" };
      const deniedByMessageError = {
        fromGetUserMedia: true,
        name: "NotAllowedError",
        message: "Permission denied by system",
      };
      const transientError = { fromGetUserMedia: true, name: "NotAllowedError", message: "gesture required" };
      const nonMicError = { fromGetUserMedia: false, name: "NotAllowedError" };
      return (
        isStrongMicDisabledSignal(deniedError, "denied") &&
        isStrongMicDisabledSignal(deniedByMessageError, "prompt") &&
        !isStrongMicDisabledSignal(transientError, "prompt") &&
        !isStrongMicDisabledSignal(transientError, null) &&
        !isStrongMicDisabledSignal(nonMicError, "denied")
      );
    },
  },
  {
    name: "post-send autoplay block gets playback copy, not generic failure",
    run: () => {
      const playbackError = { name: "NotAllowedError", fromGetUserMedia: false };
      return (
        getPlaybackFailureMessage(playbackError) ===
          "Misse svarade! Tryck knappen igen om du inte hörde mig." &&
        deriveDisplayErrorMessage({
          err: playbackError,
          attemptedStart: false,
          permissionState: null,
        }) === "Det funkade inte riktigt. Försök igen med ett nytt tryck!"
      );
    },
  },
  {
    name: "server success with playback failure is not server_failed",
    run: () =>
      classifySendResult({ serverOk: true, playbackOk: false, playbackError: { name: "NotAllowedError" } }) ===
      "playback_failed",
  },
  {
    name: "generic playback failure gets retry copy",
    run: () =>
      getPlaybackFailureMessage(new Error("Audio playback failed")) ===
      "Misse svarade men ljudet strulade. Försök igen!",
  },
  {
    name: "start NotAllowedError keeps startup retry copy",
    run: () => {
      const startError = { name: "NotAllowedError", fromGetUserMedia: true, message: "gesture required" };
      return (
        deriveDisplayErrorMessage({
          err: startError,
          attemptedStart: true,
          permissionState: "prompt",
        }) === "Inspelningen kunde inte starta. Försök igen!"
      );
    },
  },
  {
    name: "timeout classifier catches Swedish timeout copy",
    run: () => {
      const timeoutError = { name: "Error", message: "Mikrofonen svarade inte. Försök igen!" };
      return isLikelyTimeoutError(timeoutError);
    },
  },
  {
    name: "timeout classifier ignores regular permission error",
    run: () => {
      const regularError = { name: "NotAllowedError", message: "User denied microphone access" };
      return !isLikelyTimeoutError(regularError);
    },
  },
];

let failed = 0;
for (const test of tests) {
  const ok = Boolean(test.run());
  console.log(`[${ok ? "PASS" : "FAIL"}] ${test.name}`);
  if (!ok) failed++;
}

console.log(`\n${tests.length - failed}/${tests.length} passed\n`);
process.exit(failed > 0 ? 1 : 0);
