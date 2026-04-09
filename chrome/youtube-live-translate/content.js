const playerSelector = ".html5-video-player";
const videoSelector = "video.html5-main-video";
const subtitlesButtonSelector = ".ytp-subtitles-button";
const nativeCaptionContainerSelector = ".ytp-caption-window-container";
const overlayClassName = "youtube-live-translate-overlay";
const overlaySelectableClassName = "youtube-live-translate-overlay-selectable";
const overlayEnglishClassName = "youtube-live-translate-overlay-english";
const overlayTranslationClassName = "youtube-live-translate-overlay-translation";
const nativeHiddenClassName = "youtube-live-translate-native-hidden";
const activeSegmentEpsilon = 0.18;
const windowBeforeSeconds = 4;
const windowAfterSeconds = 24;
const windowRefreshLeadSeconds = 10;
const liveWindowRefreshIntervalMs = 1200;
const untranslatedSegmentRetryMs = 450;
const liveCaptionHoldMs = 350;

let currentVideoId = "";
let currentTimeline = null;
let currentTimelineToken = 0;
let windowPrefetchInFlight = false;
let renderTimer = 0;
let lastEnglishText = "";
let lastTranslationText = "";
let overlayVisible = false;
let nativeCaptionObserver = null;
let observedNativeCaptionContainer = null;
let liveCaptionRefreshFrame = 0;
let currentLiveCaptionText = "";
let currentLiveCaptionTranslation = "";
let currentLiveCaptionToken = 0;
let currentLiveCaptionRequestedToken = 0;
let currentLiveCaptionRequestSequence = 0;
let currentLiveCaptionSeenAt = 0;

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
  resetLiveCaptionState();
  disconnectNativeCaptionObserver();
  showNativeCaptions();
  hideOverlay();
}

