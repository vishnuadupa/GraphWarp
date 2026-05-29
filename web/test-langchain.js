const { ChatOpenAI } = require('@langchain/openai');
const { z } = require('zod');
require('dotenv').config({ path: '.env.local' });

async function test() {
  const model = new ChatOpenAI({
    modelName: 'anthropic/claude-3.5-sonnet',
    openAIApiKey: process.env.OPENROUTER_API_KEY || 'placeholder',
    configuration: {
      baseURL: 'https://openrouter.ai/api/v1',
    },
    temperature: 0,
  });

  const graphTripleSchema = z.object({
    triples: z.array(z.object({
      source: z.string(),
      source_type: z.string(),
      relation: z.string(),
      target: z.string(),
      target_type: z.string()
    }))
  });

  try {
    const llm = model.withStructuredOutput(graphTripleSchema, { name: "extract_graph" });
    const result = await llm.invoke([
      { role: 'system', content: "Extract relationships." },
      { role: 'user', content: "Alice works at Apple Inc." }
    ]);
    console.log("Success:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Error:", err.message, err);
  }
}

test();
