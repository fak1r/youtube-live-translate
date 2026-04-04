import path from "node:path";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { UpstreamProxyService } from "./net/upstream-proxy-service.js";
import { YouTubeLiveTranslateServer } from "./net/youtube-live-translate-server.js";
import { YouTubeLiveTranslateService } from "./youtube/youtube-live-translate-service.js";

async function main() {
  const launchLogger = logger.child({ component: "youtube-live-translate" });
  const upstreamProxyService = new UpstreamProxyService(
    env.UPSTREAM_PROXY,
    launchLogger.child({ component: "upstream-proxy" }),
  );

  const youtubeServer = new YouTubeLiveTranslateServer({
    host: env.YOUTUBE_LIVE_TRANSLATE.host,
    port: env.YOUTUBE_LIVE_TRANSLATE.port,
    logger: launchLogger.child({ component: "youtube-live-translate-server" }),
    service: new YouTubeLiveTranslateService({
      model: env.YOUTUBE_LIVE_TRANSLATE.model,
      timeoutMs: env.YOUTUBE_LIVE_TRANSLATE.timeoutMs,
      proxy: env.UPSTREAM_PROXY,
      modelCacheDir: path.resolve(process.cwd(), env.YOUTUBE_LIVE_TRANSLATE.modelCacheDir),
      logger: launchLogger.child({ component: "youtube-live-translate-runtime" }),
    }),
  });

  await upstreamProxyService.start();
  await youtubeServer.start();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    launchLogger.info({ signal }, "Stopping YouTube live translate service");

    try {
      await youtubeServer.stop();
    } catch (error) {
      launchLogger.error({ error }, "Failed to stop YouTube live translate server");
    }

    try {
      await upstreamProxyService.stop();
    } catch (error) {
      launchLogger.error({ error }, "Failed to stop upstream proxy");
    }

    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  logger.error({ error }, "YouTube live translate launcher failed");
  process.exit(1);
});
