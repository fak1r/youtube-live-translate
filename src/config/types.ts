export interface UpstreamProxyConfig {
  enabled: boolean;
  upstreamUrl: string;
  localHost: string;
  localPort: number;
  xrayPath: string;
  startupTimeoutMs: number;
  proxyUrl: string;
}

export interface YouTubeLiveTranslateConfig {
  host: string;
  port: number;
  model: string;
  timeoutMs: number;
  modelCacheDir: string;
}
