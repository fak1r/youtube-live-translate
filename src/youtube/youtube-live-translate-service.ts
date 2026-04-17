import { execFile } from "node:child_process";
import type { Logger } from "pino";
import { promisify } from "node:util";
import type { FetchParams, TranscriptResult, TranscriptSegment } from "youtube-transcript-plus";
import { fetchTranscript } from "youtube-transcript-plus";
import type { UpstreamProxyConfig } from "../config/types.js";
import { truncateText } from "../utils/text.js";
import { LocalTranslationEngine } from "./local-translation-engine.js";

const maxSubtitleChars = 600;
const maxTextCacheEntries = 1_500;
const maxSourceTranscriptEntries = 24;
const prefetchBatchMaxSegments = 100;
const prefetchBatchMaxChars = 6_000;
const liveSourceTranscriptRefreshMs = 1_500;
const liveUrgentBeforeSeconds = 0.75;
const liveUrgentAfterSeconds = 4;
const liveAheadPrefetchSeconds = 12;
const liveAheadPrefetchMaxSegments = 12;
const vodUrgentAfterSeconds = 6;
const vodAheadPrefetchSeconds = 18;
const vodAheadPrefetchMaxSegments = 24;
const aheadPrefetchBatchMaxSegments = 4;
const aheadPrefetchBatchMaxChars = 320;
const retryTranslationNumBeams = 2;
const retryTranslationMinNewTokens = 24;
const retryTranslationMaxNewTokens = 96;
const curlBinaryPath = "/usr/bin/curl";
const curlStatusMarker = "\n__YOUTUBE_LIVE_TRANSLATE_HTTP_STATUS__:";
const defaultBrowserUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const execFileAsync = promisify(execFile);

interface YouTubeLiveTranslateServiceOptions {
  model: string;
  timeoutMs: number;
  proxy: UpstreamProxyConfig;
  modelCacheDir: string;
  logger?: Logger;
}

export interface YouTubeLiveTranslateSegment {
  offset: number;
  duration: number;
  sourceText: string;
  translation: string;
}

export interface YouTubeLiveTranslateTimelineResult {
  videoId: string;
  videoUrl: string;
  title: string | null;
  author: string | null;
  sourceLanguage: string;
  model: string;
  live: boolean;
  generatedAt: number;
  cached: boolean;
  complete: boolean;
  rangeStart: number;
  rangeEnd: number;
  segments: YouTubeLiveTranslateSegment[];
}

interface YouTubeVideoReference {
  videoId: string;
  videoUrl: string;
}

interface SourceTranscriptEntry {
  videoId: string;
  videoUrl: string;
  title: string | null;
  author: string | null;
  sourceLanguage: string;
  isLiveContent: boolean;
  fetchedAt: number;
  segments: Array<{
    offset: number;
    duration: number;
    sourceText: string;
  }>;
}

interface TranscriptFetchRoute {
  label: string;
  proxyUrl: string;
}

export class YouTubeLiveTranslateService {
  private readonly translator: LocalTranslationEngine;
  private readonly textCache = new Map<string, string>();
  private readonly sourceTranscriptCache = new Map<string, SourceTranscriptEntry>();
  private readonly inflightSourceTranscript = new Map<string, Promise<SourceTranscriptEntry>>();
  private readonly queuedAheadTexts = new Set<string>();
  private readonly aheadTextQueue: string[] = [];
  private aheadPrefetchActive = false;

