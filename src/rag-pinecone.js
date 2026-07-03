import { Pinecone } from "@pinecone-database/pinecone";

let pineconeClient = null;
let pineconeIndex = null;

export function getPineconeConfig() {
  return {
    apiKey: process.env.PINECONE_API_KEY || "",
    indexName: process.env.PINECONE_INDEX || "indexbook-knowledge",
  };
}

export async function initPinecone() {
  if (pineconeIndex) return pineconeIndex;

  const config = getPineconeConfig();
  if (!config.apiKey) {
    throw new Error("PINECONE_API_KEY is required");
  }

  pineconeClient = new Pinecone({ apiKey: config.apiKey });
  pineconeIndex = pineconeClient.index(config.indexName);

  return pineconeIndex;
}

export async function upsertVectors(vectors) {
  const index = await initPinecone();
  await index.upsert(vectors);
  return { upserted: vectors.length };
}

export async function queryVectors(vector, options = {}) {
  const index = await initPinecone();
  const { topK = 5, filter = {}, includeMetadata = true } = options;

  const queryOptions = {
    vector,
    topK,
    includeMetadata,
  };

  // Only add filter if it has keys (Pinecone rejects empty objects)
  if (Object.keys(filter).length > 0) {
    queryOptions.filter = filter;
  }

  const results = await index.query(queryOptions);

  return results.matches || [];
}

export async function deleteVectors(ids) {
  const index = await initPinecone();
  await index.deleteMany(ids);
  return { deleted: ids.length };
}

export async function deleteVectorsByFilter(filter) {
  const index = await initPinecone();
  await index.deleteMany({ filter });
  return { deleted: true };
}

export async function getPineconeStats() {
  const index = await initPinecone();
  const stats = await index.describeIndexStats();
  return stats;
}
