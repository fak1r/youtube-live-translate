import "dotenv/config";
import { z } from "zod";
import type { UpstreamProxyConfig, YouTubeLiveTranslateConfig } from "./types.js";

const rawEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z.string().default("info"),
  UPSTREAM_PROXY_URL: z.string().default(""),
  UPSTREAM_PROXY_SS_URL: z.string().default(""),
  UPSTREAM_PROXY_LOCAL_HOST: z.string().default("127.0.0.1"),
  UPSTREAM_PROXY_LOCAL_PORT: z.coerce.number().int().min(1).max(65535).default(11081),
  UPSTREAM_PROXY_XRAY_PATH: z.string().default("/usr/local/bin/xray"),
  UPSTREAM_PROXY_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  YOUTUBE_LIVE_TRANSLATE_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value.trim().toLowerCase() !== "false"),
  YOUTUBE_LIVE_TRANSLATE_HOST: z.string().default("127.0.0.1"),
  YOUTUBE_LIVE_TRANSLATE_PORT: z.coerce.number().int().min(1).max(65535).default(32123),
  YOUTUBE_LIVE_TRANSLATE_MODEL: z.string().default("Xenova/opus-mt-en-ru"),
  YOUTUBE_LIVE_TRANSLATE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  YOUTUBE_LIVE_TRANSLATE_MODEL_CACHE_DIR: z
    .string()
    .default("runtime/youtube-live-translate-model-cache"),
});

const parsedEnv = rawEnvSchema.parse(process.env);
const upstreamUrl =
  parsedEnv.UPSTREAM_PROXY_URL.trim() ||
  parsedEnv.UPSTREAM_PROXY_SS_URL.trim();
const upstreamProxy: UpstreamProxyConfig = {
  enabled: Boolean(upstreamUrl),
  upstreamUrl,
  localHost: parsedEnv.UPSTREAM_PROXY_LOCAL_HOST.trim() || "127.0.0.1",
  localPort: parsedEnv.UPSTREAM_PROXY_LOCAL_PORT,
  xrayPath: parsedEnv.UPSTREAM_PROXY_XRAY_PATH.trim() || "/usr/local/bin/xray",
  startupTimeoutMs: parsedEnv.UPSTREAM_PROXY_STARTUP_TIMEOUT_MS,
  proxyUrl: `http://${parsedEnv.UPSTREAM_PROXY_LOCAL_HOST}:${parsedEnv.UPSTREAM_PROXY_LOCAL_PORT}`,
};

const youtubeLiveTranslate: YouTubeLiveTranslateConfig = {
  enabled: parsedEnv.YOUTUBE_LIVE_TRANSLATE_ENABLED,
  host: parsedEnv.YOUTUBE_LIVE_TRANSLATE_HOST.trim() || "127.0.0.1",
  port: parsedEnv.YOUTUBE_LIVE_TRANSLATE_PORT,
  model: parsedEnv.YOUTUBE_LIVE_TRANSLATE_MODEL.trim() || "Xenova/opus-mt-en-ru",
  timeoutMs: parsedEnv.YOUTUBE_LIVE_TRANSLATE_TIMEOUT_MS,
  modelCacheDir:
    parsedEnv.YOUTUBE_LIVE_TRANSLATE_MODEL_CACHE_DIR.trim() ||
    "runtime/youtube-live-translate-model-cache",
};

export const env = {
  ...parsedEnv,
  UPSTREAM_PROXY: upstreamProxy,
  YOUTUBE_LIVE_TRANSLATE: youtubeLiveTranslate,
};

export type AppEnv = typeof env;
