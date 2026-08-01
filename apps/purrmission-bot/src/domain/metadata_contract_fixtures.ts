/**
 * Adapter-neutral fixtures shared by Discord, HTTP, Pawthy, and persistence contract tests.
 * Expected values are literals so an implementation change cannot silently rewrite the contract.
 */
export const METADATA_CONTRACT_FIXTURES = Object.freeze({
  canonicalSecretKeySet: Object.freeze({
    input: Object.freeze(['éclair', 'api-token', 'DB_PASSWORD']),
    canonical: Object.freeze(['DB_PASSWORD', 'api-token', 'éclair']),
    digest: 'sha256:caed884971efd5462e61df7bbb9da699561b654dc073576e57420201fc218cda',
  }),
  deterministicProjectOrder: Object.freeze([
    Object.freeze({ id: 'project-1', name: 'Alpha' }),
    Object.freeze({ id: 'project-2', name: 'alpha' }),
    Object.freeze({ id: 'project-3', name: 'Zulu' }),
  ]),
  firstProjectCursor:
    'eyJ2ZXJzaW9uIjoxLCJraW5kIjoiUFJPSkVDVCIsImZpbHRlcktleSI6IiIsInNvcnRLZXkiOiJhbHBoYSIsImlkIjoicHJvamVjdC0yIn0',
});
