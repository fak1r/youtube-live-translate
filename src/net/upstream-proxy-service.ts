import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";
import type { Logger } from "pino";
import type { UpstreamProxyConfig } from "../config/types.js";

interface ParsedShadowsocksConfig {
  protocol: "shadowsocks";
  host: string;
  port: number;
  method: string;
  password: string;
}

interface ParsedVlessConfig {
  protocol: "vless";
  host: string;
  port: number;
  id: string;
  flow: string;
  network: string;
  security: string;
  serverName: string;
  publicKey: string;
  shortId: string;
  fingerprint: string;
  spiderX: string;
}

type ParsedProxyConfig = ParsedShadowsocksConfig | ParsedVlessConfig;

const proxyEnvVarHint = "PROXY";

function decodeBase64Url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  const padded = remainder === 0 ? normalized : `${normalized}${"=".repeat(4 - remainder)}`;

  return Buffer.from(padded, "base64").toString("utf8");
}

function parseShadowsocksUrl(proxyUrl: string): ParsedShadowsocksConfig {
  const trimmed = proxyUrl.trim();

  if (!trimmed.startsWith("ss://")) {
    throw new Error(`${proxyEnvVarHint} must start with ss://`);
  }

  const withoutScheme = trimmed.slice("ss://".length).split("#", 1)[0] ?? "";
  const withoutQuery = withoutScheme.split("/?", 1)[0] ?? "";
  const atIndex = withoutQuery.lastIndexOf("@");

  if (atIndex === -1) {
    throw new Error(`${proxyEnvVarHint} must include server host and port`);
  }

  const encodedUserInfo = withoutQuery.slice(0, atIndex);
  const addressPart = withoutQuery.slice(atIndex + 1);
  const addressUrl = new URL(`http://${addressPart}`);
  const port = Number.parseInt(addressUrl.port, 10);

  if (!addressUrl.hostname || !Number.isFinite(port) || port < 1 || port > 65_535) {
    throw new Error(`${proxyEnvVarHint} contains an invalid host or port`);
  }

  const decodedUserInfo = encodedUserInfo.includes(":")
    ? encodedUserInfo
    : decodeBase64Url(encodedUserInfo);
  const separatorIndex = decodedUserInfo.indexOf(":");

  if (separatorIndex === -1) {
    throw new Error(`${proxyEnvVarHint} contains an invalid cipher/password segment`);
  }

  const method = decodeURIComponent(decodedUserInfo.slice(0, separatorIndex)).trim();
  const password = decodeURIComponent(decodedUserInfo.slice(separatorIndex + 1)).trim();

  if (!method || !password) {
    throw new Error(`${proxyEnvVarHint} is missing cipher or password`);
  }

  return {
    protocol: "shadowsocks",
    host: addressUrl.hostname,
    port,
    method,
    password,
  };
}

function parseVlessUrl(proxyUrl: string): ParsedVlessConfig {
  const parsedUrl = new URL(proxyUrl.trim());
  const port = Number.parseInt(parsedUrl.port, 10);
  const id = decodeURIComponent(parsedUrl.username).trim();
  const network = parsedUrl.searchParams.get("type")?.trim() || "tcp";
  const security = parsedUrl.searchParams.get("security")?.trim() || "none";
  const flow = parsedUrl.searchParams.get("flow")?.trim() || "";
  const serverName = parsedUrl.searchParams.get("sni")?.trim() || "";
  const publicKey = parsedUrl.searchParams.get("pbk")?.trim() || "";
  const shortId = parsedUrl.searchParams.get("sid")?.trim() || "";
  const fingerprint = parsedUrl.searchParams.get("fp")?.trim() || "chrome";
  const spiderX = parsedUrl.searchParams.get("spx")?.trim() || "";

  if (parsedUrl.protocol !== "vless:") {
    throw new Error(`${proxyEnvVarHint} must start with vless://`);
  }

  if (!parsedUrl.hostname || !Number.isFinite(port) || port < 1 || port > 65_535) {
    throw new Error(`${proxyEnvVarHint} contains an invalid host or port`);
  }

  if (!id) {
    throw new Error(`${proxyEnvVarHint} is missing VLESS user id`);
  }

  if (security === "reality" && (!publicKey || !serverName)) {
    throw new Error(
      `${proxyEnvVarHint} must include sni and pbk query params for VLESS Reality`,
    );
  }

  return {
    protocol: "vless",
    host: parsedUrl.hostname,
    port,
    id,
    flow,
    network,
    security,
    serverName,
    publicKey,
    shortId,
    fingerprint,
    spiderX,
  };
}

