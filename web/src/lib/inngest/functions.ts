import { inngest } from './client';
import { supabaseAdmin } from '../supabase/service';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { driver } from '../neo4j/neo4j';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export const processDocument = inngest.createFunction(
  { id: "process-document", triggers: [{ event: "document.process" }] },
  async ({ event, step }) => {
    const { documentId, filePath, userId, filename } = event.data;

    // 1. Download the file from Supabase Storage as ArrayBuffer
    const { base64Data, mimeType } = await step.run("download-file", async () => {
      const { data, error } = await supabaseAdmin.storage
        .from('documents')
        .download(filePath);
        
      if (error || !data) {
        throw new Error(`Failed to download file: ${error?.message}`);
      }
      
      const arrayBuffer = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64Data = buffer.toString('base64');
      
      const ext = filename?.split('.').pop()?.toLowerCase() || '';
      let mimeType = 'text/plain';
      if (ext === 'pdf') mimeType = 'application/pdf';
      else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      }
      
      return { base64Data, mimeType };
    });

    // 2. Call Gemini API to extract entities and relationships across the entire document
    const extractedData = await step.run("extract-graph", async () => {
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
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

      try {
        const result = await model.generateContent([
          prompt,
          { inlineData: { data: base64Data, mimeType } }
        ]);
        
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

    // 3. Connect to Neo4j and MERGE Nodes and Edges with Source Citations
    await step.run("save-to-neo4j", async () => {
      if (!extractedData || extractedData.length === 0) return { inserted: 0 };
      
      const session = driver.session();
      try {
        await session.executeWrite(async (tx) => {
          for (const item of extractedData) {
            const query = `
              MERGE (s:Entity {name: $source, user_id: $userId})
              MERGE (t:Entity {name: $target, user_id: $userId})
              MERGE (s)-[r:RELATION {type: $relation, user_id: $userId, source_file: $filename}]->(t)
            `;
            await tx.run(query, {
              source: item.source,
              target: item.target,
              relation: item.relation,
              userId: userId,
              filename: filename || 'Unknown Source'
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
