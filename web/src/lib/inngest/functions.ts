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
      return { buffer: buffer.toString('base64'), ext }; // Sending as base64 to survive Inngest serialization
    });

    // 2. Call Gemini API using intelligent multi-format routing
    const extractedData = await step.run("extract-graph", async () => {
      const model = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite", // UPGRADED MODEL
        generationConfig: {
          responseMimeType: "application/json"
        }
      });

      const prompt = `
        Analyze the following document and extract all key entities and their relationships.
        Output a JSON array of objects, where each object has exactly "source", "relation", and "target" string properties.
        Keep entity names concise and capitalized appropriately.
        Extract as many meaningful relationships as possible to build a comprehensive knowledge graph.
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
        // Fallback for TXT, CSV, MD, etc.
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
                source: String(item.source).trim(),
                relation: String(item.relation).trim(),
                target: String(item.target).trim()
              });
            }
          }
        }
        return allRelationships;
      } catch (error: any) {
        throw new Error(`Gemini Extraction Failed: ${error.message}`);
      }
    });

    // 3. Connect to Neo4j and MERGE Nodes and Edges with Source Citations & Embeddings
    await step.run("save-to-neo4j", async () => {
      if (!extractedData || extractedData.length === 0) return { inserted: 0 };
      
      const uniqueEntities = Array.from(new Set(extractedData.flatMap((d: any) => [d.source, d.target])));
      
      // Generate embeddings
      const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
      const entityEmbeddings: Record<string, number[]> = {};
      
      // Process sequentially to respect rate limits
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
          // Ensure vector index exists
          await tx.run(`CREATE VECTOR INDEX entity_name_embeddings IF NOT EXISTS FOR (e:Entity) ON (e.embedding) OPTIONS {indexConfig: { \`vector.dimensions\`: 768, \`vector.similarity_function\`: 'cosine' }}`);
          // Enforce uniqueness
          await tx.run(`CREATE CONSTRAINT entity_user_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.name, e.user_id) IS NODE KEY`);
          
          for (const item of extractedData) {
            const query = `
              MERGE (s:Entity {name: $source, user_id: $userId})
              ON CREATE SET s.embedding = $sourceEmbedding
              ON MATCH SET s.embedding = coalesce(s.embedding, $sourceEmbedding)
              
              MERGE (t:Entity {name: $target, user_id: $userId})
              ON CREATE SET t.embedding = $targetEmbedding
              ON MATCH SET t.embedding = coalesce(t.embedding, $targetEmbedding)
              
              MERGE (s)-[r:RELATION {type: $relation, user_id: $userId, source_file: $filename}]->(t)
            `;
            await tx.run(query, {
              source: item.source,
              target: item.target,
              relation: item.relation,
              userId: userId,
              filename: filename || 'Unknown Source',
              sourceEmbedding: entityEmbeddings[item.source] || null,
              targetEmbedding: entityEmbeddings[item.target] || null
            });
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
