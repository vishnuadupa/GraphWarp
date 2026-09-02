import type OpenAI from 'openai';
import type { Driver } from 'neo4j-driver';
import { MODELS } from '@/lib/config/models';
import { withRetry } from '@/lib/utils/retry';
import { logLlmUsage } from '@/lib/observability/usage-log';

export interface AggregateResult {
  answer: string;
  count: number;
  type: string | null;
  nodes: Array<{ id: string; name: string; type: string; degree: number }>;
}

/**
 * Picks which entity type (if any) a counting/listing question refers to,
 * from the CLOSED set of types actually present in the user's graph — never
 * an LLM-invented type, so the Cypher WHERE clause below is always safe.
 */
async function classifyEntityType(
  client: OpenAI,
  question: string,
  availableTypes: string[],
  userId: string,
): Promise<string | null> {
  if (availableTypes.length === 0) return null;
  const started = Date.now();
  try {
    const res = await withRetry(() =>
      client.chat.completions.create({
        model: MODELS.DISCOVERY,
        messages: [
          {
            role: 'system',
            content:
              `Which entity type is this question asking to count or list? Output ONLY one exact word from: ${availableTypes.join(', ')}, all\n` +
              `Use "all" if the question isn't about one specific type.`,
          },
          { role: 'user', content: question.slice(0, 300) },
        ],
        max_tokens: 10,
      }),
    );
    logLlmUsage({ route: 'chat', model: MODELS.DISCOVERY, usage: res.usage, latencyMs: Date.now() - started, userId });
    const raw = (res.choices[0]?.message?.content ?? '').trim();
    return availableTypes.includes(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Answers "how many X" / "list all X" questions with a real Cypher COUNT
 * instead of asking the synthesis LLM to eyeball a subgraph and count —
 * that's the failure mode this replaces: entity-extraction-then-traverse
 * finds no specific named entity to match on a question like "how many
 * people are mentioned", so it either refuses or answers from a partial,
 * miscounted fragment. This bypasses entity matching entirely.
 */
export async function runAggregateQuery(
  driver: Driver,
  client: OpenAI,
  question: string,
  userId: string,
  selectedDocs: string[],
): Promise<AggregateResult> {
  const session = driver.session();
  try {
    return await session.executeRead(async (tx: any) => {
      const typesRes = await tx.run(
        'MATCH (n:Entity {user_id: $uid}) WHERE n.type IS NOT NULL RETURN DISTINCT n.type AS type',
        { uid: userId },
      );
      const availableTypes: string[] = typesRes.records.map((r: any) => r.get('type')).filter(Boolean);
      const targetType = await classifyEntityType(client, question, availableTypes, userId);

      // Nodes have no source_files of their own — a node is "in" a selected
      // document if at least one of its relationships was extracted from it.
      const docFilter = selectedDocs.length > 0
        ? `AND EXISTS {
             MATCH (n)-[r:RELATION]-()
             WHERE any(f IN coalesce(r.source_files, CASE WHEN r.source_file IS NOT NULL THEN [r.source_file] ELSE [] END)
                       WHERE f IN $selectedDocs OR any(doc IN $selectedDocs WHERE f CONTAINS doc))
           }`
        : '';

      const countRes = await tx.run(
        `MATCH (n:Entity {user_id: $uid})
         WHERE ($type IS NULL OR n.type = $type) ${docFilter}
         WITH n, COUNT { (n)-[:RELATION]-() } AS deg
         RETURN count(n) AS c, collect({id: n.name, name: n.name, type: n.type, degree: deg})[0..100] AS nodes`,
        { uid: userId, type: targetType, selectedDocs },
      );

      const record = countRes.records[0];
      const count: number = record?.get('c')?.toNumber?.() ?? 0;
      const nodesRaw: any[] = record?.get('nodes') ?? [];
      const nodes = nodesRaw.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type ?? 'Entity',
        degree: n.degree?.toNumber?.() ?? 1,
      }));

      const scope = selectedDocs.length > 0 ? ' in the selected documents' : '';
      const namesPreview = nodes.slice(0, 40).map((n) => n.name).join(', ') + (count > 40 ? ', and more' : '');
      const answer = count === 0
        ? `I found no matching entities in your knowledge graph${scope}.`
        : targetType
          ? `There are ${count} entities of type "${targetType}"${scope}: ${namesPreview}.`
          : `There are ${count} entities total${scope}: ${namesPreview}.`;

      return { answer, count, type: targetType, nodes };
    });
  } finally {
    await session.close();
  }
}
