const prefetchWindowApiUrl =
  "http://127.0.0.1:32123/api/youtube-live-translate/prefetch-window";
const maxTimelineCacheEntries = 24;
const requestTimeoutMs = 25000;
const liveTimelineCacheTtlMs = 1200;
const activeSegmentEpsilon = 0.18;
const windowTimelineCache = new Map();
const inflightWindowPrefetch = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "prefetch-window") {
    prefetchWindow(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

    return true;
  }

  return false;
});

async function prefetchWindow(message) {
  const videoKey = getVideoCacheKey(message);
  const currentTime = Number.isFinite(message.currentTime)
    ? Number(message.currentTime)
    : 0;
  const windowBeforeSeconds = Number.isFinite(message.windowBeforeSeconds)
    ? Number(message.windowBeforeSeconds)
    : 4;
  const windowAfterSeconds = Number.isFinite(message.windowAfterSeconds)
    ? Number(message.windowAfterSeconds)
    : 24;

  const cachedWindow = windowTimelineCache.get(videoKey);

  if (
    cachedWindow &&
    currentTime >= cachedWindow.rangeStart &&
    currentTime <= cachedWindow.rangeEnd &&
    canUseCachedWindow(cachedWindow, currentTime)
  ) {
    return {
      ...cachedWindow,
      cached: true,
    };
  }

  const url = normalizeText(message.url);

  if (!url) {
    throw new Error("Video URL is required for window prefetch.");
  }

  const requestKey = `${videoKey}:${Math.floor(currentTime / 10)}`;
  const pending = inflightWindowPrefetch.get(requestKey);

  if (pending) {
    return await pending;
  }

  const request = requestJson(prefetchWindowApiUrl, {
    url,
    currentTime,
    windowBeforeSeconds,
    windowAfterSeconds,
  })
    .then((payload) => {
      const normalized = normalizeTimeline(payload);
      windowTimelineCache.set(normalized.videoId || videoKey, normalized);
      trimCache(windowTimelineCache, maxTimelineCacheEntries);

      return normalized;
    })
    .finally(() => {
      inflightWindowPrefetch.delete(requestKey);
    });

  inflightWindowPrefetch.set(requestKey, request);
  return await request;
}
function normalizeTimeline(payload) {
  return {
    videoId: typeof payload.videoId === "string" ? payload.videoId.trim() : "",
    videoUrl:
      typeof payload.videoUrl === "string" ? payload.videoUrl.trim() : "",
    title: typeof payload.title === "string" ? payload.title : "",
    author: typeof payload.author === "string" ? payload.author : "",
    sourceLanguage:
      typeof payload.sourceLanguage === "string"
        ? payload.sourceLanguage
        : "en",
    model: typeof payload.model === "string" ? payload.model : "",
    live: Boolean(payload.live),
    generatedAt: Number.isFinite(payload.generatedAt)
      ? Number(payload.generatedAt)
      : Date.now(),
    cached: Boolean(payload.cached),
    complete: Boolean(payload.complete),
    rangeStart: Number.isFinite(payload.rangeStart)
      ? Number(payload.rangeStart)
      : 0,
    rangeEnd: Number.isFinite(payload.rangeEnd) ? Number(payload.rangeEnd) : 0,
    segments: Array.isArray(payload.segments)
      ? payload.segments
          .map((segment) => ({
            offset: Number.isFinite(segment.offset)
              ? Number(segment.offset)
              : 0,
            duration: Number.isFinite(segment.duration)
              ? Number(segment.duration)
              : 0,
            sourceText: normalizeText(segment.sourceText),
            translation: normalizeText(segment.translation),
          }))
          .filter((segment) => segment.sourceText)
      : [],
  };
}

function getVideoCacheKey(message) {
  const videoId = normalizeText(message.videoId);
  const url = normalizeText(message.url);

  return videoId || url;
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

function trimCache(cache, limit) {
  while (cache.size > limit) {
    const firstKey = cache.keys().next().value;

    if (typeof firstKey !== "string") {
      break;
    }

    cache.delete(firstKey);
  }
}

function canUseCachedWindow(timeline, currentTime) {
  if (
    timeline.live &&
    Date.now() - timeline.generatedAt >= liveTimelineCacheTtlMs
  ) {
    return false;
  }

  const activeSegments = getActiveSegmentsAtTime(
    timeline.segments,
    currentTime,
  );

  if (activeSegments.some((segment) => !normalizeText(segment.translation))) {
    return false;
  }

  return true;
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
    Number.NEGATIVE_INFINITY,
  );

  return activeSegments.filter(
    (segment) => Math.abs((Number(segment.offset) || 0) - latestStart) < 0.02,
  );
}

function resolveHttpError(payload, status, fallback) {
  if (payload && typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }

  return `${fallback} (${status})`;
}

async function requestJson(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const responsePayload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        resolveHttpError(
          responsePayload,
          response.status,
          "Window prefetch server error",
        ),
      );
    }

    return responsePayload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Window prefetch timed out after ${requestTimeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