  constructor(private readonly options: YouTubeLiveTranslateServiceOptions) {
    this.translator = new LocalTranslationEngine({
      model: options.model,
      cacheDir: options.modelCacheDir,
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }

  isConfigured() {
    return this.translator.isConfigured();
  }

  async warmUp() {
    await this.translator.warmUp();
  }

  async prefetchWindow(input: {
    url: string;
    currentTime: number;
    windowBeforeSeconds: number;
    windowAfterSeconds: number;
  }) {
    if (!this.isConfigured()) {
      throw new Error("YouTube live translate is not configured. Local model is missing.");
    }

    const reference = parseReference(input.url);
    const sourceTranscript = await this.getSourceTranscript(reference);
    const selectedSegments = sliceTranscriptWindow(
      sourceTranscript.segments,
      input.currentTime,
      input.windowBeforeSeconds,
      input.windowAfterSeconds,
    );
    const translatedSegments = await this.translateSelectedWindow({
      selectedSegments,
      sourceSegments: sourceTranscript.segments,
      currentTime: input.currentTime,
      selectedWindowAfterSeconds: input.windowAfterSeconds,
      urgentAfterSeconds: sourceTranscript.isLiveContent ? liveUrgentAfterSeconds : vodUrgentAfterSeconds,
      aheadPrefetchSeconds: sourceTranscript.isLiveContent ? liveAheadPrefetchSeconds : vodAheadPrefetchSeconds,
      aheadPrefetchMaxSegments: sourceTranscript.isLiveContent
        ? liveAheadPrefetchMaxSegments
        : vodAheadPrefetchMaxSegments,
    });

    return {
      videoId: reference.videoId,
      videoUrl: reference.videoUrl,
      title: sourceTranscript.title,
      author: sourceTranscript.author,
      sourceLanguage: sourceTranscript.sourceLanguage,
      model: this.translator.getModelId(),
      live: sourceTranscript.isLiveContent,
      generatedAt: Date.now(),
      cached: false,
      complete: false,
      rangeStart:
        selectedSegments.length > 0 ? (selectedSegments[0]?.offset ?? input.currentTime) : input.currentTime,
      rangeEnd:
        selectedSegments.length > 0
          ? (selectedSegments[selectedSegments.length - 1]?.offset ?? input.currentTime) +
            (selectedSegments[selectedSegments.length - 1]?.duration ?? 0)
          : input.currentTime,
      segments: translatedSegments,
    };
  }

  private async translateSelectedWindow(input: {
    selectedSegments: SourceTranscriptEntry["segments"];
    sourceSegments: SourceTranscriptEntry["segments"];
    currentTime: number;
    selectedWindowAfterSeconds: number;
    urgentAfterSeconds: number;
    aheadPrefetchSeconds: number;
    aheadPrefetchMaxSegments: number;
  }) {
    const urgentSegments = sliceTranscriptWindow(
      input.selectedSegments,
      input.currentTime,
      liveUrgentBeforeSeconds,
      input.urgentAfterSeconds,
    );

    if (urgentSegments.length > 0) {
      await this.translateSegments(urgentSegments);
    }

    const aheadSegments = mergeAheadPrefetchSegments(
      takeFutureSegmentsFromSelection(
        input.selectedSegments,
        input.currentTime + input.urgentAfterSeconds,
        input.aheadPrefetchMaxSegments,
      ),
      sliceFutureTranscriptWindow(
        input.sourceSegments,
        input.selectedSegments,
        input.currentTime,
        input.selectedWindowAfterSeconds,
        input.aheadPrefetchSeconds,
        input.aheadPrefetchMaxSegments,
      ),
      input.aheadPrefetchMaxSegments,
    );

    if (aheadSegments.length > 0) {
      this.prefetchFutureSegments(aheadSegments);
    }

    return this.projectSegmentsWithCachedTranslations(input.selectedSegments);
  }

  private projectSegmentsWithCachedTranslations(
    segments: SourceTranscriptEntry["segments"],
  ): YouTubeLiveTranslateSegment[] {
    return segments.map((segment) => ({
      offset: segment.offset,
      duration: segment.duration,
      sourceText: segment.sourceText,
      translation: this.textCache.get(segment.sourceText) ?? "",
    }));
  }

  private prefetchFutureSegments(segments: SourceTranscriptEntry["segments"]) {
    let queuedAnyText = false;

    for (const segment of segments) {
      const sourceText = normalizeSubtitleText(segment.sourceText);

      if (!sourceText || this.textCache.has(sourceText) || this.queuedAheadTexts.has(sourceText)) {
        continue;
      }

      this.queuedAheadTexts.add(sourceText);
      this.aheadTextQueue.push(sourceText);
      queuedAnyText = true;
    }

    if (queuedAnyText && !this.aheadPrefetchActive) {
      void this.drainAheadPrefetchQueue();
    }
  }

  private async drainAheadPrefetchQueue() {
    if (this.aheadPrefetchActive) {
      return;
    }

    this.aheadPrefetchActive = true;

    try {
      while (this.aheadTextQueue.length > 0) {
        const batch = takeTextBatchFromQueue(
          this.aheadTextQueue,
          aheadPrefetchBatchMaxSegments,
          aheadPrefetchBatchMaxChars,
        );

        if (!batch.length) {
          break;
        }

        try {
          const translations = await this.translateBatchWithFallback(batch);

          for (let index = 0; index < batch.length; index += 1) {
            const sourceText = batch[index]!;
            const translation = translations[index]!;

            if (translation) {
              this.textCache.set(sourceText, translation);
            }
          }

          trimMap(this.textCache, maxTextCacheEntries);
        } catch (error) {
          this.options.logger?.debug({ error }, "Future subtitle translation prefetch batch failed");
        } finally {
          for (const sourceText of batch) {
            this.queuedAheadTexts.delete(sourceText);
          }
        }

        await yieldToEventLoop();
      }
    } finally {
      this.aheadPrefetchActive = false;

      if (this.aheadTextQueue.length > 0) {
        void this.drainAheadPrefetchQueue();
      }
    }
  }

  private async getSourceTranscript(reference: YouTubeVideoReference) {
    const memoryCached = this.sourceTranscriptCache.get(reference.videoId);

    if (memoryCached && !shouldRefreshLiveTranscript(memoryCached)) {
      return memoryCached;
    }

    const pending = this.inflightSourceTranscript.get(reference.videoId);

    if (pending) {
      return memoryCached ?? await pending;
    }

    const operation = this.fetchSourceTranscript(reference)
      .catch((error) => {
        if (memoryCached) {
          this.options.logger?.warn(
            { error, videoId: reference.videoId },
            "Falling back to cached YouTube transcript after refresh failure",
          );
          return memoryCached;
        }

        throw error;
      })
      .finally(() => {
        this.inflightSourceTranscript.delete(reference.videoId);
      });

    this.inflightSourceTranscript.set(reference.videoId, operation);

    if (memoryCached) {
      return memoryCached;
    }

    return await operation;
  }

  private async fetchSourceTranscript(reference: YouTubeVideoReference) {
    const transcriptResult = await this.fetchEnglishTranscript(reference.videoUrl);
    const sourceEntry: SourceTranscriptEntry = {
      videoId: reference.videoId,
      videoUrl: reference.videoUrl,
      title: transcriptResult.videoDetails.title?.trim() || null,
      author: transcriptResult.videoDetails.author?.trim() || null,
      sourceLanguage: transcriptResult.segments[0]?.lang?.trim() || "en",
      isLiveContent: Boolean(transcriptResult.videoDetails.isLiveContent),
      fetchedAt: Date.now(),
      segments: (transcriptResult.segments as TranscriptSegment[])
        .map((segment: TranscriptSegment) => ({
          offset: Number.isFinite(segment.offset) ? segment.offset : 0,
          duration: Number.isFinite(segment.duration) ? segment.duration : 0,
          sourceText: normalizeSubtitleText(decodeHtmlEntities(segment.text)),
        }))
        .filter((segment) => segment.sourceText),
    };

    this.sourceTranscriptCache.set(reference.videoId, sourceEntry);
    trimMap(this.sourceTranscriptCache, maxSourceTranscriptEntries);

    return sourceEntry;
  }

  private async fetchEnglishTranscript(referenceUrl: string): Promise<TranscriptResult> {
    const configs = this.buildTranscriptConfigs();
    let lastError: unknown = null;

    for (const config of configs) {
      try {
        return await fetchTranscript(referenceUrl, {
          ...config.options,
          lang: "en",
          videoDetails: true,
        });
      } catch (error) {
        lastError = error;
        this.options.logger?.warn(
          `YouTube transcript prefetch failed for English track (${config.label}): ${String(error)}`,
        );
      }
    }

    for (const config of configs) {
      try {
        return await fetchTranscript(referenceUrl, {
          ...config.options,
          videoDetails: true,
        });
      } catch (error) {
        lastError = error;
        this.options.logger?.warn(
          `YouTube transcript prefetch failed for fallback track (${config.label}): ${String(error)}`,
        );
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to fetch YouTube transcript.");
  }

  private buildTranscriptConfigs() {
    return this.getTranscriptFetchRoutes().map((route) => ({
      label: route.label,
      options: this.buildTranscriptConfig(route),
    }));
  }

  private buildTranscriptConfig(route: TranscriptFetchRoute) {
    return {
      retries: 1,
      retryDelay: 750,
      signal: AbortSignal.timeout(Math.max(this.options.timeoutMs, 30_000)),
      videoFetch: (params: FetchParams) => this.fetchWithCurl(params, route.proxyUrl),
      playerFetch: (params: FetchParams) => this.fetchWithCurl(params, route.proxyUrl),
      transcriptFetch: (params: FetchParams) => this.fetchWithCurl(params, route.proxyUrl),
    };
  }

  private getTranscriptFetchRoutes(): TranscriptFetchRoute[] {
    const routes: TranscriptFetchRoute[] = [];
    const addRoute = (label: string, proxyUrl: string) => {
      const normalized = normalizeCurlProxyUrl(proxyUrl);

      if (!normalized) {
        return;
      }

      if (routes.some((route) => route.proxyUrl === normalized)) {
        return;
      }

      routes.push({ label, proxyUrl: normalized });
    };

    if (this.options.proxy.enabled) {
      addRoute("local-proxy", this.options.proxy.proxyUrl);
    }

    routes.push({
      label: "direct",
      proxyUrl: "",
    });

    return routes;
  }

  private async fetchWithCurl(params: FetchParams, proxyUrl: string) {
    const headers = {
      "User-Agent": params.userAgent || defaultBrowserUserAgent,
      "Accept-Language": params.lang ? `${params.lang},en;q=0.8` : "en-US,en;q=0.9",
      ...(params.headers ?? {}),
    };
    const timeoutSeconds = Math.max(30, Math.ceil(this.options.timeoutMs / 1_000));
    const args = [
      "-sS",
      "-L",
      "--compressed",
      "--max-time",
      String(timeoutSeconds),
      "--connect-timeout",
      "10",
      "-X",
      params.method || "GET",
    ];

    if (proxyUrl) {
      args.push("-x", proxyUrl);
    }

    for (const [name, value] of Object.entries(headers)) {
      args.push("-H", `${name}: ${value}`);
    }

    if (params.body) {
      args.push("--data-raw", params.body);
    }

    args.push("-w", `${curlStatusMarker}%{http_code}`, params.url);

    const { stdout } = await execFileAsync(curlBinaryPath, args, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutSeconds * 1_000 + 1_000,
    });
    const statusMarkerIndex = stdout.lastIndexOf(curlStatusMarker);
    const body = statusMarkerIndex >= 0 ? stdout.slice(0, statusMarkerIndex) : stdout;
    const status =
      statusMarkerIndex >= 0
        ? Number.parseInt(stdout.slice(statusMarkerIndex + curlStatusMarker.length).trim(), 10) || 200
        : 200;

    return new Response(body, {
      status,
    });
  }

  private async translateSegments(
    segments: SourceTranscriptEntry["segments"],
  ): Promise<YouTubeLiveTranslateSegment[]> {
    if (!segments.length) {
      return [];
    }

    const output: Array<YouTubeLiveTranslateSegment | null> = new Array(segments.length).fill(null);
    const missing: Array<{ index: number; text: string }> = [];

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const cachedTranslation = this.textCache.get(segment.sourceText);

      if (typeof cachedTranslation === "string") {
        output[index] = {
          offset: segment.offset,
          duration: segment.duration,
          sourceText: segment.sourceText,
          translation: cachedTranslation,
        };
        continue;
      }

      missing.push({
        index,
        text: segment.sourceText,
      });
    }

    for (const batch of buildTextBatches(missing)) {
      const translations = await this.translateBatchWithFallback(batch.map((entry) => entry.text));

      if (translations.length !== batch.length) {
        throw new Error(
          `Translated batch length mismatch: expected ${batch.length}, received ${translations.length}.`,
        );
      }

      for (let index = 0; index < batch.length; index += 1) {
        const batchEntry = batch[index]!;
        const segment = segments[batchEntry.index]!;
        const translation = translations[index]!;

        if (translation) {
          this.textCache.set(segment.sourceText, translation);
        }

        output[batchEntry.index] = {
          offset: segment.offset,
          duration: segment.duration,
          sourceText: segment.sourceText,
          translation,
        };
      }
    }

    trimMap(this.textCache, maxTextCacheEntries);

    return output.filter((segment): segment is YouTubeLiveTranslateSegment => Boolean(segment));
  }

  private async translateBatchWithFallback(lines: string[]) {
    const normalizedLines = lines.map((line) => normalizeSubtitleText(line));

    if (!normalizedLines.some(Boolean)) {
      return new Array(lines.length).fill("");
    }

    const translations = await this.translator.translateBatch(normalizedLines);
    const normalizedTranslations = translations.map((translation) => normalizeTranslationText(translation));

    if (normalizedTranslations.length !== normalizedLines.length) {
      throw new Error(
        `Local translation output length mismatch: expected ${normalizedLines.length}, received ${normalizedTranslations.length}.`,
      );
    }

    const output = [...normalizedTranslations];
    const retryIndexes = normalizedLines.flatMap((line, index) =>
      line && !normalizedTranslations[index] ? [index] : [],
    );

    const retriedEntries = await Promise.all(
      retryIndexes.map(async (index) => ({
        index,
        sourceText: normalizedLines[index]!,
        translation: await this.retrySingleTranslation(normalizedLines[index]!),
      })),
    );

    for (const retriedEntry of retriedEntries) {
      if (retriedEntry.translation) {
        output[retriedEntry.index] = retriedEntry.translation;
        continue;
      }

      this.options.logger?.warn(
        { sourceText: truncateText(retriedEntry.sourceText, 180) },
        "Subtitle translation remained empty after retry",
      );
    }

    return output;
  }

  private async retrySingleTranslation(line: string) {
    const translation = await this.translateSingleLineWithRetryOptions(line);

    if (translation) {
      return translation;
    }

    if (line.includes("\n")) {
      const translatedLines: string[] = [];

      for (const part of line.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
        const partTranslation = await this.translateSingleLineWithRetryOptions(part);

        if (!partTranslation) {
          this.options.logger?.debug(
            { sourceText: truncateText(part, 180) },
            "Line-by-line subtitle translation retry returned empty output",
          );
          return "";
        }

        translatedLines.push(partTranslation);
      }

      return normalizeTranslationText(translatedLines.join("\n"));
    }

    this.options.logger?.debug(
      { sourceText: truncateText(line, 180) },
      "Single-line subtitle translation retry returned empty output",
    );

    return "";
  }

  private async translateSingleLineWithRetryOptions(line: string) {
    try {
      const translations = await this.translator.translateBatch([line], {
        numBeams: retryTranslationNumBeams,
        maxNewTokens: estimateRetryMaxNewTokens(line),
      });

      return normalizeTranslationText(translations[0] ?? "");
    } catch (error) {
      this.options.logger?.debug(
        { error, sourceText: truncateText(line, 180) },
        "Single-line subtitle translation retry failed",
      );
      return "";
    }
  }
}

function parseReference(rawValue: string): YouTubeVideoReference {
  const value = rawValue.trim();

  if (/^[A-Za-z0-9_-]{11}$/u.test(value)) {
    return {
      videoId: value,
      videoUrl: `https://www.youtube.com/watch?v=${value}`,
    };
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error("Expected a valid YouTube URL or video id.");
  }

  const host = parsedUrl.hostname.replace(/^www\./u, "").toLowerCase();
  let videoId = "";

  if (host === "youtu.be") {
    videoId = parsedUrl.pathname.replace(/^\/+/u, "").split("/")[0] ?? "";
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (parsedUrl.pathname === "/watch") {
      videoId = parsedUrl.searchParams.get("v")?.trim() ?? "";
    } else {
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);

      if (pathParts[0] === "shorts" || pathParts[0] === "embed" || pathParts[0] === "live") {
        videoId = pathParts[1] ?? "";
      }
    }
  }

  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
    throw new Error("Could not extract YouTube video id from the provided URL.");
  }

