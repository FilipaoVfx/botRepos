const DEFAULT_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;

let openaiClient = null;

function getOpenAIClient() {
  if (openaiClient) return openaiClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  // Dynamic import to avoid hard dependency if not installed
  return import("openai").then(({ default: OpenAI }) => {
    openaiClient = new OpenAI({ apiKey });
    return openaiClient;
  });
}

export async function getEmbedding(text, model = DEFAULT_MODEL) {
  const client = await getOpenAIClient();
  const modelId = model || process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL;

  const response = await client.embeddings.create({
    model: modelId,
    input: text,
  });

  return response.data[0].embedding;
}

// Like getEmbedding, but also surfaces OpenAI token usage + the model used, so
// callers (e.g. the observability pipeline) can attribute tokens and cost.
export async function getEmbeddingDetailed(text, model = DEFAULT_MODEL) {
  const client = await getOpenAIClient();
  const modelId = model || process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL;

  const response = await client.embeddings.create({
    model: modelId,
    input: text,
  });

  return {
    embedding: response.data[0].embedding,
    tokens: response.usage?.total_tokens ?? null,
    model: modelId,
  };
}

export async function getEmbeddings(texts, model = DEFAULT_MODEL) {
  const client = await getOpenAIClient();
  const modelId = model || process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL;

  const allEmbeddings = [];

  // Process in batches to respect rate limits
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await client.embeddings.create({
      model: modelId,
      input: batch,
    });

    allEmbeddings.push(...response.data.map((d) => d.embedding));

    // Small delay between batches
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return allEmbeddings;
}

export function getEmbeddingDimensions() {
  const model = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL;
  // text-embedding-3-small: 1536
  // text-embedding-3-large: 3072
  // text-embedding-ada-002: 1536
  if (model.includes("large")) return 3072;
  return 1536;
}
