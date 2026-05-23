import { inngest } from './client';
import { supabaseAdmin } from '../supabase/service';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { driver } from '../neo4j/neo4j';
import * as mammoth from 'mammoth';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export const processDocument = inngest.createFunction(
  { id: "process-document", triggers: [{ event: "document.process" }] },
  async ({ event, step }) => {
    const { documentId, filePath, userId, filename } = event.data;

    // 1. Download the file from Supabase Storage as Buffer
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

    // 2. Call Gemini API — extract entities with types and relationships
    const extractedData = await step.run("extract-graph", async () => {
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
          responseMimeType: "application/json"
        }
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
        let mimeType = 'application/pdf';
        if (['png', 'jpg', 'jpeg', 'webp'].includes(fileData.ext)) {
          mimeType = `image/${fileData.ext === 'jpg' ? 'jpeg' : fileData.ext}`;
        }
        promptInput = { inlineData: { data: fileData.buffer, mimeType } };
      } else if (fileData.ext === 'docx') {
        const result = await mammoth.extractRawText({ buffer: rawBuffer });
        promptInput = result.value;
      } else {
        promptInput = rawBuffer.toString('utf8');
      }

      try {
        const result = await model.generateContent([ prompt, promptInput ]);
        const responseText = result.response.text();
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);

        const allRelationships = [];
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.source && item.relation && item.target) {
              allRelationships.push({
                source:      String(item.source).trim(),
                source_type: String(item.source_type || 'Entity').trim(),
                relation:    String(item.relation).trim(),
                target:      String(item.target).trim(),
                target_type: String(item.target_type || 'Entity').trim(),
              });
            }
          }
        }
        return allRelationships;
      } catch (error: any) {
        throw new Error(`Gemini Extraction Failed: ${error.message}`);
      }
    });

    // 3. Connect to Neo4j — MERGE nodes with type + embedding, MERGE edges with weight counter
    await step.run("save-to-neo4j", async () => {
      if (!extractedData || extractedData.length === 0) return { inserted: 0 };

      // Build unique entity map: name -> type
      const entityMap: Record<string, string> = {};
      for (const d of extractedData as any[]) {
        if (!entityMap[d.source]) entityMap[d.source] = d.source_type;
        if (!entityMap[d.target]) entityMap[d.target] = d.target_type;
      }
      const uniqueEntities = Object.keys(entityMap);

      // Generate embeddings sequentially to respect rate limits
      const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
      const entityEmbeddings: Record<string, number[]> = {};

      for (const entity of uniqueEntities) {
        try {
          const res = await embedModel.embedContent(entity);
          entityEmbeddings[entity] = res.embedding.values;
        } catch (e) {
          console.warn(`Failed to embed entity ${entity}`, e);
        }
      }

      const session = driver.session();
      try {
        await session.executeWrite(async (tx) => {
          // Ensure vector index + uniqueness constraint
          await tx.run(
            "CREATE VECTOR INDEX entity_name_embeddings IF NOT EXISTS FOR (e:Entity) ON (e.embedding) OPTIONS {indexConfig: { `vector.dimensions`: 768, `vector.similarity_function`: 'cosine' }}"
          );
          await tx.run(
            "CREATE CONSTRAINT entity_user_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.name, e.user_id) IS NODE KEY"
          );

          for (const item of extractedData as any[]) {
            await tx.run(
              `
              MERGE (s:Entity {name: $source, user_id: $userId})
              ON CREATE SET s.type = $sourceType, s.embedding = $sourceEmbedding
              ON MATCH SET
                s.type = coalesce(s.type, $sourceType),
                s.embedding = coalesce(s.embedding, $sourceEmbedding)

              MERGE (t:Entity {name: $target, user_id: $userId})
              ON CREATE SET t.type = $targetType, t.embedding = $targetEmbedding
              ON MATCH SET
                t.type = coalesce(t.type, $targetType),
                t.embedding = coalesce(t.embedding, $targetEmbedding)

              MERGE (s)-[r:RELATION {type: $relation, user_id: $userId, source_file: $filename}]->(t)
              ON CREATE SET r.weight = 1
              ON MATCH SET r.weight = r.weight + 1
              `,
              {
                source:          item.source,
                sourceType:      item.source_type,
                target:          item.target,
                targetType:      item.target_type,
                relation:        item.relation,
                userId:          userId,
                filename:        filename || 'Unknown Source',
                sourceEmbedding: entityEmbeddings[item.source] || null,
                targetEmbedding: entityEmbeddings[item.target] || null,
              }
            );
          }
        });
      } finally {
        await session.close();
      }

      return { inserted: extractedData.length };
    });

    // 4. Update document status to 'Completed'
    await step.run("update-status", async () => {
      await supabaseAdmin
        .from('documents')
        .update({ status: 'Completed' })
        .eq('id', documentId);
    });

    return { success: true, relationsExtracted: extractedData?.length || 0 };
  }
);
