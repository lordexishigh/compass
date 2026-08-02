import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * "A test enumerates every repository/query function and asserts each requires an org
 * scope parameter."
 *
 * ## Why this is a source scan rather than a runtime probe
 *
 * A parameter's *type* does not survive to runtime, so no amount of reflection over the
 * imported functions can see it. Calling each one with a bad first argument and requiring
 * a throw would be a runtime probe of a different property — that the guard fires — and it
 * would need a live database per function.
 *
 * So the repositories are parsed with the TypeScript compiler and every exported function
 * is required to take an org scope first. That is exactly the claim: *the signature makes
 * an unscoped call impossible to write*. `tests/scoped-db.test.ts` proves the other half —
 * that a `ScopedDb` always puts the organization predicate in the emitted SQL.
 *
 * ## What counts as an org scope
 *
 * Two shapes, and both genuinely are one:
 *
 *  - `scoped: ScopedDb` — a handle that was constructed from a validated `OrgScope` and
 *    cannot be built without one.
 *  - `organizationId: string` — for the deterministic id derivations, which take the
 *    organization as their first argument because the id they produce is namespaced by it.
 *    An id derived without the organization would collide across tenants.
 *
 * ## Which functions the rule applies to
 *
 * Every function that *reaches the database*, which in this package is exactly the
 * functions that return a Promise. A repository also holds a few synchronous helpers —
 * canonicalising an email, composing a link key from three strings — and requiring a scope
 * of those would be cargo cult: they have nothing to scope.
 *
 * The obvious way to abuse that distinction would be to write a query as a synchronous
 * function, so the sync helpers are checked too: each is required to touch no table and no
 * `ScopedDb`. A helper that reached the database would fail *that* assertion instead.
 */

const REPOSITORIES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'repositories');

/**
 * The one documented exception, and why it has to be one.
 *
 * `ensureOrganization` writes the tenant root. The scope it would be checked against is
 * the row being created, so requiring one would be circular — there is no organization to
 * be scoped to until this function has run. It takes a raw `CompassDatabase` and is the
 * only function in the package that does. Its *read* counterpart, `findOrganization`,
 * takes a scope like everything else.
 *
 * Listed by name rather than by a naming convention, so adding a second exception is a
 * visible edit to this file rather than a function that happens to match a pattern.
 */
const DOCUMENTED_EXCEPTIONS: readonly string[] = ['ensureOrganization'];

const SCOPE_FIRST_PARAMETER_TYPES = new Set(['ScopedDb']);
const SCOPE_FIRST_PARAMETER_NAMES = new Set(['organizationId']);

interface ExportedFunction {
  readonly file: string;
  readonly name: string;
  readonly firstParameterName: string | null;
  readonly firstParameterType: string | null;
  /** True when the function returns a Promise — in this package, when it reaches the database. */
  readonly reachesDatabase: boolean;
  /** The function's own source, for the "a sync helper touches no table" assertion. */
  readonly body: string;
}

/** Every way this package writes "this function awaits the database". */
const RETURNS_PROMISE = (node: ts.SignatureDeclarationBase, source: ts.SourceFile): boolean => {
  const declared = node.type?.getText(source).trim() ?? '';
  return declared.startsWith('Promise<');
};

const IS_ASYNC = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);

/** The calls that touch a table. A sync helper must contain none of them. */
const DATABASE_CALLS = /\.(selectFrom|insertInto|updateIn|deleteFrom)\s*\(/;

/** Every exported function in one repository module, with its first parameter. */
function exportedFunctionsIn(file: string): readonly ExportedFunction[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(REPOSITORIES, file), 'utf8'),
    ts.ScriptTarget.ES2023,
    true,
  );

  const found: ExportedFunction[] = [];

  const describeParameter = (parameters: ts.NodeArray<ts.ParameterDeclaration>) => {
    const first = parameters[0];
    if (first === undefined) return { firstParameterName: null, firstParameterType: null };
    return {
      firstParameterName: ts.isIdentifier(first.name) ? first.name.text : null,
      // The declared type, textually. `ScopedDb` is `ScopedDb` however it was imported.
      firstParameterType: first.type === undefined ? null : first.type.getText(source).trim(),
    };
  };

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of source.statements) {
    // `export function name(...)` / `export async function name(...)`
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.name !== undefined) {
      found.push({
        file,
        name: statement.name.text,
        ...describeParameter(statement.parameters),
        reachesDatabase: IS_ASYNC(statement) || RETURNS_PROMISE(statement, source),
        body: statement.getText(source),
      });
      continue;
    }

    // `export const name = (...) => ...`
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const initializer = declaration.initializer;
        if (initializer === undefined) continue;
        if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) continue;

        found.push({
          file,
          name: declaration.name.text,
          ...describeParameter(initializer.parameters),
          reachesDatabase: IS_ASYNC(initializer) || RETURNS_PROMISE(initializer, source),
          body: declaration.getText(source),
        });
      }
    }
  }

  return found;
}

