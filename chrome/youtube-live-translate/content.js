const playerSelector = ".html5-video-player";
const videoSelector = "video.html5-main-video";
const subtitlesButtonSelector = ".ytp-subtitles-button";
const overlayClassName = "local-agent-youtube-overlay";
const overlayEnglishClassName = "local-agent-youtube-overlay-english";
const overlayTranslationClassName = "local-agent-youtube-overlay-translation";
const nativeHiddenClassName = "local-agent-youtube-native-hidden";
const activeSegmentEpsilon = 0.18;
const windowBeforeSeconds = 4;
const windowAfterSeconds = 24;
const windowRefreshLeadSeconds = 10;

let currentVideoId = "";
let currentTimeline = null;
let currentTimelineToken = 0;
let windowPrefetchInFlight = false;
let renderTimer = 0;
let lastEnglishText = "";
let lastTranslationText = "";
let overlayVisible = false;

bootstrap();

function bootstrap() {
  ensureRenderLoop();
  bindPageEvents();
  syncVideoState();
}

function ensureRenderLoop() {
  if (renderTimer) {
    return;
  }

  renderTimer = window.setInterval(() => {
    syncVideoState();
    renderFrame();
  }, 80);
}

function bindPageEvents() {
  window.addEventListener("resize", renderFrame, { passive: true });
  document.addEventListener("fullscreenchange", renderFrame);
  document.addEventListener("yt-navigate-finish", () => {
    resetVideoState();
    syncVideoState();
    renderFrame();
  });
}

function syncVideoState() {
  const videoId = getVideoId();

  if (videoId === currentVideoId) {
    maybeRefreshWindow();
    return;
  }

  resetVideoState();
  currentVideoId = videoId;

  if (!currentVideoId) {
    return;
  }

  void fetchWindowTimeline();
}

function resetVideoState() {
  currentVideoId = "";
  currentTimeline = null;
  currentTimelineToken += 1;
  windowPrefetchInFlight = false;
  lastEnglishText = "";
  lastTranslationText = "";
  overlayVisible = false;
  showNativeCaptions();
  hideOverlay();
}

function renderFrame() {
  const player = getPlayer();
  const video = getVideo();

  if (!player || !video || !isSubtitlesEnabled()) {
    showNativeCaptions();
    hideOverlay();
    return;
  }

  if (!currentTimeline || !Array.isArray(currentTimeline.segments) || !currentTimeline.segments.length) {
    showNativeCaptions();
    hideOverlay();
    return;
  }

  const activeSegments = getActiveSegmentsAtTime(currentTimeline.segments, video.currentTime);

  if (!activeSegments.length) {
    showNativeCaptions();
    hideOverlay();
    return;
  }

  const overlay = ensureOverlay(player);
  const englishNode = overlay.querySelector(`.${overlayEnglishClassName}`);
  const translationNode = overlay.querySelector(`.${overlayTranslationClassName}`);

  if (!(englishNode instanceof HTMLElement) || !(translationNode instanceof HTMLElement)) {
    return;
  }

  const nextEnglishText = normalizeText(activeSegments.map((segment) => segment.sourceText).join("\n"));
  const nextTranslationText = normalizeText(
    activeSegments.map((segment) => segment.translation).join("\n")
  );

  if (nextEnglishText !== lastEnglishText) {
    englishNode.textContent = nextEnglishText;
    lastEnglishText = nextEnglishText;
  }

  if (nextTranslationText !== lastTranslationText) {
    translationNode.textContent = nextTranslationText;
    lastTranslationText = nextTranslationText;
  }

  if (!overlayVisible) {
    overlay.dataset.state = "ready";
    overlay.removeAttribute("hidden");
    overlayVisible = true;
  }

  hideNativeCaptions(player);
}

function maybeRefreshWindow() {
  if (windowPrefetchInFlight || !currentVideoId || !currentTimeline) {
    return;
  }

  const video = getVideo();

  if (!(video instanceof HTMLVideoElement)) {
    return;
  }

  const currentTime = video.currentTime;

  if (!Number.isFinite(currentTime)) {
    return;
  }

  if (currentTimeline.complete) {
    return;
  }

  if (
    currentTime < currentTimeline.rangeStart + 0.5 ||
    currentTime > currentTimeline.rangeEnd - windowRefreshLeadSeconds
  ) {
    void fetchWindowTimeline();
  }
}

