/**
 * The SQLite schema, exactly as specified in `docs/04-graph-spec.md` §8.
 *
 * Statement order matters: a table is created after everything it references.
 */
/**
 * Bumped to 3 for `nodes.category`, which the `Technology` kind needs.
 *
 * Version 2 added universal repository facts: `nodes.language`, `nodes.file_role` and the three
 * `region*` tables. Version 3 adds one nullable column, because a new node kind arrived with an
 * attribute none of the existing columns means. Reusing `external_kind` was tried and reverted —
 * it is a closed vocabulary of packaging systems, and a consumer filtering `external_kind = 'npm'`
 * must never meet `'frontend'` in that column.
 *
 * There is no migration path and none is needed — a graph is rebuilt from source on every scan,
 * and the store refuses a database written by a different version rather than reading it wrongly.
 */
export const SCHEMA_VERSION = 3;

const CONFIDENCE_CHECK = `CHECK (confidence IN ('CERTAIN','RESOLVED','INFERRED','AMBIGUOUS'))`;

/**
 * The frozen relationship vocabulary. Constrained because it cannot grow, so the
 * check can never force a migration and it catches a typo at insert. `nodes.kind` is
 * deliberately *not* constrained — node types are an open vocabulary, and `Route`,
 * `EnvironmentVariable` and `DatabaseTable` are still to come.
 */
