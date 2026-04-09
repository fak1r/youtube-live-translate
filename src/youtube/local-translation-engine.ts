import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

interface LocalTranslationEngineOptions {
  model: string;
  cacheDir: string;
  logger?: Logger;
}

interface TranslateBatchOptions {
  numBeams?: number;
  maxNewTokens?: number;
}

type TranslationPipeline = (
  input: string[],
  options?: {
    num_beams?: number;
    max_new_tokens?: number;
  },
) => Promise<unknown>;

export class LocalTranslationEngine {
  private pipelinePromise: Promise<TranslationPipeline> | null = null;

  constructor(private readonly options: LocalTranslationEngineOptions) {}

  isConfigured() {
    return Boolean(this.options.model.trim());
  }

  getModelId() {
    return this.options.model.trim();
  }

  async warmUp() {
    if (!this.isConfigured()) {
      return;
    }

    const pipeline = await this.getPipeline();
    await pipeline(["Hello."], {
      num_beams: 1,
      max_new_tokens: 16,
    });
  }

  async translateBatch(lines: string[], options: TranslateBatchOptions = {}) {
    if (!this.isConfigured()) {
      throw new Error("Local translation model is not configured.");
    }

    if (!lines.length) {
      return [];
    }

    const pipeline = await this.getPipeline();
    const rawResult = await pipeline(lines, {
      num_beams: options.numBeams ?? 1,
      max_new_tokens: options.maxNewTokens ?? estimateMaxNewTokens(lines),
    });
    const translations = normalizeTranslationOutputs(rawResult);

    if (translations.length !== lines.length) {
      throw new Error(
        `Local translation output length mismatch: expected ${lines.length}, received ${translations.length}.`,
      );
    }

    return translations;
  }

  private async getPipeline() {
    if (!this.pipelinePromise) {
      this.pipelinePromise = this.createPipeline().catch((error) => {
        this.pipelinePromise = null;
        throw error;
      });
    }

    return await this.pipelinePromise;
  }

  private async createPipeline(): Promise<TranslationPipeline> {
    const modelId = this.getModelId();

    process.env.ORT_LOG_SEVERITY_LEVEL ??= "3";
    process.env.ORT_LOG_VERBOSITY_LEVEL ??= "0";

    await mkdir(this.options.cacheDir, { recursive: true });

    const transformers = await import("@xenova/transformers");

    transformers.env.allowRemoteModels = true;
    transformers.env.allowLocalModels = true;
    transformers.env.useBrowserCache = false;
    transformers.env.useFSCache = true;
    transformers.env.cacheDir = path.resolve(this.options.cacheDir);

    this.options.logger?.info(
      {
        modelId,
        cacheDir: path.resolve(this.options.cacheDir),
      },
      "Loading local YouTube translation model",
    );

    const pipeline = (await transformers.pipeline("translation", modelId, {
      quantized: true,
    })) as TranslationPipeline;

    this.options.logger?.info(
      {
        modelId,
      },
      "Local YouTube translation model loaded",
    );

    return pipeline;
  }
}

function normalizeTranslationOutputs(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return "";
    }

    const record = entry as { translation_text?: unknown };
    return typeof record.translation_text === "string" ? record.translation_text.trim() : "";
  });
}

function estimateMaxNewTokens(lines: string[]) {
  const longestLineLength = lines.reduce((currentMax, line) => Math.max(currentMax, line.length), 0);

  return Math.min(64, Math.max(20, Math.ceil(longestLineLength / 2)));
}