function parseProxyUrl(proxyUrl: string): ParsedProxyConfig {
  const trimmed = proxyUrl.trim();

  if (trimmed.startsWith("ss://")) {
    return parseShadowsocksUrl(trimmed);
  }

  if (trimmed.startsWith("vless://")) {
    return parseVlessUrl(trimmed);
  }

  throw new Error(`${proxyEnvVarHint} must start with ss:// or vless://`);
}

function buildXrayOutbound(parsed: ParsedProxyConfig) {
  if (parsed.protocol === "shadowsocks") {
    return {
      tag: "youtube-upstream-out",
      protocol: "shadowsocks",
      settings: {
        servers: [
          {
            address: parsed.host,
            port: parsed.port,
            method: parsed.method,
            password: parsed.password,
          },
        ],
      },
    };
  }

  return {
    tag: "youtube-upstream-out",
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: parsed.host,
          port: parsed.port,
          users: [
            {
              id: parsed.id,
              encryption: "none",
              ...(parsed.flow ? { flow: parsed.flow } : {}),
            },
          ],
        },
      ],
    },
    streamSettings: {
      network: parsed.network,
      security: parsed.security,
      ...(parsed.security === "reality"
        ? {
            realitySettings: {
              serverName: parsed.serverName,
              publicKey: parsed.publicKey,
              fingerprint: parsed.fingerprint,
              ...(parsed.shortId ? { shortId: parsed.shortId } : {}),
              ...(parsed.spiderX ? { spiderX: parsed.spiderX } : {}),
            },
          }
        : {}),
    },
  };
}

export class UpstreamProxyService {
  private child: ChildProcess | null = null;
  private stopping = false;

  constructor(
    private readonly config: UpstreamProxyConfig,
    private readonly logger: Logger,
  ) {}

  async start() {
    if (!this.config.enabled || this.child) {
      return;
    }

    const parsed = parseProxyUrl(this.config.upstreamUrl);
    const runtimeDir = path.resolve("runtime");
    const configPath = path.join(runtimeDir, "youtube-live-translate-xray.json");
    const xrayConfig = {
      log: {
        loglevel: "warning",
      },
      inbounds: [
        {
          tag: "youtube-http-in",
          listen: this.config.localHost,
          port: this.config.localPort,
          protocol: "http",
          settings: {
            allowTransparent: false,
          },
        },
      ],
      outbounds: [buildXrayOutbound(parsed)],
    };

    await mkdir(runtimeDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(xrayConfig, null, 2));

    this.logger.info(
      {
        host: parsed.host,
        port: parsed.port,
        localProxyUrl: this.config.proxyUrl,
      },
      "Starting upstream proxy sidecar",
    );

    const child = spawn(this.config.xrayPath, ["run", "-config", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanupOnProcessExit = () => {
      child.kill("SIGKILL");
    };

    this.child = child;
    this.stopping = false;
    process.once("exit", cleanupOnProcessExit);

    child.stdout.on("data", (chunk) => {
      const line = chunk.toString().trim();

      if (line) {
        this.logger.debug({ line }, "Upstream proxy stdout");
      }
    });

    child.stderr.on("data", (chunk) => {
      const line = chunk.toString().trim();

      if (line) {
        this.logger.debug({ line }, "Upstream proxy stderr");
      }
    });

    child.once("error", (error) => {
      this.logger.error({ error }, "Upstream proxy process failed");
    });

    child.once("exit", (code, signal) => {
      process.off("exit", cleanupOnProcessExit);
      this.child = null;

      if (this.stopping) {
        return;
      }

      this.logger.error(
        {
          code,
          signal,
        },
        "Upstream proxy sidecar exited unexpectedly",
      );
      process.kill(process.pid, "SIGTERM");
    });

    try {
      await this.waitUntilReady();
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.logger.info(
      {
        localProxyUrl: this.config.proxyUrl,
      },
      "Upstream proxy sidecar started",
    );
  }

  async stop() {
    this.stopping = true;

    const child = this.child;
    this.child = null;

    if (!child) {
      return;
    }

    child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async waitUntilReady() {
    const deadline = Date.now() + this.config.startupTimeoutMs;

    while (Date.now() < deadline) {
      if (await this.canConnect()) {
        return;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }

    throw new Error(
      `Upstream proxy did not open ${this.config.localHost}:${this.config.localPort} within ${this.config.startupTimeoutMs}ms`,
    );
  }

  private async canConnect() {
    return await new Promise<boolean>((resolve) => {
      const socket = new Socket();

      const finish = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(1_000);
      socket.once("connect", () => {
        finish(true);
      });
      socket.once("timeout", () => {
        finish(false);
      });
      socket.once("error", () => {
        finish(false);
      });
      socket.connect(this.config.localPort, this.config.localHost);
    });
  }
}
