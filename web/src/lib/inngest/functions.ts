// @ts-nocheck
import { inngest } from './client';
import { supabaseAdmin } from '../supabase/service';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { driver } from '../neo4j/neo4j';
import * as mammoth from 'mammoth';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/** Embed a single entity — returns null on failure (non-fatal). */
async function embedEntity(model: any, entity: string): Promise<number[] | null> {
  try {
    const res = await model.embedContent(entity);
    return res.embedding.values;
  } catch {
    return null;
  }
}

// Inngest v4 createFunction types expect 2 args but runtime supports 3 (config, trigger, handler)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _createFn = inngest.createFunction.bind(inngest) as any;
export const processDocument = _createFn(
  { id: "process-document", retries: 2 },
  { event: "document.process" },
  async ({ event, step }: any) => {
    const { documentId, filePath, userId, filename } = event.data;

    // 1. Download the file from Supabase Storage
    const fileData = await step.run("download-file", async () => {
      const { data, error } = await supabaseAdmin.storage
        .from('documents')
        .download(filePath);

      if (error || !data) {
        throw new Error(`Failed to download file: ${error?.message}`);
      }

      const arrayBuffer = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const ext = filename?.split('.').pop()?.toLowerCase() || '';
      return { buffer: buffer.toString('base64'), ext };
    });

    // 2. Extract entities + types + relationships via Gemini
    const extractedData = await step.run("extract-graph", async () => {
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: { responseMimeType: "application/json" }
      });

      const prompt = `
        Analyze the following document and extract all key entities and their relationships.
        Output a JSON array of objects. Each object MUST have exactly these string properties:
          - "source": the source entity name (concise, capitalized)
          - "source_type": one of [Person, Organization, Location, Event, Concept, Technology, Entity]
          - "relation": the relationship verb/phrase
          - "target": the target entity name (concise, capitalized)
          - "target_type": one of [Person, Organization, Location, Event, Concept, Technology, Entity]
        Keep entity names concise and consistent. Extract as many meaningful relationships as possible.
      `;

      let promptInput: any;
      const rawBuffer = Buffer.from(fileData.buffer, 'base64');

      if (['pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(fileData.ext)) {
        const mimeType = ['png', 'jpg', 'jpeg', 'webp'].includes(fileData.ext)
          ? `image/${fileData.ext === 'jpg' ? 'jpeg' : fileData.ext}`
          : 'application/pdf';
        promptInput = { inlineData: { data: fileData.buffer, mimeType } };
      } else if (fileData.ext === 'docx') {
        const result = await mammoth.extractRawText({ buffer: rawBuffer });
        promptInput = result.value;
      } else {
        promptInput = rawBuffer.toString('utf8');
      }

      try {
        const result = await model.generateContent([prompt, promptInput]);
        const responseText = result.response.text();
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);

        return Array.isArray(parsed)
          ? parsed
              .filter((item: any) => item.source && item.relation && item.target)
              .map((item: any) => ({
                source:      String(item.source).trim(),
                source_type: String(item.source_type || 'Entity').trim(),
                relation:    String(item.relation).trim(),
                target:      String(item.target).trim(),
                target_type: String(item.target_type || 'Entity').trim(),
              }))
          : [];
      } catch (error: any) {
        throw new Error(`Gemini Extraction Failed: ${error.message}`);
      }
    });

    // 3. Generate embeddings — batch 5 at a time to respect rate limits
    const embeddingsData = await step.run("generate-embeddings", async () => {
      if (!extractedData.length) return {};

      const entityMap: Record<string, string> = {};
      for (const d of extractedData) {
        if (!entityMap[d.source]) entityMap[d.source] = d.source_type;
        if (!entityMap[d.target]) entityMap[d.target] = d.target_type;
      }

      const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
      const uniqueEntities = Object.keys(entityMap);
      const BATCH = 5;
      const result: Record<string, number[]> = {};

      for (let i = 0; i < uniqueEntities.length; i += BATCH) {
        const batch = uniqueEntities.slice(i, i + BATCH);
        const vectors = await Promise.all(batch.map((e) => embedEntity(embedModel, e)));
        batch.forEach((entity, idx) => {
          if (vectors[idx]) result[entity] = vectors[idx]!;
        });
      }

      return result;
    });

    // 4. Write to Neo4j
    await step.run("save-to-neo4j", async () => {
      if (!extractedData.length) return { inserted: 0 };

      const session = driver.session();
      try {
        await session.executeWrite(async (tx) => {
          await tx.run(
            "CREATE VECTOR INDEX entity_name_embeddings IF NOT EXISTS FOR (e:Entity) ON (e.embedding) OPTIONS {indexConfig: { `vector.dimensions`: 768, `vector.similarity_function`: 'cosine' }}"
          );
          await tx.run(
            "CREATE CONSTRAINT entity_user_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.name, e.user_id) IS NODE KEY"
          );

          for (const item of extractedData) {
            await tx.run(
              `
              MERGE (s:Entity {name: $source, user_id: $userId})
              ON CREATE SET s.type = $sourceType, s.embedding = $sourceEmbedding, s.created_at = datetime()
              ON MATCH SET
                s.type = coalesce(s.type, $sourceType),
                s.embedding = coalesce(s.embedding, $sourceEmbedding)

              MERGE (t:Entity {name: $target, user_id: $userId})
              ON CREATE SET t.type = $targetType, t.embedding = $targetEmbedding, t.created_at = datetime()
              ON MATCH SET
                t.type = coalesce(t.type, $targetType),
                t.embedding = coalesce(t.embedding, $targetEmbedding)

              MERGE (s)-[r:RELATION {type: $relation, user_id: $userId, source_file: $filename}]->(t)
              ON CREATE SET r.weight = 1, r.created_at = datetime()
              ON MATCH SET r.weight = r.weight + 1
              `,
              {
                source:          item.source,
                sourceType:      item.source_type,
                target:          item.target,
                targetType:      item.target_type,
                relation:        item.relation,
                userId,
                filename:        filename || 'Unknown Source',
                sourceEmbedding: embeddingsData[item.source] ?? null,
                targetEmbedding: embeddingsData[item.target] ?? null,
              }
            );
          }
        });
      } finally {
        await session.close();
      }

      return { inserted: extractedData.length };
    });

    // 5. Update document status to 'Completed' with entity/link counts
    await step.run("update-status", async () => {
      const uniqueEntities = new Set(extractedData.flatMap((d: any) => [d.source, d.target]));
      await supabaseAdmin
        .from('documents')
        .update({
          status:        'Completed',
          entity_count:  uniqueEntities.size,
          relation_count: extractedData.length,
        })
        .eq('id', documentId);
    });

    return { success: true, relationsExtracted: extractedData.length };
  }
);
