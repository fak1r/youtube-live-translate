import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import { truncateText } from "../utils/text.js";
import type { YouTubeLiveTranslateService } from "../youtube/youtube-live-translate-service.js";

interface YouTubeLiveTranslateServerOptions {
  host: string;
  port: number;
  logger?: Logger;
  service: YouTubeLiveTranslateService;
}

interface PrefetchWindowRequestPayload {
  url?: unknown;
  currentTime?: unknown;
  windowBeforeSeconds?: unknown;
  windowAfterSeconds?: unknown;
}

export class YouTubeLiveTranslateServer {
  private server: ReturnType<typeof createServer> | null = null;

  constructor(private readonly options: YouTubeLiveTranslateServerOptions) {}

  async start() {
    if (this.server) {
      return;
    }

    const server = createServer(async (request, response) => {
      try {
        await this.handleRequest(request, response);
      } catch (error) {
        this.options.logger?.error({ error }, "YouTube live translate server request failed");

        if (!response.headersSent) {
          response.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
          });
        }

        response.end(
          JSON.stringify({
            error: "Internal server error.",
          }),
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        resolve();
      });
    });

    this.server = server;
    this.options.logger?.info(
      {
        host: this.options.host,
        port: this.options.port,
      },
      "YouTube live translate server started",
    );

    void this.options.service.warmUp().catch((error) => {
      this.options.logger?.warn({ error }, "YouTube live translate model warm-up failed");
    });
  }

  async stop() {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    const method = request.method?.toUpperCase() ?? "GET";
    const requestUrl = new URL(request.url || "/", `http://${this.options.host}:${this.options.port}`);
    const origin = typeof request.headers.origin === "string" ? request.headers.origin.trim() : "";

    if (requestUrl.pathname === "/health") {
      this.writeCorsHeaders(response, origin);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          ok: true,
          configured: this.options.service.isConfigured(),
        }),
      );
      return;
    }

    if (method === "OPTIONS") {
      if (!this.isAllowedOrigin(origin)) {
        response.writeHead(403, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ error: "Origin is not allowed." }));
        return;
      }

      this.writeCorsHeaders(response, origin);
      response.writeHead(204);
      response.end();
      return;
    }

    if (requestUrl.pathname !== "/api/youtube-live-translate/prefetch-window") {
      response.writeHead(404, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "Not found." }));
      return;
    }

    if (method !== "POST") {
      response.writeHead(405, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "Method not allowed." }));
      return;
    }

    if (origin && !this.isAllowedOrigin(origin)) {
      response.writeHead(403, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "Origin is not allowed." }));
      return;
    }

    this.writeCorsHeaders(response, origin);

    if (!this.options.service.isConfigured()) {
      response.writeHead(503, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "Local YouTube translation model is not configured." }));
      return;
    }

    const payload = await this.readJsonBody<PrefetchWindowRequestPayload>(request);
    const url = typeof payload.url === "string" ? payload.url.trim() : "";
    const currentTime =
      typeof payload.currentTime === "number" && Number.isFinite(payload.currentTime)
        ? payload.currentTime
        : 0;
    const windowBeforeSeconds =
      typeof payload.windowBeforeSeconds === "number" && Number.isFinite(payload.windowBeforeSeconds)
        ? payload.windowBeforeSeconds
        : 4;
    const windowAfterSeconds =
      typeof payload.windowAfterSeconds === "number" && Number.isFinite(payload.windowAfterSeconds)
        ? payload.windowAfterSeconds
        : 24;

    if (!url) {
      response.writeHead(400, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "Request body must include video url." }));
      return;
    }

    const result = await this.options.service.prefetchWindow({
      url,
      currentTime,
      windowBeforeSeconds,
      windowAfterSeconds,
    });

    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(result));
  }

  private isAllowedOrigin(origin: string) {
    return origin.startsWith("chrome-extension://");
  }

  private writeCorsHeaders(response: ServerResponse, origin: string) {
    if (origin && this.isAllowedOrigin(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }

    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  private async readJsonBody<T>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);

      const combinedLength = chunks.reduce((sum, entry) => sum + entry.length, 0);

      if (combinedLength > 32_000) {
        throw new Error("YouTube live translate request body is too large.");
      }
    }

    const rawBody = Buffer.concat(chunks).toString("utf8").trim();

    if (!rawBody) {
      return {} as T;
    }

    try {
      return JSON.parse(rawBody) as T;
    } catch (error) {
      throw new Error(`Invalid JSON body: ${truncateText(String(error), 300)}`);
    }
  }
}
