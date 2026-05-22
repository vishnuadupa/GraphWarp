import { inngest } from './client';
import { supabaseAdmin } from '../supabase/service';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { driver } from '../neo4j/neo4j';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Sleep helper
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunkText(text: string, chunkSize: number = 2000): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

export const processDocument = inngest.createFunction(
  { id: "process-document", triggers: [{ event: "document.process" }] },
  async ({ event, step }) => {
    const { documentId, fileUrl, userId } = event.data;

    // 1. Download the file from Supabase Storage
    const fileContent = await step.run("download-file", async () => {
      // Assuming 'documents' is the bucket and fileUrl is the path inside the bucket
      const { data, error } = await supabaseAdmin.storage
        .from('documents')
        .download(fileUrl);
        
      if (error || !data) {
        throw new Error(`Failed to download file: ${error?.message}`);
      }
      return await data.text();
    });

    // 2. Extract and chunk the text
    const chunks = await step.run("chunk-text", async () => {
      return chunkText(fileContent, 3000);
    });

    // 3. Call Gemini API to extract entities and relationships
    const extractedData = await step.run("extract-graph", async () => {
      const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        generationConfig: {
          responseMimeType: "application/json"
        }
      });

      const allRelationships: Array<{source: string; relation: string; target: string}> = [];

      for (let i = 0; i < chunks.length; i++) {
        // Implement delay to respect Gemini's 15 RPM free-tier limit (wait ~4 seconds between calls)
        if (i > 0) {
          await sleep(4100); 
        }

        const chunk = chunks[i];
        const prompt = `
          Analyze the following text and extract entities and relationships.
          Output a JSON array of objects, where each object has "source", "relation", and "target" properties.
          Keep entity names concise and capitalized appropriately.
          
          Text:
          ${chunk}
        `;

        try {
          const result = await model.generateContent(prompt);
          const responseText = result.response.text();
          
          // Parse the JSON array
          const jsonMatch = responseText.match(/\[[\s\S]*\]/);
          const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
          
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item.source && item.relation && item.target) {
                allRelationships.push({
                  source: item.source.trim(),
                  relation: item.relation.trim(),
                  target: item.target.trim()
                });
              }
            }
          }
        } catch (error) {
          console.error(`Failed to process chunk ${i}:`, error);
          // Continue with next chunks
        }
      }

      return allRelationships;
    });

    // 4. Connect to Neo4j and MERGE Nodes and Edges
    await step.run("save-to-neo4j", async () => {
      if (extractedData.length === 0) return { inserted: 0 };
      
      const session = driver.session();
      try {
        await session.executeWrite(async (tx) => {
          for (const item of extractedData) {
            const query = `
              MERGE (s:Entity {name: $source, user_id: $userId})
              MERGE (t:Entity {name: $target, user_id: $userId})
              MERGE (s)-[r:RELATION {type: $relation, user_id: $userId}]->(t)
            `;
            await tx.run(query, {
              source: item.source,
              target: item.target,
              relation: item.relation,
              userId: userId
            });
          }
        });
      } finally {
        await session.close();
      }
      
      return { inserted: extractedData.length };
    });

    // 5. Update document status to 'Completed'
    await step.run("update-status", async () => {
      await supabaseAdmin
        .from('documents')
        .update({ status: 'Completed' })
        .eq('id', documentId);
    });

    return { success: true, processedChunks: chunks.length, relationsExtracted: extractedData.length };
  }
);
