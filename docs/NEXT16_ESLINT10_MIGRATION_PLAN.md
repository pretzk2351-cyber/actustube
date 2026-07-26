# Next.js 16 / ESLint 10 Migration Plan

## Status

Planning document. The project owner separately approved the time-limited exception recorded in [the formal GHSA-mh99-v99m-4gvg exception](./SECURITY_EXCEPTION_GHSA-MH99-V99M-4GVG.md) on 2026-07-26. This plan does not start a major-version upgrade or authorize a Production change.

## Purpose

Move the development lint chain off the vulnerable `brace-expansion` path by upgrading Next.js and ESLint in a dedicated, reviewable change. The migration must preserve ActusTube authentication, ownership checks, usage-limit behavior, database constraints, and rollback safety.

## Tracked advisory and current reachability

- Advisory: [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) / CVE-2026-14257.
- The affected package is currently reachable only through development lint dependencies.
- The current candidate's Production dependency query, server trace, client bundle, middleware/proxy search, API route search, and user-input taint search found no affected runtime path.
- `npm audit --omit=dev` currently reports zero vulnerabilities at every severity.
- These observations must be regenerated at least weekly, before each release decision, and whenever a withdrawal condition may have changed. The formal exception record, not this plan, is the approval evidence.

## Current formatter status

The repository has no formatter script, formatter configuration, formatter development dependency, lint-staged formatter, or formatter CI command. Formatter validation is therefore N/A for this work. Whitespace, syntax, type, lint, test, build, JSON, Markdown, and SQL checks remain mandatory substitutes; this plan does not introduce Prettier or another formatter.

## Temporary-exception boundary

The project owner approved a temporary exception only for GHSA-mh99-v99m-4gvg in the development lint dependency path. It expires at 2026-08-24 23:59 JST, with the first weekly recheck due by 2026-08-02. Recheck the advisory and every compatible backport at least weekly. The exception does not renew automatically; permanent remediation must complete before expiry, or the release decision must stop for a new risk assessment and explicit owner decision.

## Ownership and schedule

- Approval: project owner.
- Implementation: Codex Local.
- Audit: Work.
- Candidate branch: `chore/next16-eslint10-migration`.
- Investigation start deadline: 2026-08-02.
- Completion target: before 2026-08-24 23:59 JST.
- Review cadence: at least weekly until the advisory is removed or any exception expires.
- Weekly backport check: Codex Local records official compatible fixes and regenerated technical evidence; Work independently audits the result; the project owner retains approval accountability.

## Official migration baseline