  return {
    videoId,
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

function sliceTranscriptWindow<T extends { offset: number; duration: number }>(
  segments: T[],
  currentTime: number,
  windowBeforeSeconds: number,
  windowAfterSeconds: number,
) {
  const rangeStart = Math.max(0, currentTime - Math.max(0, windowBeforeSeconds));
  const rangeEnd = currentTime + Math.max(0, windowAfterSeconds);

  return segments.filter((segment) => {
    const segmentStart = segment.offset;
    const segmentEnd = segment.offset + segment.duration;

    return segmentEnd >= rangeStart && segmentStart <= rangeEnd;
  });
}

function sliceFutureTranscriptWindow<T extends { offset: number; duration: number }>(
  segments: T[],
  selectedSegments: T[],
  currentTime: number,
  windowAfterSeconds: number,
  aheadSeconds: number,
  maxSegments: number,
) {
  if (!segments.length || maxSegments <= 0 || aheadSeconds <= 0) {
    return [];
  }

  const currentRangeEnd =
    selectedSegments.length > 0
      ? (selectedSegments[selectedSegments.length - 1]?.offset ?? currentTime) +
        (selectedSegments[selectedSegments.length - 1]?.duration ?? 0)
      : currentTime + Math.max(0, windowAfterSeconds);
  const futureRangeEnd = currentRangeEnd + aheadSeconds;
  const output: T[] = [];

  for (const segment of segments) {
    const segmentStart = segment.offset;

    if (segmentStart <= currentRangeEnd) {
      continue;
    }

    if (segmentStart > futureRangeEnd) {
      break;
    }

    output.push(segment);

    if (output.length >= maxSegments) {
      break;
    }
  }

  return output;
}

function takeFutureSegmentsFromSelection<T extends { offset: number; duration: number; sourceText: string }>(
  segments: T[],
  minOffset: number,
  maxSegments: number,
) {
  if (!segments.length || maxSegments <= 0) {
    return [];
  }

  const output: T[] = [];

  for (const segment of segments) {
    if (segment.offset <= minOffset) {
      continue;
    }

    output.push(segment);

    if (output.length >= maxSegments) {
      break;
    }
  }

  return output;
}

function mergeAheadPrefetchSegments<T extends { sourceText: string }>(
  primarySegments: T[],
  secondarySegments: T[],
  maxSegments: number,
) {
  if (maxSegments <= 0) {
    return [];
  }

  const output: T[] = [];
  const seenTexts = new Set<string>();

  for (const segment of [...primarySegments, ...secondarySegments]) {
    const sourceText = normalizeSubtitleText(segment.sourceText);

    if (!sourceText || seenTexts.has(sourceText)) {
      continue;
    }

    seenTexts.add(sourceText);
    output.push(segment);

    if (output.length >= maxSegments) {
      break;
    }
  }

  return output;
}

function buildTextBatches(entries: Array<{ index: number; text: string }>) {
  const batches: Array<Array<{ index: number; text: string }>> = [];
  let currentBatch: Array<{ index: number; text: string }> = [];
  let currentChars = 0;

  for (const entry of entries) {
    const nextChars = currentChars + entry.text.length;
    const shouldFlush =
      currentBatch.length >= prefetchBatchMaxSegments ||
      (currentBatch.length > 0 && nextChars > prefetchBatchMaxChars);

    if (shouldFlush) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(entry);
    currentChars += entry.text.length;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function takeTextBatchFromQueue(queue: string[], maxSegments: number, maxChars: number) {
  const batch: string[] = [];
  let currentChars = 0;

  while (queue.length > 0) {
    const nextText = queue[0] ?? "";
    const nextChars = currentChars + nextText.length;
    const shouldStop =
      batch.length >= maxSegments ||
      (batch.length > 0 && nextChars > maxChars);

    if (shouldStop) {
      break;
    }

    batch.push(queue.shift() ?? "");
    currentChars = nextChars;
  }

  return batch.filter(Boolean);
}

function yieldToEventLoop() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function normalizeSubtitleText(value: string) {
  return truncateText(
    value
      .replace(/\r\n/gu, "\n")
      .split("\n")
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .filter(Boolean)
      .join("\n")
      .trim(),
    maxSubtitleChars,
  );
}

function normalizeTranslationText(value: string) {
  return value
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .join("\n")
    .trim();
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, codePoint) =>
      String.fromCodePoint(Number.parseInt(codePoint, 10)),
    )
    .replace(/&#x([0-9a-f]+);/giu, (_match, codePoint) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16)),
    );
}

function trimMap<T>(cache: Map<string, T>, limit: number) {
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;

    if (typeof oldestKey !== "string") {
      break;
    }

    cache.delete(oldestKey);
  }
}

function normalizeCurlProxyUrl(proxyUrl: string) {
  const normalized = proxyUrl.trim();

  return normalized ? normalized : "";
}

function shouldRefreshLiveTranscript(entry: SourceTranscriptEntry) {
  return entry.isLiveContent && Date.now() - entry.fetchedAt >= liveSourceTranscriptRefreshMs;
}

function estimateRetryMaxNewTokens(line: string) {
  return Math.min(
    retryTranslationMaxNewTokens,
    Math.max(retryTranslationMinNewTokens, Math.ceil(line.length * 0.75)),
  );
}