const REPOSITORY_FILES = readdirSync(REPOSITORIES).filter((name) => name.endsWith('.ts')).sort();

const EVERY_EXPORTED_FUNCTION: readonly ExportedFunction[] = REPOSITORY_FILES.flatMap(exportedFunctionsIn);

/** The query functions — everything that reaches the database. The rule applies to these. */
const QUERY_FUNCTIONS = EVERY_EXPORTED_FUNCTION.filter((entry) => entry.reachesDatabase);

/** The synchronous helpers. Held to a different, equally load-bearing rule. */
const SYNC_HELPERS = EVERY_EXPORTED_FUNCTION.filter((entry) => !entry.reachesDatabase);

describe('the scoped-query layer has no unscoped door', () => {
  it('found the repositories at all, so an empty walk cannot pass this file', () => {
    expect(REPOSITORY_FILES.length).toBeGreaterThanOrEqual(6);
    expect(REPOSITORY_FILES).toContain('auth.ts');
    expect(REPOSITORY_FILES).toContain('goals.ts');
    expect(REPOSITORY_FILES).toContain('reports.ts');
  });

  it('found a plausible number of exported functions, so the parser is not silently failing', () => {
    expect(EVERY_EXPORTED_FUNCTION.length).toBeGreaterThan(40);
    expect(EVERY_EXPORTED_FUNCTION.map((entry) => entry.name)).toContain('findUserByEmail');
    expect(EVERY_EXPORTED_FUNCTION.map((entry) => entry.name)).toContain('appendAuditLogEntry');
    // Both classifications must be non-empty, or one of the two rules below is vacuous.
    expect(QUERY_FUNCTIONS.length).toBeGreaterThan(40);
    expect(SYNC_HELPERS.length).toBeGreaterThan(0);
  });

  it.each(QUERY_FUNCTIONS.map((entry) => [`${entry.file}:${entry.name}`, entry] as const))(
    '%s takes an organization scope as its first parameter',
    (_label, entry) => {
      if (DOCUMENTED_EXCEPTIONS.includes(entry.name)) {
        // Asserted rather than skipped: the exception has to keep being the shape the
        // comment above describes, or it is no longer the documented one.
        expect(entry.firstParameterType).toBe('CompassDatabase');
        return;
      }

      const scopedByType =
        entry.firstParameterType !== null && SCOPE_FIRST_PARAMETER_TYPES.has(entry.firstParameterType);
      const scopedByName =
        entry.firstParameterName !== null && SCOPE_FIRST_PARAMETER_NAMES.has(entry.firstParameterName);

      expect(
        scopedByType || scopedByName,
        `${entry.file}:${entry.name} takes \`${entry.firstParameterName}: ${entry.firstParameterType}\` first. ` +
          'Every repository function must take `scoped: ScopedDb` (or `organizationId: string` for an id derivation) ' +
          'so an unscoped query cannot be written.',
      ).toBe(true);
    },
  );

  it('has exactly one documented exception', () => {
    const exceptions = EVERY_EXPORTED_FUNCTION.filter((entry) => entry.firstParameterType === 'CompassDatabase');

    expect(
      exceptions.map((entry) => entry.name).sort(),
      'a new function takes a raw database handle — it needs a documented reason in this file, or a scope',
    ).toEqual([...DOCUMENTED_EXCEPTIONS].sort());
  });

  /**
   * The other half of the rule.
   *
   * Classifying by "reaches the database" is only safe if a query cannot dodge the
   * classification by being written synchronously. So every sync helper is required to
   * touch no table and hold no `ScopedDb` — a query written as one would fail here.
   */
  it.each(SYNC_HELPERS.map((entry) => [`${entry.file}:${entry.name}`, entry] as const))(
    '%s is a pure helper: it reaches no table, so it has nothing to scope',
    (_label, entry) => {
      expect(
        DATABASE_CALLS.test(entry.body),
        `${entry.name} is synchronous but calls a table. Make it take \`scoped: ScopedDb\` and return a Promise.`,
      ).toBe(false);
      expect(entry.body).not.toContain('ScopedDb');
    },
  );

  /**
   * The complete list of functions that take no organization at all.
   *
   * Most synchronous helpers here *are* scoped — the id derivations take
   * `organizationId` first, because an id not namespaced by the tenant would collide
   * across them. These five take nothing, and each has a reason that has to survive
   * being written down:
   *
   *  - `normalizeEmail(email)` — lower-cases and trims a string.
   *  - `tableNameOf(table)` — reads a drizzle table's own name.
   *  - `scopeLinkKey(nodeId, kind, key)` — joins three strings with `|`.
   *  - `narrationTraceRowId(reportId, …)` — namespaced by the report id, which is itself
   *    derived from `(organizationId, scope, instant)`, so the tenant is already in it.
   *  - `feedbackNaturalKey({action, cause…})` — a natural key, and a natural key is by
   *    definition the part of an identity that is *not* the tenant. `recordItemFeedback`
   *    passes it through `entityRowId(scoped.organizationId, …)`, which is where the tenant
   *    enters, exactly as every other entity's natural key works.
   *
   * Enumerated rather than pattern-matched, so a sixth one is a visible edit here.
   */
  it('names every function that takes no organization at all', () => {
    const unscoped = EVERY_EXPORTED_FUNCTION.filter(
      (entry) =>
        !(entry.firstParameterType !== null && SCOPE_FIRST_PARAMETER_TYPES.has(entry.firstParameterType)) &&
        !(entry.firstParameterName !== null && SCOPE_FIRST_PARAMETER_NAMES.has(entry.firstParameterName)) &&
        entry.firstParameterType !== 'CompassDatabase',
    );

    expect(unscoped.map((entry) => `${entry.file}:${entry.name}`).sort()).toEqual([
      'auth.ts:normalizeEmail',
      'entity-rows.ts:tableNameOf',
      'feedback.ts:feedbackNaturalKey',
      'goals.ts:scopeLinkKey',
      'narration.ts:narrationTraceRowId',
    ]);
    // And every one of them is synchronous, so none can be reaching the database.
    expect(unscoped.every((entry) => !entry.reachesDatabase)).toBe(true);
  });
});