- Follow the [Next.js 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16). In particular, review the Node.js and TypeScript minimums, Turbopack as the default bundler, fully asynchronous request APIs, the middleware-to-proxy rename, ESLint Flat Config, and removal of `next lint` and the `next.config` `eslint` option.
- Follow the [ESLint 10 migration guide](https://eslint.org/docs/latest/use/migrate-to-10.0.0). Confirm the Node.js requirement and all user-facing Flat Config changes before updating the dependency.
- Preserve React 19 behavior and verify relevant items in the [React 19 upgrade guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide). Do not perform an unrelated React major upgrade.
- Verify Auth.js against its [official Next.js example](https://authjs.dev/), including the `proxy` export pattern. Do not perform an unrelated `next-auth` major upgrade.

## Investigation and implementation sequence

1. Create the dedicated branch from the then-current approved base and record branch, HEAD, upstream, and a clean worktree.
2. Re-run full and Production-only audits and confirm whether a compatible backport already removes the advisory. Prefer a compatible backport over a major migration when it is officially available and passes all gates.
3. Inventory current Next.js, React, Auth.js, ESLint, TypeScript, Node.js, and npm compatibility. Keep Node.js on the approved 24.x line unless official constraints require a separately approved change.
4. Run the official Next.js codemod in dry-run or reviewable mode first. Do not accept unrelated dependency or source changes.
5. Remove the obsolete `eslint.ignoreDuringBuilds` setting from `next.config.ts` only after a separate ESLint CLI gate is proven for local and required build workflows.
6. Keep `npm run lint` as the explicit lint command. Confirm that no workflow still relies on the removed `next lint` command.
7. Convert `eslint.config.mjs` from `FlatCompat` to the native flat configuration exported by the matching Next.js 16 lint plugin. Upgrade to ESLint 10 only when the matching `eslint-config-next` version officially supports it.
8. Search for synchronous `cookies`, `headers`, `draftMode`, `params`, and `searchParams` usage and migrate only the calls required by Next.js 16.
9. Inventory `middleware.*` and `proxy.*`. If a middleware boundary is introduced or renamed, verify Node.js runtime behavior, matcher scope, authentication, redirects, and that no secret or user data crosses the wrong boundary.
10. Verify Auth.js handlers, `auth()` calls, JWT/session identity separation, OAuth refresh behavior, account linking, protected routes, and any `proxy` integration.
11. Verify every API route and server action, especially ownership checks, request-size limits, fail-closed usage reservations, release/finalize behavior, and sanitized unexpected errors.
12. Compare Turbopack and the current build output. Investigate changed route traces, server/client boundaries, dynamic imports, middleware/proxy bundles, and output-file traces.
13. Run unit, integration, authentication, usage-limit, owned-channel, weekly-cycle, and migration-harness tests. Do not reduce coverage or increase skips.
14. Recheck responsive behavior at 320px, 375px, 390px, 1024px, and 1440px, including overflow, loading, error, empty, authenticated, and owned-channel states.
15. Run TypeScript, ESLint, Production build, `npm audit`, `npm audit --omit=dev`, `drizzle-kit check`, schema-drift checks, `git diff --check`, secret scanning, and clean-install reproducibility twice.
16. Run the disposable loopback PostgreSQL migration harness for fresh migrations and the 0005-to-0006 upgrade. Do not change Migration 0000 through 0006 to accommodate the framework upgrade.
17. Generate and independently review Production dependency, server trace, client, middleware/proxy, API route, server action, dynamic import, child-process, and lifecycle reachability evidence.

## Production release and rollback plan

- Keep dependency/code deployment separate from any database operation. This migration is not expected to require a schema change.
- Do not modify Neon, Production DB, Vercel settings, or environment variables as part of local implementation.
- Before release, verify the exact Production source, approved Node/npm toolchain, build command, required checks, Preview separation, and rollback target without exposing identifiers or credentials.
- Release only after project-owner approval and an independent review with no P0, P1, P2, NOT VERIFIED, or evidence gap.
- Roll back by restoring the last independently verified application commit through the approved Production runbook. Do not roll back Migration 0000 through 0006 and do not use force-push.

## Completion conditions

- Next.js 16 and its matching lint configuration are installed without unrelated major upgrades.
- ESLint 10 is officially compatible with the selected Next.js lint packages.
- GHSA-mh99-v99m-4gvg no longer appears in the full audit.
- Runtime audit remains zero at every severity.
- Invalid and extraneous package counts are zero after two identical clean installs.
- All tests, TypeScript, ESLint, Production build, Drizzle, migration harness, responsive checks, trace checks, and secret checks pass.
- Production and user-input reachability remain absent.
- Independent review reports P0/P1/P2 = 0 and no NOT VERIFIED item.
- Project-owner approval, release notes, and a tested rollback target are recorded without infrastructure identifiers or credentials.

## Exception withdrawal conditions

Withdraw any temporary exception immediately when any of the following occurs:

- A compatible patched backport becomes available.
- The affected package enters a Production dependency, trace, or bundle.
- User-controlled input can reach `brace-expansion`, `minimatch`, glob expansion, or lint execution.
- A new High or Critical advisory appears.
- CI, Preview, Production build, toolchain, or secret-isolation conditions change.
- Any required regression, migration, reproducibility, or independent-review gate fails.
- The approved expiry date is reached.