function renderFrame() {
  const player = getPlayer();
  const video = getVideo();

  syncNativeCaptionObserver(player);

  if (!player || !video || !isSubtitlesEnabled()) {
    showNativeCaptions();
    hideOverlay();
    return;
  }

  if (shouldUseLiveCaptionFlow(video)) {
    maybeRequestLiveCaptionTranslation(video);

    if (renderLiveCaptionFrame(player, video)) {
      return;
    }
  }

  if (!currentTimeline || !Array.isArray(currentTimeline.segments) || !currentTimeline.segments.length) {
    showNativeCaptions();
    hideOverlay();
    return;
  }

  const activeSegments = getActiveSegmentsAtTime(currentTimeline.segments, video.currentTime);
  const preparedSegments = activeSegments.filter((segment) => normalizeText(segment.translation));

  if (!activeSegments.length || preparedSegments.length !== activeSegments.length) {
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

  updateOverlaySelectionState(overlay, video.paused);

  const nextEnglishText = normalizeText(preparedSegments.map((segment) => segment.sourceText).join("\n"));
  const nextTranslationText = normalizeText(
    preparedSegments.map((segment) => segment.translation).join("\n")
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

  if (video.paused) {
    return;
  }

  const currentTime = video.currentTime;

  if (!Number.isFinite(currentTime)) {
    return;
  }

  if (currentTimeline.complete) {
    return;
  }

  if (currentTimeline.live) {
    const activeSegments = getActiveSegmentsAtTime(currentTimeline.segments, currentTime);
    const hasUntranslatedActiveSegment = activeSegments.some((segment) => !normalizeText(segment.translation));
    const timelineAgeMs = Date.now() - (Number(currentTimeline.generatedAt) || 0);

    if (
      timelineAgeMs >= liveWindowRefreshIntervalMs ||
      (hasUntranslatedActiveSegment && timelineAgeMs >= untranslatedSegmentRetryMs)
    ) {
      void fetchWindowTimeline();
      return;
    }
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

function renderLiveCaptionFrame(player, video) {
  if (!currentLiveCaptionText) {
    return false;
  }

  if (!currentLiveCaptionTranslation && !video.paused) {
    return false;
  }

  const overlay = ensureOverlay(player);
  const englishNode = overlay.querySelector(`.${overlayEnglishClassName}`);
  const translationNode = overlay.querySelector(`.${overlayTranslationClassName}`);

  if (!(englishNode instanceof HTMLElement) || !(translationNode instanceof HTMLElement)) {
    return false;
  }

  updateOverlaySelectionState(overlay, video.paused);

  if (currentLiveCaptionText !== lastEnglishText) {
    englishNode.textContent = currentLiveCaptionText;
    lastEnglishText = currentLiveCaptionText;
  }

  if (currentLiveCaptionTranslation !== lastTranslationText) {
    translationNode.textContent = currentLiveCaptionTranslation;
    lastTranslationText = currentLiveCaptionTranslation;
  }

  if (!overlayVisible) {
    overlay.dataset.state = "ready";
    overlay.removeAttribute("hidden");
    overlayVisible = true;
  }

  hideNativeCaptions(player);

  return true;
}

function hideOverlay() {
  const overlay = document.querySelector(`.${overlayClassName}`);

  if (overlay instanceof HTMLElement) {
    updateOverlaySelectionState(overlay, false);

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

function updateOverlaySelectionState(overlay, enabled) {
  const isEnabled = overlay.classList.contains(overlaySelectableClassName);

  if (enabled === isEnabled) {
    return;
  }

  overlay.classList.toggle(overlaySelectableClassName, enabled);

  if (!enabled) {
    clearOverlaySelection(overlay);
  }
}

function clearOverlaySelection(overlay) {
  const selection = window.getSelection();

  if (!selection || !selection.rangeCount) {
    return;
  }

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;

  if ((anchorNode && overlay.contains(anchorNode)) || (focusNode && overlay.contains(focusNode))) {
    selection.removeAllRanges();
  }
}

function syncNativeCaptionObserver(player) {
  const nextContainer =
    player instanceof HTMLElement
      ? player.querySelector(nativeCaptionContainerSelector)
      : null;

  if (nextContainer === observedNativeCaptionContainer) {
    return;
  }

  disconnectNativeCaptionObserver();

  if (!(nextContainer instanceof HTMLElement)) {
    updateCurrentLiveCaption("");
    return;
  }

  observedNativeCaptionContainer = nextContainer;
  nativeCaptionObserver = new MutationObserver(() => {
    scheduleLiveCaptionRefresh();
  });
  nativeCaptionObserver.observe(nextContainer, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"]
  });

  refreshLiveCaptionFromDom();
}

function disconnectNativeCaptionObserver() {
  if (nativeCaptionObserver instanceof MutationObserver) {
    nativeCaptionObserver.disconnect();
  }

  nativeCaptionObserver = null;
  observedNativeCaptionContainer = null;

  if (liveCaptionRefreshFrame) {
    window.cancelAnimationFrame(liveCaptionRefreshFrame);
    liveCaptionRefreshFrame = 0;
  }
}

function scheduleLiveCaptionRefresh() {
  if (liveCaptionRefreshFrame) {
    return;
  }

  liveCaptionRefreshFrame = window.requestAnimationFrame(() => {
    liveCaptionRefreshFrame = 0;
    refreshLiveCaptionFromDom();
    renderFrame();
  });
}

function refreshLiveCaptionFromDom() {
  const nextText = readActiveNativeCaptionText(observedNativeCaptionContainer);

  if (nextText) {
    currentLiveCaptionSeenAt = Date.now();
    updateCurrentLiveCaption(nextText);
    return;
  }

  if (currentLiveCaptionText && Date.now() - currentLiveCaptionSeenAt < liveCaptionHoldMs) {
    return;
  }

  updateCurrentLiveCaption("");
}

function updateCurrentLiveCaption(nextText) {
  const normalizedText = normalizeText(nextText);

  if (normalizedText === currentLiveCaptionText) {
    return;
  }

  currentLiveCaptionText = normalizedText;
  currentLiveCaptionTranslation = "";
  currentLiveCaptionToken += 1;
  currentLiveCaptionRequestedToken = 0;
  currentLiveCaptionRequestSequence += 1;

  if (!normalizedText) {
    currentLiveCaptionSeenAt = 0;
  }
}

function resetLiveCaptionState() {
  currentLiveCaptionText = "";
  currentLiveCaptionTranslation = "";
  currentLiveCaptionToken = 0;
  currentLiveCaptionRequestedToken = 0;
  currentLiveCaptionRequestSequence += 1;
  currentLiveCaptionSeenAt = 0;
}

function maybeRequestLiveCaptionTranslation(video) {
  if (!(video instanceof HTMLVideoElement) || !shouldUseLiveCaptionFlow(video) || !currentLiveCaptionText) {
    return;
  }

  if (currentLiveCaptionRequestedToken === currentLiveCaptionToken) {
    return;
  }

  const requestSequence = currentLiveCaptionRequestSequence;
  const liveCaptionToken = currentLiveCaptionToken;
  const sourceText = currentLiveCaptionText;

  currentLiveCaptionRequestedToken = liveCaptionToken;

  void requestLiveCaptionTranslation(sourceText, liveCaptionToken, requestSequence);
}

async function requestLiveCaptionTranslation(sourceText, liveCaptionToken, requestSequence) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "translate-live-caption",
      text: sourceText
    });

    if (!response || !response.ok) {
      if (
        requestSequence === currentLiveCaptionRequestSequence &&
        liveCaptionToken === currentLiveCaptionToken
      ) {
        currentLiveCaptionRequestedToken = 0;
      }
      return;
    }

    if (
      requestSequence !== currentLiveCaptionRequestSequence ||
      liveCaptionToken !== currentLiveCaptionToken ||
      sourceText !== currentLiveCaptionText
    ) {
      return;
    }

    currentLiveCaptionTranslation = normalizeText(response.translation);
    renderFrame();
  } catch (_error) {
    if (requestSequence === currentLiveCaptionRequestSequence && liveCaptionToken === currentLiveCaptionToken) {
      currentLiveCaptionRequestedToken = 0;
    }
  }
}

function shouldUseLiveCaptionFlow(video) {
  if (!(video instanceof HTMLVideoElement)) {
    return false;
  }

  if (currentTimeline && currentTimeline.live) {
    return true;
  }

  if (video.duration === Number.POSITIVE_INFINITY) {
    return true;
  }

  if (window.location.pathname.startsWith("/live/")) {
    return true;
  }

  const watchPage = document.querySelector("ytd-watch-flexy");

  if (
    watchPage instanceof HTMLElement &&
    (
      watchPage.hasAttribute("is-live") ||
      watchPage.hasAttribute("is-live-content") ||
      watchPage.getAttribute("is-live") === "true" ||
      watchPage.getAttribute("is-live-content") === "true"
    )
  ) {
    return true;
  }

  const liveBadge = document.querySelector(".ytp-live-badge");

  return isLiveBadgeVisible(liveBadge);
}

function readActiveNativeCaptionText(container) {
  if (!(container instanceof HTMLElement)) {
    return "";
  }

  const preferredTexts = collectVisibleCaptionTexts(container, ".captions-text");

  if (preferredTexts.length) {
    return preferredTexts[preferredTexts.length - 1] || "";
  }

  const windowTexts = collectVisibleCaptionTexts(container, ".caption-window");

  if (windowTexts.length) {
    return windowTexts[windowTexts.length - 1] || "";
  }

  const lineTexts = collectVisibleCaptionTexts(container, ".caption-visual-line");

  if (lineTexts.length) {
    return normalizeText(lineTexts.join("\n"));
  }

  return normalizeText(container.innerText || container.textContent || "");
}

function collectVisibleCaptionTexts(container, selector) {
  const texts = [];
  const nodes = container.querySelectorAll(selector);

  for (const node of nodes) {
    if (!(node instanceof HTMLElement) || !isCaptionNodeVisible(node)) {
      continue;
    }

    const text = normalizeText(node.innerText || node.textContent || "");

    if (text && !texts.includes(text)) {
      texts.push(text);
    }
  }

  return texts;
}

function isCaptionNodeVisible(node) {
  if (!(node instanceof HTMLElement) || !node.isConnected || node.hidden || node.getAttribute("aria-hidden") === "true") {
    return false;
  }

  const style = window.getComputedStyle(node);

  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  return node.getClientRects().length > 0;
}

function isLiveBadgeVisible(node) {
  if (!(node instanceof HTMLElement) || !node.isConnected || node.hidden || node.getAttribute("aria-hidden") === "true") {
    return false;
  }

  const style = window.getComputedStyle(node);

  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  if (node.getClientRects().length === 0) {
    return false;
  }

  return /live/iu.test(node.innerText || node.textContent || "");
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
    live: Boolean(payload.live),
    generatedAt: Number.isFinite(payload.generatedAt) ? Number(payload.generatedAt) : Date.now(),
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
