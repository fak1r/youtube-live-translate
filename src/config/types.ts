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
  enabled: boolean;
  host: string;
  port: number;
  model: string;
  timeoutMs: number;
  modelCacheDir: string;
}
