import "dotenv/config";
import { z } from "zod";
import type { UpstreamProxyConfig, YouTubeLiveTranslateConfig } from "./types.js";

const defaultServerHost = "127.0.0.1";
const defaultServerPort = 32123;
const defaultModel = "Xenova/opus-mt-en-ru";
const defaultTranslationTimeoutMs = 15_000;
const defaultModelCacheDir = "runtime/youtube-live-translate-model-cache";
const defaultLocalProxyHost = "127.0.0.1";
const defaultLocalProxyPort = 11_081;
const defaultProxyStartupTimeoutMs = 15_000;
const defaultXrayPath = process.platform === "win32" ? "xray.exe" : "xray";

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  PROXY: z.string().default(""),
  UPSTREAM_PROXY_URL: z.string().default(""),
  UPSTREAM_PROXY_SS_URL: z.string().default(""),
});

const parsedEnv = rawEnvSchema.parse(process.env);
const upstreamUrl =
  parsedEnv.PROXY.trim() ||
  parsedEnv.UPSTREAM_PROXY_URL.trim() ||
  parsedEnv.UPSTREAM_PROXY_SS_URL.trim();

const upstreamProxy: UpstreamProxyConfig = {
  enabled: Boolean(upstreamUrl),
  upstreamUrl,
  localHost: defaultLocalProxyHost,
  localPort: defaultLocalProxyPort,
  xrayPath: defaultXrayPath,
  startupTimeoutMs: defaultProxyStartupTimeoutMs,
  proxyUrl: `http://${defaultLocalProxyHost}:${defaultLocalProxyPort}`,
};

const youtubeLiveTranslate: YouTubeLiveTranslateConfig = {
  host: defaultServerHost,
  port: defaultServerPort,
  model: defaultModel,
  timeoutMs: defaultTranslationTimeoutMs,
  modelCacheDir: defaultModelCacheDir,
};

export const env = {
  NODE_ENV: parsedEnv.NODE_ENV,
  LOG_LEVEL: parsedEnv.LOG_LEVEL,
  UPSTREAM_PROXY: upstreamProxy,
  YOUTUBE_LIVE_TRANSLATE: youtubeLiveTranslate,
};

export type AppEnv = typeof env;
