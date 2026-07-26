# ActusTube Temporary Security Exception: GHSA-mh99-v99m-4gvg

## Approval record

- Advisory: [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg)
- CVE: [CVE-2026-14257](https://nvd.nist.gov/vuln/detail/CVE-2026-14257)
- Severity: High（CVSS 7.5）
- Package: `brace-expansion`
- Scope: development-only lint dependency path
- Approval date: 2026-07-26
- Expiry: 2026-08-24 23:59 JST
- First weekly recheck deadline: 2026-08-02
- Approver: ActusTube project owner
- Approval status: explicitly approved

This exception applies only to GHSA-mh99-v99m-4gvg / CVE-2026-14257 in the development lint dependency path. It does not cover any other High or Critical advisory, Production runtime dependency, Production bundle or trace, API route, server action, authentication, OAuth, database, Migration, secret, user data, ownership, or usage-limit issue.

## Vulnerability summary

Affected `brace-expansion` versions can build expansion results whose total length is not adequately bounded. Attacker-influenced brace patterns can therefore exhaust process memory and cause an uncatchable Node.js out-of-memory crash, resulting in denial of service. The upstream remediation is a patched release that bounds accumulated expansion length.

## Recorded reachability evidence

The following evidence was regenerated for the candidate before owner approval:

- `npm audit --omit=dev` reported zero vulnerabilities at every severity.
- The full `npm audit` reported nine High findings, all attributable to this single advisory. Findings attributable to any other advisory were zero.
- The affected package was present only through development lint dependencies; the Production dependency tree did not contain it.
- Production server traces, client bundles, middleware or proxy boundaries, API routes, server actions, dynamic imports, child-process calls, lifecycle scripts, and Production start paths did not contain or invoke the affected package.
- Searches from user-controlled input to `brace-expansion`, `minimatch`, glob expansion, or lint execution found no reachable path.
- Production startup uses the built Next.js application and does not execute ESLint.
- Git Fork Protection is enabled.
- Preview does not receive the Production-only `DATABASE_URL`; Preview and Production database configuration are separated.
- The candidate's automatic Preview build demonstrated Node.js 24.x, Corepack, and npm 11.18.0 with the repository's default install and `npm run build` commands.
- The pre-approval independent review reported P0, P1, P2, P3, and NOT VERIFIED counts of zero.

These facts do not mean that the full dependency audit has zero vulnerabilities. The exact accepted state is:

- Runtime audit: zero at every severity.
- Full audit: nine High findings caused only by GHSA-mh99-v99m-4gvg.
- Findings from advisories other than GHSA-mh99-v99m-4gvg: zero.

## Conditions of validity

This exception remains valid only while every condition below is true:

1. The current date and time are no later than 2026-08-24 23:59 JST.
2. The latest required weekly recheck is complete and not overdue; the first recheck is due by 2026-08-02.
3. `npm audit --omit=dev` remains zero at every severity.
4. The full audit contains no High or Critical advisory other than GHSA-mh99-v99m-4gvg.
5. The affected package remains absent from every Production dependency, trace, bundle, route, action, process, and lifecycle path.
6. User-controlled input cannot reach the affected expansion behavior or any lint or glob execution path that invokes it.
7. The verified Node.js 24.x, Corepack, npm 11.18.0, default install, and build configuration remain in effect for the candidate Preview.
8. Git Fork Protection and Preview/Production secret isolation remain effective.
9. Required regression, reproducibility, Migration harness, secret, and independent-review gates remain successful.
10. None of the immediate withdrawal conditions has occurred.

The normal release rule remains zero unexcepted High or Critical findings. This record is not a general allowance for development-dependency vulnerabilities and must not be reused for another advisory.

## Weekly recheck

The project owner is accountable for keeping the exception within its approved boundary. Codex Local performs the technical recheck, and Work performs or coordinates the independent audit. At least once every seven days, and additionally before any release decision, record the following without storing credentials or infrastructure identifiers:

- advisory status, affected and patched versions, and availability of a compatible backport;
- Production-only and full audit counts grouped by advisory;
- Production dependency, trace, bundle, middleware/proxy, API route, server action, lifecycle, and user-input reachability;
- Node.js, Corepack, npm, clean-install, build, regression, Drizzle, Migration harness, and secret-isolation results;
- independent-review severities and any NOT VERIFIED item;
- recheck date, reviewer roles, conclusion, and next deadline.

A compatible patched backport is preferred over the Next.js 16 / ESLint 10 major migration when it removes the advisory and passes all gates. The first weekly backport and reachability recheck must finish by 2026-08-02.

## Immediate withdrawal conditions

Withdraw this exception immediately and stop the release decision if any of the following occurs:

- a compatible patched backport becomes available and can pass the required gates;
- the affected package enters a Production dependency, server or client trace, bundle, middleware/proxy path, API route, server action, dynamic import, child process, lifecycle script, or startup path;
- user-controlled input can reach `brace-expansion`, `minimatch`, glob expansion, or lint execution;
- the Runtime audit reports any vulnerability;
- any High or Critical advisory other than GHSA-mh99-v99m-4gvg appears;
- Git Fork Protection, Preview/Production database separation, secret isolation, or the verified Preview toolchain changes or cannot be proven;
- a required clean install, package-tree, type, lint, test, build, Drizzle, Migration harness, secret, reproducibility, or independent-review gate fails or becomes NOT VERIFIED;
- a weekly recheck becomes overdue;
- the project owner withdraws approval; or
- 2026-08-24 23:59 JST is reached.

Withdrawal is fail-closed. It does not authorize an automatic dependency upgrade, main integration, deployment, rollback, environment change, database connection, or Migration.

## Permanent remediation

The permanent target is removal of GHSA-mh99-v99m-4gvg from the full dependency audit. Each weekly review must first assess an officially compatible patched backport. If no safe backport is available, follow [the dedicated Next.js 16 / ESLint 10 migration plan](./NEXT16_ESLINT10_MIGRATION_PLAN.md) in a separate branch and approval process. Complete permanent remediation and all regression gates before expiry; if that is not possible, stop the release decision and require a new risk assessment and explicit owner decision. This exception does not renew or extend automatically.

## Separation from Production authorization

The project owner explicitly approved this time-limited security exception on 2026-07-26. That approval does not authorize main integration, Production deployment, Production or Preview environment changes, Production database access, Migration 0006 application, Neon operations, Google Cloud or OAuth changes, Production smoke tests, promotion, rollback, or alias changes. Every Production release step remains subject to a separate plan, independent audit, current-state verification, and explicit authorization.
