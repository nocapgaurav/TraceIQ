/**
 * Scans a repository into the API's graph, once, on first start.
 *
 * Without this a fresh `docker compose up` brings up an API with nothing in it: every read endpoint answers
 * `409 repository-not-scanned` and the web UI shows its "no repository has been scanned" state. Correct, but
 * a poor first impression when the repository to analyse is right there.
 *
 * **It goes through `POST /scan`.** The published REST surface, the same call the CLI and the UI would make —
 * so this script contains no analysis, opens no database and imports nothing. It is a `fetch` and a check.
 *
 * **Idempotent.** `GET /version` reports whether a graph exists; if one does, this exits without touching it.
 * A rescan is `docker compose run --rm seed --force`, or `POST /scan` by hand.
 */
const API = process.env.TRACEIQ_API_URL ?? 'http://api:3000';
const REPOSITORY = process.env.TRACEIQ_SCAN_PATH ?? '/workspace';
const FORCE = process.argv.includes('--force') || process.env.TRACEIQ_SCAN_FORCE === '1';

/** The API's own health check governs startup order, so this is a short backstop, not the real wait. */
const ATTEMPTS = 30;

async function version() {
  const response = await fetch(`${API}/version`);

  if (!response.ok) {
    throw new Error(`GET /version answered ${response.status}`);
  }

  const body = await response.json();

  return body.data;
}

async function waitForApi() {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await version();
    } catch (cause) {
      if (attempt === ATTEMPTS) {
        throw new Error(`the API at ${API} never answered: ${String(cause)}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw new Error('unreachable');
}

const current = await waitForApi();

if (current.scanned && !FORCE) {
  console.log(`a graph already exists at ${current.databasePath} — leaving it alone`);
  process.exit(0);
}

console.log(`scanning ${REPOSITORY} — this takes a minute or two on a repository of any size`);

const response = await fetch(`${API}/scan`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ repository: REPOSITORY }),
});

const body = await response.json();

if (!response.ok || body.success !== true) {
  // The API's error carries a code, a detail and a hint. Printing all three is more use than a status.
  const error = body.error ?? {};

  console.error(`scan failed: ${error.code ?? response.status}`);
  console.error(`  ${error.detail ?? 'no detail'}`);
  console.error(`  ${error.hint ?? ''}`);
  process.exit(1);
}

const summary = body.data;

console.log(
  `scanned ${summary.repository}: ${summary.files} files, ${summary.declarations} declarations, ` +
    `${summary.nodes} nodes, ${summary.edges} edges`,
);