const RELATIONSHIP_CHECK = `CHECK (type IN (
    'DECLARES','IMPORTS','EXPORTS','CALLS','IMPLEMENTS','EXTENDS','REFERENCES_TYPE',
    'HANDLED_BY','READS','WRITES','DEPENDS_ON','CONTINUES_TO','TESTS'
  ))`;

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE repository (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    name           TEXT NOT NULL,
    root_path      TEXT NOT NULL,
    schema_version INTEGER NOT NULL
  )`,

  `CREATE TABLE revisions (
    id          INTEGER PRIMARY KEY,
    created_at  TEXT NOT NULL,
    source_hash TEXT
  )`,

  `CREATE TABLE nodes (
    id                      TEXT PRIMARY KEY,
    kind                    TEXT NOT NULL,
    name                    TEXT NOT NULL,
    file_id                 TEXT REFERENCES nodes(id),
    container_chain         TEXT,
    visibility              TEXT CHECK (visibility IN ('public','protected','private')),
    is_exported             INTEGER NOT NULL DEFAULT 0,
    is_static               INTEGER NOT NULL DEFAULT 0,
    is_abstract             INTEGER NOT NULL DEFAULT 0,
    is_readonly             INTEGER NOT NULL DEFAULT 0,
    is_optional             INTEGER NOT NULL DEFAULT 0,
    is_async                INTEGER NOT NULL DEFAULT 0,
    is_declaration_file     INTEGER,
    has_symbol              INTEGER,
    is_exported_from_module INTEGER,
    external_kind           TEXT,
    external_name           TEXT,
    language                TEXT,
    file_role               TEXT,
    category                TEXT,
    confidence              TEXT NOT NULL ${CONFIDENCE_CHECK},
    provenance_producer     TEXT NOT NULL,
    provenance_file_id      TEXT REFERENCES nodes(id),
    provenance_evidence     TEXT NOT NULL,
    revision_id             INTEGER NOT NULL REFERENCES revisions(id)
  )`,

  /*
   * Technology regions and how deeply each was analysed.
   *
   * Tables rather than nodes: a region describes the *analysis*, not the code, so putting
   * it in `nodes` would surface it in search results and traversals where a reader would
   * not expect it. Its languages and ecosystems are rows rather than delimited strings,
   * because a delimiter in a column is a parser waiting to be written.
   */
  `CREATE TABLE regions (
    path              TEXT PRIMARY KEY,
    primary_language  TEXT,
    file_count        INTEGER NOT NULL,
    source_file_count INTEGER NOT NULL,
    analysis_depth    TEXT NOT NULL CHECK (analysis_depth IN (
      'universal','structural','semantic','framework'
    )),
    depth_reason      TEXT NOT NULL,
    revision_id       INTEGER NOT NULL REFERENCES revisions(id)
  )`,

  `CREATE TABLE region_languages (
    region_path TEXT NOT NULL REFERENCES regions(path),
    language    TEXT NOT NULL,
    files       INTEGER NOT NULL,
    PRIMARY KEY (region_path, language)
  )`,

  `CREATE TABLE region_ecosystems (
    region_path TEXT NOT NULL REFERENCES regions(path),
    ecosystem   TEXT NOT NULL,
    PRIMARY KEY (region_path, ecosystem)
  )`,

  `CREATE TABLE node_locations (
    node_id      TEXT    NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    ordinal      INTEGER NOT NULL,
    start_line   INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_line     INTEGER NOT NULL,
    end_column   INTEGER NOT NULL,
    PRIMARY KEY (node_id, ordinal)
  )`,

  `CREATE TABLE node_roles (
    node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    role       TEXT NOT NULL
               CHECK (role IN ('Controller','Service','Repository','Middleware','Model','Test')),
    confidence TEXT NOT NULL ${CONFIDENCE_CHECK},
    evidence   TEXT NOT NULL,
    PRIMARY KEY (node_id, role)
  )`,

  `CREATE TABLE file_revisions (
    revision_id  INTEGER NOT NULL REFERENCES revisions(id),
    file_id      TEXT    NOT NULL REFERENCES nodes(id),
    content_hash TEXT,
    PRIMARY KEY (revision_id, file_id)
  )`,

  `CREATE TABLE edges (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL ${RELATIONSHIP_CHECK},
    source_id           TEXT NOT NULL REFERENCES nodes(id),
    target_id           TEXT NOT NULL REFERENCES nodes(id),
    name                TEXT,
    confidence          TEXT NOT NULL ${CONFIDENCE_CHECK},
    candidate_group     TEXT,
    ordinal             INTEGER,
    provenance_resolver TEXT NOT NULL,
    provenance_file_id  TEXT NOT NULL REFERENCES nodes(id),
    provenance_evidence TEXT NOT NULL,
    start_line          INTEGER NOT NULL,
    start_column        INTEGER NOT NULL,
    end_line            INTEGER NOT NULL,
    end_column          INTEGER NOT NULL,
    revision_id         INTEGER NOT NULL REFERENCES revisions(id)
  )`,

  `CREATE TABLE unresolved_references (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL ${RELATIONSHIP_CHECK},
    source_id           TEXT NOT NULL REFERENCES nodes(id),
    name                TEXT,
    reason              TEXT NOT NULL,
    text                TEXT NOT NULL,
    provenance_resolver TEXT NOT NULL,
    provenance_file_id  TEXT NOT NULL REFERENCES nodes(id),
    provenance_evidence TEXT NOT NULL,
    start_line          INTEGER NOT NULL,
    start_column        INTEGER NOT NULL,
    end_line            INTEGER NOT NULL,
    end_column          INTEGER NOT NULL,
    revision_id         INTEGER NOT NULL REFERENCES revisions(id)
  )`,

  `CREATE INDEX nodes_by_file ON nodes(file_id)`,
  `CREATE INDEX nodes_by_kind ON nodes(kind)`,
  `CREATE INDEX edges_by_source ON edges(source_id, type)`,
  `CREATE INDEX edges_by_target ON edges(target_id, type)`,
  `CREATE INDEX edges_by_group ON edges(candidate_group)`,
  `CREATE INDEX edges_by_file ON edges(provenance_file_id)`,
  `CREATE INDEX unresolved_by_file ON unresolved_references(provenance_file_id)`,
];

/**
 * Delete order for replacing a revision: children before parents, so foreign keys
 * hold at every step and enforcement never has to be deferred.
 *
 * `nodes` is emptied in two statements because `nodes.file_id` is self-referential:
 * every declaration node points at a `File` node, so the declarations must go first.
 * A single `DELETE FROM nodes` would depend on row order to avoid a transient
 * violation.
 */
export const TRUNCATE_STATEMENTS: readonly string[] = [
  'DELETE FROM edges',
  'DELETE FROM unresolved_references',
  'DELETE FROM region_languages',
  'DELETE FROM region_ecosystems',
  'DELETE FROM regions',
  'DELETE FROM node_roles',
  'DELETE FROM node_locations',
  'DELETE FROM file_revisions',
  `DELETE FROM nodes WHERE kind <> 'File'`,
  'DELETE FROM nodes',
  'DELETE FROM revisions',
  'DELETE FROM repository',
];
