/**
 * Extraction eval — runs every fixture in eval/dataset through the real
 * classification + extraction pipeline and scores it against the hand labels.
 *
 * Needs a live OPENROUTER_API_KEY. There is no offline/mock mode by design:
 * this measures the actual model + template behaviour, which is the only thing
 * worth measuring.
 *
 *   npm run eval:extraction
 *   npm run eval:extraction -- vendor-services-contract   # single fixture
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as fs from 'fs';
import * as path from 'path';
import { runPipeline, requireApiKey, type Entity, type GraphTriple } from './pipeline';
import { MODELS } from '../src/lib/config/models';
import { fuzzyMatch, prf, pct, round, writeReport } from './util';

interface Expected {
  name: string;
  expectedClass: string;
  acceptableClasses: string[];
  notes?: string;
  entities: Entity[];
  relationships: Array<{ source: string; relation: string; target: string }>;
  qa: Array<{ question: string; expectedAnswer: string | null; answerable: boolean }>;
}

const DATASET = path.join(__dirname, 'dataset');

function loadFixtures(filter?: string): Array<{ expected: Expected; text: string }> {
  return fs.readdirSync(DATASET)
    .filter((f) => f.endsWith('.expected.json'))
    .map((f) => {
      const base = f.replace('.expected.json', '');
      const expected: Expected = JSON.parse(fs.readFileSync(path.join(DATASET, f), 'utf8'));
      const doc = ['.md', '.txt'].map((e) => path.join(DATASET, base + e)).find(fs.existsSync);
      if (!doc) throw new Error(`No .md/.txt fixture found for ${f}`);
      return { expected, text: fs.readFileSync(doc, 'utf8') };
    })
    .filter((f) => !filter || f.expected.name.includes(filter));
}

function scoreEntities(expected: Entity[], actual: Entity[]) {
  const matchedActual = new Set<number>();
  const missed: string[] = [];
  let typeCorrect = 0;

  for (const exp of expected) {
    const i = actual.findIndex((a, idx) => !matchedActual.has(idx) && fuzzyMatch(exp.name, a.name));
    if (i === -1) { missed.push(`${exp.name} (${exp.type})`); continue; }
    matchedActual.add(i);
    if (fuzzyMatch(exp.type, actual[i].type)) typeCorrect++;
  }

  const tp = matchedActual.size;
  return {
    expectedCount: expected.length,
    extractedCount: actual.length,
    matched: tp,
    missed,
    // Gold labels are the entities that MUST appear, not an exhaustive list —
    // so precision is a lower bound: legitimate extra entities count as FPs.
    ...prf(tp, actual.length - tp, expected.length - tp),
    typeAccuracy: tp ? round(typeCorrect / tp) : 0,
  };
}

function scoreRelations(
  expected: Expected['relationships'],
  actual: GraphTriple[],
) {
  const missed: string[] = [];
  let matched = 0;
  let reversed = 0;
  let verbMatched = 0;

  for (const exp of expected) {
    const hit = actual.find((t) => fuzzyMatch(exp.source, t.source) && fuzzyMatch(exp.target, t.target));
    if (hit) {
      matched++;
      if (fuzzyMatch(exp.relation.replace(/_/g, ' '), hit.relation.replace(/_/g, ' '))) verbMatched++;
      continue;
    }
    const flipped = actual.find((t) => fuzzyMatch(exp.source, t.target) && fuzzyMatch(exp.target, t.source));
    if (flipped) { reversed++; missed.push(`${exp.source} -${exp.relation}-> ${exp.target} [DIRECTION REVERSED]`); }
    else missed.push(`${exp.source} -${exp.relation}-> ${exp.target}`);
  }

  return {
    expectedCount: expected.length,
    extractedCount: actual.length,
    matched,
    reversedDirection: reversed,
    verbMatched,
    // Recall only: hand labels cover key relationships, not every valid triple,
    // so relation precision would punish correct extra output.
    recall: expected.length ? round(matched / expected.length) : 0,
    missed,
  };
}

/** `npm run eval:extraction -- --selftest` — checks the scoring math, no API calls. */
function selftest(): void {
  const ent = scoreEntities(
    [{ name: 'Northwind Analytics Inc.', type: 'Company' }, { name: 'Corvus Data Systems', type: 'Company' }],
    [{ name: 'northwind analytics', type: 'Company' }, { name: 'Atlas Reporting Suite', type: 'Product' }],
  );
  assert(ent.matched === 1, 'fuzzy match should find Northwind but not Corvus');
  assert(ent.recall === 0.5 && ent.precision === 0.5, `expected 0.5/0.5, got ${ent.recall}/${ent.precision}`);
  assert(ent.typeAccuracy === 1, 'matched entity type should score');
  assert(ent.missed.length === 1 && ent.missed[0].startsWith('Corvus'), 'Corvus should be reported missed');

  const t = (source: string, relation: string, target: string) =>
    ({ source, source_type: 'Company', relation, target, target_type: 'Company' });
  const rel = scoreRelations(
    [
      { source: 'Lumen Metrics Ltd.', relation: 'ACQUIRED_BY', target: 'Northwind Analytics Inc.' },
      { source: 'Northwind Analytics Inc.', relation: 'OWNS_STAKE_IN', target: 'Corvus Data Systems' },
      { source: 'Northwind Analytics Inc.', relation: 'AUDITED_BY', target: 'Harkness & Wolfe LLP' },
    ],
    [t('Lumen Metrics', 'ACQUIRED_BY', 'Northwind Analytics'), t('Corvus Data Systems', 'OWNED_BY', 'Northwind Analytics')],
  );
  assert(rel.matched === 1, `expected 1 directed match, got ${rel.matched}`);
  assert(rel.verbMatched === 1, 'ACQUIRED_BY verb should match');
  assert(rel.reversedDirection === 1, 'the Corvus triple is reversed and should be flagged');
  assert(rel.missed.some((m) => m.includes('DIRECTION REVERSED')), 'reversal should show in missed list');
  assert(rel.recall === round(1 / 3), `expected recall 0.333, got ${rel.recall}`);

  console.log('selftest: scoring math OK (no API calls made)');
}

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error(`selftest FAILED: ${msg}`); process.exit(1); }
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  requireApiKey();
  const filter = process.argv[2];
  const fixtures = loadFixtures(filter);
  if (!fixtures.length) { console.error(`No fixtures matched "${filter}"`); process.exit(1); }

  console.log(`\nExtraction eval — ${fixtures.length} fixture(s), models: ${MODELS.DISCOVERY} / ${MODELS.EXTRACTION}\n`);

  const docs = [];
  let classCorrect = 0;
  let tp = 0, fp = 0, fn = 0;
  let relMatched = 0, relExpected = 0;

  for (const { expected, text } of fixtures) {
    const started = Date.now();
    process.stdout.write(`  ${expected.name} … `);

    const { docClass, entities, triples } = await runPipeline(text);

    const accepted = expected.acceptableClasses?.length ? expected.acceptableClasses : [expected.expectedClass];
    const classOk = accepted.includes(docClass);
    if (classOk) classCorrect++;

    const ent = scoreEntities(expected.entities, entities);
    const rel = scoreRelations(expected.relationships, triples);

    tp += ent.matched;
    fp += ent.extractedCount - ent.matched;
    fn += ent.expectedCount - ent.matched;
    relMatched += rel.matched;
    relExpected += rel.expectedCount;

    const durationMs = Date.now() - started;
    docs.push({
      name: expected.name,
      expectedClass: expected.expectedClass,
      acceptableClasses: accepted,
      actualClass: docClass,
      classificationCorrect: classOk,
      entities: ent,
      relations: rel,
      durationMs,
    });

    console.log(
      `${classOk ? 'OK ' : 'MISS'} class=${docClass}  ` +
      `entities F1=${pct(ent.f1)} (${ent.matched}/${ent.expectedCount} found, ${ent.extractedCount} extracted)  ` +
      `relations recall=${pct(rel.recall)}  ${durationMs}ms`,
    );
  }

  const summary = {
    fixtures: fixtures.length,
    classificationAccuracy: round(classCorrect / fixtures.length),
    entities: prf(tp, fp, fn),
    relationRecall: relExpected ? round(relMatched / relExpected) : 0,
  };

  console.log('\n── Summary ───────────────────────────────────');
  console.log(`  classification accuracy : ${pct(summary.classificationAccuracy)} (${classCorrect}/${fixtures.length})`);
  console.log(`  entity precision        : ${pct(summary.entities.precision)}  (lower bound — gold set is not exhaustive)`);
  console.log(`  entity recall           : ${pct(summary.entities.recall)}`);
  console.log(`  entity F1               : ${pct(summary.entities.f1)}`);
  console.log(`  relation recall         : ${pct(summary.relationRecall)}`);

  const missedAll = docs.flatMap((d) => d.entities.missed);
  if (missedAll.length) {
    console.log(`\n  missed entities (${missedAll.length}):`);
    for (const m of missedAll) console.log(`    - ${m}`);
  }

  const file = writeReport('extraction', {
    timestamp: new Date().toISOString(),
    models: { discovery: MODELS.DISCOVERY, extraction: MODELS.EXTRACTION },
    summary,
    docs,
  });
  console.log(`\n  report: ${file}\n`);
}

main().catch((err) => { console.error('\nEval failed:', err?.message ?? err); process.exit(1); });