async function fetchWindowTimeline() {
  if (!currentVideoId) {
    return;
  }

  const video = getVideo();

  if (!(video instanceof HTMLVideoElement)) {
    return;
  }

  const token = ++currentTimelineToken;
  windowPrefetchInFlight = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "prefetch-window",
      videoId: currentVideoId,
      url: window.location.href,
      currentTime: video.currentTime,
      windowBeforeSeconds,
      windowAfterSeconds
    });

    if (!response || !response.ok) {
      return;
    }

    if (token !== currentTimelineToken || currentVideoId !== getVideoId()) {
      return;
    }

    currentTimeline = normalizeTimeline(response);
    renderFrame();
  } catch (_error) {
    // keep native captions visible on failure
  } finally {
    windowPrefetchInFlight = false;
  }
}

function ensureOverlay(player) {
  let overlay = player.querySelector(`.${overlayClassName}`);

  if (overlay instanceof HTMLElement) {
    return overlay;
  }

  overlay = document.createElement("div");
  overlay.className = overlayClassName;
  overlay.dataset.state = "pending";
  overlay.setAttribute("hidden", "hidden");
  overlay.setAttribute("aria-hidden", "true");

  const english = document.createElement("div");
  english.className = overlayEnglishClassName;
  overlay.appendChild(english);

  const translation = document.createElement("div");
  translation.className = overlayTranslationClassName;
  overlay.appendChild(translation);

  player.appendChild(overlay);

  return overlay;
}

function hideOverlay() {
  const overlay = document.querySelector(`.${overlayClassName}`);

  if (overlay instanceof HTMLElement) {
    if (!overlay.hasAttribute("hidden")) {
      overlay.setAttribute("hidden", "hidden");
    }
  }

  overlayVisible = false;
}

function hideNativeCaptions(player) {
  if (!player.classList.contains(nativeHiddenClassName)) {
    player.classList.add(nativeHiddenClassName);
  }
}

function showNativeCaptions() {
  const player = getPlayer();

  if (player && player.classList.contains(nativeHiddenClassName)) {
    player.classList.remove(nativeHiddenClassName);
  }
}

function getActiveSegmentsAtTime(segments, currentTime) {
  const activeSegments = [];

  for (const segment of segments) {
    const start = Number(segment.offset) || 0;
    const end = start + (Number(segment.duration) || 0);

    if (start - activeSegmentEpsilon > currentTime) {
      break;
    }

    if (currentTime + activeSegmentEpsilon < start) {
      continue;
    }

    if (currentTime - activeSegmentEpsilon > end) {
      continue;
    }

    activeSegments.push(segment);

    if (activeSegments.length >= 3) {
      break;
    }
  }

  if (activeSegments.length <= 1) {
    return activeSegments;
  }

  const latestStart = activeSegments.reduce(
    (currentMax, segment) => Math.max(currentMax, Number(segment.offset) || 0),
    Number.NEGATIVE_INFINITY
  );

  return activeSegments.filter(
    (segment) => Math.abs((Number(segment.offset) || 0) - latestStart) < 0.02
  );
}

function normalizeTimeline(payload) {
  return {
    videoId: typeof payload.videoId === "string" ? payload.videoId.trim() : "",
    videoUrl: typeof payload.videoUrl === "string" ? payload.videoUrl.trim() : "",
    title: typeof payload.title === "string" ? payload.title : "",
    author: typeof payload.author === "string" ? payload.author : "",
    sourceLanguage: typeof payload.sourceLanguage === "string" ? payload.sourceLanguage : "en",
    model: typeof payload.model === "string" ? payload.model : "",
    cached: Boolean(payload.cached),
    complete: Boolean(payload.complete),
    rangeStart: Number.isFinite(payload.rangeStart) ? Number(payload.rangeStart) : 0,
    rangeEnd: Number.isFinite(payload.rangeEnd) ? Number(payload.rangeEnd) : 0,
    segments: Array.isArray(payload.segments)
      ? payload.segments
          .map((segment) => ({
            offset: Number.isFinite(segment.offset) ? Number(segment.offset) : 0,
            duration: Number.isFinite(segment.duration) ? Number(segment.duration) : 0,
            sourceText: normalizeText(segment.sourceText),
            translation: normalizeText(segment.translation)
          }))
          .filter((segment) => segment.sourceText)
      : []
  };
}

function isSubtitlesEnabled() {
  const button = document.querySelector(subtitlesButtonSelector);

  return button instanceof HTMLElement && button.getAttribute("aria-pressed") === "true";
}

function getPlayer() {
  const player = document.querySelector(playerSelector);
  return player instanceof HTMLElement ? player : null;
}

function getVideo() {
  const video = document.querySelector(videoSelector);
  return video instanceof HTMLVideoElement ? video : null;
}

function getVideoId() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}