describe('no repository offers a way to rewrite the audit log', () => {
  /**
   * Structural, not behavioural.
   *
   * `tests/auth-repository.test.ts` proves the runtime guards fire. This proves something
   * a runtime test cannot: that there is no function to call in the first place. A guard
   * can be bypassed by a caller who finds another door; a door that was never built cannot.
   */
  const auth = readFileSync(join(REPOSITORIES, 'auth.ts'), 'utf8');

  it('exports nothing that updates or deletes an audit entry', () => {
    const names = exportedFunctionsIn('auth.ts').map((entry) => entry.name);

    for (const forbidden of [
      'updateAuditLogEntry',
      'deleteAuditLogEntry',
      'removeAuditLogEntry',
      'pruneAuditLog',
      'clearAuditLog',
      'setAuditLogEntry',
    ]) {
      expect(names, `${forbidden} must not exist`).not.toContain(forbidden);
    }
  });

  it('never names the audit table in an update or a delete anywhere in the package', () => {
    // A textual check over the whole repositories directory, because the function could be
    // written in any file. `auditLogEntries` reaches `insertInto` and nothing else.
    for (const file of REPOSITORY_FILES) {
      const source = readFileSync(join(REPOSITORIES, file), 'utf8');
      for (const match of source.matchAll(/\.(updateIn|deleteFrom)\(\s*([A-Za-z0-9_]+)/g)) {
        expect(
          match[2],
          `${file} calls .${match[1] ?? ''}(${match[2] ?? ''}) — the audit log is append-only`,
        ).not.toBe('auditLogEntries');
      }
    }
  });

  it('reaches the audit table only through an insert', () => {
    const mentions = [...auth.matchAll(/auditLogEntries/g)];
    expect(mentions.length).toBeGreaterThan(0);

    // The only statement that writes it.
    expect(auth).toContain('.insertInto(auditLogEntries,');
    expect(auth).not.toMatch(/updateIn\(\s*auditLogEntries/);
    expect(auth).not.toMatch(/deleteFrom\(\s*auditLogEntries/);
  });
});
