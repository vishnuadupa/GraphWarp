/**
 * Domain extraction templates — written entirely by us, never by an LLM.
 *
 * Injection safety guarantee:
 *   Document content is ONLY used in Phase 1 (classification) where the
 *   LLM can output exactly one token from VALID_CLASSES.  Any injection
 *   attempt becomes a wrong category at worst — it cannot write or modify
 *   a template because templates are static TypeScript code.
 */

export type DocumentClass =
  | 'medical_research'
  | 'legal'
  | 'technical'
  | 'family_genealogy'
  | 'financial_business'
  | 'academic_scientific'
  | 'news_journalism'
  | 'resume_cv'
  | 'historical_literary'
  | 'general';

export const VALID_CLASSES = new Set<string>([
  'medical_research', 'legal', 'technical', 'family_genealogy',
  'financial_business', 'academic_scientific', 'news_journalism',
  'resume_cv', 'historical_literary', 'general',
]);

export interface ExtractionTemplate {
  label: string;
  entityTypes: string[];
  relationVerbs: string[];
  extractionRules: string[];
}

export const TEMPLATES: Record<DocumentClass, ExtractionTemplate> = {

  // ─────────────────────────────────────────────────────────────────────────
  medical_research: {
    label: 'Medical / Clinical Research',
    entityTypes: [
      'Drug', 'Condition', 'Trial', 'Institution', 'Patient', 'Researcher',
      'Biomarker', 'Gene', 'Protein', 'Pathway', 'AdverseEvent',
      'TreatmentProtocol', 'Result', 'Population', 'Dosage',
    ],
    relationVerbs: [
      'TREATS', 'INHIBITS', 'ACTIVATES', 'CAUSES', 'STUDIED_IN',
      'ENROLLED_IN', 'ADMINISTERED_TO', 'PUBLISHED_BY', 'CONDUCTED_AT',
      'CONTRAINDICATED_WITH', 'EXPRESSED_IN', 'ASSOCIATED_WITH',
      'COMPARED_TO', 'PRECEDED_BY', 'PART_OF', 'INVESTIGATED_BY',
      'REPORTED_IN', 'INTERACTS_WITH', 'BIOMARKER_OF', 'ENCODES',
    ],
    extractionRules: [
      'Extract both generic and brand name for every drug as separate Person nodes linked with IS_ALIAS_OF',
      'Dosage (amount + unit + frequency) is a property on the ADMINISTERED_TO relationship, not a standalone node',
      'Capture trial phase (Phase I / II / III / IV) as a property on Trial nodes',
      'p-values, confidence intervals, and hazard ratios are properties on Result nodes',
      'Direction rule: Drug TREATS Condition — never the reverse',
      'Direction rule: Drug CAUSES AdverseEvent — never Condition CAUSES Drug',
      'Patient cohort size and demographics (age range, sex ratio) are properties on Population nodes',
      'Extract every institution where research was conducted, even if mentioned briefly',
      'Capture all co-authors as Researcher nodes linked to the publication with AUTHORED_BY',
      'Extract funding bodies as Institution nodes linked to Trial with FUNDED_BY',
      'If a gene is mentioned alongside a condition, extract ASSOCIATED_WITH even if causality is not confirmed',
      'Capture follow-up duration as a property on Trial nodes',
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  legal: {
    label: 'Legal Document',
    entityTypes: [
      'Party', 'Obligation', 'Right', 'Clause', 'Contract', 'Court',
      'Jurisdiction', 'Date', 'Penalty', 'Asset', 'Agreement',
      'Law', 'Regulation', 'Event', 'Dispute', 'Remedy',
    ],
    relationVerbs: [
      'OBLIGATED_TO', 'GRANTED_TO', 'GOVERNED_BY', 'FILED_IN',
      'EFFECTIVE_ON', 'EXPIRES_ON', 'BREACHED_BY', 'ENFORCED_BY',
      'DEFINED_IN', 'REFERENCES', 'SUPERSEDES', 'BINDS', 'PROHIBITS',
      'PERMITS', 'INDEMNIFIES', 'SUBJECT_TO', 'EXECUTED_BY',
      'TRANSFERABLE_TO', 'DISPUTES_RESOLVED_BY',
    ],
    extractionRules: [
      'Every defined term in quotation marks or parentheses is an entity — extract it with type matching its semantic role',
      'Dates are always Date nodes — link them to the clause or obligation they govern',
      'Monetary amounts and penalty values are properties on the relationship, not standalone nodes',
      'Direction is critical: Party A OBLIGATED_TO Party B means A owes B, not the reverse',
      'Governing law and jurisdiction are always Jurisdiction nodes linked with GOVERNED_BY',
      'Extract every party, including third-party beneficiaries, even if mentioned once',
      'Termination conditions are Event nodes linked to the Contract with TERMINATES_ON',
      'Warranties and representations are Right nodes',
      'Indemnification: indemnifying party INDEMNIFIES indemnified party',
      'Amendments reference the original agreement with SUPERSEDES',
      'Extract notice requirements as Obligation nodes with deadline as Date property',
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  technical: {
    label: 'Technical / Software Documentation',
    entityTypes: [
      'Component', 'Module', 'Library', 'API', 'Endpoint', 'Function',
      'Class', 'Interface', 'Event', 'Version', 'Author', 'Organization',
      'Platform', 'Protocol', 'Error', 'Feature', 'Database', 'Tool',
      'Configuration', 'Service',
    ],
    relationVerbs: [
      'DEPENDS_ON', 'CALLS', 'IMPLEMENTS', 'EXTENDS', 'EMITS', 'HANDLES',
      'AUTHORED_BY', 'REPLACED_BY', 'COMPATIBLE_WITH', 'CONNECTS_TO',
      'STORES_IN', 'EXPOSES', 'DEPRECATED_BY', 'TRIGGERS', 'RETURNS',
      'THROWS', 'CONFIGURED_BY', 'DEPLOYED_ON', 'PUBLISHED_TO',
      'CONSUMED_BY', 'AUTHENTICATED_BY',
    ],
    extractionRules: [
      'Version numbers are properties on nodes, not separate nodes — unless the document explicitly compares multiple versions',
      'API endpoints are separate Endpoint nodes linked to their parent Service with EXPOSES',
      'Extract every dependency, even transitive ones mentioned in the text',
      'Deprecated items: OldComponent DEPRECATED_BY NewComponent',
      'Error codes and exception types are Error nodes linked to the function that throws them',
      'Configuration keys are Configuration nodes if they affect behavior of a component',
      'Extract all authors, contributors, and maintainers even if only mentioned in passing',
      'Platform compatibility constraints are properties on Component nodes',
      'Extract database schemas / collections as Database nodes',
      'Protocols (HTTP, gRPC, WebSocket) are Protocol nodes linked to services that use them',
      'Extract events emitted and the components that handle them — both sides of the relationship',
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  family_genealogy: {
    label: 'Family / Genealogical',
    entityTypes: [
      'Person', 'Marriage', 'Location', 'Date', 'Occupation',
      'Event', 'Ethnicity', 'Religion', 'Property',
    ],
    relationVerbs: [
      'PARENT_OF', 'CHILD_OF', 'MARRIED_TO', 'DIVORCED_FROM',
      'BORN_IN', 'DIED_IN', 'SIBLING_OF', 'HALF_SIBLING_OF',
      'ADOPTED_BY', 'STEP_PARENT_OF', 'WORKED_AS', 'LIVED_IN',
      'EMIGRATED_TO', 'BURIED_IN', 'WIDOWED_BY', 'IS_ALIAS_OF',
      'OWNS', 'RELATED_TO',
    ],
    extractionRules: [
      'Always use the full name — if only a surname is mentioned, use context to resolve to the full known name',
      'Maiden names: extract as separate Person node linked with IS_ALIAS_OF to the married name',
      'Dates are Date nodes (format: YYYY or YYYY-MM-DD); link to the event they describe',
      'Marriage is symmetric: if A MARRIED_TO B, also assert B MARRIED_TO A',
      'Half-siblings must be HALF_SIBLING_OF, not SIBLING_OF',
      'Adoption: child ADOPTED_BY adoptive parent — also capture biological parents if known',
      'Occupations are Occupation nodes, not text properties, so they can be queried across people',
      'Extract every location: birthplace, residence, emigration destination, burial site',
      'Approximate dates (circa, early 1900s) are still Date nodes with approximate=true property',
      'Extract godparents if mentioned: child HAS_GODPARENT Person',
      'Titles and honorifics (Dr., Sir, Rev.) are properties on Person nodes, not separate nodes',
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  financial_business: {
    label: 'Financial / Business',
    entityTypes: [
      'Company', 'Person', 'Role', 'Transaction', 'Date', 'Product',
      'Market', 'Asset', 'Liability', 'Revenue', 'Contract', 'Investor',
      'Subsidiary', 'Competitor', 'Regulator', 'Currency',
    ],
    relationVerbs: [
      'ACQUIRED_BY', 'INVESTED_IN', 'EMPLOYED_BY', 'FOUNDED_BY',
      'MERGED_WITH', 'SUBSIDIARY_OF', 'TRADED_ON', 'VALUED_AT',
      'REPORTED_BY', 'COMPETED_WITH', 'PARTNERED_WITH', 'SERVES',
      'REGULATED_BY', 'AUDITED_BY', 'DIVESTED_FROM', 'ISSUED_BY',
      'BACKED_BY', 'OWNS_STAKE_IN', 'DEFAULTED_ON', 'LISTED_ON',
    ],
    extractionRules: [
      'Monetary amounts and currencies are properties on relationships (e.g., ACQUIRED_BY has amount, currency)',
      'Extract all named executives: Person HELD_ROLE Role AT Company',
      'Funding rounds: extract amount, round type (Series A/B/C), date as properties on INVESTED_IN',
      'Extract every subsidiary, joint venture, and holding company relationship',
      'Market cap, revenue, profit — are properties on the Company node, not standalone nodes',
      'Regulatory actions: Regulator INVESTIGATED Company, Regulator FINED Company',
      'Extract all board members, not just C-suite',
      'Competitors: extract COMPETED_WITH relationships even when stated indirectly ("rival", "peer")',
      'Dates of transactions, filings, and announcements are Date nodes linked to the event',
      'Extract stock tickers as properties on Company nodes',
      'Ownership percentages are properties on OWNS_STAKE_IN relationships',
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  academic_scientific: {
    label: 'Academic / Scientific (Non-medical)',
    entityTypes: [
      'Researcher', 'Institution', 'Concept', 'Theory', 'Experiment',
      'Finding', 'Method', 'Dataset', 'Publication', 'Citation',
      'Field', 'Hypothesis', 'Equipment', 'Variable', 'Model',
    ],
    relationVerbs: [
      'PROPOSED_BY', 'CONDUCTED_AT', 'CITED_BY', 'TESTED_BY', 'SUPPORTS',
      'CONTRADICTS', 'BUILDS_ON', 'PUBLISHED_IN', 'PART_OF', 'USES',
      'DISCOVERED_BY', 'VALIDATED_BY', 'REFUTES', 'EXTENDS',
      'CORRELATED_WITH', 'CAUSED_BY', 'MEASURED_BY', 'APPLIED_TO',
    ],
    extractionRules: [
      'Every cited work is a Publication node linked with CITED_BY to the citing work',
      'Hypotheses and findings are separate nodes — link them with SUPPORTS or CONTRADICTS',
      'Extract all co-authors of every paper mentioned',
      'Methods and datasets are reusable nodes — multiple experiments can USES the same Method',
      'Statistical relationships (correlation, causation, regression) are captured as relationships with direction',
      'Extract equipment and instruments as Equipment nodes; experiments USE them',
      'Variables (independent, dependent, control) are Variable nodes linked to Experiment',
      'Replication studies: new Experiment VALIDATES or REFUTES existing Finding',
      'Extract funding sources as Institution nodes linked to research with FUNDED_BY',
      'Preprints and peer-reviewed publications are both Publication nodes with status as property',
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  news_journalism: {
    label: 'News / Journalism',
    entityTypes: [
      'Person', 'Organization', 'Location', 'Event', 'Date',
      'Statement', 'Policy', 'Conflict', 'Publication', 'Role',
    ],
    relationVerbs: [
      'REPORTED_BY', 'OCCURRED_IN', 'CAUSED_BY', 'RESPONDED_TO',
      'ACCUSED_OF', 'SUPPORTED_BY', 'OPPOSED_BY', 'ANNOUNCED_BY',
      'AFFECTED_BY', 'PARTICIPATED_IN', 'PUBLISHED_IN', 'QUOTED_BY',
      'ATTRIBUTED_TO', 'INVESTIGATED_BY', 'CONDEMNED_BY', 'ENDORSED_BY',
    ],
    extractionRules: [
      'Direct quotes are Statement nodes; link them to the speaker with QUOTED_BY and to the publication with PUBLISHED_IN',
      'Unnamed sources: create a Person node with name "Anonymous Source" and a role property',
      'Dates and locations of events are always extracted as Date and Location nodes',
      'Accusations and allegations: use ACCUSED_OF — never assert guilt as fact',
      'Policy actions: Organization ANNOUNCED_BY Person, Policy AFFECTS Population',
      'Extract all organizations mentioned, including those only referenced once',
      'Conflicts: capture both sides and link each to the Conflict node with PARTICIPATED_IN',
      'Official roles are captured as Role nodes linked to Person and Organization with dates',
      'Reactions to events are captured: Organization RESPONDED_TO Event',
      'Extract reporter and publication for every article referenced',
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  resume_cv: {
    label: 'Resume / CV / Biographical',
    entityTypes: [
      'Person', 'Organization', 'Role', 'Skill', 'Degree', 'Institution',
      'Certification', 'Project', 'Achievement', 'Location', 'Date', 'Tool',
      'Publication', 'Award',
    ],
    relationVerbs: [
      'WORKED_AT', 'HELD_ROLE', 'STUDIED_AT', 'EARNED_DEGREE', 'HAS_SKILL',
      'COMPLETED_PROJECT', 'RECEIVED_CERTIFICATION', 'MANAGED', 'USED_TOOL',
      'ACHIEVED', 'PROMOTED_TO', 'REPORTED_TO', 'VOLUNTEERED_AT',
      'PUBLISHED', 'RECEIVED_AWARD', 'LOCATED_IN', 'COLLABORATED_WITH',
    ],
    extractionRules: [
      'Each job position is a Role node linked to both Person (HELD_ROLE) and Organization (AT)',
      'Employment duration (start date, end date or "present") is a property on WORKED_AT',
      'Skills are always Skill nodes — never text properties on Person — so they can be queried across resumes',
      'Tools and technologies are Tool nodes linked to the Person or Role that used them',
      'Each certification has an issuing Organization and expiry Date as properties',
      'Projects are Project nodes; extract client, outcome, and tools used as properties or relationships',
      'Promotions: Person PROMOTED_TO new Role within same Organization, with date',
      'Academic degrees: Person EARNED_DEGREE Degree AT Institution with graduation year',
      'Extract every company, institution, and organization even if mentioned once',
      'Awards and honors are Award nodes linked to Person with RECEIVED_AWARD and year as property',
      'Volunteer and advisory roles are as important as paid employment — extract them all',
      'Publications: Person PUBLISHED Publication, including journal articles, blogs, and books',
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  historical_literary: {
    label: 'Historical / Literary',
    entityTypes: [
      'Person', 'Place', 'Event', 'Period', 'Work', 'Organization',
      'Concept', 'Date', 'Culture', 'Artifact', 'Belief', 'Movement',
    ],
    relationVerbs: [
      'PARTICIPATED_IN', 'OCCURRED_IN', 'AUTHORED_BY', 'INFLUENCED_BY',
      'PRECEDED_BY', 'LED_TO', 'PART_OF', 'LOCATED_IN', 'CREATED_BY',
      'ASSOCIATED_WITH', 'CONTEMPORARY_OF', 'OPPOSED_BY', 'INSPIRED_BY',
      'SYMBOLIZES', 'NAMED_AFTER', 'SUCCEEDED_BY', 'COMMEMORATES',
    ],
    extractionRules: [
      'Approximate dates (circa, mid-18th century) are still Date nodes with approximate=true property',
      'Works of literature or art are Work nodes; link to author, period, and cultural movement',
      'Historical figures: extract all known roles, titles, and aliases as IS_ALSO_KNOWN_AS',
      'Battles and conflicts are Event nodes; extract all participating factions and outcomes',
      'Cultural movements are Organization nodes; extract all associated figures',
      'Cause-effect in history: Event LED_TO Event, even across long time spans',
      'Artifacts are Artifact nodes; link to creator, period, and current location if known',
      'Dynasties and successions: Person SUCCEEDED_BY Person with date of transition',
      'Literary themes and motifs are Concept nodes linked to Work with EXPLORES',
      'Extract every geographic location, even if only a setting or backdrop',
      'Characters in literary works are Person nodes linked to Work with APPEARS_IN',
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  general: {
    label: 'General / Mixed',
    entityTypes: [
      'Person', 'Organization', 'Location', 'Event', 'Date',
      'Concept', 'Technology', 'Product', 'Role', 'Document',
    ],
    relationVerbs: [
      'WORKS_FOR', 'PART_OF', 'LOCATED_IN', 'FOUNDED_BY', 'EMPLOYED_BY',
      'PARTICIPATED_IN', 'CREATED_BY', 'ASSOCIATED_WITH', 'SUCCEEDED_BY',
      'CAUSED_BY', 'RELATED_TO', 'OWNED_BY', 'LED_BY', 'OCCURRED_ON',
    ],
    extractionRules: [
      'Extract every distinct entity mentioned, including those referenced only once',
      'Always use the most complete canonical form of a name',
      'Dates are Date nodes, not text properties',
      'Extract both direct and implied relationships',
      'Relationship direction follows grammatical subject → object',
    ],
  },
};

export function getTemplate(cls: string): ExtractionTemplate {
  const key = VALID_CLASSES.has(cls) ? (cls as DocumentClass) : 'general';
  return TEMPLATES[key];
}
