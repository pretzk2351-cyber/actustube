/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS,
  PREFLIGHT_SQL_FOR_TESTS,
  STAGING_EXTENSION_INVENTORY_LIMITS,
  createPreflightBaseReport,
  parseExpectedStagingExtensions,
  verifyStagingDatabasePreflight,
} from "../scripts/staging-database-preflight/core.mjs";
import {
  POSTFLIGHT_SQL_FOR_TESTS,
  loadRepositorySpecification,
} from "../scripts/staging-database-postflight/core.mjs";
import { assertReadOnlySql } from "../scripts/staging-database-postflight/safety.mjs";
import {
  EXTERNAL_FIXTURE_EXTENSION_CONTRACT_FOR_TESTS,
  HARNESS_DEADLINE_LIMITS_FOR_TESTS,
  INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS,
  TEMPORARY_AUTHORITY_INVENTORY_SQL_FOR_TESTS,
  createIndependentDeadlineContextsForTests,
  externalFixtureSuccessResultForTests,
  harnessAuthorityBoundaryForTests,
  runConnectionOnlyHarness,
  runExternalFixturePhaseProbeForTests,
  runGrantInventoryDiagnosticOutputProbeForTests,
  runHarnessDeadlineProbeForTests,
  runHarnessTransactionBoundaryProbeForTests,
  runMigrationOwnerBoundaryProbeForTests,
  runOwnershipCanonicalizationProbeForTests,
  runUsageBodyAclBoundaryProbeForTests,
  validateExternalFixtureConfigurationForTests,
  validateIndependentExtensionInventoryForTests,
} from "../scripts/test-staging-database-preflight-postgres.mjs";
import {
  benignChildLifecycleCountersForTests,
  runBenignChildLifecycleProbeForTests,
} from "../scripts/test-staging-database-fault-lifecycle.mjs";
import {
  PARENT_ENVIRONMENT_NOTICE,
  createFatalExitLatch,
  executeStagingDatabasePreflight,
  formatHumanSummary,
  runPreflightCli,
} from "../scripts/verify-staging-database-preflight.mjs";

const repositoryRoot = process.cwd();
const fakeSecret = "preflight-fixture-secret-never-print";
const directUrl =
  `postgresql://staging_direct:${fakeSecret}@ep-actustube-safe.example.test/staging_database?sslmode=require`;
const pooledUrl =
  `postgresql://staging_runtime:${fakeSecret}@ep-actustube-safe-pooler.example.test/staging_database?sslmode=require`;

const externalFixturePhaseMarkerOracle = Object.freeze([
  Object.freeze({
    scenario: "fixture-client-connect-rejects",
    phase: "FIXTURE_CLIENT_CONNECT",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_CLIENT_CONNECT",
  }),
  Object.freeze({
    scenario: "fixture-identity-rejects",
    phase: "FIXTURE_IDENTITY",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_IDENTITY",
  }),
  Object.freeze({
    scenario: "fixture-ledger-setup-rejects",
    phase: "FIXTURE_LEDGER_SETUP",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_LEDGER_SETUP",
  }),
  Object.freeze({
    scenario: "extension-inventory-rejects",
    phase: "EXTENSION_INVENTORY",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_EXTENSION_INVENTORY",
  }),
  Object.freeze({
    scenario: "fixture-client-close-rejects",
    phase: "FIXTURE_CLIENT_CLOSE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_CLIENT_CLOSE",
  }),
  Object.freeze({
    scenario: "preflight-stability-rejects",
    phase: "PREFLIGHT_STABILITY",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_PREFLIGHT_STABILITY",
  }),
  Object.freeze({
    scenario: "snapshot-drift-control-rejects",
    phase: "SNAPSHOT_DRIFT_CONTROL",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_SNAPSHOT_DRIFT_CONTROL",
  }),
  Object.freeze({
    scenario: "extension-classification-rejects",
    phase: "EXTENSION_CLASSIFICATION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_EXTENSION_CLASSIFICATION",
  }),
  Object.freeze({
    scenario: "pre-mutation-client-connect-rejects",
    phase: "PRE_MUTATION_CLIENT_CONNECT",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_PRE_MUTATION_CLIENT_CONNECT",
  }),
  Object.freeze({
    scenario: "pre-mutation-identity-rejects",
    phase: "PRE_MUTATION_IDENTITY",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_PRE_MUTATION_IDENTITY",
  }),
  Object.freeze({
    scenario: "default-privilege-revoke-rejects",
    phase: "DEFAULT_PRIVILEGE_REVOKE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_DEFAULT_PRIVILEGE_REVOKE",
  }),
  Object.freeze({
    scenario: "fixture-role-setup-rejects",
    phase: "FIXTURE_ROLE_SETUP",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_ROLE_SETUP",
  }),
  Object.freeze({
    scenario: "migration-boundary-identity-rejects",
    phase: "MIGRATION_BOUNDARY_IDENTITY",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_BOUNDARY_IDENTITY",
  }),
  Object.freeze({
    scenario: "migration-baseline-rejects",
    phase: "MIGRATION_BASELINE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_BASELINE",
  }),
  Object.freeze({
    scenario: "migration-public-acl-negative-control-unexpected-rejects",
    phase: "MIGRATION_PUBLIC_ACL_NEGATIVE_CONTROL",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PUBLIC_ACL_NEGATIVE_CONTROL",
  }),
  Object.freeze({
    scenario: "migration-final-rejects",
    phase: "MIGRATION_FINAL",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL",
  }),
  Object.freeze({
    scenario: "migration-replay-rejects",
    phase: "MIGRATION_REPLAY",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_REPLAY",
  }),
  Object.freeze({
    scenario: "migration-final-owner-postcondition-failure",
    phase: "MIGRATION_FINAL_OWNER_POSTCONDITION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL_OWNER_POSTCONDITION",
  }),
  Object.freeze({
    scenario: "migration-replay-owner-postcondition-failure",
    phase: "MIGRATION_REPLAY_OWNER_POSTCONDITION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_REPLAY_OWNER_POSTCONDITION",
  }),
  Object.freeze({
    scenario: "migration-usage-body-acl-grant-failure",
    phase: "MIGRATION_USAGE_BODY_ACL_GRANT",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT",
  }),
  Object.freeze({
    scenario: "migration-usage-body-acl-grant-inventory-failure",
    phase: "MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY",
  }),
  Object.freeze({
    scenario: "migration-usage-acl-inheritance-failure",
    phase: "MIGRATION_USAGE_ACL_INHERITANCE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_ACL_INHERITANCE",
  }),
  Object.freeze({
    scenario: "migration-usage-owner-postcondition-failure",
    phase: "MIGRATION_USAGE_OWNER_POSTCONDITION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_OWNER_POSTCONDITION",
  }),
  Object.freeze({
    scenario: "migration-usage-owner-inheritance-failure",
    phase: "MIGRATION_USAGE_OWNER_INHERITANCE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_OWNER_INHERITANCE",
  }),
  Object.freeze({
    scenario: "migration-usage-legacy-acl-preservation-failure",
    phase: "MIGRATION_USAGE_LEGACY_ACL_PRESERVATION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_LEGACY_ACL_PRESERVATION",
  }),
  Object.freeze({
    scenario: "migration-usage-acl-comparison-failure",
    phase: "MIGRATION_USAGE_ACL_COMPARISON",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_ACL_COMPARISON",
  }),
  Object.freeze({
    scenario: "migration-usage-explicit-runtime-privilege-failure",
    phase: "MIGRATION_USAGE_EXPLICIT_RUNTIME_PRIVILEGE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_EXPLICIT_RUNTIME_PRIVILEGE",
  }),
  Object.freeze({
    scenario: "migration-usage-membership-runtime-privilege-failure",
    phase: "MIGRATION_USAGE_MEMBERSHIP_RUNTIME_PRIVILEGE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_MEMBERSHIP_RUNTIME_PRIVILEGE",
  }),
  Object.freeze({
    scenario: "migration-usage-denied-runtime-privilege-failure",
    phase: "MIGRATION_USAGE_DENIED_RUNTIME_PRIVILEGE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_DENIED_RUNTIME_PRIVILEGE",
  }),
  Object.freeze({
    scenario: "migration-usage-public-runtime-privilege-failure",
    phase: "MIGRATION_USAGE_PUBLIC_RUNTIME_PRIVILEGE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_PUBLIC_RUNTIME_PRIVILEGE",
  }),
  Object.freeze({
    scenario: "migration-usage-security-mode-failure",
    phase: "MIGRATION_USAGE_SECURITY_MODE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_SECURITY_MODE",
  }),
  Object.freeze({
    scenario: "migration-usage-search-path-failure",
    phase: "MIGRATION_USAGE_SEARCH_PATH",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_SEARCH_PATH",
  }),
  Object.freeze({
    scenario: "migration-usage-explicit-runtime-execution-failure",
    phase: "MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION",
  }),
  Object.freeze({
    scenario: "migration-usage-membership-runtime-execution-failure",
    phase: "MIGRATION_USAGE_MEMBERSHIP_RUNTIME_EXECUTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_MEMBERSHIP_RUNTIME_EXECUTION",
  }),
  Object.freeze({
    scenario: "migration-usage-denied-runtime-execution-failure",
    phase: "MIGRATION_USAGE_DENIED_RUNTIME_EXECUTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_DENIED_RUNTIME_EXECUTION",
  }),
  Object.freeze({
    scenario: "migration-usage-public-runtime-execution-failure",
    phase: "MIGRATION_USAGE_PUBLIC_RUNTIME_EXECUTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_PUBLIC_RUNTIME_EXECUTION",
  }),
  Object.freeze({
    scenario: "migration-plan-resolution-failure",
    phase: "MIGRATION_PLAN_RESOLUTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_RESOLUTION",
  }),
  Object.freeze({
    scenario: "migration-plan-free-fallback-failure",
    phase: "MIGRATION_PLAN_FREE_FALLBACK",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_FREE_FALLBACK",
  }),
  Object.freeze({
    scenario: "migration-plan-inactive-fallback-failure",
    phase: "MIGRATION_PLAN_INACTIVE_FALLBACK",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_INACTIVE_FALLBACK",
  }),
  Object.freeze({
    scenario: "migration-plan-future-assignment-rejection",
    phase: "MIGRATION_PLAN_FUTURE_ASSIGNMENT_REJECTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_FUTURE_ASSIGNMENT_REJECTION",
  }),
  Object.freeze({
    scenario: "migration-plan-expired-assignment-rejection",
    phase: "MIGRATION_PLAN_EXPIRED_ASSIGNMENT_REJECTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_EXPIRED_ASSIGNMENT_REJECTION",
  }),
  Object.freeze({
    scenario: "migration-plan-unknown-reference-rejection",
    phase: "MIGRATION_PLAN_UNKNOWN_REFERENCE_REJECTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_UNKNOWN_REFERENCE_REJECTION",
  }),
  Object.freeze({
    scenario: "migration-plan-duplicate-assignment-rejection",
    phase: "MIGRATION_PLAN_DUPLICATE_ASSIGNMENT_REJECTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_DUPLICATE_ASSIGNMENT_REJECTION",
  }),
  Object.freeze({
    scenario: "migration-plan-missing-baseline-rejection",
    phase: "MIGRATION_PLAN_MISSING_BASELINE_REJECTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_MISSING_BASELINE_REJECTION",
  }),
  Object.freeze({
    scenario: "migration-plan-duplicate-baseline-rejection",
    phase: "MIGRATION_PLAN_DUPLICATE_BASELINE_REJECTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_DUPLICATE_BASELINE_REJECTION",
  }),
  Object.freeze({
    scenario: "migration-plan-inactive-baseline-rejection",
    phase: "MIGRATION_PLAN_INACTIVE_BASELINE_REJECTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_INACTIVE_BASELINE_REJECTION",
  }),
  Object.freeze({
    scenario: "migration-plan-limit-mismatch-rejection",
    phase: "MIGRATION_PLAN_LIMIT_MISMATCH_REJECTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_LIMIT_MISMATCH_REJECTION",
  }),
  Object.freeze({
    scenario: "migration-plan-invalid-limit-rejection",
    phase: "MIGRATION_PLAN_INVALID_LIMIT_REJECTION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_INVALID_LIMIT_REJECTION",
  }),
  Object.freeze({
    scenario: "migration-reservation-lifecycle-failure",
    phase: "MIGRATION_RESERVATION_LIFECYCLE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_LIFECYCLE",
  }),
  Object.freeze({
    scenario: "migration-reservation-concurrency-setup-failure",
    phase: "MIGRATION_RESERVATION_CONCURRENCY_SETUP",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_CONCURRENCY_SETUP",
  }),
  Object.freeze({
    scenario: "migration-reservation-concurrent-limit-failure",
    phase: "MIGRATION_RESERVATION_CONCURRENT_LIMIT",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_CONCURRENT_LIMIT",
  }),
  Object.freeze({
    scenario: "migration-reservation-bucket-postcondition-failure",
    phase: "MIGRATION_RESERVATION_BUCKET_POSTCONDITION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_BUCKET_POSTCONDITION",
  }),
  Object.freeze({
    scenario: "migration-reservation-concurrency-cleanup-failure",
    phase: "MIGRATION_RESERVATION_CONCURRENCY_CLEANUP",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_CONCURRENCY_CLEANUP",
  }),
  Object.freeze({
    scenario: "migration-reservation-release-setup-failure",
    phase: "MIGRATION_RESERVATION_RELEASE_SETUP",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_RELEASE_SETUP",
  }),
  Object.freeze({
    scenario: "migration-reservation-release-create-failure",
    phase: "MIGRATION_RESERVATION_RELEASE_CREATE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_RELEASE_CREATE",
  }),
  Object.freeze({
    scenario: "migration-reservation-release-idempotency-failure",
    phase: "MIGRATION_RESERVATION_RELEASE_IDEMPOTENCY",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_RELEASE_IDEMPOTENCY",
  }),
  Object.freeze({
    scenario: "migration-reservation-finalization-create-failure",
    phase: "MIGRATION_RESERVATION_FINALIZATION_CREATE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_FINALIZATION_CREATE",
  }),
  Object.freeze({
    scenario: "migration-reservation-finalization-failure",
    phase: "MIGRATION_RESERVATION_FINALIZATION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_FINALIZATION",
  }),
  Object.freeze({
    scenario: "migration-reservation-stale-setup-failure",
    phase: "MIGRATION_RESERVATION_STALE_SETUP",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_STALE_SETUP",
  }),
  Object.freeze({
    scenario: "migration-reservation-stale-recovery-failure",
    phase: "MIGRATION_RESERVATION_STALE_RECOVERY",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_STALE_RECOVERY",
  }),
  Object.freeze({
    scenario: "migration-reservation-lifecycle-cleanup-failure",
    phase: "MIGRATION_RESERVATION_LIFECYCLE_CLEANUP",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_LIFECYCLE_CLEANUP",
  }),
  Object.freeze({
    scenario: "migration-usage-body-acl-revoke-failure",
    phase: "MIGRATION_USAGE_BODY_ACL_REVOKE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_REVOKE",
  }),
  Object.freeze({
    scenario: "migration-usage-body-acl-zero-residue-failure",
    phase: "MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE",
  }),
  Object.freeze({
    scenario: "migration-runtime-acl-configuration-failure",
    phase: "MIGRATION_RUNTIME_ACL_CONFIGURATION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RUNTIME_ACL_CONFIGURATION",
  }),
  Object.freeze({
    scenario: "migration-client-close-rejects",
    phase: "MIGRATION_CLIENT_CLOSE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_CLIENT_CLOSE",
  }),
  Object.freeze({
    scenario: "transaction-rollback-control-rejects",
    phase: "TRANSACTION_ROLLBACK_CONTROL",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_TRANSACTION_ROLLBACK_CONTROL",
  }),
  Object.freeze({
    scenario: "cleanup-client-connect-rejects",
    phase: "CLEANUP_CLIENT_CONNECT",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_CLEANUP_CLIENT_CONNECT",
  }),
  Object.freeze({
    scenario: "cleanup-identity-rejects",
    phase: "CLEANUP_IDENTITY",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_CLEANUP_IDENTITY",
  }),
  Object.freeze({
    scenario: "ownership-pre-inventory-rejects",
    phase: "OWNERSHIP_PRE_INVENTORY",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_OWNERSHIP_PRE_INVENTORY",
  }),
  Object.freeze({
    scenario: "ownership-canonicalization-rejects",
    phase: "OWNERSHIP_CANONICALIZATION",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_OWNERSHIP_CANONICALIZATION",
  }),
  Object.freeze({
    scenario: "ownership-post-snapshot-rejects",
    phase: "OWNERSHIP_POST_SNAPSHOT",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_OWNERSHIP_POST_SNAPSHOT",
  }),
  Object.freeze({
    scenario: "authority-pre-inventory-rejects",
    phase: "AUTHORITY_PRE_INVENTORY",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_AUTHORITY_PRE_INVENTORY",
  }),
  Object.freeze({
    scenario: "bounded-revoke-rejects",
    phase: "BOUNDED_REVOKE",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_BOUNDED_REVOKE",
  }),
  Object.freeze({
    scenario: "authority-zero-residue-rejects",
    phase: "AUTHORITY_ZERO_RESIDUE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_AUTHORITY_ZERO_RESIDUE",
  }),
  Object.freeze({
    scenario: "maintenance-owner-snapshot-rejects",
    phase: "MAINTENANCE_OWNER_SNAPSHOT",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MAINTENANCE_OWNER_SNAPSHOT",
  }),
  Object.freeze({
    scenario: "canonical-client-close-rejects",
    phase: "CANONICAL_CLIENT_CLOSE",
    marker:
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_CANONICAL_CLIENT_CLOSE",
  }),
  Object.freeze({
    scenario: "postflight-rejects",
    phase: "POSTFLIGHT",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_POSTFLIGHT",
  }),
  Object.freeze({
    scenario: "postflight-drift-rejects",
    phase: "POSTFLIGHT_DRIFT",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_POSTFLIGHT_DRIFT",
  }),
] as const);

const externalFixtureProductionPhaseOrder = Object.freeze([
  "FIXTURE_CLIENT_CONNECT",
  "FIXTURE_IDENTITY",
  "FIXTURE_LEDGER_SETUP",
  "EXTENSION_INVENTORY",
  "FIXTURE_CLIENT_CLOSE",
  "PREFLIGHT_STABILITY",
  "SNAPSHOT_DRIFT_CONTROL",
  "EXTENSION_CLASSIFICATION",
  "PRE_MUTATION_CLIENT_CONNECT",
  "PRE_MUTATION_IDENTITY",
  "DEFAULT_PRIVILEGE_REVOKE",
  "FIXTURE_ROLE_SETUP",
  "MIGRATION_BOUNDARY_IDENTITY",
  "FIXTURE_ROLE_SETUP",
  "MIGRATION_BASELINE",
  "MIGRATION_PUBLIC_ACL_NEGATIVE_CONTROL",
  "MIGRATION_FINAL",
  "MIGRATION_FINAL_OWNER_POSTCONDITION",
  "MIGRATION_REPLAY",
  "MIGRATION_REPLAY_OWNER_POSTCONDITION",
  "MIGRATION_CLIENT_CLOSE",
  "MIGRATION_USAGE_BODY_ACL_GRANT",
  "MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY",
  "MIGRATION_USAGE_ACL_INHERITANCE",
  "MIGRATION_USAGE_OWNER_POSTCONDITION",
  "MIGRATION_USAGE_OWNER_INHERITANCE",
  "MIGRATION_USAGE_LEGACY_ACL_PRESERVATION",
  "MIGRATION_USAGE_ACL_COMPARISON",
  "MIGRATION_USAGE_EXPLICIT_RUNTIME_PRIVILEGE",
  "MIGRATION_USAGE_MEMBERSHIP_RUNTIME_PRIVILEGE",
  "MIGRATION_USAGE_DENIED_RUNTIME_PRIVILEGE",
  "MIGRATION_USAGE_PUBLIC_RUNTIME_PRIVILEGE",
  "MIGRATION_USAGE_SECURITY_MODE",
  "MIGRATION_USAGE_SEARCH_PATH",
  "MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION",
  "MIGRATION_USAGE_MEMBERSHIP_RUNTIME_EXECUTION",
  "MIGRATION_USAGE_DENIED_RUNTIME_EXECUTION",
  "MIGRATION_USAGE_PUBLIC_RUNTIME_EXECUTION",
  "MIGRATION_PLAN_RESOLUTION",
  "MIGRATION_PLAN_FREE_FALLBACK",
  "MIGRATION_PLAN_INACTIVE_FALLBACK",
  "MIGRATION_PLAN_FUTURE_ASSIGNMENT_REJECTION",
  "MIGRATION_PLAN_EXPIRED_ASSIGNMENT_REJECTION",
  "MIGRATION_PLAN_UNKNOWN_REFERENCE_REJECTION",
  "MIGRATION_PLAN_DUPLICATE_ASSIGNMENT_REJECTION",
  "MIGRATION_PLAN_MISSING_BASELINE_REJECTION",
  "MIGRATION_PLAN_DUPLICATE_BASELINE_REJECTION",
  "MIGRATION_PLAN_INACTIVE_BASELINE_REJECTION",
  "MIGRATION_PLAN_LIMIT_MISMATCH_REJECTION",
  "MIGRATION_PLAN_INVALID_LIMIT_REJECTION",
  "MIGRATION_RESERVATION_LIFECYCLE",
  "MIGRATION_RESERVATION_CONCURRENCY_SETUP",
  "MIGRATION_RESERVATION_CONCURRENT_LIMIT",
  "MIGRATION_RESERVATION_BUCKET_POSTCONDITION",
  "MIGRATION_RESERVATION_CONCURRENCY_CLEANUP",
  "MIGRATION_RESERVATION_RELEASE_SETUP",
  "MIGRATION_RESERVATION_RELEASE_CREATE",
  "MIGRATION_RESERVATION_RELEASE_IDEMPOTENCY",
  "MIGRATION_RESERVATION_FINALIZATION_CREATE",
  "MIGRATION_RESERVATION_FINALIZATION",
  "MIGRATION_RESERVATION_STALE_SETUP",
  "MIGRATION_RESERVATION_STALE_RECOVERY",
  "MIGRATION_RESERVATION_LIFECYCLE_CLEANUP",
  "MIGRATION_USAGE_BODY_ACL_REVOKE",
  "MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE",
  "MIGRATION_RUNTIME_ACL_CONFIGURATION",
  "TRANSACTION_ROLLBACK_CONTROL",
  "CLEANUP_CLIENT_CONNECT",
  "CLEANUP_IDENTITY",
  "OWNERSHIP_PRE_INVENTORY",
  "OWNERSHIP_CANONICALIZATION",
  "OWNERSHIP_POST_SNAPSHOT",
  "AUTHORITY_PRE_INVENTORY",
  "BOUNDED_REVOKE",
  "AUTHORITY_ZERO_RESIDUE",
  "MAINTENANCE_OWNER_SNAPSHOT",
  "CANONICAL_CLIENT_CLOSE",
  "POSTFLIGHT",
  "POSTFLIGHT_DRIFT",
] as const);

const externalFixturePublicSuccessOracle = Object.freeze({
  success: true,
  fixtureConfigured: true,
  lifecycleOwner: "github_actions_service_container",
  postgresqlMajor: 18,
  migrationCount: 7,
  stablePreflight: true,
  snapshotDriftRejected: true,
  extensionClassification: true,
  independentExtensionInventory: true,
  migrationOrderAndReplay: true,
  usageMigrationSemantics: true,
  temporaryAuthorityCleanup: true,
  deadlineBounded: true,
  transactionRollback: true,
  postflight: true,
  postflightDriftRejected: true,
  verifierQueriesReadOnly: true,
  outputRedaction: true,
});

const externalFixtureUnknownMarkerOracle = Object.freeze([
  Object.freeze({
    scenario: "unbranded-unknown",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN",
  }),
  Object.freeze({
    scenario: "forged-known-marker-message",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN",
  }),
  Object.freeze({
    scenario: "old-broad-marker-message",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN",
  }),
  Object.freeze({
    scenario: "forged-known-marker-object",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN",
  }),
  Object.freeze({
    scenario: "redaction-shaped-unknown",
    marker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN",
  }),
] as const);

function validEnvironment(): any {
  return {
    ACTUSTUBE_DB_ENV: "staging",
    ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT: "1",
    DIRECT_DATABASE_URL: directUrl,
    DATABASE_URL: pooledUrl,
    ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "ep-actustube-safe",
    ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
      schemaVersion: 1,
      extensions: [],
    }),
  };
}

function baseState(): any {
  return {
    serverVersion: {
      server_version_num: "180004",
    },
    identity: {
      database_oid: "100",
      system_identifier: "200",
    },
    roleIdentity: { role_name: "staging_direct" },
    extensionInventory: [],
    migrationCatalog: {
      schema_exists: false,
      table_exists: false,
      objects: [],
    },
    migrationColumns: [],
    migrationColumnExact: [],
    migrationPrimaryKey: [],
    migrationHistory: [],
    migrationExact: null,
    userDefinedObjects: {
      total_count: 0,
      schema_count: 0,
      relation_count: 0,
      routine_count: 0,
      type_count: 0,
      trigger_count: 0,
      rule_count: 0,
      policy_count: 0,
      constraint_count: 0,
      other_count: 0,
      estimated_data_rows: "0",
      object_signature: [],
      extension_classification_evidence: [],
      extension_unclassified_count: 0,
      extension_ambiguous_count: 0,
      extension_candidate_signature: [],
      extension_managed_signature: [],
      extension_residual_signature: [],
    },
  };
}

const exactMigrationState = {
  table_relkind: "r",
  table_persistence: "p",
  table_is_shared: false,
  table_rewrite_is_zero: true,
  table_row_type_is_canonical: true,
  table_is_partition: false,
  table_row_security: false,
  table_force_row_security: false,
  table_replica_identity: "d",
  table_check_count: 0,
  table_has_rules: false,
  table_has_triggers: false,
  table_attribute_count: 3,
  table_has_index: true,
  table_has_subclass: false,
  table_is_populated: true,
  table_not_typed: true,
  table_no_partition_bound: true,
  table_has_toast: true,
  table_toast_mapping_is_canonical: true,
  table_tablespace_is_default: true,
  table_acl_is_default: true,
  object_namespaces_are_canonical: true,
  object_owner_is_consistent: true,
  table_option_count: 0,
  table_access_method: "heap",
  sequence_relkind: "S",
  sequence_persistence: "p",
  sequence_access_method_is_zero: true,
  sequence_is_shared: false,
  sequence_rewrite_is_zero: true,
  sequence_row_type_is_zero: true,
  sequence_is_partition: false,
  sequence_row_security: false,
  sequence_force_row_security: false,
  sequence_replica_identity: "n",
  sequence_check_count: 0,
  sequence_has_rules: false,
  sequence_has_triggers: false,
  sequence_attribute_count: 3,
  sequence_has_index: false,
  sequence_has_subclass: false,
  sequence_is_populated: true,
  sequence_not_typed: true,
  sequence_no_partition_bound: true,
  sequence_has_no_toast: true,
  sequence_tablespace_is_default: true,
  sequence_acl_is_default: true,
  sequence_option_count: 0,
  sequence_data_type: "integer",
  sequence_start: "1",
  sequence_increment: "1",
  sequence_minimum: "1",
  sequence_maximum: "2147483647",
  sequence_cache: "1",
  sequence_cycle: false,
  sequence_last_value: "1",
  sequence_is_called: false,
  index_relkind: "i",
  index_persistence: "p",
  index_is_shared: false,
  index_rewrite_is_zero: true,
  index_row_type_is_zero: true,
  index_relation_attribute_count: 1,
  index_is_partition: false,
  index_row_security: false,
  index_force_row_security: false,
  index_replica_identity: "n",
  index_check_count: 0,
  index_has_rules: false,
  index_has_triggers: false,
  index_has_index: false,
  index_has_subclass: false,
  index_is_populated: true,
  index_not_typed: true,
  index_no_partition_bound: true,
  index_has_no_toast: true,
  index_tablespace_is_default: true,
  index_acl_is_default: true,
  index_option_count: 0,
  index_access_method: "btree",
  index_is_unique: true,
  index_is_primary: true,
  index_is_exclusion: false,
  index_is_valid: true,
  index_is_ready: true,
  index_is_live: true,
  index_is_clustered: false,
  index_is_replica_identity: false,
  index_is_immediate: true,
  index_check_xmin: false,
  index_nulls_not_distinct: false,
  index_has_no_predicate: true,
  index_has_no_expressions: true,
  index_collation_is_canonical: true,
  index_option_is_canonical: true,
  index_operator_class_is_canonical: true,
  index_key_count: 1,
  index_attribute_count: 1,
  index_column_exact: true,
  index_vector_lengths_are_canonical: true,
  index_relation_mapping_is_canonical: true,
  constraint_count: 3,
  primary_constraint_count: 1,
  not_null_constraint_count: 2,
  unexpected_constraint_count: 0,
  primary_key_exact: true,
  constraint_enforcement_is_canonical: true,
  constraint_period_is_canonical: true,
  constraint_mapping_is_canonical: true,
  constraint_action_fields_are_canonical: true,
  constraint_foreign_key_fields_are_canonical: true,
  constraint_exclusion_fields_are_canonical: true,
  constraint_expression_fields_are_canonical: true,
  not_null_constraint_keys_exact: true,
  not_null_constraint_names_exact: true,
  not_null_constraints_exact: true,
  trigger_count: 0,
  rule_count: 0,
  policy_count: 0,
  sequence_owned_by_count: 1,
  default_sequence_dependency_count: 1,
};

const migrationColumns = [
  {
    column_name: "id",
    data_type: "integer",
    is_nullable: "NO",
    column_default:
      "nextval('drizzle.__drizzle_migrations_id_seq'::regclass)",
  },
  {
    column_name: "hash",
    data_type: "text",
    is_nullable: "NO",
    column_default: null,
  },
  {
    column_name: "created_at",
    data_type: "bigint",
    is_nullable: "YES",
    column_default: null,
  },
];

const migrationColumnExact = [
  {
    relation_is_canonical: true,
    position: 1,
    column_name: "id",
    is_dropped: false,
    inherited_count: 0,
    is_local: true,
    type_key: "integer",
    typmod: -1,
    type_length: 4,
    dimensions: 0,
    passed_by_value: true,
    alignment: "i",
    type_kind: "b",
    domain_base_is_none: true,
    identity_kind: "",
    generated_kind: "",
    collation_is_canonical: true,
    is_not_null: true,
    has_default: true,
    default_kind: "serial_sequence",
    acl_is_default: true,
    options_are_default: true,
    fdw_options_are_default: true,
    storage_kind: "p",
    compression_kind: "",
    statistics_are_default: true,
    has_no_missing_value: true,
    missing_value_is_null: true,
  },
  {
    relation_is_canonical: true,
    position: 2,
    column_name: "hash",
    is_dropped: false,
    inherited_count: 0,
    is_local: true,
    type_key: "text",
    typmod: -1,
    type_length: -1,
    dimensions: 0,
    passed_by_value: false,
    alignment: "i",
    type_kind: "b",
    domain_base_is_none: true,
    identity_kind: "",
    generated_kind: "",
    collation_is_canonical: true,
    is_not_null: true,
    has_default: false,
    default_kind: "none",
    acl_is_default: true,
    options_are_default: true,
    fdw_options_are_default: true,
    storage_kind: "x",
    compression_kind: "",
    statistics_are_default: true,
    has_no_missing_value: true,
    missing_value_is_null: true,
  },
  {
    relation_is_canonical: true,
    position: 3,
    column_name: "created_at",
    is_dropped: false,
    inherited_count: 0,
    is_local: true,
    type_key: "bigint",
    typmod: -1,
    type_length: 8,
    dimensions: 0,
    passed_by_value: true,
    alignment: "d",
    type_kind: "b",
    domain_base_is_none: true,
    identity_kind: "",
    generated_kind: "",
    collation_is_canonical: true,
    is_not_null: false,
    has_default: false,
    default_kind: "none",
    acl_is_default: true,
    options_are_default: true,
    fdw_options_are_default: true,
    storage_kind: "p",
    compression_kind: "",
    statistics_are_default: true,
    has_no_missing_value: true,
    missing_value_is_null: true,
  },
];

function emptyMigrationTableState(): any {
  return {
    ...baseState(),
    migrationCatalog: {
      schema_exists: true,
      table_exists: true,
      objects: [
        "S:__drizzle_migrations_id_seq",
        "i:__drizzle_migrations_pkey",
        "r:__drizzle_migrations",
      ],
    },
    migrationColumns,
    migrationColumnExact: migrationColumnExact.map((row) => ({ ...row })),
    migrationPrimaryKey: [{ columns: ["id"] }],
    migrationExact: { ...exactMigrationState },
  };
}

function residualState(
  field: string,
  { estimatedDataRows = "0", signature = "1259:90001:0" } = {}
) {
  const state = baseState();
  const kindByField: Record<string, string> = {
    schema_count: "schema",
    relation_count: "relation",
    routine_count: "routine",
    type_count: "type",
    trigger_count: "trigger",
    rule_count: "rule",
    policy_count: "policy",
    constraint_count: "constraint",
    other_count: "other",
  };
  const kind = kindByField[field];
  if (!kind) throw new Error("UNKNOWN_RESIDUAL_FIXTURE_FIELD");
  state.userDefinedObjects = {
    ...state.userDefinedObjects,
    total_count: 1,
    [field]: 1,
    estimated_data_rows: estimatedDataRows,
    object_signature: [`${kind}:${signature}`],
    extension_classification_evidence: [
      {
        objectSignature: signature,
        evidenceSignature: `candidate:${signature}`,
        evidenceKind: "candidate",
        dependencyType: "none",
        dependentClass: "none",
        referencedClass: "none",
        referencedIsDirectExtensionMember: false,
        triggerConstraintMatches: false,
        ruleName: null,
        relationKind: null,
        constraintType: null,
      },
      {
        objectSignature: signature,
        evidenceSignature: `residual_catalog:${signature}`,
        evidenceKind: "residual_catalog",
        dependencyType: "none",
        dependentClass: "other_catalog",
        referencedClass: "none",
        referencedIsDirectExtensionMember: false,
        triggerConstraintMatches: false,
        ruleName: null,
        relationKind: null,
        constraintType: null,
      },
    ],
    extension_candidate_signature: [signature],
    extension_managed_signature: [],
    extension_residual_signature: [signature],
  };
  return state;
}

function extensionClassificationState(
  evidence: Record<string, unknown>,
  {
    managed = false,
    residualField = "other_count",
    signature = "1259:90002:0",
  }: { managed?: boolean; residualField?: string; signature?: string } = {}
) {
  const state = managed
    ? baseState()
    : residualState(residualField, { signature });
  state.userDefinedObjects.extension_classification_evidence = [
    {
      objectSignature: signature,
      evidenceSignature: `candidate:${signature}`,
      evidenceKind: "candidate",
      dependencyType: "none",
      dependentClass: "none",
      referencedClass: "none",
      referencedIsDirectExtensionMember: false,
      triggerConstraintMatches: false,
      ruleName: null,
      relationKind: null,
      constraintType: null,
    },
    {
      objectSignature: signature,
      evidenceSignature: `dependency:${signature}:1`,
      evidenceKind: "dependency",
      referencedIsDirectExtensionMember: false,
      triggerConstraintMatches: false,
      ruleName: null,
      relationKind: null,
      constraintType: null,
      ...evidence,
    },
    ...(!managed
      ? [
          {
            objectSignature: signature,
            evidenceSignature: `residual_catalog:${signature}`,
            evidenceKind: "residual_catalog",
            dependencyType: "none",
            dependentClass: "other_catalog",
            referencedClass: "none",
            referencedIsDirectExtensionMember: false,
            triggerConstraintMatches: false,
            ruleName: null,
            relationKind: null,
            constraintType: null,
          },
        ]
      : []),
  ];
  state.userDefinedObjects.extension_candidate_signature = [signature];
  state.userDefinedObjects.extension_managed_signature = managed
    ? [signature]
    : [];
  state.userDefinedObjects.extension_residual_signature = managed
    ? []
    : [signature];
  return state;
}

function dependencyEvidence(
  signature: string,
  suffix: string,
  overrides: Record<string, unknown>
) {
  return {
    objectSignature: signature,
    evidenceSignature: `dependency:${signature}:${suffix}`,
    evidenceKind: "dependency",
    dependencyType: "n",
    dependentClass: "other_catalog",
    referencedClass: "other_catalog",
    referencedIsDirectExtensionMember: false,
    triggerConstraintMatches: false,
    ruleName: null,
    relationKind: null,
    constraintType: null,
    ...overrides,
  };
}

function sameSql(left: string, right: string) {
  return left.replaceAll(/\s+/g, " ").trim() ===
    right.replaceAll(/\s+/g, " ").trim();
}

function countSqlCalls(connection: any, statement: string) {
  return connection.query.mock.calls.filter(([actual]: [string]) =>
    sameSql(actual, statement)
  ).length;
}

function createConnection(
  stateFactory: () => any,
  options: {
    failCleanup?: boolean;
    hangCleanup?: boolean;
    hangAt?: string;
    roleName?: string;
  } = {}
) {
  let serverVersionReads = 0;
  let identityReads = 0;
  let userObjectReads = 0;
  let migrationColumnExactReads = 0;
  let migrationExactReads = 0;
  let extensionInventoryReads = 0;
  let cleanupHandle: ReturnType<typeof setInterval> | undefined;
  const query = vi.fn((statement: string) => {
    if (options.hangAt && sameSql(statement, (PREFLIGHT_SQL_FOR_TESTS as any)[options.hangAt])) {
      return new Promise(() => undefined);
    }
    if (
      sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.begin) ||
      sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.statementTimeout) ||
      sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.lockTimeout) ||
      sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.rollback)
    ) {
      return Promise.resolve({ rows: [] });
    }
    if (sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.transactionReadOnly)) {
      return Promise.resolve({ rows: [{ transaction_read_only: "on" }] });
    }
    const state = stateFactory();
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.serverVersion)) {
      serverVersionReads += 1;
      const serverVersion =
        state.serverVersionForRead?.(serverVersionReads) || state.serverVersion;
      return Promise.resolve({ rows: serverVersion ? [serverVersion] : [] });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.identity)) {
      identityReads += 1;
      const identity =
        state.identityForRead?.(identityReads) ?? state.identity;
      return Promise.resolve({ rows: identity ? [identity] : [] });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.roleIdentity)) {
      const roleIdentity = state.roleIdentityForRead?.() ?? {
        role_name: options.roleName ?? state.roleIdentity?.role_name,
      };
      return Promise.resolve({ rows: roleIdentity?.role_name ? [roleIdentity] : [] });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.extensionInventory)) {
      extensionInventoryReads += 1;
      return Promise.resolve({
        rows:
          state.extensionInventoryForRead?.(extensionInventoryReads) ??
          state.extensionInventory,
      });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationCatalog)) {
      return Promise.resolve({ rows: [state.migrationCatalog] });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationColumns)) {
      return Promise.resolve({ rows: state.migrationColumns });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationColumnExact)) {
      migrationColumnExactReads += 1;
      return Promise.resolve({
        rows:
          state.migrationColumnExactForRead?.(migrationColumnExactReads) ||
          state.migrationColumnExact,
      });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationPrimaryKey)) {
      return Promise.resolve({ rows: state.migrationPrimaryKey });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationHistory)) {
      return Promise.resolve({ rows: state.migrationHistory });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationExact)) {
      migrationExactReads += 1;
      const migrationExact =
        state.migrationExactForRead?.(migrationExactReads) || state.migrationExact;
      return Promise.resolve({ rows: migrationExact ? [migrationExact] : [] });
    }
    if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.userDefinedObjects)) {
      userObjectReads += 1;
      return Promise.resolve({
        rows: [
          state.userDefinedObjectsForRead?.(userObjectReads) ||
            state.userDefinedObjects,
        ],
      });
    }
    throw new Error(`Unexpected fixture query: ${statement.slice(0, 32)}`);
  });
  const connection = {
    query,
    close: options.failCleanup
      ? vi.fn().mockRejectedValue(new Error(`${fakeSecret} cleanup failure`))
      : options.hangCleanup
        ? vi.fn(
            () =>
              new Promise(() => {
                cleanupHandle = setInterval(() => undefined, 1_000);
              })
          )
        : vi.fn().mockResolvedValue(undefined),
    clearCleanupHandle() {
      if (cleanupHandle) clearInterval(cleanupHandle);
      cleanupHandle = undefined;
    },
  };
  return connection;
}

function createAdapter({
  directState = baseState(),
  pooledState = directState,
  directFailure,
  pooledFailure,
  directOptions,
  pooledOptions,
}: any = {}) {
  const directConnection = createConnection(() => directState, {
    roleName: "staging_direct",
    ...directOptions,
  });
  const pooledConnection = createConnection(() => pooledState, {
    roleName: "staging_runtime",
    ...pooledOptions,
  });
  const connect = vi.fn(
    (
      kind: string,
      _url?: string,
      _options?: { signal?: AbortSignal }
    ) => {
      void _url;
      void _options;
      if (kind === "direct" && directFailure) return Promise.reject(directFailure);
      if (kind === "pooled" && pooledFailure) return Promise.reject(pooledFailure);
      return Promise.resolve(
        kind === "direct" ? directConnection : pooledConnection
      );
    }
  );
  return { connect, directConnection, pooledConnection };
}

async function runPreflight(adapter: any, environment = validEnvironment()) {
  return verifyStagingDatabasePreflight({
    environment,
    repositoryRoot,
    adapter,
  }) as Promise<any>;
}

function createSanitizedNodeChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "COMSPEC",
    "PATHEXT",
  ]) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

async function runCliChild(scenario: string) {
  const entryUrl = pathToFileURL(
    resolve(repositoryRoot, "scripts/verify-staging-database-preflight.mjs")
  ).href;
  const coreUrl = pathToFileURL(
    resolve(repositoryRoot, "scripts/staging-database-preflight/core.mjs")
  ).href;
  const postflightCoreUrl = pathToFileURL(
    resolve(repositoryRoot, "scripts/staging-database-postflight/core.mjs")
  ).href;
  const childSource = `
    import {
      runPreflightCli,
      runStagingPreflightEntrypoint,
    } from ${JSON.stringify(entryUrl)};
    import {
      PREFLIGHT_SQL_FOR_TESTS,
      verifyStagingDatabasePreflight,
    } from ${JSON.stringify(coreUrl)};
    import { POSTFLIGHT_SQL_FOR_TESTS } from ${JSON.stringify(postflightCoreUrl)};
    const scenario = process.argv[2];
    const childSecret = ${JSON.stringify(fakeSecret)};
    const normalize = (value) => value.replaceAll(/\\s+/g, " ").trim();
    const sameSql = (left, right) => normalize(left) === normalize(right);
    const residualSignature = "1259:90003:0";
    const userObjects = {
      total_count: scenario === "residual" ? 1 : 0,
      schema_count: 0,
      relation_count: scenario === "residual" ? 1 : 0,
      routine_count: 0,
      type_count: 0,
      trigger_count: 0,
      rule_count: 0,
      policy_count: 0,
      constraint_count: 0,
      other_count: 0,
      estimated_data_rows: "0",
      object_signature: scenario === "residual"
        ? ["relation:" + residualSignature]
        : [],
      extension_classification_evidence: scenario === "residual"
        ? [
            {
              objectSignature: residualSignature,
              evidenceSignature: "candidate:" + residualSignature,
              evidenceKind: "candidate",
              dependencyType: "none",
              dependentClass: "none",
              referencedClass: "none",
              referencedIsDirectExtensionMember: false,
              triggerConstraintMatches: false,
              ruleName: null,
              relationKind: null,
              constraintType: null,
            },
            {
              objectSignature: residualSignature,
              evidenceSignature: "residual_catalog:" + residualSignature,
              evidenceKind: "residual_catalog",
              dependencyType: "none",
              dependentClass: "pg_class",
              referencedClass: "none",
              referencedIsDirectExtensionMember: false,
              triggerConstraintMatches: false,
              ruleName: null,
              relationKind: null,
              constraintType: null,
            },
          ]
        : [],
      extension_unclassified_count: 0,
      extension_ambiguous_count: 0,
      extension_candidate_signature: scenario === "residual"
        ? [residualSignature]
        : [],
      extension_managed_signature: [],
      extension_residual_signature: scenario === "residual"
        ? [residualSignature]
        : [],
    };
    const state = {
      serverVersion: { server_version_num: "180004" },
      identity: { database_oid: "100", system_identifier: "200" },
      extensionInventory: [],
      migrationCatalog: {
        schema_exists: false,
        table_exists: false,
        objects: [],
      },
      userDefinedObjects: userObjects,
    };
    let activeCleanupHandle;
    if (scenario === "cleanup_timeout") {
      const nativeSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (handler, timeout, ...args) =>
        nativeSetTimeout(handler, timeout === 5_000 ? 25 : timeout, ...args);
    }
    const createConnection = (kind) => ({
      async query(statement) {
        if (
          sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.begin) ||
          sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.statementTimeout) ||
          sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.lockTimeout) ||
          sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.rollback)
        ) return { rows: [] };
        if (sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.transactionReadOnly)) {
          return { rows: [{ transaction_read_only: "on" }] };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.identity)) {
          return { rows: [state.identity] };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.roleIdentity)) {
          return {
            rows: [
              {
                role_name:
                  kind === "direct" ? "staging_direct" : "staging_runtime",
              },
            ],
          };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.extensionInventory)) {
          return { rows: state.extensionInventory };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.serverVersion)) {
          return { rows: [state.serverVersion] };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.migrationCatalog)) {
          return { rows: [state.migrationCatalog] };
        }
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.userDefinedObjects)) {
          return scenario === "catalog_unknown"
            ? { rows: [] }
            : { rows: [state.userDefinedObjects] };
        }
        throw new Error(childSecret);
      },
      close() {
        if (scenario === "cleanup_timeout" && kind === "pooled") {
          return new Promise(() => {
            activeCleanupHandle = setInterval(() => undefined, 1_000);
          });
        }
        return Promise.resolve();
      },
    });
    const adapter = {
      async connect(kind) {
        if (scenario === "connection_unknown" && kind === "direct") {
          throw new AggregateError([new Error(childSecret)]);
        }
        return createConnection(kind);
      },
    };
    const environment = {
      ACTUSTUBE_DB_ENV: scenario === "safety" ? "production" : "staging",
      ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT: "1",
      DIRECT_DATABASE_URL: ${JSON.stringify(directUrl)},
      DATABASE_URL: ${JSON.stringify(pooledUrl)},
      ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "ep-actustube-safe",
      ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
        schemaVersion: 1,
        extensions: [],
      }),
    };
    const mainFunction = () => verifyStagingDatabasePreflight({
      environment,
      repositoryRoot: process.cwd(),
      adapter,
    });
    const runCliFunction = () => runPreflightCli({
      mainFunction,
      ...(scenario === "formatter_failure"
        ? { formatSummary: () => { throw new Error(childSecret); } }
        : {}),
    });
    if (scenario === "cleanup_timeout") {
      await runStagingPreflightEntrypoint({ runCliFunction });
      process.exit(96);
    }
    await runCliFunction();
    if (
      process.listenerCount("uncaughtException") !== 0 ||
      process.listenerCount("unhandledRejection") !== 0
    ) {
      process.exitCode = 98;
    }
  `;
  return await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolveChild, rejectChild) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-", scenario],
      {
        env: createSanitizedNodeChildEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectChild(new Error("CLI_CHILD_TIMEOUT"));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectChild(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolveChild({ exitCode, stdout, stderr });
    });
    child.stdin.end(childSource);
  });
}

const postgresHarnessModule = resolve(
  repositoryRoot,
  "scripts/test-staging-database-preflight-postgres.mjs"
);
const faultLifecycleModule = resolve(
  repositoryRoot,
  "scripts/test-staging-database-fault-lifecycle.mjs"
);

function sourceSection(
  source: string,
  startLiteral: string,
  endLiteral: string
): string {
  const start = source.indexOf(startLiteral);
  const end = source.indexOf(endLiteral, start + startLiteral.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("TEST_SOURCE_SECTION_NOT_FOUND");
  }
  return source.slice(start, end);
}

function literalOccurrenceCount(source: string, literal: string): number {
  return source.split(literal).length - 1;
}

function externalFixtureEnvironment(
  overrides: Partial<NodeJS.ProcessEnv> = {}
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ACTUSTUBE_STAGING_HARNESS_DATABASE_URL:
      "postgresql://actustube_ci_fixture:ci_fixture_only_not_a_secret@127.0.0.1:5432/actustube_ci_fixture",
    ACTUSTUBE_STAGING_HARNESS_EXPECTED_DATABASE: "actustube_ci_fixture",
    ACTUSTUBE_STAGING_HARNESS_EXPECTED_ROLE: "actustube_ci_fixture",
    ACTUSTUBE_STAGING_HARNESS_EXPECTED_MAJOR: "18",
    ACTUSTUBE_STAGING_HARNESS_EXPECTED_MIGRATION_MAX: "6",
    ...overrides,
  };
}

function createDeadlineFakeClient({
  connectHang = false,
  queryHang = false,
  endHang = false,
  lateQueryRejection = false,
  hangOnStatement = null as string | null,
  rejectOnStatement = null as string | null,
} = {}) {
  const counters = {
    connect: 0,
    query: [] as string[],
    end: 0,
    destroy: 0,
  };
  const state = {
    connected: false,
    usable: true,
    destroyed: false,
    ended: false,
    queriesAtDestroy: null as number | null,
  };
  const client = {
    connection: {
      stream: {
        destroy() {
          counters.destroy += 1;
          state.destroyed = true;
          state.usable = false;
          state.queriesAtDestroy = counters.query.length;
        },
      },
    },
    connect() {
      counters.connect += 1;
      if (connectHang) return new Promise(() => undefined);
      state.connected = true;
      return Promise.resolve(undefined);
    },
    query(statement: string) {
      counters.query.push(statement);
      if (rejectOnStatement === statement) {
        return Promise.reject(new Error("fixed-finite-query-failure"));
      }
      if (lateQueryRejection) {
        return new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("credential-raw-query-late-rejection")),
            35
          );
        });
      }
      return queryHang || hangOnStatement === statement
        ? new Promise(() => undefined)
        : Promise.resolve({ rows: [] });
    },
    end() {
      counters.end += 1;
      state.ended = true;
      state.usable = false;
      return endHang
        ? new Promise(() => undefined)
        : Promise.resolve(undefined);
    },
  };
  return { client, counters, state };
}

const testLegacyOwner = "actustube_ci_usage_legacy_owner";
const testMigrationExecutor = "actustube_ci_usage_migration_executor";
const testFixtureSessionRole = "actustube_ci_fixture";
const testCallerConfigurationRole = "actustube_ci_fixture";
const testInitialObservedSessionRole = "actustube_ci_fixture";
const testInitialObservedCurrentRole = "actustube_ci_fixture";
const testCleanupObservedSessionRole = "actustube_ci_fixture";
const testCleanupObservedCurrentRole = "actustube_ci_fixture";
const testActualAclGrantorRole = "actustube_ci_fixture";
const testLegacyOwnerOid = "81001";
const testMigrationExecutorOid = "81002";
const testUsageOwnerIdentities = [
  "public.reserve_usage_limits(uuid,integer,public.usage_metric,timestamp with time zone)",
  "public.usage_period_boundaries_v1(timestamp with time zone)",
  "public.resolve_effective_usage_plan_v1(uuid,timestamp with time zone)",
  "public.reserve_usage_limits_v2(uuid,integer,public.usage_metric,timestamp with time zone)",
  "public.get_usage_status_v1(uuid,integer,timestamp with time zone)",
] as const;

const exactProductionDefaultPrivilegeContract = {
  statement:
    "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
  parameters: [],
} as const;

const exactRevokeContracts = [
  {
    label: "revoke-database-create",
    statement: `
      DO $fixture_database_revoke$
      BEGIN
        EXECUTE pg_catalog.format(
          'REVOKE CREATE ON DATABASE %I FROM %I',
          pg_catalog.current_database(),
          '${testMigrationExecutor}'
        );
      END;
      $fixture_database_revoke$;
    `,
    parameters: [],
  },
  {
    label: "revoke-public-executor",
    statement: `REVOKE USAGE, CREATE ON SCHEMA public FROM "${testMigrationExecutor}"`,
    parameters: [],
  },
  {
    label: "revoke-public-legacy",
    statement: `REVOKE USAGE, CREATE ON SCHEMA public FROM "${testLegacyOwner}"`,
    parameters: [],
  },
  {
    label: "revoke-drizzle-executor",
    statement: `REVOKE USAGE, CREATE ON SCHEMA drizzle FROM "${testMigrationExecutor}"`,
    parameters: [],
  },
  {
    label: "revoke-ledger-table",
    statement: `REVOKE SELECT, INSERT ON TABLE drizzle.__drizzle_migrations FROM "${testMigrationExecutor}"`,
    parameters: [],
  },
  {
    label: "revoke-ledger-sequence",
    statement: `REVOKE USAGE, SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq FROM "${testMigrationExecutor}"`,
    parameters: [],
  },
  {
    label: "revoke-legacy-membership",
    statement: `REVOKE "${testLegacyOwner}" FROM "${testMigrationExecutor}"`,
    parameters: [],
  },
] as const;

type ExactRevokeLabel = (typeof exactRevokeContracts)[number]["label"];

function normalizeExactRevokeSql(statement: string) {
  return statement
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function exactRevokeQueryLabel(
  statement: string,
  parameters: unknown[]
): ExactRevokeLabel | null {
  const normalized = normalizeExactRevokeSql(statement);
  const matches = exactRevokeContracts.filter(
    (contract) =>
      normalizeExactRevokeSql(contract.statement) === normalized &&
      JSON.stringify(contract.parameters) === JSON.stringify(parameters)
  );
  return matches.length === 1 ? matches[0].label : null;
}

function isExactProductionDefaultPrivilegeQuery(
  statement: string,
  parameters: unknown[]
) {
  return (
    normalizeExactRevokeSql(statement) ===
      normalizeExactRevokeSql(
        exactProductionDefaultPrivilegeContract.statement
      ) &&
    Array.isArray(parameters) &&
    parameters.length === exactProductionDefaultPrivilegeContract.parameters.length
  );
}

function validMigrationRolePrecondition(
  overrides: Record<string, unknown> = {}
) {
  return {
    session_role: testFixtureSessionRole,
    effective_role: testMigrationExecutor,
    legacy_function_owner_oid: testLegacyOwnerOid,
    legacy_owner_oid: testLegacyOwnerOid,
    legacy_owner_name: testLegacyOwner,
    migration_executor_oid: testMigrationExecutorOid,
    migration_executor_name: testMigrationExecutor,
    has_legacy_membership: true,
    legacy_owner_restricted: true,
    migration_executor_restricted: true,
    ...overrides,
  };
}

function validInitialMigrationBoundaryRoles() {
  return [
    {
      ordinal: 1,
      role_name: testLegacyOwner,
      role_oid: testLegacyOwnerOid,
      session_role: testFixtureSessionRole,
      effective_role: testFixtureSessionRole,
      role_restricted: true,
      oid_is_separated: true,
    },
    {
      ordinal: 2,
      role_name: testMigrationExecutor,
      role_oid: testMigrationExecutorOid,
      session_role: testFixtureSessionRole,
      effective_role: testFixtureSessionRole,
      role_restricted: true,
      oid_is_separated: true,
    },
  ];
}

function validObservedSessionIdentityRows({
  sessionRole = testInitialObservedSessionRole,
  effectiveRole = testInitialObservedCurrentRole,
}: {
  sessionRole?: unknown;
  effectiveRole?: unknown;
} = {}) {
  return [
    {
      session_role: sessionRole,
      effective_role: effectiveRole,
    },
  ];
}

function validUsageOwnerPostcondition(): Array<Record<string, any>> {
  return testUsageOwnerIdentities.map((functionIdentity, index) => ({
    function_identity: functionIdentity,
    ordinal: index + 1,
    function_oid: String(82001 + index),
    owner_oid: testLegacyOwnerOid,
    owner_name: testLegacyOwner,
    acl_text: "{fixed_acl}",
    security_definer: false,
    search_path: ["search_path=public, pg_temp"],
  }));
}

function ownerBoundaryQueryLabel(
  statement: string,
  parameters: unknown[] = []
) {
  if (isExactProductionDefaultPrivilegeQuery(statement, parameters)) {
    return "production-alter-default-privileges";
  }
  const exactRevokeLabel = exactRevokeQueryLabel(statement, parameters);
  if (exactRevokeLabel) return exactRevokeLabel;
  if (statement.includes("CREATE ROLE") && statement.includes(testLegacyOwner)) {
    return "create-fixed-roles";
  }
  if (statement.includes("fixture_database_grant")) return "minimal-grants";
  if (statement.startsWith("SET ROLE")) return "set-migration-executor";
  if (statement === "RESET ROLE") return "reset-role";
  if (
    statement.replace(/\s+/g, " ").trim() ===
    "SELECT session_user AS session_role, current_user AS effective_role"
  ) {
    return "observed-session-identity";
  }
  if (statement.includes("WITH expected(role_name, ordinal)")) {
    return "initial-role-contract";
  }
  if (statement.includes("AS migration_executor_restricted") &&
      !statement.includes("legacy_function AS")) {
    return "migration-executor-identity";
  }
  if (
    statement.includes(`ALTER FUNCTION ${testUsageOwnerIdentities[0]}`) &&
    statement.includes(`OWNER TO "${testLegacyOwner}"`)
  ) {
    return "legacy-owner-baseline";
  }
  if (statement.trimStart().startsWith("GRANT") &&
      statement.includes(testLegacyOwner) &&
      statement.includes(testMigrationExecutor)) {
    return "legacy-owner-membership";
  }
  if (statement.includes("WITH legacy_function AS")) return "role-precondition";
  if (statement.includes("WITH expected(function_identity, ordinal)")) {
    return "owner-postcondition";
  }
  const compactStatement = statement.replace(/\s+/g, " ").trim();
  if (compactStatement.startsWith('CREATE SCHEMA IF NOT EXISTS "drizzle"')) {
    return "drizzle-migration-start";
  }
  if (
    compactStatement.startsWith(
      'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations"'
    )
  ) {
    return "drizzle-migration-table";
  }
  if (
    compactStatement ===
    'select id, hash, created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1'
  ) {
    return "drizzle-migration-last";
  }
  if (
    compactStatement.startsWith(
      'insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values('
    )
  ) {
    return "drizzle-migration-insert";
  }
  if (
    statement.includes("count(DISTINCT hash)::integer") &&
    statement.includes("FROM drizzle.__drizzle_migrations")
  ) {
    return "migration-ledger-count";
  }
  if (
    statement.includes("'assignments'") &&
    statement.includes("public.user_usage_buckets")
  ) {
    return "old-migration-state";
  }
  if (
    statement.includes("AS compatible") &&
    statement.includes("reserve_usage_limits_v2")
  ) {
    return "old-migration-compatible";
  }
  if (statement.includes("SELECT * FROM public.reserve_usage_limits_v2(")) {
    return "old-migration-versioned-call";
  }
  if (
    compactStatement.startsWith("GRANT EXECUTE ON FUNCTION") &&
    compactStatement.endsWith("TO PUBLIC")
  ) {
    return "before-final-boundary";
  }
  if (statement.includes("AS versioned_function_absent")) {
    return "public-acl-failure-state";
  }
  if (
    compactStatement.startsWith("REVOKE ALL PRIVILEGES ON FUNCTION") &&
    compactStatement.endsWith("FROM PUBLIC")
  ) {
    return "public-acl-failure-reset";
  }
  if (statement.includes("pg_catalog.md5(proacl::text) AS acl_hash")) {
    return "legacy-acl-hash";
  }
  if (compactStatement === "BEGIN" || compactStatement === "begin") {
    return "begin";
  }
  if (compactStatement === "COMMIT" || compactStatement === "commit") {
    return "commit";
  }
  if (compactStatement === "ROLLBACK" || compactStatement === "rollback") {
    return "rollback";
  }
  if (compactStatement.startsWith("SAVEPOINT ")) return "savepoint";
  if (compactStatement.startsWith("ROLLBACK TO SAVEPOINT ")) {
    return "rollback-savepoint";
  }
  if (compactStatement.startsWith("RELEASE SAVEPOINT ")) {
    return "release-savepoint";
  }
  if (statement.includes("authority_inventory")) {
    return "temporary-authority-inventory";
  }
  if (statement.includes("unsupported_owned_object")) {
    return "pre-canonical-inventory";
  }
  if (statement.includes("'database'::text AS object_kind")) {
    return "post-canonical-snapshot";
  }
  if (/^ALTER (?:SCHEMA|TABLE|SEQUENCE|TYPE|FUNCTION) /.test(statement)) {
    return "canonical-owner-change";
  }
  if (statement.includes("fixed_postflight_boundary")) {
    return "postflight-boundary";
  }
  return "unknown-fixed-query";
}

type MigrationOwnerFakeClientOptions = {
  initialObservedIdentityRows?: Array<Record<string, unknown>>;
  boundaryObservedIdentityRows?: Array<Record<string, unknown>>;
  initialRoleRows?: Array<Record<string, unknown>>;
  preconditionRows?: Array<Record<string, unknown>>;
  postconditionRows?: Array<Record<string, unknown>>;
  hangOnLabel?: string | null;
  rejectOnLabel?: string | null;
};

function createMigrationOwnerFakeClient({
  initialObservedIdentityRows = validObservedSessionIdentityRows(),
  boundaryObservedIdentityRows = validObservedSessionIdentityRows(),
  initialRoleRows = validInitialMigrationBoundaryRoles(),
  preconditionRows = [validMigrationRolePrecondition()],
  postconditionRows = validUsageOwnerPostcondition(),
  hangOnLabel = null as string | null,
  rejectOnLabel = null as string | null,
}: MigrationOwnerFakeClientOptions = {}) {
  const state = {
    query: [] as string[],
    parameters: [] as unknown[][],
    labels: [] as string[],
    activeRole: testFixtureSessionRole,
    callbackObservations: [] as Array<{
      kind: string;
      sequence: number;
      client: unknown;
      activeRole: string;
    }>,
    defaultPrivilegeAttemptCount: 0,
    defaultPrivilegeMutationCount: 0,
    identityQueryCount: 0,
    migrationRunCount: 0,
    migrationLedger: [] as Array<{ hash: string; created_at: number }>,
    awaitingDrizzleTransaction: false,
    inDrizzleTransaction: false,
    publicAclFailureArmed: false,
    connect: 0,
    end: 0,
    destroy: 0,
    usable: true,
    queriesAtDestroy: null as number | null,
  };
  const client = {
    connection: {
      stream: {
        destroy() {
          state.destroy += 1;
          state.usable = false;
          state.queriesAtDestroy = state.query.length;
        },
      },
    },
    connect() {
      state.connect += 1;
      return Promise.resolve();
    },
    query(
      statementOrConfiguration: string | { text: string; values?: unknown[] },
      parameters: unknown[] = []
    ) {
      const configurationHasValues =
        typeof statementOrConfiguration !== "string" &&
        Object.prototype.hasOwnProperty.call(
          statementOrConfiguration,
          "values"
        );
      const separateParameters = Array.isArray(parameters)
        ? parameters
        : ["invalid-fixed-query-parameter-contract"];
      const effectiveParameters =
        typeof statementOrConfiguration === "string" ||
        !configurationHasValues
          ? separateParameters
          : Array.isArray(statementOrConfiguration.values) &&
              separateParameters.length === 0
            ? statementOrConfiguration.values
            : ["invalid-fixed-query-parameter-contract"];
      const statement =
        typeof statementOrConfiguration === "string"
          ? statementOrConfiguration
          : statementOrConfiguration.text;
      state.query.push(statement);
      state.parameters.push(effectiveParameters);
      const baseLabel = ownerBoundaryQueryLabel(
        statement,
        effectiveParameters
      );
      let label = baseLabel;
      if (baseLabel === "drizzle-migration-start") {
        state.migrationRunCount += 1;
        label =
          state.migrationRunCount === 1
            ? "migration-callback-baseline"
            : state.migrationRunCount === 2
              ? "public-acl-failure-migration"
              : state.migrationRunCount === 3
                ? "migration-callback-final"
                : state.migrationRunCount === 4
                  ? "migration-callback-replay"
                  : "unexpected-migration-run";
      }
      state.labels.push(label);
      if (
        normalizeExactRevokeSql(statement).startsWith(
          "ALTER DEFAULT PRIVILEGES"
        )
      ) {
        state.defaultPrivilegeAttemptCount += 1;
      }
      if (label === "production-alter-default-privileges") {
        state.defaultPrivilegeMutationCount += 1;
      }
      if (label === "set-migration-executor") {
        state.activeRole = testMigrationExecutor;
      } else if (label === "reset-role") {
        state.activeRole = testFixtureSessionRole;
      } else if (label.startsWith("migration-callback-")) {
        state.callbackObservations.push({
          kind: label.slice("migration-callback-".length),
          sequence: state.query.length,
          client,
          activeRole: state.activeRole,
        });
      }
      if (label === hangOnLabel) return new Promise(() => undefined);
      if (label === rejectOnLabel) {
        return Promise.reject(new Error("fixed-owner-boundary-failure"));
      }
      if (label === "initial-role-contract") {
        return Promise.resolve({ rows: initialRoleRows });
      }
      if (label === "observed-session-identity") {
        state.identityQueryCount += 1;
        return Promise.resolve({
          rows:
            state.identityQueryCount === 1
              ? initialObservedIdentityRows
              : boundaryObservedIdentityRows,
        });
      }
      if (label === "migration-executor-identity") {
        return Promise.resolve({
          rows: [
            {
              session_role: testFixtureSessionRole,
              effective_role: testMigrationExecutor,
              migration_executor_name: testMigrationExecutor,
              migration_executor_restricted: true,
            },
          ],
        });
      }
      if (label === "role-precondition") {
        return Promise.resolve({ rows: preconditionRows });
      }
      if (label === "owner-postcondition") {
        return Promise.resolve({ rows: postconditionRows });
      }
      if (label === "drizzle-migration-last") {
        state.awaitingDrizzleTransaction = true;
        return Promise.resolve({
          rows:
            state.migrationLedger.length === 0
              ? []
              : [state.migrationLedger.at(-1)],
        });
      }
      if (label === "begin" && state.awaitingDrizzleTransaction) {
        state.awaitingDrizzleTransaction = false;
        state.inDrizzleTransaction = true;
        return Promise.resolve({ rows: [] });
      }
      if (label === "drizzle-migration-insert") {
        const [hash, createdAt] = effectiveParameters;
        if (typeof hash === "string" && typeof createdAt === "number") {
          state.migrationLedger.push({ hash, created_at: createdAt });
        }
        return Promise.resolve({ rows: [] });
      }
      if (label === "commit" || label === "rollback") {
        state.inDrizzleTransaction = false;
        state.awaitingDrizzleTransaction = false;
        return Promise.resolve({ rows: [] });
      }
      if (label === "migration-ledger-count") {
        const rowCount = state.migrationLedger.length;
        return Promise.resolve({
          rows: [
            {
              row_count: rowCount,
              distinct_hash_count: rowCount,
              distinct_created_at_count: rowCount,
            },
          ],
        });
      }
      if (label === "old-migration-state") {
        return Promise.resolve({
          rows: [{ state: { fixed_old_migration_state: 0 } }],
        });
      }
      if (label === "old-migration-compatible") {
        return Promise.resolve({ rows: [{ compatible: true }] });
      }
      if (label === "old-migration-versioned-call") {
        return Promise.reject({ code: "42883" });
      }
      if (label === "before-final-boundary") {
        state.publicAclFailureArmed = true;
        return Promise.resolve({ rows: [] });
      }
      if (label === "public-acl-failure-state") {
        return Promise.resolve({
          rows: [
            {
              versioned_function_absent: true,
              public_execute_retained: true,
            },
          ],
        });
      }
      if (label === "public-acl-failure-reset") {
        state.publicAclFailureArmed = false;
        return Promise.resolve({ rows: [] });
      }
      if (label === "legacy-acl-hash") {
        return Promise.resolve({ rows: [{ acl_hash: "fixed_acl_hash" }] });
      }
      if (
        label === "unknown-fixed-query" &&
        state.inDrizzleTransaction &&
        state.migrationRunCount === 2 &&
        state.publicAclFailureArmed &&
        state.migrationLedger.length === 6
      ) {
        return Promise.reject({ code: "P0001" });
      }
      return Promise.resolve({ rows: [] });
    },
    end() {
      state.end += 1;
      state.usable = false;
      return Promise.resolve();
    },
  };
  return { client, state };
}

function createObservedSessionIdentityFakeClient({
  rows = validObservedSessionIdentityRows(),
  reject = false,
  hang = false,
}: {
  rows?: Array<Record<string, unknown>>;
  reject?: boolean;
  hang?: boolean;
} = {}) {
  const state = {
    connect: 0,
    query: [] as string[],
    parameters: [] as unknown[][],
    end: 0,
    destroy: 0,
    queriesAtDestroy: null as number | null,
  };
  const client = {
    connection: {
      stream: {
        destroy() {
          state.destroy += 1;
          state.queriesAtDestroy = state.query.length;
        },
      },
    },
    connect() {
      state.connect += 1;
      return Promise.resolve();
    },
    query(statement: string, parameters: unknown[] = []) {
      state.query.push(statement);
      state.parameters.push(parameters);
      if (hang) return new Promise(() => undefined);
      if (reject) {
        return Promise.reject(new Error("fixed-observed-identity-failure"));
      }
      return Promise.resolve({ rows });
    },
    end() {
      state.end += 1;
      return Promise.resolve();
    },
  };
  return { client, state };
}

const testUsageBodyAclRoles = {
  explicit: "actustube_ci_usage_explicit",
  group: "actustube_ci_usage_group",
  member: "actustube_ci_usage_member",
  denied: "actustube_ci_usage_denied",
  publicProbe: "actustube_ci_usage_public_probe",
  migrationExecutor: testMigrationExecutor,
  legacyOwner: testLegacyOwner,
  productionRuntime: "actustube_ci_fixture_runtime",
} as const;

const testUsageBodyAclManifest = [
  {
    objectName: "users",
    privileges: ["SELECT", "UPDATE"],
  },
  {
    objectName: "user_plan_assignments",
    privileges: ["SELECT"],
  },
  {
    objectName: "plans",
    privileges: ["SELECT"],
  },
  {
    objectName: "user_usage_buckets",
    privileges: ["SELECT", "INSERT", "UPDATE"],
  },
  {
    objectName: "usage_reservation_leases",
    privileges: ["SELECT", "INSERT"],
  },
] as const;

const testUsageBodyAclRecipients = [
  testUsageBodyAclRoles.explicit,
  testUsageBodyAclRoles.group,
] as const;

const testUsageBodyAclInventoryRoleScope = [
  ...testUsageBodyAclRecipients,
  testUsageBodyAclRoles.member,
  testUsageBodyAclRoles.denied,
  testUsageBodyAclRoles.publicProbe,
  testUsageBodyAclRoles.migrationExecutor,
  testUsageBodyAclRoles.legacyOwner,
  testUsageBodyAclRoles.productionRuntime,
] as const;

const exactUsageBodyAclGrantContract = testUsageBodyAclManifest
  .map(
    (entry) =>
      `GRANT ${entry.privileges.join(", ")} ON TABLE "public"."${entry.objectName}" TO "${testUsageBodyAclRoles.explicit}", "${testUsageBodyAclRoles.group}" GRANTED BY "${testFixtureSessionRole}"`
  )
  .join(";\n");

const exactUsageBodyAclRevokeContract = testUsageBodyAclManifest
  .map(
    (entry) =>
      `REVOKE ${entry.privileges.join(", ")} ON TABLE "public"."${entry.objectName}" FROM "${testUsageBodyAclRoles.explicit}", "${testUsageBodyAclRoles.group}" GRANTED BY "${testFixtureSessionRole}"`
  )
  .join(";\n");
const exactUsageBodyAclIdentityContract = `SELECT
session_user AS session_role,
current_user AS effective_role`;
const testGrantInventoryDiagnosticVersion =
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DIAGNOSTIC_V1";
const testGrantInventoryPrimaryMarkers = [
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_CLIENT_FACTORY",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_CLIENT_CONNECT_REJECTED",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_CLIENT_CONNECT_TIMEOUT",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_QUERY_REJECTED",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_QUERY_TIMEOUT",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_RESULT_SHAPE",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_EXACT_SET_MISMATCH",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_NORMALIZATION",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_CLIENT_CLOSE_REJECTED",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_CLIENT_CLOSE_TIMEOUT",
] as const;
const testGrantInventoryDetailMarkers = [
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_DUPLICATE_ROW",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_MISSING_ROW",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_EXTRA_ROW",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_OBJECT_CONTRACT",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_PRIVILEGE_CONTRACT",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_GRANT_OPTION_CONTRACT",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_RECIPIENT_CONTRACT",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_GRANTOR_CONTRACT",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_OWNER_SELF_CONTRACT",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_SYSTEM_RECIPIENT_COVERAGE",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_TARGET_GRANTOR_COVERAGE",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_OBSERVED_GRANTOR_COVERAGE",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_GRANTEE_DEPENDENCY",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_GRANTOR_DEPENDENCY",
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_UNCOVERED_DEPENDENCY",
] as const;
const testGrantInventoryCleanupAttempted =
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_CLEANUP_ATTEMPTED";
const testGrantInventoryCleanupSucceeded =
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_CLEANUP_SUCCEEDED";
const testGrantInventoryCleanupFailed =
  "EXTERNAL_FIXTURE_GRANT_INVENTORY_CLEANUP_FAILED";
const testGrantInventoryGenericMarker =
  "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY";

function testGrantInventoryOutputLines(diagnosticOutput: string) {
  return diagnosticOutput.endsWith("\n")
    ? diagnosticOutput.slice(0, -1).split("\n")
    : diagnosticOutput.split("\n");
}

const exactMissingUserUsageExecutionContract = `SELECT allowed FROM public.reserve_usage_limits_v2(
  $1::uuid, 1, 'channel_analysis'::public.usage_metric,
  statement_timestamp()
)`;
const exactDeniedUsageExecutionContract = `SELECT * FROM public.reserve_usage_limits_v2(
  $1::uuid, 1, 'channel_analysis'::public.usage_metric,
  statement_timestamp()
)`;
const exactMissingUserUsageExecutionParameters = [
  "10000000-0000-4000-8000-000000000001",
] as const;

type TestUsageBodyAclRow = {
  authority_kind: string;
  recipient_relation: string;
  grantor_name: string;
  grantee_name: string;
  object_kind: string;
  schema_name: string;
  object_name: string;
  privilege_type: string;
  grant_option: boolean;
  grantee_dependency_count: number;
  grantor_dependency_count: number;
};

const testUsageBodyAclRowKeys = [
  "authority_kind",
  "recipient_relation",
  "grantor_name",
  "grantee_name",
  "object_kind",
  "schema_name",
  "object_name",
  "privilege_type",
  "grant_option",
  "grantee_dependency_count",
  "grantor_dependency_count",
] as const;

function sortTestUsageBodyAclRows(rows: TestUsageBodyAclRow[]) {
  return [...rows].sort((left, right) => {
    for (const key of testUsageBodyAclRowKeys) {
      const comparison = String(left[key]).localeCompare(String(right[key]));
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

function validTestUsageBodyAclRows({
  grantorName = testFixtureSessionRole,
}: {
  grantorName?: string;
} = {}): TestUsageBodyAclRow[] {
  const rows: TestUsageBodyAclRow[] = [];
  for (const entry of testUsageBodyAclManifest) {
    for (const granteeName of testUsageBodyAclRecipients) {
      for (const privilegeType of entry.privileges) {
        rows.push({
          authority_kind: "explicit_acl",
          recipient_relation:
            granteeName === testUsageBodyAclRoles.explicit
              ? "explicit_direct"
              : "membership_group_direct",
          grantor_name: grantorName,
          grantee_name: granteeName,
          object_kind: "table",
          schema_name: "public",
          object_name: entry.objectName,
          privilege_type: privilegeType,
          grant_option: false,
          grantee_dependency_count: 1,
          grantor_dependency_count: 1,
        });
      }
    }
  }
  return sortTestUsageBodyAclRows(rows);
}

function testUsageBodyAclResidueRow(
  overrides: Partial<TestUsageBodyAclRow> = {}
): TestUsageBodyAclRow {
  return {
    authority_kind: "explicit_acl",
    recipient_relation: "explicit_direct",
    grantor_name: testFixtureSessionRole,
    grantee_name: testUsageBodyAclRoles.explicit,
    object_kind: "table",
    schema_name: "public",
    object_name: "users",
    privilege_type: "SELECT",
    grant_option: false,
    grantee_dependency_count: 1,
    grantor_dependency_count: 1,
    ...overrides,
  };
}

const testSystemWideAclRecipients = ["PUBLIC"] as const;
const testTargetAsGrantorRoles = [
  "actustube_ci_usage_explicit",
  "actustube_ci_usage_group",
  "actustube_ci_usage_member",
  "actustube_ci_usage_denied",
  "actustube_ci_usage_public_probe",
  "actustube_ci_usage_migration_executor",
  "actustube_ci_usage_legacy_owner",
  "actustube_ci_fixture_runtime",
] as const;

type TestUsageBodyAclCatalogRow = {
  physical_key: string;
  owner_name: string;
  grantor_name: string;
  grantee_name: string;
  object_kind: string;
  schema_name: string;
  object_name: string;
  privilege_type: string;
  grant_option: boolean;
};

type TestUsageBodyAclObjectOwner = {
  object_kind: "table";
  schema_name: "public";
  object_name: string;
  owner_name: string;
};

type TestUsageBodyAclDependencyCatalogRow = {
  physical_key: string;
  role_name: string;
  object_name: string;
  dependency_type: string;
  database_boundary: string;
  class_boundary: string;
};

type TestUsageBodyAclSelectionArm =
  | "system-wide-recipient"
  | "target-as-grantor"
  | "observed-grantor";

const testPostgreSql18TableOwnerPrivileges = Object.freeze([
  "INSERT",
  "SELECT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
] as const);
const testUsageBodyAclFixedObjectOwner =
  testUsageBodyAclRoles.migrationExecutor;

const testUsageBodyAclObjectOwners: TestUsageBodyAclObjectOwner[] =
  testUsageBodyAclManifest.map((entry) => ({
    object_kind: "table",
    schema_name: "public",
    object_name: entry.objectName,
    owner_name: testUsageBodyAclFixedObjectOwner,
  }));

function testLocalHasExactPostgreSql18OwnerPrivilegeAllowlist(
  privileges: readonly unknown[]
) {
  if (privileges.length !== 8) return false;
  if (!privileges.every((privilege) => typeof privilege === "string")) {
    return false;
  }
  const actual = [...privileges].sort();
  const expected = [...testPostgreSql18TableOwnerPrivileges].sort();
  return (
    new Set(privileges).size === 8 &&
    actual.every((privilege, index) => privilege === expected[index])
  );
}

function testLocalUsageBodyAclOwnerRowKey(row: TestUsageBodyAclCatalogRow) {
  return [
    row.physical_key,
    row.owner_name,
    row.grantor_name,
    row.grantee_name,
    row.object_kind,
    row.schema_name,
    row.object_name,
    row.privilege_type,
    String(row.grant_option),
  ].join("\u001f");
}

function testLocalExpectedUsageBodyAclOwnerRowKeys(
  objectOwners: TestUsageBodyAclObjectOwner[] = testUsageBodyAclObjectOwners
) {
  return objectOwners
    .flatMap((entry, objectIndex) =>
      testPostgreSql18TableOwnerPrivileges.map((privilegeType) =>
        [
          `owner-default-${objectIndex}-${privilegeType}`,
          entry.owner_name,
          entry.owner_name,
          entry.owner_name,
          entry.object_kind,
          entry.schema_name,
          entry.object_name,
          privilegeType,
          "false",
        ].join("\u001f")
      )
    )
    .sort();
}

function testLocalActualUsageBodyAclOwnerRowKeys(
  rows: TestUsageBodyAclCatalogRow[]
) {
  return rows
    .filter(testLocalIsExactOwnerSelfAcl)
    .map(testLocalUsageBodyAclOwnerRowKey)
    .sort();
}

function testLocalOwnerAclMultisetMatches(
  rows: TestUsageBodyAclCatalogRow[],
  objectOwners: TestUsageBodyAclObjectOwner[] = testUsageBodyAclObjectOwners
) {
  const actualKeys = testLocalActualUsageBodyAclOwnerRowKeys(rows);
  const expectedKeys = testLocalExpectedUsageBodyAclOwnerRowKeys(objectOwners);
  const physicalKeys = rows
    .filter(testLocalIsExactOwnerSelfAcl)
    .map((row) => row.physical_key);
  return (
    actualKeys.length === 40 &&
    new Set(physicalKeys).size === physicalKeys.length &&
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function testLocalNormalBodyObjectOwnerAuthorityIsDistinct(
  objectOwners: TestUsageBodyAclObjectOwner[]
) {
  const forbiddenOwnerIdentities = new Set([
    testFixtureSessionRole,
    testUsageBodyAclRoles.explicit,
    testUsageBodyAclRoles.group,
    testUsageBodyAclRoles.member,
    testUsageBodyAclRoles.denied,
    "PUBLIC",
    testUsageBodyAclRoles.productionRuntime,
    testUsageBodyAclRoles.legacyOwner,
  ]);
  return (
    objectOwners.length === 5 &&
    new Set(objectOwners.map((entry) => entry.object_name)).size === 5 &&
    objectOwners.every(
      (entry) =>
        entry.object_kind === "table" &&
        entry.schema_name === "public" &&
        entry.owner_name === testUsageBodyAclFixedObjectOwner &&
        !forbiddenOwnerIdentities.has(entry.owner_name) &&
        testUsageBodyAclManifest.some(
          (manifestEntry) => manifestEntry.objectName === entry.object_name
        )
    )
  );
}

function testUsageBodyAclCatalogRow(
  overrides: Partial<TestUsageBodyAclCatalogRow> = {}
): TestUsageBodyAclCatalogRow {
  return {
    physical_key: "fixed-acl-row",
    owner_name: testFixtureSessionRole,
    grantor_name: testFixtureSessionRole,
    grantee_name: testUsageBodyAclRoles.explicit,
    object_kind: "table",
    schema_name: "public",
    object_name: "users",
    privilege_type: "SELECT",
    grant_option: false,
    ...overrides,
  };
}

function testLocalIsExactOwnerSelfAcl(row: TestUsageBodyAclCatalogRow) {
  return (
    row.grantee_name === row.owner_name && row.grantor_name === row.owner_name
  );
}

function testLocalIsExactTemporaryUsageBodyAcl(row: TestUsageBodyAclCatalogRow) {
  return (
    row.object_kind === "table" &&
    row.schema_name === "public" &&
    row.grantor_name === testFixtureSessionRole &&
    row.grant_option === false &&
    testUsageBodyAclRecipients.some(
      (recipientName) => recipientName === row.grantee_name
    ) &&
    testUsageBodyAclManifest.some(
      (entry) =>
        entry.objectName === row.object_name &&
        entry.privileges.some(
          (privilegeType) => privilegeType === row.privilege_type
        )
    )
  );
}

function testLocalUsageBodyAclSemanticUnionArms(
  row: TestUsageBodyAclCatalogRow,
  observedGrantorName = testFixtureSessionRole
): TestUsageBodyAclSelectionArm[] {
  const fixedObject =
    row.object_kind === "table" &&
    row.schema_name === "public" &&
    testUsageBodyAclManifest.some((entry) => entry.objectName === row.object_name);
  if (!fixedObject) return [];

  const arms: TestUsageBodyAclSelectionArm[] = [];
  if (
    testSystemWideAclRecipients.some(
      (recipientName) => recipientName === row.grantee_name
    )
  ) {
    arms.push("system-wide-recipient");
  }
  if (
    testTargetAsGrantorRoles.some(
      (targetRoleName) => targetRoleName === row.grantor_name
    )
  ) {
    arms.push("target-as-grantor");
  }
  if (
    row.grantor_name === observedGrantorName
  ) {
    arms.push("observed-grantor");
  }
  return arms;
}

function testLocalUsageBodyAclSelectionArms(
  row: TestUsageBodyAclCatalogRow,
  observedGrantorName = testFixtureSessionRole
): TestUsageBodyAclSelectionArm[] {
  const fixedObject =
    row.object_kind === "table" &&
    row.schema_name === "public" &&
    testUsageBodyAclManifest.some((entry) => entry.objectName === row.object_name);
  if (!fixedObject) return [];

  if (testLocalIsExactOwnerSelfAcl(row)) return [];

  return testLocalUsageBodyAclSemanticUnionArms(row, observedGrantorName);
}

function testLocalSelectedUsageBodyAclRows(
  rows: TestUsageBodyAclCatalogRow[],
  observedGrantorName = testFixtureSessionRole
) {
  return rows.filter(
    (row) =>
      testLocalUsageBodyAclSelectionArms(row, observedGrantorName).length > 0
  );
}

function testLocalUsageBodyAclDependencyCounts(
  row: TestUsageBodyAclCatalogRow,
  dependencies: TestUsageBodyAclDependencyCatalogRow[]
) {
  const matchingDependencies = dependencies.filter(
    (dependency) =>
      dependency.dependency_type === "a" &&
      dependency.database_boundary === "current" &&
      dependency.class_boundary === "relation" &&
      dependency.object_name === row.object_name
  );
  return {
    grantee_dependency_count: matchingDependencies.filter(
      (dependency) => dependency.role_name === row.grantee_name
    ).length,
    grantor_dependency_count: matchingDependencies.filter(
      (dependency) => dependency.role_name === row.grantor_name
    ).length,
  };
}

function materializeTestUsageBodyAclCatalogRow(
  row: TestUsageBodyAclCatalogRow,
  dependencies: TestUsageBodyAclDependencyCatalogRow[]
): TestUsageBodyAclRow {
  const dependencyCounts = testLocalUsageBodyAclDependencyCounts(row, dependencies);
  return {
    authority_kind: "explicit_acl",
    recipient_relation:
      row.grantee_name === testUsageBodyAclRoles.explicit
        ? "explicit_direct"
        : row.grantee_name === testUsageBodyAclRoles.group
          ? "membership_group_direct"
          : "unexpected",
    grantor_name: row.grantor_name,
    grantee_name: row.grantee_name,
    object_kind: row.object_kind,
    schema_name: row.schema_name,
    object_name: row.object_name,
    privilege_type: row.privilege_type,
    grant_option: row.grant_option,
    ...dependencyCounts,
  };
}

function testUsageBodyAclDependencyCatalogRow(
  overrides: Partial<TestUsageBodyAclDependencyCatalogRow> = {}
): TestUsageBodyAclDependencyCatalogRow {
  return {
    physical_key: "fixed-dependency-row",
    role_name: testUsageBodyAclRoles.explicit,
    object_name: "users",
    dependency_type: "a",
    database_boundary: "current",
    class_boundary: "relation",
    ...overrides,
  };
}

function testUsageBodyAclOwnerForObject(
  objectName: string,
  objectOwners: TestUsageBodyAclObjectOwner[] = testUsageBodyAclObjectOwners
) {
  const matches = objectOwners.filter(
    (entry) =>
      entry.object_kind === "table" &&
      entry.schema_name === "public" &&
      entry.object_name === objectName
  );
  expect(matches).toHaveLength(1);
  return matches[0].owner_name;
}

function testUsageBodyAclOwnerDefaultCatalogRows(
  objectOwners: TestUsageBodyAclObjectOwner[] = testUsageBodyAclObjectOwners
): TestUsageBodyAclCatalogRow[] {
  return objectOwners.flatMap((entry, objectIndex) =>
    testPostgreSql18TableOwnerPrivileges.map((privilegeType) =>
      testUsageBodyAclCatalogRow({
        physical_key: `owner-default-${objectIndex}-${privilegeType}`,
        owner_name: entry.owner_name,
        grantor_name: entry.owner_name,
        grantee_name: entry.owner_name,
        object_kind: entry.object_kind,
        schema_name: entry.schema_name,
        object_name: entry.object_name,
        privilege_type: privilegeType,
      })
    )
  );
}

function testUsageBodyAclTemporaryCatalogRows(
  objectOwners: TestUsageBodyAclObjectOwner[] = testUsageBodyAclObjectOwners,
  grantorName = testFixtureSessionRole
): TestUsageBodyAclCatalogRow[] {
  return validTestUsageBodyAclRows({ grantorName }).map((row, index) =>
    testUsageBodyAclCatalogRow({
      physical_key: `temporary-acl-${index}`,
      owner_name: testUsageBodyAclOwnerForObject(row.object_name, objectOwners),
      grantor_name: row.grantor_name,
      grantee_name: row.grantee_name,
      object_kind: row.object_kind,
      schema_name: row.schema_name,
      object_name: row.object_name,
      privilege_type: row.privilege_type,
      grant_option: row.grant_option,
    })
  );
}

function testUsageBodyAclDefaultCatalogDependencies(
  rows: TestUsageBodyAclCatalogRow[]
): TestUsageBodyAclDependencyCatalogRow[] {
  const dependencies = new Map<string, TestUsageBodyAclDependencyCatalogRow>();
  for (const row of rows) {
    for (const [side, roleName] of [
      ["grantee", row.grantee_name],
      ["grantor", row.grantor_name],
    ] as const) {
      const key = `${row.object_name}:${roleName}`;
      if (!dependencies.has(key)) {
        dependencies.set(
          key,
          testUsageBodyAclDependencyCatalogRow({
            physical_key: `${side}-dependency-${dependencies.size}`,
            role_name: roleName,
            object_name: row.object_name,
          })
        );
      }
    }
  }
  return [...dependencies.values()];
}

function testUsageBodyAclCatalogInventoryRows({
  rows,
  dependencies,
  observedGrantorName = testFixtureSessionRole,
}: {
  rows: TestUsageBodyAclCatalogRow[];
  dependencies: TestUsageBodyAclDependencyCatalogRow[];
  observedGrantorName?: string;
}) {
  return sortTestUsageBodyAclRows(
    testLocalSelectedUsageBodyAclRows(rows, observedGrantorName).map((row) =>
      materializeTestUsageBodyAclCatalogRow(row, dependencies)
    )
  );
}

type UsageBodyAclFakeOptions = {
  grantedRows?: TestUsageBodyAclRow[];
  executionRows?: TestUsageBodyAclRow[];
  postRevokeRows?: TestUsageBodyAclRow[];
  rawGrantedCatalogRows?: TestUsageBodyAclCatalogRow[];
  rawPostRevokeCatalogRows?: TestUsageBodyAclCatalogRow[];
  rawPostRevokeCatalogSnapshot?: TestUsageBodyAclCatalogRow[];
  rawCatalogDependencies?: TestUsageBodyAclDependencyCatalogRow[];
  objectOwners?: TestUsageBodyAclObjectOwner[];
  schemaUsageRecipients?: string[];
  functionExecuteRecipients?: string[];
  explicitResultRows?: Array<Record<string, unknown>>;
  membershipResultRows?: Array<Record<string, unknown>>;
  rejectOnLabel?: string | null;
  hangOnLabel?: string | null;
  grantIdentityRows?: Array<Record<string, unknown>>;
  revokeIdentityRows?: Array<Record<string, unknown>>;
  unrelatedAuthorityRows?: Array<Record<string, unknown>>;
  grantInventoryResultRows?: unknown;
  grantInventoryNormalizerFailure?: boolean;
  inventoryClientScenario?:
    | "factory-throws"
    | "factory-invalid"
    | "connect-rejects"
    | "connect-hangs"
    | "close-rejects"
    | "close-hangs";
};

function createUsageBodyAclFakeHarness(options: UsageBodyAclFakeOptions = {}) {
  const hasGrantedRowsOverride = Object.prototype.hasOwnProperty.call(
    options,
    "grantedRows"
  );
  const grantedRows = options.grantedRows ?? validTestUsageBodyAclRows();
  const executionRows = options.executionRows ?? grantedRows;
  const postRevokeRows = options.postRevokeRows ?? [];
  const objectOwners = (options.objectOwners ?? testUsageBodyAclObjectOwners).map(
    (entry) => ({ ...entry })
  );
  const defaultTemporaryCatalogRows = testUsageBodyAclTemporaryCatalogRows(
    objectOwners
  );
  const initialOwnerCatalogRows =
    testUsageBodyAclOwnerDefaultCatalogRows(objectOwners);
  const rawGrantedCatalogRows = (
    options.rawGrantedCatalogRows ?? [
      ...initialOwnerCatalogRows,
      ...defaultTemporaryCatalogRows,
    ]
  ).map((row) => ({ ...row }));
  const rawPostRevokeCatalogRows = (
    options.rawPostRevokeCatalogRows ?? []
  ).map((row) => ({ ...row }));
  const rawPostRevokeCatalogSnapshot =
    options.rawPostRevokeCatalogSnapshot?.map((row) => ({ ...row })) ?? null;
  const rawCatalogDependencies = (
    options.rawCatalogDependencies ??
    testUsageBodyAclDefaultCatalogDependencies(defaultTemporaryCatalogRows)
  ).map((row) => ({ ...row }));
  const schemaUsageRecipients = options.schemaUsageRecipients ?? [
    testUsageBodyAclRoles.explicit,
    testUsageBodyAclRoles.group,
    testUsageBodyAclRoles.denied,
    testUsageBodyAclRoles.publicProbe,
  ];
  const functionExecuteRecipients = options.functionExecuteRecipients ?? [
    testUsageBodyAclRoles.explicit,
    testUsageBodyAclRoles.group,
  ];
  const explicitResultRows = options.explicitResultRows ?? [{ allowed: false }];
  const membershipResultRows = options.membershipResultRows ?? [{ allowed: false }];
  const rejectOnLabel = options.rejectOnLabel ?? null;
  const hangOnLabel = options.hangOnLabel ?? null;
  const grantIdentityRows =
    options.grantIdentityRows ?? validObservedSessionIdentityRows();
  const revokeIdentityRows =
    options.revokeIdentityRows ?? validObservedSessionIdentityRows();
  const unrelatedAuthorityRows = options.unrelatedAuthorityRows ?? [
    { fixed_unrelated_authority: true },
  ];
  const hasGrantInventoryResultRows = Object.prototype.hasOwnProperty.call(
    options,
    "grantInventoryResultRows"
  );
  const grantInventoryNormalizerFailure =
    options.grantInventoryNormalizerFailure === true;
  const inventoryClientScenario = options.inventoryClientScenario ?? null;
  const state = {
    aclRows: [] as TestUsageBodyAclRow[],
    rawAclCatalogRows: initialOwnerCatalogRows.map((row) => ({ ...row })),
    objectOwners,
    inventorySnapshots: [] as Array<{
      rawCount: number;
      ownerSelfCount: number;
      filteredCount: number;
    }>,
    ownerAclMutationCount: 0,
    ownerAclRevokeStatementCount: 0,
    ownerAclMultisetMismatchCount: 0,
    ownerAclMultisetSnapshots: [
      {
        phase: "before-grant",
        keys: testLocalActualUsageBodyAclOwnerRowKeys(initialOwnerCatalogRows),
      },
    ] as Array<{ phase: string; keys: string[] }>,
    queryLog: [] as Array<{
      statement: string;
      parameters: unknown;
      separateParameters: unknown;
      queryConfigValues: unknown;
      label: string;
    }>,
    unrelatedAuthorityRows: unrelatedAuthorityRows.map((row) => ({ ...row })),
    grantAttemptCount: 0,
    exactGrantCount: 0,
    revokeAttemptCount: 0,
    exactRevokeCount: 0,
    inventoryCount: 0,
    executionCount: 0,
    connectCount: 0,
    factoryCount: 0,
    endCount: 0,
    destroyCount: 0,
    grantIdentityQueryCount: 0,
    revokeIdentityQueryCount: 0,
    zeroResidueInventoryCount: 0,
    clients: [] as Array<{
      connect: number;
      end: number;
      destroy: number;
      queryLabels: string[];
    }>,
  };

  function currentRawCatalogInventoryRows() {
    return testUsageBodyAclCatalogInventoryRows({
      rows: state.rawAclCatalogRows,
      dependencies: rawCatalogDependencies,
    });
  }

  function hasCompleteBodyAuthority(granteeName: string) {
    return (
      schemaUsageRecipients.includes(granteeName) &&
      functionExecuteRecipients.includes(granteeName) &&
      testUsageBodyAclManifest.every((entry) =>
        entry.privileges.every((privilegeType) =>
          executionRows.some(
            (row) =>
              row.authority_kind === "explicit_acl" &&
              row.grantee_name === granteeName &&
              row.object_kind === "table" &&
              row.schema_name === "public" &&
              row.object_name === entry.objectName &&
              row.privilege_type === privilegeType &&
              row.grant_option === false &&
              row.grantee_dependency_count === 1 &&
              row.grantor_dependency_count === 1
          )
        )
      )
    );
  }

  function createClient() {
    const clientOrdinal = state.clients.length + 1;
    let activeRole = testFixtureSessionRole;
    let destroyed = false;
    const clientState = {
      connect: 0,
      end: 0,
      destroy: 0,
      queryLabels: [] as string[],
    };
    state.clients.push(clientState);
    return {
      connection: {
        stream: {
          destroy() {
            if (!destroyed) state.destroyCount += 1;
            if (!destroyed) clientState.destroy += 1;
            destroyed = true;
          },
        },
      },
      connect() {
        state.connectCount += 1;
        clientState.connect += 1;
        if (clientOrdinal === 2 && inventoryClientScenario === "connect-rejects") {
          return Promise.reject(new Error("fixed-sensitive-connect-rejection"));
        }
        if (clientOrdinal === 2 && inventoryClientScenario === "connect-hangs") {
          return new Promise(() => undefined);
        }
        return Promise.resolve();
      },
      query(
        statementOrConfiguration: string | { text: string; values?: unknown[] },
        parameters: unknown[] | string = []
      ) {
        const statement =
          typeof statementOrConfiguration === "string"
            ? statementOrConfiguration
            : statementOrConfiguration.text;
        const queryConfigValues =
          typeof statementOrConfiguration === "string"
            ? undefined
            : statementOrConfiguration.values;
        const effectiveParameters =
          typeof statementOrConfiguration === "string"
            ? parameters
            : Array.isArray(statementOrConfiguration.values)
              ? statementOrConfiguration.values
              : parameters;
        const normalized = normalizeExactRevokeSql(statement);
        let label = "other";
        let exactGrantMatched = false;
        let exactRevokeMatched = false;
        if (
          normalized === normalizeExactRevokeSql(exactUsageBodyAclIdentityContract)
        ) {
          const identityOrdinal =
            state.grantIdentityQueryCount + state.revokeIdentityQueryCount;
          if (identityOrdinal === 0) {
            label = "body-acl-grant-identity";
            state.grantIdentityQueryCount += 1;
          } else {
            label = "body-acl-revoke-identity";
            state.revokeIdentityQueryCount += 1;
          }
        } else if (normalized.startsWith("GRANT ")) {
          label = "body-acl-grant";
          state.grantAttemptCount += 1;
          if (
            typeof statementOrConfiguration === "string" &&
            normalized === normalizeExactRevokeSql(exactUsageBodyAclGrantContract) &&
            Array.isArray(parameters) &&
            parameters.length === 0
          ) {
            label = "body-acl-grant-exact";
            exactGrantMatched = true;
          }
        } else if (normalized.startsWith("REVOKE ")) {
          label = "body-acl-revoke";
          state.revokeAttemptCount += 1;
          if (normalized.includes(`"${testUsageBodyAclFixedObjectOwner}"`)) {
            state.ownerAclRevokeStatementCount += 1;
          }
          if (
            typeof statementOrConfiguration === "string" &&
            normalized === normalizeExactRevokeSql(exactUsageBodyAclRevokeContract) &&
            Array.isArray(parameters) &&
            parameters.length === 0
          ) {
            label = "body-acl-revoke-exact";
            exactRevokeMatched = true;
          }
        } else if (
          statement.includes("target_objects(object_name, ordinal)") &&
          statement.includes("grantee_dependency_count") &&
          statement.includes("grantor_dependency_count")
        ) {
          label = "body-acl-inventory";
          state.inventoryCount += 1;
          if (
            JSON.stringify(effectiveParameters) !==
            JSON.stringify([
              [...testUsageBodyAclInventoryRoleScope],
              testFixtureSessionRole,
            ])
          ) {
            return Promise.reject(new Error("fixed-body-acl-parameter-mismatch"));
          }
        } else if (normalized === "BEGIN") {
          label = "begin";
        } else if (normalized === "ROLLBACK") {
          label = "rollback";
        } else if (normalized.startsWith("SET LOCAL ROLE ")) {
          label = "set-role";
          const roleMatch = normalized.match(/^SET LOCAL ROLE "([a-z0-9_]+)"$/);
          activeRole = roleMatch?.[1] ?? "invalid_role";
        } else if (
          normalized ===
            normalizeExactRevokeSql(exactMissingUserUsageExecutionContract) ||
          normalized === normalizeExactRevokeSql(exactDeniedUsageExecutionContract)
        ) {
          label = "missing-user-execution";
          state.executionCount += 1;
        }
        state.queryLog.push({
          statement,
          parameters: Array.isArray(effectiveParameters)
            ? [...effectiveParameters]
            : effectiveParameters,
          separateParameters: Array.isArray(parameters)
            ? [...parameters]
            : parameters,
          queryConfigValues: Array.isArray(queryConfigValues)
            ? [...queryConfigValues]
            : queryConfigValues,
          label,
        });
        clientState.queryLabels.push(label);
        if (label === hangOnLabel) return new Promise(() => undefined);
        if (label === rejectOnLabel) {
          return Promise.reject(new Error("fixed-body-acl-failure"));
        }
        if (exactGrantMatched) {
          state.exactGrantCount += 1;
          state.rawAclCatalogRows = rawGrantedCatalogRows.map((row) => ({ ...row }));
          const ownerKeys = testLocalActualUsageBodyAclOwnerRowKeys(
            state.rawAclCatalogRows
          );
          state.ownerAclMultisetSnapshots.push({
            phase: "post-grant",
            keys: ownerKeys,
          });
          if (
            ownerKeys.length !==
              state.ownerAclMultisetSnapshots[0].keys.length ||
            ownerKeys.some(
              (key, index) =>
                key !== state.ownerAclMultisetSnapshots[0].keys[index]
            )
          ) {
            state.ownerAclMultisetMismatchCount += 1;
          }
          state.aclRows = hasGrantedRowsOverride
            ? grantedRows.map((row) => ({ ...row }))
            : currentRawCatalogInventoryRows();
        }
        if (exactRevokeMatched) {
          state.exactRevokeCount += 1;
          state.ownerAclMutationCount += state.rawAclCatalogRows.filter(
            (row) =>
              testLocalIsExactOwnerSelfAcl(row) &&
              testLocalIsExactTemporaryUsageBodyAcl(row)
          ).length;
          state.rawAclCatalogRows = state.rawAclCatalogRows.filter(
            (row) => !testLocalIsExactTemporaryUsageBodyAcl(row)
          );
          state.rawAclCatalogRows.push(
            ...rawPostRevokeCatalogRows.map((row) => ({ ...row }))
          );
          if (rawPostRevokeCatalogSnapshot !== null) {
            state.rawAclCatalogRows = rawPostRevokeCatalogSnapshot.map((row) => ({
              ...row,
            }));
          }
          const ownerKeys = testLocalActualUsageBodyAclOwnerRowKeys(
            state.rawAclCatalogRows
          );
          state.ownerAclMultisetSnapshots.push({
            phase: "post-revoke",
            keys: ownerKeys,
          });
          if (
            ownerKeys.length !==
              state.ownerAclMultisetSnapshots[0].keys.length ||
            ownerKeys.some(
              (key, index) =>
                key !== state.ownerAclMultisetSnapshots[0].keys[index]
            )
          ) {
            state.ownerAclMultisetMismatchCount += 1;
          }
          state.aclRows = hasGrantedRowsOverride
            ? state.aclRows.filter(
                (row) =>
                  !(
                    row.authority_kind === "explicit_acl" &&
                    row.grantor_name === testFixtureSessionRole &&
                    testUsageBodyAclRecipients.some(
                      (recipient) => recipient === row.grantee_name
                    ) &&
                    testUsageBodyAclManifest.some(
                      (entry) =>
                        entry.objectName === row.object_name &&
                        entry.privileges.some(
                          (privilege) => privilege === row.privilege_type
                        )
                    )
                  )
              )
            : currentRawCatalogInventoryRows();
          state.aclRows.push(...postRevokeRows.map((row) => ({ ...row })));
        }
        if (label === "body-acl-inventory") {
          if (
            !testLocalNormalBodyObjectOwnerAuthorityIsDistinct(objectOwners) ||
            !testLocalOwnerAclMultisetMatches(
              state.rawAclCatalogRows,
              objectOwners
            )
          ) {
            return Promise.reject(
              new Error("fixed-owner-acl-catalog-contract-mismatch")
            );
          }
          state.inventorySnapshots.push({
            rawCount: state.rawAclCatalogRows.length,
            ownerSelfCount: state.rawAclCatalogRows.filter(
              testLocalIsExactOwnerSelfAcl
            ).length,
            filteredCount: state.aclRows.length,
          });
          if (state.revokeIdentityQueryCount > 0) {
            state.zeroResidueInventoryCount += 1;
          }
          if (state.revokeIdentityQueryCount === 0 && grantInventoryNormalizerFailure) {
            const normalizationFailureRow = {
              ...validTestUsageBodyAclRows()[0],
            };
            Object.defineProperty(normalizationFailureRow, "object_name", {
              enumerable: true,
              get() {
                throw new Error("fixed-sensitive-normalization-failure");
              },
            });
            return Promise.resolve({ rows: [normalizationFailureRow] });
          }
          if (state.revokeIdentityQueryCount === 0 && hasGrantInventoryResultRows) {
            return Promise.resolve({ rows: options.grantInventoryResultRows });
          }
          return Promise.resolve({ rows: state.aclRows.map((row) => ({ ...row })) });
        }
        if (label === "body-acl-grant-identity") {
          return Promise.resolve({
            rows: grantIdentityRows.map((row) => ({ ...row })),
          });
        }
        if (label === "body-acl-revoke-identity") {
          return Promise.resolve({
            rows: revokeIdentityRows.map((row) => ({ ...row })),
          });
        }
        if (label === "missing-user-execution") {
          if (
            JSON.stringify(effectiveParameters) !==
            JSON.stringify([...exactMissingUserUsageExecutionParameters])
          ) {
            return Promise.reject({ code: "42501" });
          }
          const authorityGrantee =
            activeRole === testUsageBodyAclRoles.explicit
              ? testUsageBodyAclRoles.explicit
              : activeRole === testUsageBodyAclRoles.member
                ? testUsageBodyAclRoles.group
                : null;
          if (
            normalized === normalizeExactRevokeSql(exactDeniedUsageExecutionContract)
          ) {
            return Promise.reject({ code: "42501" });
          }
          if (
            authorityGrantee === null ||
            !hasCompleteBodyAuthority(authorityGrantee)
          ) {
            return Promise.reject({ code: "42501" });
          }
          return Promise.resolve({
            rows:
              activeRole === testUsageBodyAclRoles.explicit
                ? explicitResultRows
                : membershipResultRows,
          });
        }
        return Promise.resolve({ rows: [] });
      },
      end() {
        state.endCount += 1;
        clientState.end += 1;
        if (clientOrdinal === 2 && inventoryClientScenario === "close-rejects") {
          return Promise.reject(new Error("fixed-sensitive-close-rejection"));
        }
        if (clientOrdinal === 2 && inventoryClientScenario === "close-hangs") {
          return new Promise(() => undefined);
        }
        return Promise.resolve();
      },
    };
  }

  return {
    state,
    clientFactory: () => {
      state.factoryCount += 1;
      if (state.factoryCount === 2 && inventoryClientScenario === "factory-throws") {
        throw new Error("fixed-sensitive-factory-rejection");
      }
      if (state.factoryCount === 2 && inventoryClientScenario === "factory-invalid") {
        return Object.freeze({ invalid: true });
      }
      return createClient();
    },
  };
}

const testRepositoryTables = [
  "analysis_runs",
  "improvement_actions",
  "oauth_accounts",
  "plans",
  "usage_reservation_leases",
  "user_plan_assignments",
  "user_usage_buckets",
  "users",
] as const;
const testRepositoryIndexes = [
  "analysis_runs_id_user_unique",
  "analysis_runs_pkey",
  "analysis_runs_user_analyzed_idx",
  "improvement_actions_analysis_run_unique",
  "improvement_actions_one_planned_per_user",
  "improvement_actions_pkey",
  "improvement_actions_user_updated_idx",
  "oauth_accounts_pkey",
  "oauth_accounts_provider_account_unique",
  "oauth_accounts_user_id_idx",
  "plans_pkey",
  "usage_reservation_leases_created_at_idx",
  "usage_reservation_leases_pkey",
  "usage_reservation_leases_user_metric_idx",
  "user_plan_assignments_one_active_per_user",
  "user_plan_assignments_pkey",
  "user_plan_assignments_plan_code_idx",
  "user_usage_buckets_period_start_idx",
  "user_usage_buckets_pkey",
  "user_usage_buckets_scope_unique",
  "users_pkey",
  "users_status_idx",
] as const;
const testRepositoryEnums = [
  "improvement_action_status",
  "plan_assignment_source",
  "plan_assignment_status",
  "usage_metric",
  "usage_period_kind",
  "user_status",
] as const;
const testCanonicalFunctions = [
  {
    name: "finalize_ai_consult_reservation",
    identity:
      "p_reservation_id uuid, p_user_id uuid, p_analysis_run_id uuid, p_ai_consult_snapshot jsonb, p_created_at timestamp with time zone",
  },
  {
    name: "finalize_channel_analysis_reservation",
    identity:
      "p_reservation_id uuid, p_user_id uuid, p_channel_id character varying, p_channel_title character varying, p_analysis_snapshot jsonb, p_regular_video_count integer, p_short_video_count integer, p_regular_average_views bigint, p_short_average_views bigint, p_analyzed_at timestamp with time zone",
  },
  {
    name: "finalize_usage_reservation",
    identity: "p_reservation_id uuid, p_user_id uuid",
  },
  {
    name: "get_usage_status_v1",
    identity:
      "p_user_id uuid, p_session_version integer, p_now timestamp with time zone",
  },
  {
    name: "recover_stale_usage_reservations",
    identity:
      "p_stale_before timestamp with time zone, p_batch_size integer",
  },
  {
    name: "release_usage_limits",
    identity: "p_reservation_id uuid, p_user_id uuid",
  },
  {
    name: "reserve_usage_limits",
    identity:
      "p_user_id uuid, p_session_version integer, p_metric usage_metric, p_now timestamp with time zone",
  },
  {
    name: "reserve_usage_limits_v2",
    identity:
      "p_user_id uuid, p_session_version integer, p_metric usage_metric, p_now timestamp with time zone",
  },
  {
    name: "resolve_effective_usage_plan_v1",
    identity: "p_user_id uuid, p_now timestamp with time zone",
  },
  {
    name: "sync_google_oauth_account",
    identity:
      "p_provider_account_id character varying, p_email character varying, p_name character varying, p_image_url character varying, p_granted_scope text, p_seen_at timestamp with time zone",
  },
  {
    name: "usage_period_boundaries_v1",
    identity: "p_now timestamp with time zone",
  },
] as const;
const testLegacyOwnedFunctionNames = new Set([
  "get_usage_status_v1",
  "reserve_usage_limits",
  "reserve_usage_limits_v2",
  "resolve_effective_usage_plan_v1",
  "usage_period_boundaries_v1",
]);

type TestOwnershipRow = {
  object_kind: string;
  schema_name: string | null;
  object_name: string;
  function_identity: string | null;
  owner_name: string;
};

type TestTemporaryAuthorityRow = {
  authority_kind: string;
  role_name: string;
  role_relation: string | null;
  grantor_name: string | null;
  grantee_name: string | null;
  object_kind: string;
  schema_name: string | null;
  object_name: string;
  column_name: string | null;
  function_identity: string | null;
  privilege_type: string;
  grant_option: boolean;
  granted_role: string | null;
  inherit_option: boolean | null;
  set_option: boolean | null;
};

function sortTestOwnershipRows(rows: TestOwnershipRow[]) {
  const keys = [
    "object_kind",
    "schema_name",
    "object_name",
    "function_identity",
    "owner_name",
  ] as const;
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const comparison = String(left[key] ?? "").localeCompare(
        String(right[key] ?? "")
      );
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

function sortTestTemporaryAuthorityRows(rows: TestTemporaryAuthorityRow[]) {
  const keys = [
    "authority_kind",
    "role_name",
    "role_relation",
    "grantor_name",
    "grantee_name",
    "object_kind",
    "schema_name",
    "object_name",
    "column_name",
    "function_identity",
    "privilege_type",
    "grant_option",
    "granted_role",
    "inherit_option",
    "set_option",
  ] as const;
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const comparison = String(left[key] ?? "").localeCompare(
        String(right[key] ?? "")
      );
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

function testTemporaryAuthorityRow(
  overrides: Partial<TestTemporaryAuthorityRow>
): TestTemporaryAuthorityRow {
  const authorityKind = overrides.authority_kind ?? "explicit_acl";
  const roleName = overrides.role_name ?? testMigrationExecutor;
  const isExplicitAcl = authorityKind === "explicit_acl";
  return {
    authority_kind: authorityKind,
    role_name: roleName,
    role_relation: isExplicitAcl ? "grantee" : null,
    grantor_name: isExplicitAcl ? testActualAclGrantorRole : null,
    grantee_name: isExplicitAcl ? roleName : null,
    object_kind: "schema",
    schema_name: null,
    object_name: "fixed_object",
    column_name: null,
    function_identity: null,
    privilege_type: "USAGE",
    grant_option: false,
    granted_role: null,
    inherit_option: null,
    set_option: null,
    ...overrides,
  };
}

function validTemporaryAuthorityRows(): TestTemporaryAuthorityRow[] {
  return sortTestTemporaryAuthorityRows([
    testTemporaryAuthorityRow({
      object_kind: "database",
      object_name: "actustube_ci_fixture",
      privilege_type: "CREATE",
    }),
    ...["CREATE", "USAGE"].map((privilege_type) =>
      testTemporaryAuthorityRow({
        schema_name: "public",
        object_name: "public",
        privilege_type,
      })
    ),
    ...["CREATE", "USAGE"].map((privilege_type) =>
      testTemporaryAuthorityRow({
        role_name: testLegacyOwner,
        schema_name: "public",
        object_name: "public",
        privilege_type,
      })
    ),
    ...["CREATE", "USAGE"].map((privilege_type) =>
      testTemporaryAuthorityRow({
        schema_name: "drizzle",
        object_name: "drizzle",
        privilege_type,
      })
    ),
    ...["INSERT", "SELECT"].map((privilege_type) =>
      testTemporaryAuthorityRow({
        object_kind: "table",
        schema_name: "drizzle",
        object_name: "__drizzle_migrations",
        privilege_type,
      })
    ),
    ...["SELECT", "USAGE"].map((privilege_type) =>
      testTemporaryAuthorityRow({
        object_kind: "sequence",
        schema_name: "drizzle",
        object_name: "__drizzle_migrations_id_seq",
        privilege_type,
      })
    ),
    testTemporaryAuthorityRow({
      authority_kind: "direct_membership",
      object_kind: "role",
      object_name: testLegacyOwner,
      privilege_type: "MEMBER",
      granted_role: testLegacyOwner,
      inherit_option: true,
      set_option: true,
    }),
    testTemporaryAuthorityRow({
      authority_kind: "recursive_membership",
      object_kind: "role",
      object_name: testLegacyOwner,
      privilege_type: "MEMBER",
      granted_role: testLegacyOwner,
    }),
    testTemporaryAuthorityRow({
      authority_kind: "effective_membership",
      object_kind: "role",
      object_name: testLegacyOwner,
      privilege_type: "USAGE",
      granted_role: testLegacyOwner,
    }),
  ]);
}

function grantorSideTemporaryAuthorityRow(
  overrides: Partial<TestTemporaryAuthorityRow>
): TestTemporaryAuthorityRow {
  return testTemporaryAuthorityRow({
    role_name: testMigrationExecutor,
    role_relation: "grantor",
    grantor_name: testMigrationExecutor,
    grantee_name: "unexpected_fixture_grantee",
    ...overrides,
  });
}

function uncoveredAclDependencyRow(
  overrides: Partial<TestTemporaryAuthorityRow> = {}
): TestTemporaryAuthorityRow {
  return testTemporaryAuthorityRow({
    authority_kind: "uncovered_acl_dependency",
    role_name: testMigrationExecutor,
    role_relation: null,
    grantor_name: null,
    grantee_name: null,
    object_kind: "unsupported_acl_dependency",
    schema_name: null,
    object_name: "pg_catalog.pg_class",
    column_name: null,
    function_identity: null,
    privilege_type: "ACL_DEPENDENCY",
    grant_option: false,
    granted_role: null,
    inherit_option: null,
    set_option: null,
    ...overrides,
  });
}

function validPreCanonicalOwnershipRows(): TestOwnershipRow[] {
  return sortTestOwnershipRows([
    ...testRepositoryTables.map((name) => ({
      object_kind: "table",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testMigrationExecutor,
    })),
    ...testRepositoryIndexes.map((name) => ({
      object_kind: "index",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testMigrationExecutor,
    })),
    ...testRepositoryEnums.map((name) => ({
      object_kind: "type",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testMigrationExecutor,
    })),
    ...testCanonicalFunctions.map((entry) => ({
      object_kind: "function",
      schema_name: "public",
      object_name: entry.name,
      function_identity: entry.identity,
      owner_name: testLegacyOwnedFunctionNames.has(entry.name)
        ? testLegacyOwner
        : testMigrationExecutor,
    })),
  ]);
}

function validPostCanonicalOwnershipRows(): TestOwnershipRow[] {
  return sortTestOwnershipRows([
    {
      object_kind: "database",
      schema_name: null,
      object_name: "current_database",
      function_identity: null,
      owner_name: testFixtureSessionRole,
    },
    ...["drizzle", "public"].map((name) => ({
      object_kind: "schema",
      schema_name: name,
      object_name: name,
      function_identity: null,
      owner_name: testFixtureSessionRole,
    })),
    ...testRepositoryTables.map((name) => ({
      object_kind: "table",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testFixtureSessionRole,
    })),
    {
      object_kind: "table",
      schema_name: "drizzle",
      object_name: "__drizzle_migrations",
      function_identity: null,
      owner_name: testFixtureSessionRole,
    },
    ...testRepositoryIndexes.map((name) => ({
      object_kind: "index",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testFixtureSessionRole,
    })),
    {
      object_kind: "index",
      schema_name: "drizzle",
      object_name: "__drizzle_migrations_pkey",
      function_identity: null,
      owner_name: testFixtureSessionRole,
    },
    {
      object_kind: "sequence",
      schema_name: "drizzle",
      object_name: "__drizzle_migrations_id_seq",
      function_identity: null,
      owner_name: testFixtureSessionRole,
    },
    ...testRepositoryEnums.map((name) => ({
      object_kind: "type",
      schema_name: "public",
      object_name: name,
      function_identity: null,
      owner_name: testFixtureSessionRole,
    })),
    ...testCanonicalFunctions.map((entry) => ({
      object_kind: "function",
      schema_name: "public",
      object_name: entry.name,
      function_identity: entry.identity,
      owner_name: testFixtureSessionRole,
    })),
  ]);
}

type OwnershipCanonicalizationFakeClientOptions = {
  initialIdentityRows?: Array<Record<string, unknown>>;
  initialIdentityReject?: boolean;
  initialIdentityHang?: boolean;
  cleanupIdentityRows?: Array<Record<string, unknown>>;
  cleanupIdentityReject?: boolean;
  cleanupIdentityHang?: boolean;
  preRows?: TestOwnershipRow[];
  postRows?: TestOwnershipRow[];
  maintenanceRows?: TestOwnershipRow[];
  preAuthorityRows?: TestTemporaryAuthorityRow[];
  postAuthorityRows?: TestTemporaryAuthorityRow[] | null;
  rejectOwnerChangeAt?: number | null;
  hangOwnerChangeAt?: number | null;
  hangOnSnapshot?: boolean;
  hangOnMaintenanceSnapshot?: boolean;
  rejectOnCleanupLabel?: string | null;
  hangOnCleanupLabel?: string | null;
  skipCleanupLabel?: string | null;
  cleanupStatementOverrides?: Partial<Record<ExactRevokeLabel, string>>;
  cleanupParameterOverrides?: Partial<Record<ExactRevokeLabel, unknown[]>>;
  hangOnAuthorityInventoryAt?: number | null;
  events?: string[];
};

function createOwnershipCanonicalizationFakeClient(
  {
    initialIdentityRows = validObservedSessionIdentityRows(),
    initialIdentityReject = false,
    initialIdentityHang = false,
    cleanupIdentityRows = validObservedSessionIdentityRows({
      sessionRole: testCleanupObservedSessionRole,
      effectiveRole: testCleanupObservedCurrentRole,
    }),
    cleanupIdentityReject = false,
    cleanupIdentityHang = false,
    preRows = validPreCanonicalOwnershipRows(),
    postRows = validPostCanonicalOwnershipRows(),
    maintenanceRows,
    preAuthorityRows = validTemporaryAuthorityRows(),
    postAuthorityRows = null as TestTemporaryAuthorityRow[] | null,
    rejectOwnerChangeAt = null as number | null,
    hangOwnerChangeAt = null as number | null,
    hangOnSnapshot = false,
    hangOnMaintenanceSnapshot = false,
    rejectOnCleanupLabel = null as string | null,
    hangOnCleanupLabel = null as string | null,
    skipCleanupLabel = null as string | null,
    cleanupStatementOverrides = {} as Partial<Record<ExactRevokeLabel, string>>,
    cleanupParameterOverrides = {} as Partial<
      Record<ExactRevokeLabel, unknown[]>
    >,
    hangOnAuthorityInventoryAt = null as number | null,
    events = [] as string[],
  }: OwnershipCanonicalizationFakeClientOptions = {}
) {
  const initialIdentity = createObservedSessionIdentityFakeClient({
    rows: initialIdentityRows,
    reject: initialIdentityReject,
    hang: initialIdentityHang,
  });
  const effectiveMaintenanceRows = maintenanceRows ?? postRows;
  const state = {
    connect: 0,
    query: [] as string[],
    parameters: [] as unknown[][],
    labels: [] as string[],
    ownerChanges: [] as string[],
    cleanup: [] as string[],
    preCanonicalInventoryCount: 0,
    snapshotCount: 0,
    cleanupIdentityCount: 0,
    authorityInventoryCount: 0,
    authorityRows: [...preAuthorityRows],
    end: 0,
    destroy: 0,
    queriesAtDestroy: null as number | null,
  };
  const client = {
    connection: {
      stream: {
        destroy() {
          state.destroy += 1;
          state.queriesAtDestroy = state.query.length;
        },
      },
    },
    connect() {
      state.connect += 1;
      return Promise.resolve();
    },
    query(statement: string, parameters: unknown[] = []) {
      const originalRevokeLabel = exactRevokeQueryLabel(statement, parameters);
      const executedStatement = originalRevokeLabel
        ? cleanupStatementOverrides[originalRevokeLabel] ?? statement
        : statement;
      const executedParameters = originalRevokeLabel
        ? cleanupParameterOverrides[originalRevokeLabel] ?? parameters
        : parameters;
      state.query.push(executedStatement);
      state.parameters.push(executedParameters);
      const label = ownerBoundaryQueryLabel(
        executedStatement,
        executedParameters
      );
      state.labels.push(label);
      events.push(label);
      if (label === "pre-canonical-inventory") {
        state.preCanonicalInventoryCount += 1;
        return Promise.resolve({ rows: preRows });
      }
      if (label === "post-canonical-snapshot") {
        state.snapshotCount += 1;
        const shouldHang =
          (state.snapshotCount === 1 && hangOnSnapshot) ||
          (state.snapshotCount === 2 && hangOnMaintenanceSnapshot);
        return shouldHang
          ? new Promise(() => undefined)
          : Promise.resolve({
              rows:
                state.snapshotCount === 1
                  ? postRows
                  : effectiveMaintenanceRows,
            });
      }
      if (label === "observed-session-identity") {
        state.cleanupIdentityCount += 1;
        if (cleanupIdentityHang) return new Promise(() => undefined);
        if (cleanupIdentityReject) {
          return Promise.reject(new Error("fixed-cleanup-identity-failure"));
        }
        return Promise.resolve({ rows: cleanupIdentityRows });
      }
      if (label === "canonical-owner-change") {
        state.ownerChanges.push(executedStatement);
        if (state.ownerChanges.length === hangOwnerChangeAt) {
          return new Promise(() => undefined);
        }
        if (state.ownerChanges.length === rejectOwnerChangeAt) {
          return Promise.reject(new Error("fixed-canonicalization-failure"));
        }
      }
      if (label === "temporary-authority-inventory") {
        state.authorityInventoryCount += 1;
        if (state.authorityInventoryCount === hangOnAuthorityInventoryAt) {
          return new Promise(() => undefined);
        }
        return Promise.resolve({
          rows:
            state.authorityInventoryCount === 1
              ? preAuthorityRows
              : postAuthorityRows ?? state.authorityRows,
        });
      }
      if (label.startsWith("revoke-")) {
        state.cleanup.push(label);
        if (label === hangOnCleanupLabel) return new Promise(() => undefined);
        if (label === rejectOnCleanupLabel) {
          return Promise.reject(new Error("fixed-cleanup-failure"));
        }
        if (label !== skipCleanupLabel) {
          state.authorityRows = state.authorityRows.filter((row) => {
            if (label === "revoke-database-create") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testMigrationExecutor &&
                row.role_relation === "grantee" &&
                row.grantor_name === testActualAclGrantorRole &&
                row.grantee_name === testMigrationExecutor &&
                row.object_kind === "database" &&
                row.object_name === "actustube_ci_fixture" &&
                row.privilege_type === "CREATE"
              );
            }
            if (label === "revoke-public-executor") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testMigrationExecutor &&
                row.role_relation === "grantee" &&
                row.grantor_name === testActualAclGrantorRole &&
                row.grantee_name === testMigrationExecutor &&
                row.object_kind === "schema" &&
                row.schema_name === "public" &&
                row.object_name === "public" &&
                ["CREATE", "USAGE"].includes(row.privilege_type)
              );
            }
            if (label === "revoke-public-legacy") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testLegacyOwner &&
                row.role_relation === "grantee" &&
                row.grantor_name === testActualAclGrantorRole &&
                row.grantee_name === testLegacyOwner &&
                row.object_kind === "schema" &&
                row.schema_name === "public" &&
                row.object_name === "public" &&
                ["CREATE", "USAGE"].includes(row.privilege_type)
              );
            }
            if (label === "revoke-drizzle-executor") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testMigrationExecutor &&
                row.role_relation === "grantee" &&
                row.grantor_name === testActualAclGrantorRole &&
                row.grantee_name === testMigrationExecutor &&
                row.object_kind === "schema" &&
                row.schema_name === "drizzle" &&
                row.object_name === "drizzle" &&
                ["CREATE", "USAGE"].includes(row.privilege_type)
              );
            }
            if (label === "revoke-ledger-table") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testMigrationExecutor &&
                row.role_relation === "grantee" &&
                row.grantor_name === testActualAclGrantorRole &&
                row.grantee_name === testMigrationExecutor &&
                row.object_kind === "table" &&
                row.schema_name === "drizzle" &&
                row.object_name === "__drizzle_migrations" &&
                ["INSERT", "SELECT"].includes(row.privilege_type)
              );
            }
            if (label === "revoke-ledger-sequence") {
              return !(
                row.authority_kind === "explicit_acl" &&
                row.role_name === testMigrationExecutor &&
                row.role_relation === "grantee" &&
                row.grantor_name === testActualAclGrantorRole &&
                row.grantee_name === testMigrationExecutor &&
                row.object_kind === "sequence" &&
                row.schema_name === "drizzle" &&
                row.object_name === "__drizzle_migrations_id_seq" &&
                ["SELECT", "USAGE"].includes(row.privilege_type)
              );
            }
            if (label === "revoke-legacy-membership") {
              return !(
                row.role_name === testMigrationExecutor &&
                row.object_kind === "role" &&
                row.granted_role === testLegacyOwner &&
                row.authority_kind.endsWith("membership")
              );
            }
            return true;
          });
        }
      }
      return Promise.resolve({ rows: [] });
    },
    end() {
      state.end += 1;
      events.push("canonical-close");
      return Promise.resolve();
    },
  };
  return {
    client,
    state,
    initialIdentityClient: initialIdentity.client,
    initialIdentityState: initialIdentity.state,
  };
}

function createPostflightBoundaryFakeClient(events: string[] = []) {
  const state = {
    connect: 0,
    query: [] as string[],
    end: 0,
    destroy: 0,
  };
  const client = {
    connection: {
      stream: {
        destroy() {
          state.destroy += 1;
        },
      },
    },
    connect() {
      state.connect += 1;
      events.push("postflight-connect");
      return Promise.resolve();
    },
    query(statement: string) {
      state.query.push(statement);
      events.push(ownerBoundaryQueryLabel(statement));
      return Promise.resolve({ rows: [] });
    },
    end() {
      state.end += 1;
      events.push("postflight-close");
      return Promise.resolve();
    },
  };
  return { client, state };
}

async function runDirectHarnessInvocation(
  environment: Partial<NodeJS.ProcessEnv> = {}
) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveChild, rejectChild) => {
      const child = spawn(process.execPath, [postgresHarnessModule], {
        env: { ...createSanitizedNodeChildEnvironment(), ...environment },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        rejectChild(new Error("DIRECT_HARNESS_TIMEOUT"));
      }, 5_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectChild(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolveChild({ code, stdout, stderr });
      });
    }
  );
}

describe("temporary usage body-object ACL boundary", () => {
  async function runBodyAclProbe({
    fakeOptions,
    grantMutationForTest = null,
    revokeMutationForTest = null,
    deadlineLimits,
    unrelatedClient = null,
    replaceGrantObservedSessionIdentityForTest = false,
    replaceRevokeObservedSessionIdentityForTest = false,
  }: {
    fakeOptions?: UsageBodyAclFakeOptions;
    grantMutationForTest?: string | null;
    revokeMutationForTest?: string | null;
    deadlineLimits?: Record<string, number>;
    unrelatedClient?: ReturnType<
      typeof createObservedSessionIdentityFakeClient
    >["client"] | null;
    replaceGrantObservedSessionIdentityForTest?: boolean;
    replaceRevokeObservedSessionIdentityForTest?: boolean;
  } = {}) {
    const initial = createObservedSessionIdentityFakeClient();
    const fake = createUsageBodyAclFakeHarness(fakeOptions);
    const result = await runUsageBodyAclBoundaryProbeForTests({
      initialIdentityClient: initial.client,
      clientFactory: fake.clientFactory,
      unrelatedClient,
      expectedSessionRole: testFixtureSessionRole,
      deadlineLimits,
      grantMutationForTest,
      revokeMutationForTest,
      replaceGrantObservedSessionIdentityForTest,
      replaceRevokeObservedSessionIdentityForTest,
    });
    return { initial, fake, result };
  }

  it("grant inventory observability keeps success silent and preserves the generic failure identity", async () => {
    const success = await runBodyAclProbe();
    expect(success.result.failureMarker).toBeNull();
    expect(success.result.diagnosticOutput).toBe("");

    const failure = await runBodyAclProbe({
      fakeOptions: { grantedRows: validTestUsageBodyAclRows().slice(1) },
    });
    const lines = testGrantInventoryOutputLines(failure.result.diagnosticOutput);
    expect(failure.result.failureMarker).toBe(testGrantInventoryGenericMarker);
    expect(lines[0]).toBe(testGrantInventoryDiagnosticVersion);
    expect(lines.at(-1)).toBe(testGrantInventoryGenericMarker);
    expect(lines.filter((line) => testGrantInventoryPrimaryMarkers.includes(line as never))).toHaveLength(1);
    expect(lines.filter((line) => line === testGrantInventoryCleanupAttempted)).toHaveLength(1);
    expect(
      lines.filter(
        (line) =>
          line === testGrantInventoryCleanupSucceeded ||
          line === testGrantInventoryCleanupFailed
      )
    ).toHaveLength(1);
    expect(failure.fake.state).toMatchObject({
      exactGrantCount: 1,
      exactRevokeCount: 1,
      inventoryCount: 2,
      connectCount: 3,
      endCount: 3,
    });
    expect(failure.result.operationStarts).toMatchObject({
      connect: 4,
      query: 7,
      close: 4,
    });
    expect(failure.result.cleanupReserveMilliseconds).toBe(
      HARNESS_DEADLINE_LIMITS_FOR_TESTS.connectMilliseconds +
        3 * HARNESS_DEADLINE_LIMITS_FOR_TESTS.queryMilliseconds +
        HARNESS_DEADLINE_LIMITS_FOR_TESTS.closeMilliseconds
    );
    expect(failure.result.bodyAclWindowComplete).toBe(false);
    expect(failure.result.runtimeAclConfigurationStartCount).toBe(0);
    expect(failure.result.postflightStartCount).toBe(0);
  });

  it.each([
    ["factory throws", { inventoryClientScenario: "factory-throws" }, "CLIENT_FACTORY", null],
    ["factory shape", { inventoryClientScenario: "factory-invalid" }, "CLIENT_FACTORY", null],
    [
      "connect rejection",
      { inventoryClientScenario: "connect-rejects" },
      "CLIENT_CONNECT_REJECTED",
      null,
    ],
    [
      "connect timeout",
      { inventoryClientScenario: "connect-hangs" },
      "CLIENT_CONNECT_TIMEOUT",
      { totalMilliseconds: 100, connectMilliseconds: 5, queryMilliseconds: 5, closeMilliseconds: 5 },
    ],
    ["query rejection", { rejectOnLabel: "body-acl-inventory" }, "QUERY_REJECTED", null],
    [
      "query timeout",
      { hangOnLabel: "body-acl-inventory" },
      "QUERY_TIMEOUT",
      { totalMilliseconds: 100, connectMilliseconds: 5, queryMilliseconds: 5, closeMilliseconds: 5 },
    ],
    ["rows non-array", { grantInventoryResultRows: {} }, "RESULT_SHAPE", null],
    ["null row", { grantInventoryResultRows: [null] }, "RESULT_SHAPE", null],
    ["missing key", { grantInventoryResultRows: [{ authority_kind: "explicit_acl" }] }, "RESULT_SHAPE", null],
    [
      "extra key",
      { grantInventoryResultRows: [{ ...validTestUsageBodyAclRows()[0], extra: true }] },
      "RESULT_SHAPE",
      null,
    ],
    [
      "wrong field type",
      { grantInventoryResultRows: [{ ...validTestUsageBodyAclRows()[0], object_kind: 7 }] },
      "RESULT_SHAPE",
      null,
    ],
    ["normalizer failure", { grantInventoryNormalizerFailure: true }, "NORMALIZATION", null],
    [
      "close rejection",
      { inventoryClientScenario: "close-rejects" },
      "CLIENT_CLOSE_REJECTED",
      null,
    ],
    [
      "close timeout",
      { inventoryClientScenario: "close-hangs" },
      "CLIENT_CLOSE_TIMEOUT",
      { totalMilliseconds: 100, connectMilliseconds: 5, queryMilliseconds: 5, closeMilliseconds: 5 },
    ],
  ] as const)(
    "grant inventory primary classifier identifies %s without changing cleanup precedence",
    async (_label, fakeOptions, primarySuffix, deadlineLimits) => {
      const { result } = await runBodyAclProbe({
        fakeOptions: fakeOptions as UsageBodyAclFakeOptions,
        deadlineLimits: deadlineLimits ?? undefined,
      });
      const lines = testGrantInventoryOutputLines(result.diagnosticOutput);
      const expectedPrimary = `EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_${primarySuffix}`;
      expect(testGrantInventoryPrimaryMarkers).toContain(expectedPrimary);
      expect(lines).toContain(expectedPrimary);
      expect(lines.filter((line) => testGrantInventoryPrimaryMarkers.includes(line as never))).toHaveLength(1);
      expect(lines[0]).toBe(testGrantInventoryDiagnosticVersion);
      expect(lines.at(-1)).toBe(testGrantInventoryGenericMarker);
      expect(result.failureMarker).toBe(testGrantInventoryGenericMarker);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it.each([
    [
      "duplicate exact row",
      [...validTestUsageBodyAclRows(), { ...validTestUsageBodyAclRows()[0] }],
      [18, 19, 0, 1, 1],
      ["DUPLICATE_ROW", "EXTRA_ROW"],
    ],
    [
      "over-broad owner-self exclusion represented by one missing expected row",
      validTestUsageBodyAclRows().slice(1),
      [18, 17, 1, 0, 0],
      ["MISSING_ROW"],
    ],
    [
      "one extra row",
      [
        ...validTestUsageBodyAclRows(),
        { ...validTestUsageBodyAclRows()[0], grantee_name: "unknown_fixture_recipient" },
      ],
      [18, 19, 0, 1, 0],
      ["EXTRA_ROW", "RECIPIENT_CONTRACT", "OBSERVED_GRANTOR_COVERAGE"],
    ],
    [
      "same-count replacement",
      validTestUsageBodyAclRows().map((row, index) =>
        index === 0 ? { ...row, object_name: "unknown_fixture_object" } : row
      ),
      [18, 18, 1, 1, 0],
      ["MISSING_ROW", "EXTRA_ROW", "OBJECT_CONTRACT"],
    ],
    [
      "missing and extra together",
      [
        ...validTestUsageBodyAclRows().slice(1),
        { ...validTestUsageBodyAclRows()[0], privilege_type: "DELETE" },
      ],
      [18, 18, 1, 1, 0],
      ["MISSING_ROW", "EXTRA_ROW", "PRIVILEGE_CONTRACT"],
    ],
  ] as const)(
    "grant inventory exact-set counters report %s with fixed field order",
    async (_label, grantedRows, expectedCounts, expectedDetails) => {
      const { result } = await runBodyAclProbe({
        fakeOptions: { grantedRows: [...grantedRows] as TestUsageBodyAclRow[] },
      });
      const lines = testGrantInventoryOutputLines(result.diagnosticOutput);
      const countLine = lines.find((line) =>
        line.startsWith("EXTERNAL_FIXTURE_GRANT_INVENTORY_COUNTS_V1 ")
      );
      expect(countLine).toBe(
        `EXTERNAL_FIXTURE_GRANT_INVENTORY_COUNTS_V1 EXPECTED_TOTAL=${expectedCounts[0]} ACTUAL_TOTAL=${expectedCounts[1]} MISSING_TOTAL=${expectedCounts[2]} EXTRA_TOTAL=${expectedCounts[3]} DUPLICATE_TOTAL=${expectedCounts[4]}`
      );
      expect(
        lines.filter((line) => line.startsWith("EXTERNAL_FIXTURE_GRANT_INVENTORY_COUNTS_V1 "))
      ).toHaveLength(1);
      for (const detail of expectedDetails) {
        expect(lines).toContain(`EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_${detail}`);
      }
    }
  );

  it.each([
    ["object contract", { object_name: "unknown_fixture_object" }, "OBJECT_CONTRACT"],
    ["privilege contract", { privilege_type: "DELETE" }, "PRIVILEGE_CONTRACT"],
    ["grant option contract", { grant_option: true }, "GRANT_OPTION_CONTRACT"],
    [
      "recipient contract",
      { recipient_relation: "unexpected", grantee_name: "unknown_fixture_recipient" },
      "RECIPIENT_CONTRACT",
    ],
    ["grantor contract", { grantor_name: "wrong_fixture_grantor" }, "GRANTOR_CONTRACT"],
    [
      "owner-self inclusion",
      { grantor_name: testUsageBodyAclRoles.explicit },
      "OWNER_SELF_CONTRACT",
    ],
    [
      "system-wide recipient coverage",
      { recipient_relation: "unexpected", grantee_name: testUsageBodyAclRoles.denied },
      "SYSTEM_RECIPIENT_COVERAGE",
    ],
    [
      "target-as-grantor coverage",
      { grantor_name: testUsageBodyAclRoles.denied },
      "TARGET_GRANTOR_COVERAGE",
    ],
    [
      "observed-grantor unknown recipient coverage",
      { recipient_relation: "unexpected", grantee_name: "unknown_fixture_recipient" },
      "OBSERVED_GRANTOR_COVERAGE",
    ],
    ["grantee dependency", { grantee_dependency_count: 0 }, "GRANTEE_DEPENDENCY"],
    ["grantor dependency", { grantor_dependency_count: 0 }, "GRANTOR_DEPENDENCY"],
    [
      "uncovered dependency",
      {
        authority_kind: "uncovered_acl_dependency",
        recipient_relation: "unexpected",
        grantor_name: "UNRESOLVED",
        privilege_type: "ACL_DEPENDENCY",
        grantee_dependency_count: 0,
        grantor_dependency_count: 0,
      },
      "UNCOVERED_DEPENDENCY",
    ],
  ] as const)(
    "grant inventory exact-set counters classify %s from the complete in-memory row set",
    async (_label, replacement, expectedDetail) => {
      const grantedRows = validTestUsageBodyAclRows().map((row, index) =>
        index === 0 ? { ...row, ...replacement } : row
      );
      const { result } = await runBodyAclProbe({ fakeOptions: { grantedRows } });
      const lines = testGrantInventoryOutputLines(result.diagnosticOutput);
      expect(lines).toContain(
        `EXTERNAL_FIXTURE_GRANT_INVENTORY_DETAIL_${expectedDetail}`
      );
      const emittedDetails = lines.filter((line) =>
        testGrantInventoryDetailMarkers.includes(line as never)
      );
      expect(emittedDetails).toEqual(
        testGrantInventoryDetailMarkers.filter((marker) => emittedDetails.includes(marker))
      );
    }
  );

  it("grant inventory cleanup markers preserve a successful cleanup and a failed cleanup without replacing the primary", async () => {
    const grantedRows = validTestUsageBodyAclRows().slice(1);
    const cleanupSucceeded = await runBodyAclProbe({ fakeOptions: { grantedRows } });
    const cleanupFailed = await runBodyAclProbe({
      fakeOptions: { grantedRows, rejectOnLabel: "body-acl-revoke-exact" },
    });
    for (const [scenario, expectedResult] of [
      [cleanupSucceeded, testGrantInventoryCleanupSucceeded],
      [cleanupFailed, testGrantInventoryCleanupFailed],
    ] as const) {
      const lines = testGrantInventoryOutputLines(scenario.result.diagnosticOutput);
      expect(lines.filter((line) => line === testGrantInventoryCleanupAttempted)).toHaveLength(1);
      expect(lines.filter((line) => line === expectedResult)).toHaveLength(1);
      expect(
        lines.filter(
          (line) =>
            line === testGrantInventoryCleanupSucceeded ||
            line === testGrantInventoryCleanupFailed
        )
      ).toHaveLength(1);
      expect(lines.at(-1)).toBe(testGrantInventoryGenericMarker);
      expect(scenario.result.failureMarker).toBe(testGrantInventoryGenericMarker);
    }
    expect(cleanupSucceeded.fake.state.exactRevokeCount).toBe(1);
    expect(cleanupFailed.fake.state.revokeAttemptCount).toBe(1);
    expect(cleanupFailed.fake.state.exactRevokeCount).toBe(0);
  });

  it("grant inventory observability redaction fails closed for invalid counts, unknown codes, and classifier failure", async () => {
    const rejected = await runBodyAclProbe({
      fakeOptions: { rejectOnLabel: "body-acl-inventory" },
    });
    const output = rejected.result.diagnosticOutput;
    expect(output).toContain(
      "EXTERNAL_FIXTURE_GRANT_INVENTORY_PRIMARY_QUERY_REJECTED"
    );
    expect(output).not.toContain(exactUsageBodyAclGrantContract);
    expect(output).not.toContain(exactUsageBodyAclRevokeContract);
    expect(output).not.toContain(testFixtureSessionRole);
    expect(output).not.toMatch(
      /sensitive|fixed-body-acl-failure|oid|catalog|postgresql:\/\/|127\.0\.0\.1|5432/i
    );
    expect(output.split("\n").filter(Boolean).every((line) => /^[A-Z0-9_= ]+$/.test(line))).toBe(true);

    for (const scenario of [
      "negative-count",
      "decimal-count",
      "exponent-count",
      "overflow-count",
      "unknown-primary",
      "unknown-detail",
      "classification-failure",
    ]) {
      const invalid = runGrantInventoryDiagnosticOutputProbeForTests(scenario);
      expect(invalid.output).toBe(`${testGrantInventoryGenericMarker}\n`);
      expect(invalid.output).not.toContain(testGrantInventoryDiagnosticVersion);
      expect(invalid.output).not.toMatch(/PRIMARY_|DETAIL_|COUNTS_V1|CLEANUP_/);
    }
  });

  it("uses exact body-object ACL grants for explicit runtime and membership runtime inheritance, then proves zero residue", async () => {
    const { fake, result } = await runBodyAclProbe();

    expect(result).toMatchObject({
      failureMarker: null,
      bodyAclWindowComplete: true,
      timedOut: false,
      activeClientCount: 0,
      observedIdentityFrozen: true,
    });
    expect(fake.state.exactGrantCount).toBe(1);
    expect(fake.state.exactRevokeCount).toBe(1);
    expect(fake.state.inventoryCount).toBe(2);
    expect(fake.state.executionCount).toBe(4);
    expect(fake.state.aclRows).toEqual([]);
    expect(result.cleanupReserveMilliseconds).toBe(
      HARNESS_DEADLINE_LIMITS_FOR_TESTS.connectMilliseconds +
        3 * HARNESS_DEADLINE_LIMITS_FOR_TESTS.queryMilliseconds +
        HARNESS_DEADLINE_LIMITS_FOR_TESTS.closeMilliseconds
    );
    expect(result.cleanupReserveMilliseconds).toBe(105_000);
    expect(result.cleanupSharesOriginalDeadline).toBe(true);
    expect(result.businessReservesCleanupDeadline).toBe(true);
    const grantClient = fake.state.clients.find(
      (client) => client.queryLabels[0] === "body-acl-grant-identity"
    );
    const revokeClient = fake.state.clients.find(
      (client) => client.queryLabels[0] === "body-acl-revoke-identity"
    );
    expect(grantClient).toMatchObject({
      connect: 1,
      end: 1,
      destroy: 0,
      queryLabels: ["body-acl-grant-identity", "body-acl-grant-exact"],
    });
    expect(revokeClient).toMatchObject({
      connect: 1,
      end: 1,
      destroy: 0,
      queryLabels: [
        "body-acl-revoke-identity",
        "body-acl-revoke-exact",
        "body-acl-inventory",
      ],
    });
    expect(exactUsageBodyAclGrantContract.split(";\n")).toHaveLength(5);
    expect(exactUsageBodyAclRevokeContract.split(";\n")).toHaveLength(5);
    expect(
      fake.state.queryLog.filter((entry) => entry.label === "body-acl-grant-exact")
    ).toEqual([
      expect.objectContaining({
        statement: exactUsageBodyAclGrantContract,
        parameters: [],
      }),
    ]);
    expect(
      fake.state.queryLog.filter((entry) => entry.label === "body-acl-revoke-exact")
    ).toEqual([
      expect.objectContaining({
        statement: exactUsageBodyAclRevokeContract,
        parameters: [],
      }),
    ]);
    const phaseOrder = [
      "MIGRATION_USAGE_BODY_ACL_GRANT",
      "MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY",
      "MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION",
      "MIGRATION_USAGE_MEMBERSHIP_RUNTIME_EXECUTION",
      "MIGRATION_USAGE_DENIED_RUNTIME_EXECUTION",
      "MIGRATION_USAGE_PUBLIC_RUNTIME_EXECUTION",
      "MIGRATION_USAGE_BODY_ACL_REVOKE",
      "MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE",
    ];
    expect(
      result.phaseTrace.filter((phase) => phaseOrder.includes(phase))
    ).toEqual(phaseOrder);
  });

  it("owner-default 40-row catalog fixture keeps the owner-default catalog fixture metadata independent for every fixed object", () => {
    const ownerRows = testUsageBodyAclOwnerDefaultCatalogRows();
    const temporaryRows = testUsageBodyAclTemporaryCatalogRows();

    expect(testUsageBodyAclObjectOwners).toHaveLength(5);
    expect(
      new Set(testUsageBodyAclObjectOwners.map((row) => row.object_name)).size
    ).toBe(5);
    expect(ownerRows).toHaveLength(40);
    expect(ownerRows.every(testLocalIsExactOwnerSelfAcl)).toBe(true);
    expect(temporaryRows).toHaveLength(18);
    for (const objectOwner of testUsageBodyAclObjectOwners) {
      const objectRows = ownerRows.filter(
        (row) => row.object_name === objectOwner.object_name
      );
      expect(objectRows).toHaveLength(8);
      expect(
        [...new Set(objectRows.map((row) => row.privilege_type))].sort()
      ).toEqual([...testPostgreSql18TableOwnerPrivileges].sort());
      for (const ownerRow of objectRows) {
        expect(ownerRow.owner_name).toBe(
          testUsageBodyAclOwnerForObject(ownerRow.object_name)
        );
        expect(ownerRow.grantor_name).toBe(ownerRow.owner_name);
        expect(ownerRow.grantee_name).toBe(ownerRow.owner_name);
      }
    }
  });

  it("PostgreSQL 18 owner ACL expansion filters raw 58 to 18 and raw 40 to zero residue", async () => {
    const { fake, result } = await runBodyAclProbe();

    expect(result.failureMarker).toBeNull();
    expect(result.bodyAclWindowComplete).toBe(true);
    expect(fake.state.inventorySnapshots).toEqual([
      { rawCount: 58, ownerSelfCount: 40, filteredCount: 18 },
      { rawCount: 40, ownerSelfCount: 40, filteredCount: 0 },
    ]);
    expect(fake.state.rawAclCatalogRows).toHaveLength(40);
    expect(fake.state.rawAclCatalogRows.every(testLocalIsExactOwnerSelfAcl)).toBe(
      true
    );
    expect(fake.state.ownerAclMutationCount).toBe(0);
    expect(fake.state.aclRows).toEqual([]);
    expect(result.phaseTrace).toEqual(
      expect.arrayContaining([
        "MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION",
        "MIGRATION_USAGE_MEMBERSHIP_RUNTIME_EXECUTION",
        "MIGRATION_USAGE_BODY_ACL_REVOKE",
        "MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE",
      ])
    );
    expect(JSON.stringify(result)).not.toContain(testFixtureSessionRole);
    expect(JSON.stringify(result)).not.toContain(
      testUsageBodyAclFixedObjectOwner
    );
  });

  it("distinct body object owner authority remains separate from the observed grantor and runtime identities", () => {
    expect(
      testLocalNormalBodyObjectOwnerAuthorityIsDistinct(
        testUsageBodyAclObjectOwners
      )
    ).toBe(true);
    expect(testUsageBodyAclFixedObjectOwner).not.toBe(testFixtureSessionRole);
    expect(testUsageBodyAclFixedObjectOwner).not.toBe(
      testUsageBodyAclRoles.legacyOwner
    );
    expect(testUsageBodyAclFixedObjectOwner).not.toBe(
      testUsageBodyAclRoles.explicit
    );
    expect(
      testUsageBodyAclObjectOwners.every(
        (entry) => entry.owner_name === testUsageBodyAclFixedObjectOwner
      )
    ).toBe(true);
  });

  it("owner ACL multiset preservation keeps the exact 40 public-safe fixture rows across grant and revoke", async () => {
    const { fake, result } = await runBodyAclProbe();

    expect(result.failureMarker).toBeNull();
    expect(fake.state.ownerAclMultisetSnapshots).toHaveLength(3);
    expect(fake.state.ownerAclMultisetSnapshots.map((snapshot) => snapshot.phase)).toEqual([
      "before-grant",
      "post-grant",
      "post-revoke",
    ]);
    const [beforeGrant, postGrant, postRevoke] =
      fake.state.ownerAclMultisetSnapshots;
    expect(beforeGrant.keys).toHaveLength(40);
    expect(postGrant.keys).toEqual(beforeGrant.keys);
    expect(postRevoke.keys).toEqual(beforeGrant.keys);
    expect(fake.state.ownerAclMultisetMismatchCount).toBe(0);
    expect(fake.state.ownerAclMutationCount).toBe(0);
    expect(fake.state.ownerAclRevokeStatementCount).toBe(0);
    expect(exactUsageBodyAclRevokeContract).not.toContain(
      testUsageBodyAclFixedObjectOwner
    );
  });

  it("owner privilege allowlist is the exact independent canonical PostgreSQL 18 set", () => {
    expect(testPostgreSql18TableOwnerPrivileges).toEqual([
      "INSERT",
      "SELECT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN",
    ]);
    expect(testLocalHasExactPostgreSql18OwnerPrivilegeAllowlist(
      testPostgreSql18TableOwnerPrivileges
    )).toBe(true);
    expect(testPostgreSql18TableOwnerPrivileges).toHaveLength(8);
    expect(new Set(testPostgreSql18TableOwnerPrivileges).size).toBe(8);
  });

  it.each([
    ["one missing", testPostgreSql18TableOwnerPrivileges.slice(0, -1)],
    [
      "one unknown extra",
      [...testPostgreSql18TableOwnerPrivileges, "EXECUTE"],
    ],
    [
      "one duplicate",
      [...testPostgreSql18TableOwnerPrivileges, "SELECT"],
    ],
    [
      "case mismatch",
      testPostgreSql18TableOwnerPrivileges.map((privilege, index) =>
        index === 0 ? privilege.toLowerCase() : privilege
      ),
    ],
    ["empty value", [...testPostgreSql18TableOwnerPrivileges.slice(1), ""]],
    ["null value", [...testPostgreSql18TableOwnerPrivileges.slice(1), null]],
    ["non-string value", [...testPostgreSql18TableOwnerPrivileges.slice(1), 7]],
  ] as Array<[string, readonly unknown[]]>)(
    "owner privilege allowlist rejects %s",
    (_label, privileges) => {
      expect(testLocalHasExactPostgreSql18OwnerPrivilegeAllowlist(privileges)).toBe(
        false
      );
    }
  );

  const normalOwnerCatalogRows = testUsageBodyAclOwnerDefaultCatalogRows();
  const ownerCatalogContractMutations: Array<
    [string, TestUsageBodyAclCatalogRow[]]
  > = [
    ["one of 40 rows missing", normalOwnerCatalogRows.slice(1)],
    [
      "one extra owner row",
      [
        ...normalOwnerCatalogRows,
        {
          ...normalOwnerCatalogRows[0],
          physical_key: "owner-default-extra",
        },
      ],
    ],
    [
      "one object with seven rows",
      normalOwnerCatalogRows.filter(
        (row) =>
          !(
            row.object_name === testUsageBodyAclObjectOwners[0].object_name &&
            row.privilege_type === "MAINTAIN"
          )
      ),
    ],
    [
      "one object with nine rows",
      [
        ...normalOwnerCatalogRows,
        {
          ...normalOwnerCatalogRows[0],
          physical_key: "owner-default-ninth-row",
          privilege_type: "EXECUTE",
        },
      ],
    ],
    [
      "one object with a duplicate privilege",
      [
        ...normalOwnerCatalogRows,
        {
          ...normalOwnerCatalogRows[0],
          physical_key: "owner-default-duplicate-privilege",
        },
      ],
    ],
    [
      "one object with the wrong owner",
      normalOwnerCatalogRows.map((row, index) =>
        index === 0
          ? {
              ...row,
              owner_name: "wrong_body_object_owner",
              grantor_name: "wrong_body_object_owner",
              grantee_name: "wrong_body_object_owner",
            }
          : row
      ),
    ],
    [
      "one object owned by the observed grantor",
      normalOwnerCatalogRows.map((row) =>
        row.object_name === testUsageBodyAclObjectOwners[0].object_name
          ? {
              ...row,
              owner_name: testFixtureSessionRole,
              grantor_name: testFixtureSessionRole,
              grantee_name: testFixtureSessionRole,
            }
          : row
      ),
    ],
    [
      "all objects owned by the observed grantor",
      normalOwnerCatalogRows.map((row) => ({
        ...row,
        owner_name: testFixtureSessionRole,
        grantor_name: testFixtureSessionRole,
        grantee_name: testFixtureSessionRole,
      })),
    ],
    [
      "correct owner grantee with a wrong grantor",
      normalOwnerCatalogRows.map((row, index) =>
        index === 0
          ? { ...row, grantor_name: testUsageBodyAclRoles.denied }
          : row
      ),
    ],
    [
      "correct owner grantor with a wrong grantee",
      normalOwnerCatalogRows.map((row, index) =>
        index === 0
          ? { ...row, grantee_name: testUsageBodyAclRoles.denied }
          : row
      ),
    ],
    [
      "correct privilege on the wrong object",
      normalOwnerCatalogRows.map((row, index) =>
        index === 0 ? { ...row, object_name: "outside_fixed_scope" } : row
      ),
    ],
    [
      "correct privilege on the wrong object kind",
      normalOwnerCatalogRows.map((row, index) =>
        index === 0 ? { ...row, object_kind: "sequence" } : row
      ),
    ],
  ];

  it.each(ownerCatalogContractMutations)(
    "PostgreSQL 18 owner ACL expansion rejects malformed raw owner catalog: %s",
    async (_label, ownerRows) => {
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: {
          rawGrantedCatalogRows: [
            ...ownerRows,
            ...testUsageBodyAclTemporaryCatalogRows(),
          ],
        },
      });

      expect(result.bodyAclWindowComplete).toBe(false);
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
      );
      expect(fake.state.executionCount).toBe(0);
      expect(fake.state.ownerAclMutationCount).toBe(0);
      expect(fake.state.ownerAclRevokeStatementCount).toBe(0);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
      const publicResult = JSON.stringify(result);
      expect(publicResult).not.toContain(testFixtureSessionRole);
      expect(publicResult).not.toContain(testUsageBodyAclFixedObjectOwner);
      expect(publicResult).not.toContain("wrong_body_object_owner");
    }
  );

  it("distinct body object owner authority rejects an internally consistent observed-grantor owner fixture", async () => {
    const objectOwners = testUsageBodyAclObjectOwners.map((entry) => ({
      ...entry,
      owner_name: testFixtureSessionRole,
    }));
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { objectOwners },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
    );
    expect(fake.state.executionCount).toBe(0);
    expect(fake.state.ownerAclMutationCount).toBe(0);
    expect(result.runtimeAclConfigurationStartCount).toBe(0);
    expect(result.postflightStartCount).toBe(0);
  });

  it.each([
    ["17", validTestUsageBodyAclRows().slice(1)],
    [
      "19",
      [
        ...validTestUsageBodyAclRows(),
        testUsageBodyAclResidueRow({
          recipient_relation: "unexpected",
          grantee_name: "unknown_fixture_recipient",
        }),
      ],
    ],
  ])(
    "PostgreSQL 18 owner ACL expansion rejects filtered temporary count %s",
    async (_label, grantedRows) => {
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: { grantedRows },
      });

      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
      );
      expect(fake.state.executionCount).toBe(0);
      expect(fake.state.ownerAclMutationCount).toBe(0);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it.each([
    ["39 raw owner rows", normalOwnerCatalogRows.slice(1)],
    [
      "41 raw owner rows",
      [
        ...normalOwnerCatalogRows,
        {
          ...normalOwnerCatalogRows[0],
          physical_key: "post-revoke-extra-owner-row",
        },
      ],
    ],
    [
      "same-count changed owner multiset",
      normalOwnerCatalogRows.map((row, index) =>
        index === 0 ? { ...row, privilege_type: "SELECT" } : row
      ),
    ],
  ])(
    "owner ACL multiset preservation rejects post-REVOKE %s",
    async (_label, rawPostRevokeCatalogSnapshot) => {
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: { rawPostRevokeCatalogSnapshot },
      });

      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE"
      );
      expect(fake.state.zeroResidueInventoryCount).toBe(0);
      expect(fake.state.ownerAclRevokeStatementCount).toBe(0);
      expect(fake.state.ownerAclMultisetMismatchCount).toBeGreaterThan(0);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it("owner ACL multiset preservation keeps owner rows outside temporary expected and REVOKE targets", () => {
    const ownerRows = testUsageBodyAclOwnerDefaultCatalogRows();
    const temporaryRows = testUsageBodyAclTemporaryCatalogRows();

    expect(ownerRows).toHaveLength(40);
    expect(temporaryRows).toHaveLength(18);
    expect(ownerRows.some(testLocalIsExactTemporaryUsageBodyAcl)).toBe(false);
    expect(temporaryRows.some(testLocalIsExactOwnerSelfAcl)).toBe(false);
    expect(exactUsageBodyAclRevokeContract).not.toContain(
      testUsageBodyAclFixedObjectOwner
    );
  });

  it("owner-as-grantor preservation keeps owner to non-owner authority in the inventory", async () => {
    const ownerAsGrantor = testUsageBodyAclCatalogRow({
      physical_key: "owner-to-unknown-recipient",
      owner_name: testFixtureSessionRole,
      grantor_name: testFixtureSessionRole,
      grantee_name: "unknown_fixture_recipient",
    });
    const rawGrantedCatalogRows = [
      ...testUsageBodyAclOwnerDefaultCatalogRows(),
      ...testUsageBodyAclTemporaryCatalogRows(),
      ownerAsGrantor,
    ];
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { rawGrantedCatalogRows },
    });

    expect(testLocalUsageBodyAclSelectionArms(ownerAsGrantor)).toEqual([
      "observed-grantor",
    ]);
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
    );
    expect(fake.state.aclRows).toContainEqual(
      expect.objectContaining({ grantee_name: ownerAsGrantor.grantee_name })
    );
    expect(fake.state.executionCount).toBe(0);
    expect(result.runtimeAclConfigurationStartCount).toBe(0);
    expect(result.postflightStartCount).toBe(0);
  });

  it("owner-as-grantee preservation keeps non-owner target grantor authority in the inventory", async () => {
    const ownerAsGrantee = testUsageBodyAclCatalogRow({
      physical_key: "target-grantor-to-owner",
      owner_name: testFixtureSessionRole,
      grantor_name: testUsageBodyAclRoles.denied,
      grantee_name: testFixtureSessionRole,
    });
    const rawGrantedCatalogRows = [
      ...testUsageBodyAclOwnerDefaultCatalogRows(),
      ...testUsageBodyAclTemporaryCatalogRows(),
      ownerAsGrantee,
    ];
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { rawGrantedCatalogRows },
    });

    expect(testLocalUsageBodyAclSelectionArms(ownerAsGrantee)).toEqual([
      "target-as-grantor",
    ]);
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
    );
    expect(fake.state.aclRows).toContainEqual(
      expect.objectContaining({ grantor_name: ownerAsGrantee.grantor_name })
    );
    expect(fake.state.executionCount).toBe(0);
    expect(result.runtimeAclConfigurationStartCount).toBe(0);
    expect(result.postflightStartCount).toBe(0);
  });

  it("per-object owner boundary rejects a global owner assumption across objects", () => {
    const objectOwners: TestUsageBodyAclObjectOwner[] = [
      {
        ...testUsageBodyAclObjectOwners[0],
        owner_name: "first_fixed_object_owner",
      },
      {
        ...testUsageBodyAclObjectOwners[1],
        owner_name: "second_fixed_object_owner",
      },
    ];
    const ownerRows = testUsageBodyAclOwnerDefaultCatalogRows(objectOwners);
    const wrongObjectOwnerApplied = testUsageBodyAclCatalogRow({
      physical_key: "wrong-owner-applied-to-second-object",
      owner_name: objectOwners[1].owner_name,
      grantor_name: objectOwners[0].owner_name,
      grantee_name: objectOwners[0].owner_name,
      object_name: objectOwners[1].object_name,
    });

    expect(ownerRows).toHaveLength(16);
    expect(ownerRows.every(testLocalIsExactOwnerSelfAcl)).toBe(true);
    expect(testLocalSelectedUsageBodyAclRows(ownerRows)).toEqual([]);
    expect(
      testLocalUsageBodyAclSelectionArms(
        wrongObjectOwnerApplied,
        objectOwners[0].owner_name
      )
    ).toEqual(["observed-grantor"]);
  });

  it("owner-self ACL exclusion preserves narrow system, target, observed, and self-grant coverage", () => {
    const nonOwnerSelfGrant = testUsageBodyAclCatalogRow({
      physical_key: "non-owner-self-grant",
      owner_name: testFixtureSessionRole,
      grantor_name: testUsageBodyAclRoles.denied,
      grantee_name: testUsageBodyAclRoles.denied,
    });
    const ownerTargetGrantor = testUsageBodyAclCatalogRow({
      physical_key: "owner-target-grantor",
      owner_name: testUsageBodyAclRoles.denied,
      grantor_name: testUsageBodyAclRoles.denied,
      grantee_name: "unknown_fixture_recipient",
    });
    const ownerSystemRecipient = testUsageBodyAclCatalogRow({
      physical_key: "owner-system-recipient",
      owner_name: "PUBLIC",
      grantor_name: "fixed_unrelated_grantor",
      grantee_name: "PUBLIC",
    });
    const publicRecipient = testUsageBodyAclCatalogRow({
      physical_key: "public-recipient",
      owner_name: testFixtureSessionRole,
      grantor_name: "fixed_unrelated_grantor",
      grantee_name: "PUBLIC",
    });
    const ownerSelfAcrossMultipleArms = testUsageBodyAclCatalogRow({
      physical_key: "owner-self-multiple-arms",
      owner_name: testUsageBodyAclRoles.explicit,
      grantor_name: testUsageBodyAclRoles.explicit,
      grantee_name: testUsageBodyAclRoles.explicit,
    });

    expect(testLocalUsageBodyAclSelectionArms(nonOwnerSelfGrant)).toEqual([
      "target-as-grantor",
    ]);
    expect(testLocalUsageBodyAclSelectionArms(ownerTargetGrantor)).toEqual([
      "target-as-grantor",
    ]);
    expect(testLocalUsageBodyAclSelectionArms(ownerSystemRecipient)).toEqual([
      "system-wide-recipient",
    ]);
    expect(testLocalUsageBodyAclSelectionArms(publicRecipient)).toEqual([
      "system-wide-recipient",
    ]);
    expect(
      testLocalUsageBodyAclSemanticUnionArms(
        ownerSelfAcrossMultipleArms,
        testUsageBodyAclRoles.explicit
      )
    ).toEqual(["target-as-grantor", "observed-grantor"]);
    expect(
      testLocalUsageBodyAclSelectionArms(
        ownerSelfAcrossMultipleArms,
        testUsageBodyAclRoles.explicit
      )
    ).toEqual([]);
  });

  it("owner-self ACL exclusion mutation controls reject broad and phase-specific filters", () => {
    const exactOwnerSelf = testUsageBodyAclCatalogRow({
      physical_key: "exact-owner-self",
      owner_name: testUsageBodyAclRoles.explicit,
      grantor_name: testUsageBodyAclRoles.explicit,
      grantee_name: testUsageBodyAclRoles.explicit,
    });
    const ownerToNonOwner = testUsageBodyAclCatalogRow({
      physical_key: "owner-to-non-owner",
      owner_name: testFixtureSessionRole,
      grantor_name: testFixtureSessionRole,
      grantee_name: "unknown_fixture_recipient",
    });
    const nonOwnerToOwner = testUsageBodyAclCatalogRow({
      physical_key: "non-owner-to-owner",
      owner_name: testFixtureSessionRole,
      grantor_name: testUsageBodyAclRoles.denied,
      grantee_name: testFixtureSessionRole,
    });
    const nonOwnerSelfGrant = testUsageBodyAclCatalogRow({
      physical_key: "non-owner-self",
      owner_name: testFixtureSessionRole,
      grantor_name: testUsageBodyAclRoles.denied,
      grantee_name: testUsageBodyAclRoles.denied,
    });
    const rows = [
      exactOwnerSelf,
      ownerToNonOwner,
      nonOwnerToOwner,
      nonOwnerSelfGrant,
    ];
    const oracleKeys = testLocalSelectedUsageBodyAclRows(rows).map(
      (row) => row.physical_key
    );
    const excludesEverySelfGrant = rows
      .filter((row) => row.grantee_name !== row.grantor_name)
      .flatMap((row) => testLocalUsageBodyAclSemanticUnionArms(row).length ? [row.physical_key] : []);
    const excludesEitherOwnerSide = rows
      .filter(
        (row) =>
          row.grantee_name !== row.owner_name && row.grantor_name !== row.owner_name
      )
      .flatMap((row) => testLocalUsageBodyAclSemanticUnionArms(row).length ? [row.physical_key] : []);
    const ownerSelfOnlyOnObservedArm = rows
      .filter(
        (row) =>
          !(
            row.grantee_name === row.owner_name &&
            row.grantor_name === row.owner_name &&
            testLocalUsageBodyAclSemanticUnionArms(row).includes("observed-grantor")
          )
      )
      .flatMap((row) => testLocalUsageBodyAclSemanticUnionArms(row).length ? [row.physical_key] : []);

    expect(oracleKeys).toEqual([
      ownerToNonOwner.physical_key,
      nonOwnerToOwner.physical_key,
      nonOwnerSelfGrant.physical_key,
    ]);
    expect(excludesEverySelfGrant).not.toEqual(oracleKeys);
    expect(excludesEitherOwnerSide).not.toEqual(oracleKeys);
    expect(ownerSelfOnlyOnObservedArm).not.toEqual(oracleKeys);
    expect(validTestUsageBodyAclRows()).toHaveLength(18);
  });

  it.each([
    [
      "owner to non-owner ACL",
      testUsageBodyAclCatalogRow({
        physical_key: "cleanup-owner-to-non-owner",
        owner_name: testFixtureSessionRole,
        grantor_name: testFixtureSessionRole,
        grantee_name: "unknown_fixture_recipient",
      }),
    ],
    [
      "non-owner to owner ACL",
      testUsageBodyAclCatalogRow({
        physical_key: "cleanup-non-owner-to-owner",
        owner_name: testFixtureSessionRole,
        grantor_name: testUsageBodyAclRoles.denied,
        grantee_name: testFixtureSessionRole,
      }),
    ],
    [
      "non-owner self-grant ACL",
      testUsageBodyAclCatalogRow({
        physical_key: "cleanup-non-owner-self-grant",
        owner_name: testFixtureSessionRole,
        grantor_name: testUsageBodyAclRoles.denied,
        grantee_name: testUsageBodyAclRoles.denied,
      }),
    ],
  ])(
    "rejects cleanup-after owner-self ACL exclusion residue %s",
    async (_label, rawResidue) => {
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: { rawPostRevokeCatalogRows: [rawResidue] },
      });

      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE"
      );
      expect(fake.state.rawAclCatalogRows).toContainEqual(rawResidue);
      expect(fake.state.aclRows).toContainEqual(
        expect.objectContaining({
          grantor_name: rawResidue.grantor_name,
          grantee_name: rawResidue.grantee_name,
        })
      );
      expect(fake.state.ownerAclMutationCount).toBe(0);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it.each([
    ["wrong object", { object_name: "outside_fixed_scope" }],
    ["wrong object kind", { object_kind: "sequence" }],
  ] as const)(
    "keeps %s owner-self-like catalog rows outside the fixed-object boundary",
    (_label, overrides) => {
      const row = testUsageBodyAclCatalogRow({
        physical_key: `owner-self-like-${_label}`,
        owner_name: testUsageBodyAclRoles.explicit,
        grantor_name: testUsageBodyAclRoles.explicit,
        grantee_name: testUsageBodyAclRoles.explicit,
        ...overrides,
      });

      expect(testLocalIsExactOwnerSelfAcl(row)).toBe(true);
      expect(testLocalUsageBodyAclSemanticUnionArms(row)).toEqual([]);
      expect(testLocalUsageBodyAclSelectionArms(row)).toEqual([]);
    }
  );

  const invalidMutationIdentityRows = [
    ["zero rows", []],
    [
      "two rows",
      [
        ...validObservedSessionIdentityRows(),
        ...validObservedSessionIdentityRows(),
      ],
    ],
    ["missing key", [{ session_role: testFixtureSessionRole }]],
    [
      "extra key",
      [
        {
          ...validObservedSessionIdentityRows()[0],
          extra: "fixed",
        },
      ],
    ],
    [
      "null",
      [{ session_role: null, effective_role: testFixtureSessionRole }],
    ],
    [
      "non-string",
      [{ session_role: 7, effective_role: testFixtureSessionRole }],
    ],
    ["empty", [{ session_role: "", effective_role: "" }]],
    [
      "unsafe identifier",
      [{ session_role: "unsafe-role!", effective_role: "unsafe-role!" }],
    ],
    [
      "session/current mismatch",
      [
        {
          session_role: testFixtureSessionRole,
          effective_role: "different_fixture_session",
        },
      ],
    ],
    [
      "original identity mismatch",
      [
        {
          session_role: "different_fixture_session",
          effective_role: "different_fixture_session",
        },
      ],
    ],
  ] as const;

  it.each(invalidMutationIdentityRows)(
    "rejects GRANT Client identity %s before mutation",
    async (_label, grantIdentityRows) => {
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: { grantIdentityRows: [...grantIdentityRows] },
      });

      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT"
      );
      expect(fake.state.grantAttemptCount).toBe(0);
      expect(fake.state.revokeAttemptCount).toBe(0);
      expect(fake.state.inventoryCount).toBe(0);
      expect(fake.state.executionCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it.each(invalidMutationIdentityRows)(
    "rejects REVOKE Client identity %s before cleanup mutation",
    async (_label, revokeIdentityRows) => {
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: { revokeIdentityRows: [...revokeIdentityRows] },
      });

      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_REVOKE"
      );
      expect(fake.state.exactGrantCount).toBe(1);
      expect(fake.state.revokeAttemptCount).toBe(0);
      expect(fake.state.inventoryCount).toBe(1);
      expect(fake.state.zeroResidueInventoryCount).toBe(0);
      expect(fake.state.aclRows).toHaveLength(18);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it.each([
    ["query rejection", { rejectOnLabel: "body-acl-grant-identity" }],
    ["query timeout", { hangOnLabel: "body-acl-grant-identity" }],
  ])("rejects GRANT Client identity %s with mutation zero", async (_label, fakeOptions) => {
    const { fake, result } = await runBodyAclProbe({
      fakeOptions,
      deadlineLimits: {
        totalMilliseconds: 100,
        connectMilliseconds: 20,
        queryMilliseconds: 5,
        closeMilliseconds: 20,
      },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT"
    );
    expect(fake.state.grantAttemptCount).toBe(0);
    expect(fake.state.revokeAttemptCount).toBe(0);
    expect(fake.state.inventoryCount).toBe(0);
    expect(result.postflightStartCount).toBe(0);
  });

  it.each([
    ["query rejection", { rejectOnLabel: "body-acl-revoke-identity" }],
    ["query timeout", { hangOnLabel: "body-acl-revoke-identity" }],
  ])("rejects REVOKE Client identity %s with cleanup mutation zero", async (_label, fakeOptions) => {
    const { fake, result } = await runBodyAclProbe({
      fakeOptions,
      deadlineLimits: {
        totalMilliseconds: 100,
        connectMilliseconds: 20,
        queryMilliseconds: 5,
        closeMilliseconds: 20,
      },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_REVOKE"
    );
    expect(fake.state.exactGrantCount).toBe(1);
    expect(fake.state.revokeAttemptCount).toBe(0);
    expect(fake.state.zeroResidueInventoryCount).toBe(0);
    expect(fake.state.aclRows).toHaveLength(18);
    expect(result.postflightStartCount).toBe(0);
  });

  it("rejects a same-value replacement authority object before the GRANT Client identity query", async () => {
    const { fake, result } = await runBodyAclProbe({
      replaceGrantObservedSessionIdentityForTest: true,
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT"
    );
    expect(fake.state.grantIdentityQueryCount).toBe(0);
    expect(fake.state.grantAttemptCount).toBe(0);
  });

  it("rejects a same-value replacement authority object before the REVOKE Client identity query", async () => {
    const { fake, result } = await runBodyAclProbe({
      replaceRevokeObservedSessionIdentityForTest: true,
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_REVOKE"
    );
    expect(fake.state.revokeIdentityQueryCount).toBe(0);
    expect(fake.state.revokeAttemptCount).toBe(0);
    expect(fake.state.aclRows).toHaveLength(18);
  });

  it("keeps GRANT and REVOKE Client identity failures public-safe", async () => {
    const wrongIdentity = "different_fixture_session";
    const grantFailure = await runBodyAclProbe({
      fakeOptions: {
        grantIdentityRows: [
          { session_role: wrongIdentity, effective_role: wrongIdentity },
        ],
      },
    });
    const revokeFailure = await runBodyAclProbe({
      fakeOptions: {
        revokeIdentityRows: [
          { session_role: wrongIdentity, effective_role: wrongIdentity },
        ],
      },
    });

    for (const result of [grantFailure.result, revokeFailure.result]) {
      const publicResult = JSON.stringify(result);
      expect(publicResult).not.toContain(wrongIdentity);
      expect(publicResult).not.toContain(testFixtureSessionRole);
      expect(publicResult).not.toContain("session_role");
      expect(publicResult).not.toContain("effective_role");
    }
  });

  it.each([
    "wrong-object",
    "wrong-privilege",
    "wrong-recipient",
    "wrong-grantor",
    "wrong-privilege-order",
    "wrong-statement-order",
    "prefix-only",
    "trailing-sql",
    "query-config-values-nonempty",
  ])(
    "rejects the independent exact body-object ACL SQL oracle mutation %s",
    async (grantMutationForTest) => {
      const { fake, result } = await runBodyAclProbe({ grantMutationForTest });

      expect(result.bodyAclWindowComplete).toBe(false);
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
      );
      expect(fake.state.exactGrantCount).toBe(0);
      expect(fake.state.executionCount).toBe(0);
      expect(fake.state.exactRevokeCount).toBe(1);
      expect(fake.state.aclRows).toEqual([]);
    }
  );

  it.each([
    [
      "explicit schema lookup",
      { schemaUsageRecipients: [testUsageBodyAclRoles.group] },
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION",
    ],
    [
      "explicit function execution",
      { functionExecuteRecipients: [testUsageBodyAclRoles.group] },
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION",
    ],
    [
      "membership group schema lookup",
      { schemaUsageRecipients: [testUsageBodyAclRoles.explicit] },
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_MEMBERSHIP_RUNTIME_EXECUTION",
    ],
    [
      "membership group function execution",
      { functionExecuteRecipients: [testUsageBodyAclRoles.explicit] },
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_MEMBERSHIP_RUNTIME_EXECUTION",
    ],
  ])(
    "rejects missing independent %s authority before returning a fake result",
    async (_label, fakeOptions, expectedMarker) => {
      const { fake, result } = await runBodyAclProbe({ fakeOptions });

      expect(result.failureMarker).toBe(expectedMarker);
      expect(fake.state.exactRevokeCount).toBe(1);
      expect(fake.state.aclRows).toEqual([]);
    }
  );

  it.each(
    testUsageBodyAclManifest.flatMap((entry) =>
      entry.privileges.map((privilegeType) => [entry.objectName, privilegeType])
    )
  )(
    "fails explicit runtime execution when body-object ACL %s %s is absent even after the catalog oracle passed",
    async (objectName, privilegeType) => {
      const executionRows = validTestUsageBodyAclRows().filter(
        (row) =>
          !(
            row.grantee_name === testUsageBodyAclRoles.explicit &&
            row.object_name === objectName &&
            row.privilege_type === privilegeType
          )
      );
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: { executionRows },
      });

      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION"
      );
      expect(fake.state.executionCount).toBe(1);
      expect(fake.state.exactRevokeCount).toBe(1);
      expect(fake.state.inventoryCount).toBe(2);
      expect(fake.state.aclRows).toEqual([]);
    }
  );

  it.each([
    [
      "missing membership group grant",
      validTestUsageBodyAclRows().filter(
        (row) => row.grantee_name !== testUsageBodyAclRoles.group
      ),
    ],
    [
      "membership leaf direct grants only",
      validTestUsageBodyAclRows().map((row) =>
        row.grantee_name === testUsageBodyAclRoles.group
          ? {
              ...row,
              recipient_relation: "unexpected",
              grantee_name: testUsageBodyAclRoles.member,
            }
          : row
      ),
    ],
  ])("rejects membership runtime execution with %s", async (_label, executionRows) => {
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { executionRows },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_MEMBERSHIP_RUNTIME_EXECUTION"
    );
    expect(fake.state.executionCount).toBe(2);
    expect(fake.state.exactRevokeCount).toBe(1);
    expect(fake.state.aclRows).toEqual([]);
  });

  it.each([
    [
      "wrong grantor",
      validTestUsageBodyAclRows().map((row, index) =>
        index === 0 ? { ...row, grantor_name: "wrong_fixture_grantor" } : row
      ),
    ],
    [
      "wrong grantee",
      validTestUsageBodyAclRows().map((row, index) =>
        index === 0
          ? { ...row, grantee_name: testUsageBodyAclRoles.denied }
          : row
      ),
    ],
    [
      "denied recipient",
      [
        ...validTestUsageBodyAclRows(),
        testUsageBodyAclResidueRow({
          recipient_relation: "unexpected",
          grantee_name: testUsageBodyAclRoles.denied,
        }),
      ],
    ],
    [
      "PUBLIC recipient",
      [
        ...validTestUsageBodyAclRows(),
        testUsageBodyAclResidueRow({
          recipient_relation: "unexpected",
          grantee_name: "PUBLIC",
        }),
      ],
    ],
    [
      "uncovered dependency",
      [
        ...validTestUsageBodyAclRows(),
        testUsageBodyAclResidueRow({
          authority_kind: "uncovered_acl_dependency",
          recipient_relation: "unexpected",
          grantor_name: "UNRESOLVED",
          privilege_type: "ACL_DEPENDENCY",
          grantee_dependency_count: 0,
          grantor_dependency_count: 0,
        }),
      ],
    ],
  ])("fails the post-GRANT exact catalog inventory for %s", async (_label, grantedRows) => {
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { grantedRows },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
    );
    expect(fake.state.executionCount).toBe(0);
    expect(fake.state.exactRevokeCount).toBe(1);
    expect(fake.state.aclRows).toEqual(
      grantedRows.filter(
        (row) =>
          row.grantor_name !== testFixtureSessionRole ||
          !testUsageBodyAclRecipients.some(
            (recipient) => recipient === row.grantee_name
          ) ||
          row.authority_kind !== "explicit_acl"
      )
    );
  });

  it.each([
    [
      "observed grantor to unknown third recipient",
      testUsageBodyAclResidueRow({
        recipient_relation: "unexpected",
        grantee_name: "unknown_fixture_recipient",
      }),
    ],
    [
      "observed grantor to unknown third recipient with an expected privilege",
      testUsageBodyAclResidueRow({
        recipient_relation: "unexpected",
        grantee_name: "unknown_fixture_recipient",
        privilege_type: "UPDATE",
      }),
    ],
    [
      "observed grantor to unknown third recipient with an unexpected privilege",
      testUsageBodyAclResidueRow({
        recipient_relation: "unexpected",
        grantee_name: "unknown_fixture_recipient",
        privilege_type: "DELETE",
      }),
    ],
    [
      "expected grantor with a wrong grantee",
      testUsageBodyAclResidueRow({
        recipient_relation: "unexpected",
        grantee_name: "wrong_fixture_grantee",
      }),
    ],
    [
      "target as both grantee and grantor",
      testUsageBodyAclResidueRow({
        grantor_name: testUsageBodyAclRoles.explicit,
        grantee_name: testUsageBodyAclRoles.explicit,
      }),
    ],
    [
      "grantor-side shared dependency",
      testUsageBodyAclResidueRow({
        authority_kind: "uncovered_acl_dependency",
        recipient_relation: "unexpected",
        grantee_name: "unknown_fixture_recipient",
        privilege_type: "ACL_DEPENDENCY",
        grantee_dependency_count: 0,
        grantor_dependency_count: 0,
      }),
    ],
  ])(
    "rejects unknown third recipient inventory case %s",
    async (_label, unexpectedRow) => {
      const grantedRows = [...validTestUsageBodyAclRows(), unexpectedRow];
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: { grantedRows },
      });

      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
      );
      expect(fake.state.executionCount).toBe(0);
      expect(fake.state.exactRevokeCount).toBe(1);
      expect(fake.state.aclRows).toEqual([unexpectedRow]);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it.each([
    [
      "unknown third recipient ACL only",
      testUsageBodyAclResidueRow({
        recipient_relation: "unexpected",
        grantee_name: "unknown_fixture_recipient",
      }),
    ],
    [
      "unknown third recipient dependency only",
      testUsageBodyAclResidueRow({
        authority_kind: "uncovered_acl_dependency",
        recipient_relation: "unexpected",
        grantor_name: "UNRESOLVED",
        grantee_name: "unknown_fixture_recipient",
        privilege_type: "ACL_DEPENDENCY",
        grantee_dependency_count: 0,
        grantor_dependency_count: 0,
      }),
    ],
  ])(
    "rejects cleanup residue for %s at the zero-residue gate",
    async (_label, residue) => {
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: { postRevokeRows: [residue] },
      });

      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE"
      );
      expect(fake.state.aclRows).toEqual([residue]);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it.each([
    ["expected privilege", {}, true],
    ["unexpected privilege", { privilege_type: "DELETE" }, true],
    ["wrong object", { object_name: "outside_fixed_scope" }, false],
    ["wrong object kind", { object_kind: "sequence" }, false],
  ] as const)(
    "system-wide recipient ACL coverage rejects %s without silent inventory acceptance",
    async (_label, overrides, selectedByCoverage) => {
      const catalogRow = testUsageBodyAclCatalogRow({
        grantor_name: "fixed_unrelated_grantor",
        grantee_name: "PUBLIC",
        ...overrides,
      });
      const dependencies = [
        testUsageBodyAclDependencyCatalogRow({
          role_name: catalogRow.grantor_name,
          object_name: catalogRow.object_name,
        }),
      ];
      const reportedRow = materializeTestUsageBodyAclCatalogRow(
        catalogRow,
        dependencies
      );
      const selectedRows = testLocalSelectedUsageBodyAclRows([catalogRow]);
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: {
          grantedRows: [...validTestUsageBodyAclRows(), reportedRow],
        },
      });

      expect(selectedRows).toHaveLength(selectedByCoverage ? 1 : 0);
      expect(testLocalUsageBodyAclSelectionArms(catalogRow)).toEqual(
        selectedByCoverage ? ["system-wide-recipient"] : []
      );
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
      );
      expect(fake.state.executionCount).toBe(0);
      expect(fake.state.exactRevokeCount).toBe(1);
      expect(fake.state.inventoryCount).toBe(2);
      expect(
        fake.state.queryLog.filter((entry) => entry.label === "body-acl-inventory")
      ).toHaveLength(2);
      expect(fake.state.aclRows).toContainEqual(reportedRow);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
      const publicResult = JSON.stringify(result);
      expect(publicResult).not.toContain(catalogRow.grantor_name);
      expect(publicResult).not.toContain(catalogRow.grantee_name);
    }
  );

  it.each(testTargetAsGrantorRoles)(
    "target-as-grantor ACL coverage rejects unknown recipient authority from target class %s",
    async (grantorName) => {
      const catalogRow = testUsageBodyAclCatalogRow({
        grantor_name: grantorName,
        grantee_name: "unknown_fixture_recipient",
      });
      const dependencies = [
        testUsageBodyAclDependencyCatalogRow({
          physical_key: "target-grantee-dependency",
          role_name: catalogRow.grantee_name,
        }),
        testUsageBodyAclDependencyCatalogRow({
          physical_key: "target-grantor-dependency",
          role_name: catalogRow.grantor_name,
        }),
      ];
      const reportedRow = materializeTestUsageBodyAclCatalogRow(
        catalogRow,
        dependencies
      );
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: {
          grantedRows: [...validTestUsageBodyAclRows(), reportedRow],
        },
      });

      expect(testLocalUsageBodyAclSelectionArms(catalogRow)).toEqual([
        "target-as-grantor",
      ]);
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
      );
      expect(fake.state.executionCount).toBe(0);
      expect(fake.state.exactRevokeCount).toBe(1);
      expect(fake.state.inventoryCount).toBe(2);
      expect(
        fake.state.queryLog.filter((entry) => entry.label === "body-acl-inventory")
      ).toHaveLength(2);
      expect(fake.state.aclRows).toContainEqual(reportedRow);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it.each([
    ["expected privilege", {}, true],
    ["unexpected privilege", { privilege_type: "DELETE" }, true],
    ["wrong object", { object_name: "outside_fixed_scope" }, false],
    ["wrong object kind", { object_kind: "sequence" }, false],
  ] as const)(
    "target-as-grantor ACL coverage preserves fixed-object boundary for %s",
    async (_label, overrides, selectedByCoverage) => {
      const catalogRow = testUsageBodyAclCatalogRow({
        grantor_name: testUsageBodyAclRoles.denied,
        grantee_name: "unknown_fixture_recipient",
        ...overrides,
      });
      const reportedRow = materializeTestUsageBodyAclCatalogRow(catalogRow, [
        testUsageBodyAclDependencyCatalogRow({
          physical_key: "target-grantee-dependency",
          role_name: catalogRow.grantee_name,
          object_name: catalogRow.object_name,
        }),
        testUsageBodyAclDependencyCatalogRow({
          physical_key: "target-grantor-dependency",
          role_name: catalogRow.grantor_name,
          object_name: catalogRow.object_name,
        }),
      ]);
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: {
          grantedRows: [...validTestUsageBodyAclRows(), reportedRow],
        },
      });

      expect(testLocalSelectedUsageBodyAclRows([catalogRow])).toHaveLength(
        selectedByCoverage ? 1 : 0
      );
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
      );
      expect(fake.state.exactRevokeCount).toBe(1);
      expect(fake.state.inventoryCount).toBe(2);
      expect(fake.state.aclRows).toContainEqual(reportedRow);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it("deduplicates overlapping system-wide recipient ACL coverage and target-as-grantor ACL coverage arms without hiding distinct rows", () => {
    const systemAndTarget = testUsageBodyAclCatalogRow({
      physical_key: "system-and-target",
      grantor_name: testUsageBodyAclRoles.denied,
      grantee_name: "PUBLIC",
    });
    const targetAndObserved = testUsageBodyAclCatalogRow({
      physical_key: "target-and-observed",
      grantor_name: testUsageBodyAclRoles.explicit,
      grantee_name: "unknown_fixture_recipient",
    });
    const targetOnBothSides = testUsageBodyAclCatalogRow({
      physical_key: "target-on-both-sides",
      grantor_name: testUsageBodyAclRoles.group,
      grantee_name: testUsageBodyAclRoles.group,
    });
    const distinctPrivilege = testUsageBodyAclCatalogRow({
      ...systemAndTarget,
      physical_key: "system-and-target-distinct",
      privilege_type: "UPDATE",
    });

    expect(testLocalUsageBodyAclSelectionArms(systemAndTarget)).toEqual([
      "system-wide-recipient",
      "target-as-grantor",
    ]);
    expect(
      testLocalUsageBodyAclSelectionArms(
        targetAndObserved,
        testUsageBodyAclRoles.explicit
      )
    ).toEqual(["target-as-grantor", "observed-grantor"]);
    expect(testLocalUsageBodyAclSelectionArms(targetOnBothSides)).toEqual([
      "target-as-grantor",
    ]);
    expect(
      testLocalSelectedUsageBodyAclRows([systemAndTarget, distinctPrivilege])
    ).toEqual([systemAndTarget, distinctPrivilege]);
    expect(testLocalSelectedUsageBodyAclRows([systemAndTarget])).toEqual([
      systemAndTarget,
    ]);
  });

  it.each([
    [
      "system-wide recipient ACL coverage residue",
      testUsageBodyAclResidueRow({
        recipient_relation: "unexpected",
        grantor_name: "fixed_unrelated_grantor",
        grantee_name: "PUBLIC",
        grantee_dependency_count: 0,
      }),
    ],
    [
      "target-as-grantor ACL coverage residue",
      testUsageBodyAclResidueRow({
        recipient_relation: "unexpected",
        grantor_name: testUsageBodyAclRoles.denied,
        grantee_name: "unknown_fixture_recipient",
      }),
    ],
    [
      "observed-grantor ACL coverage residue",
      testUsageBodyAclResidueRow({
        recipient_relation: "unexpected",
        grantee_name: "unknown_fixture_recipient",
      }),
    ],
  ])("rejects cleanup-only %s before runtime work", async (_label, residue) => {
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { postRevokeRows: [residue] },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE"
    );
    expect(fake.state.aclRows).toEqual([residue]);
    expect(fake.state.inventoryCount).toBe(2);
    expect(
      fake.state.queryLog.filter((entry) => entry.label === "body-acl-inventory")
    ).toHaveLength(2);
    expect(result.runtimeAclConfigurationStartCount).toBe(0);
    expect(result.postflightStartCount).toBe(0);
  });

  const dependencyCatalogAclRow = testUsageBodyAclCatalogRow();
  const granteeDependencyCatalogRow = testUsageBodyAclDependencyCatalogRow({
    physical_key: "grantee-dependency",
    role_name: dependencyCatalogAclRow.grantee_name,
  });
  const grantorDependencyCatalogRow = testUsageBodyAclDependencyCatalogRow({
    physical_key: "grantor-dependency",
    role_name: dependencyCatalogAclRow.grantor_name,
  });

  it.each([
    ["valid grantee-side dependency only", [granteeDependencyCatalogRow], 1, 0],
    ["valid grantor-side dependency only", [grantorDependencyCatalogRow], 0, 1],
    ["grantor-side row reused as grantee-side dependency", [grantorDependencyCatalogRow], 0, 1],
    ["grantee-side row reused as grantor-side dependency", [granteeDependencyCatalogRow], 1, 0],
    [
      "correct grantee role with wrong dependency type",
      [
        testUsageBodyAclDependencyCatalogRow({
          role_name: dependencyCatalogAclRow.grantee_name,
          dependency_type: "o",
        }),
        grantorDependencyCatalogRow,
      ],
      0,
      1,
    ],
    [
      "correct grantee role with wrong object",
      [
        testUsageBodyAclDependencyCatalogRow({
          role_name: dependencyCatalogAclRow.grantee_name,
          object_name: "plans",
        }),
        grantorDependencyCatalogRow,
      ],
      0,
      1,
    ],
    [
      "correct grantee role with wrong database boundary",
      [
        testUsageBodyAclDependencyCatalogRow({
          role_name: dependencyCatalogAclRow.grantee_name,
          database_boundary: "other",
        }),
        grantorDependencyCatalogRow,
      ],
      0,
      1,
    ],
    [
      "correct grantor role with wrong class boundary",
      [
        granteeDependencyCatalogRow,
        testUsageBodyAclDependencyCatalogRow({
          role_name: dependencyCatalogAclRow.grantor_name,
          class_boundary: "other",
        }),
      ],
      1,
      0,
    ],
    [
      "unrelated shared dependency",
      [
        testUsageBodyAclDependencyCatalogRow({
          role_name: "unrelated_fixture_role",
        }),
      ],
      0,
      0,
    ],
    [
      "duplicate grantee-side dependency",
      [
        granteeDependencyCatalogRow,
        { ...granteeDependencyCatalogRow, physical_key: "grantee-dependency-2" },
        grantorDependencyCatalogRow,
      ],
      2,
      1,
    ],
    [
      "duplicate grantor-side dependency",
      [
        granteeDependencyCatalogRow,
        grantorDependencyCatalogRow,
        { ...grantorDependencyCatalogRow, physical_key: "grantor-dependency-2" },
      ],
      1,
      2,
    ],
  ] as const)(
    "dependency side separation rejects %s",
    async (_label, dependencies, expectedGranteeCount, expectedGrantorCount) => {
      const actualRow = materializeTestUsageBodyAclCatalogRow(
        dependencyCatalogAclRow,
        [...dependencies]
      );
      const grantedRows = validTestUsageBodyAclRows().map((row) =>
        row.grantor_name === dependencyCatalogAclRow.grantor_name &&
        row.grantee_name === dependencyCatalogAclRow.grantee_name &&
        row.object_name === dependencyCatalogAclRow.object_name &&
        row.privilege_type === dependencyCatalogAclRow.privilege_type
          ? actualRow
          : row
      );
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: { grantedRows },
      });

      expect(actualRow.grantee_dependency_count).toBe(expectedGranteeCount);
      expect(actualRow.grantor_dependency_count).toBe(expectedGrantorCount);
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
      );
      expect(fake.state.executionCount).toBe(0);
      expect(fake.state.exactRevokeCount).toBe(1);
      expect(fake.state.inventoryCount).toBe(2);
      expect(fake.state.aclRows).toEqual([]);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it("keeps grantee-side dependency and grantor-side dependency provenance when one physical dependency serves the same identity on both sides", () => {
    const sameIdentityAcl = testUsageBodyAclCatalogRow({
      grantor_name: testUsageBodyAclRoles.explicit,
      grantee_name: testUsageBodyAclRoles.explicit,
    });
    const sharedPhysicalDependency = testUsageBodyAclDependencyCatalogRow({
      role_name: testUsageBodyAclRoles.explicit,
    });

    expect(
      testLocalUsageBodyAclDependencyCounts(sameIdentityAcl, [
        sharedPhysicalDependency,
      ])
    ).toEqual({
      grantee_dependency_count: 1,
      grantor_dependency_count: 1,
    });
  });

  it("rejects crossed grantee-side dependency and grantor-side dependency ACL identities", async () => {
    const crossedAcl = testUsageBodyAclCatalogRow({
      grantor_name: testUsageBodyAclRoles.explicit,
      grantee_name: testFixtureSessionRole,
    });
    const crossedRow = materializeTestUsageBodyAclCatalogRow(crossedAcl, [
      testUsageBodyAclDependencyCatalogRow({
        physical_key: "crossed-grantee",
        role_name: crossedAcl.grantee_name,
      }),
      testUsageBodyAclDependencyCatalogRow({
        physical_key: "crossed-grantor",
        role_name: crossedAcl.grantor_name,
      }),
    ]);
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: {
        grantedRows: [...validTestUsageBodyAclRows(), crossedRow],
      },
    });

    expect(crossedRow).toMatchObject({
      grantee_dependency_count: 1,
      grantor_dependency_count: 1,
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY"
    );
    expect(fake.state.exactRevokeCount).toBe(1);
    expect(fake.state.inventoryCount).toBe(2);
    expect(fake.state.aclRows).toContainEqual(crossedRow);
    expect(result.runtimeAclConfigurationStartCount).toBe(0);
    expect(result.postflightStartCount).toBe(0);
  });

  it.each([
    [
      "grantee-side dependency residue",
      1,
      0,
      testUsageBodyAclRoles.explicit,
    ],
    [
      "grantor-side dependency residue",
      0,
      1,
      testFixtureSessionRole,
    ],
    [
      "system-wide-recipient grantee-side dependency residue",
      1,
      0,
      testUsageBodyAclRoles.publicProbe,
    ],
    [
      "target-as-grantor grantor-side dependency residue",
      0,
      1,
      testUsageBodyAclRoles.denied,
    ],
    [
      "observed-grantor grantor-side dependency residue",
      0,
      1,
      testFixtureSessionRole,
    ],
  ] as const)(
    "rejects one-side-only %s at zero residue when ACL authority is otherwise absent",
    async (
      _label,
      granteeDependencyCount,
      grantorDependencyCount,
      referencedRoleName
    ) => {
      const dependencyResidue = testUsageBodyAclResidueRow({
        authority_kind: "uncovered_acl_dependency",
        recipient_relation: "unexpected",
        grantor_name: "UNRESOLVED",
        grantee_name: referencedRoleName,
        privilege_type: "ACL_DEPENDENCY",
        grantee_dependency_count: granteeDependencyCount,
        grantor_dependency_count: grantorDependencyCount,
      });
      const { fake, result } = await runBodyAclProbe({
        fakeOptions: { postRevokeRows: [dependencyResidue] },
      });

      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE"
      );
      expect(fake.state.aclRows).toEqual([dependencyResidue]);
      expect(fake.state.inventoryCount).toBe(2);
      expect(
        fake.state.queryLog.filter((entry) => entry.label === "body-acl-inventory")
      ).toHaveLength(2);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
    }
  );

  it.each([
    ["zero rows", []],
    ["two rows", [{ allowed: false }, { allowed: false }]],
    ["missing key", [{}]],
    ["extra key", [{ allowed: false, extra: false }]],
    ["null", [{ allowed: null }]],
    ["string", [{ allowed: "false" }]],
    ["boolean true", [{ allowed: true }]],
  ])("rejects the strict missing-user result contract for %s", async (_label, explicitResultRows) => {
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { explicitResultRows },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION"
    );
    expect(fake.state.exactRevokeCount).toBe(1);
    expect(fake.state.aclRows).toEqual([]);
  });

  it("does not replace a primary usage failure with a later bounded REVOKE failure", async () => {
    const executionRows = validTestUsageBodyAclRows().filter(
      (row) =>
        !(
          row.grantee_name === testUsageBodyAclRoles.explicit &&
          row.object_name === "users" &&
          row.privilege_type === "SELECT"
        )
    );
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: {
        executionRows,
        rejectOnLabel: "body-acl-revoke-exact",
      },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION"
    );
    expect(fake.state.revokeAttemptCount).toBe(1);
    expect(fake.state.exactRevokeCount).toBe(0);
    expect(fake.state.aclRows).toHaveLength(18);
  });

  it("reports an exact bounded REVOKE failure when verification succeeded", async () => {
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { rejectOnLabel: "body-acl-revoke-exact" },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_REVOKE"
    );
    expect(result.bodyAclWindowComplete).toBe(false);
    expect(fake.state.revokeAttemptCount).toBe(1);
    expect(fake.state.exactRevokeCount).toBe(0);
    expect(fake.state.aclRows).toHaveLength(18);
  });

  it.each([
    "wrong-object",
    "wrong-object-kind",
    "wrong-privilege",
    "wrong-privilege-set",
    "wrong-privilege-order",
    "wrong-recipient",
    "wrong-grantor",
    "wrong-statement-order",
    "prefix-only",
    "missing-suffix",
    "trailing-sql",
    "unexpected-separate-parameter",
    "non-array-parameter",
    "query-config-values-nonempty",
    "query-config-values-conflict",
    "action-swap",
    "duplicate-statement",
    "missing-statement",
  ])(
    "rejects the independent action-aware REVOKE exact oracle mutation %s",
    async (revokeMutationForTest) => {
      const { fake, result } = await runBodyAclProbe({ revokeMutationForTest });
      const cleanupIdentityIndex = fake.state.queryLog.findIndex(
        (entry) => entry.label === "body-acl-revoke-identity"
      );
      const mutationEntry = fake.state.queryLog[cleanupIdentityIndex + 1];
      const sqlChanged =
        normalizeExactRevokeSql(mutationEntry.statement) !==
        normalizeExactRevokeSql(exactUsageBodyAclRevokeContract);
      const parameterContractChanged =
        JSON.stringify(mutationEntry.separateParameters) !== "[]" ||
        mutationEntry.queryConfigValues !== undefined;

      expect(sqlChanged || parameterContractChanged).toBe(true);
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE"
      );
      expect(fake.state.exactRevokeCount).toBe(0);
      expect(fake.state.aclRows).toHaveLength(18);
      expect(fake.state.unrelatedAuthorityRows).toEqual([
        { fixed_unrelated_authority: true },
      ]);
      expect(fake.state.zeroResidueInventoryCount).toBe(1);
      expect(result.runtimeAclConfigurationStartCount).toBe(0);
      expect(result.postflightStartCount).toBe(0);
      const publicResult = JSON.stringify(result);
      expect(publicResult).not.toContain(exactUsageBodyAclRevokeContract);
      expect(publicResult).not.toContain(testFixtureSessionRole);
      expect(publicResult).not.toContain("unexpected");
    }
  );

  it("keeps authority residue when the bounded REVOKE SQL is incomplete", async () => {
    const { fake, result } = await runBodyAclProbe({
      revokeMutationForTest: "prefix-only",
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE"
    );
    expect(fake.state.revokeAttemptCount).toBe(1);
    expect(fake.state.exactRevokeCount).toBe(0);
    expect(fake.state.aclRows).toHaveLength(18);
  });

  it.each([
    ["grantor residue", testUsageBodyAclResidueRow()],
    [
      "grantee residue",
      testUsageBodyAclResidueRow({
        grantee_name: testUsageBodyAclRoles.group,
        recipient_relation: "membership_group_direct",
      }),
    ],
    [
      "dependency residue",
      testUsageBodyAclResidueRow({
        authority_kind: "uncovered_acl_dependency",
        recipient_relation: "unexpected",
        grantor_name: "UNRESOLVED",
        privilege_type: "ACL_DEPENDENCY",
        grantee_dependency_count: 0,
        grantor_dependency_count: 0,
      }),
    ],
  ])("rejects post-REVOKE %s before later runtime ACL work", async (_label, residue) => {
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { postRevokeRows: [residue] },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE"
    );
    expect(fake.state.inventoryCount).toBe(2);
    expect(fake.state.aclRows).toHaveLength(1);
  });

  it("attempts bounded cleanup after a usage timeout and leaves an unrelated Client undestroyed", async () => {
    const unrelated = createObservedSessionIdentityFakeClient();
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { hangOnLabel: "missing-user-execution" },
      deadlineLimits: {
        totalMilliseconds: 100,
        connectMilliseconds: 20,
        queryMilliseconds: 5,
        closeMilliseconds: 20,
      },
      unrelatedClient: unrelated.client,
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_EXPLICIT_RUNTIME_EXECUTION"
    );
    expect(result.timedOut).toBe(true);
    expect(result.businessTimedOut).toBe(true);
    expect(result.cleanupTimedOut).toBe(false);
    expect(result.cleanupSharesOriginalDeadline).toBe(true);
    expect(result.businessReservesCleanupDeadline).toBe(true);
    expect(result.phaseTrace).toContain("MIGRATION_USAGE_BODY_ACL_REVOKE");
    expect(fake.state.exactRevokeCount).toBe(1);
    expect(fake.state.zeroResidueInventoryCount).toBe(1);
    expect(fake.state.destroyCount).toBe(1);
    const timedOutBusinessClient = fake.state.clients.find((client) =>
      client.queryLabels.includes("missing-user-execution")
    );
    const cleanupClient = fake.state.clients.find(
      (client) => client.queryLabels[0] === "body-acl-revoke-identity"
    );
    expect(timedOutBusinessClient).toMatchObject({
      destroy: 1,
      end: 0,
    });
    expect(cleanupClient).toMatchObject({
      connect: 1,
      destroy: 0,
      end: 1,
      queryLabels: [
        "body-acl-revoke-identity",
        "body-acl-revoke-exact",
        "body-acl-inventory",
      ],
    });
    const timeoutCleanupRevoke = fake.state.queryLog.find(
      (entry) => entry.label === "body-acl-revoke-exact"
    );
    expect(timeoutCleanupRevoke?.statement.split(";\n")).toHaveLength(5);
    expect(timeoutCleanupRevoke?.separateParameters).toEqual([]);
    expect(result.businessActiveClientCount).toBe(0);
    expect(result.cleanupActiveClientCount).toBe(0);
    expect(result.postflightStartCount).toBe(0);
    expect(result.unrelatedDestroyed).toBe(false);
    expect(result.unrelatedActiveClientCount).toBe(0);
    expect(unrelated.state.destroy).toBe(0);
    expect(unrelated.state.end).toBe(1);
  });

  it("fails closed before GRANT when the cleanup reserve cannot fit inside the original deadline", async () => {
    const { fake, result } = await runBodyAclProbe({
      deadlineLimits: {
        totalMilliseconds: 50,
        connectMilliseconds: 20,
        queryMilliseconds: 5,
        closeMilliseconds: 20,
      },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN"
    );
    expect(result.bodyAclWindowComplete).toBe(false);
    expect(result.cleanupReserveMilliseconds).toBeNull();
    expect(fake.state.connectCount).toBe(0);
    expect(fake.state.grantAttemptCount).toBe(0);
    expect(fake.state.revokeAttemptCount).toBe(0);
    expect(fake.state.inventoryCount).toBe(0);
    expect(result.postflightStartCount).toBe(0);
  });

  it("fails closed when the cleanup reserve is exhausted during an actual REVOKE query", async () => {
    const { fake, result } = await runBodyAclProbe({
      fakeOptions: { hangOnLabel: "body-acl-revoke-exact" },
      deadlineLimits: {
        totalMilliseconds: 100,
        connectMilliseconds: 20,
        queryMilliseconds: 5,
        closeMilliseconds: 20,
      },
    });

    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_REVOKE"
    );
    expect(result.cleanupTimedOut).toBe(true);
    expect(fake.state.revokeAttemptCount).toBe(1);
    expect(fake.state.zeroResidueInventoryCount).toBe(0);
    expect(fake.state.aclRows).toHaveLength(18);
    expect(result.postflightStartCount).toBe(0);
  });

  it("keeps the body-object ACL manifest fixed, least-privilege, invoker-only, and ahead of runtime ACL configuration", async () => {
    const source = await readFile(
      resolve(repositoryRoot, "scripts/test-staging-database-preflight-postgres.mjs"),
      "utf8"
    );
    const boundaryStart = source.indexOf(
      "async function runTemporaryUsageBodyAclWindow({"
    );
    const boundaryEnd = source.indexOf(
      "async function configureRuntimeAcl",
      boundaryStart
    );
    const boundarySource = source.slice(boundaryStart, boundaryEnd);
    const inventoryQueryStart = source.indexOf(
      "const USAGE_BODY_ACL_INVENTORY_SQL = `"
    );
    const inventoryQueryEnd = source.indexOf(
      "const FIXTURE_EXTENSION_CONTRACT",
      inventoryQueryStart
    );
    const inventoryQuerySource = source.slice(
      inventoryQueryStart,
      inventoryQueryEnd
    );
    const applyStart = source.indexOf(
      "async function applyMigrationsAndRuntimeAcl("
    );
    const applyEnd = source.indexOf("function usageSignatureArraySql", applyStart);
    const applySource = source.slice(applyStart, applyEnd);
    const grantWindowIndex = applySource.indexOf(
      "await runTemporaryUsageBodyAclWindow({"
    );
    const runtimeAclIndex = applySource.indexOf(
      "await runMigrationRuntimeAclConfigurationPhase",
      grantWindowIndex
    );
    const revokeIndex = boundarySource.indexOf(
      "await runMigrationUsageBodyAclRevokePhase"
    );
    const zeroResidueIndex = boundarySource.indexOf(
      "runMigrationUsageBodyAclZeroResiduePhase",
      revokeIndex
    );
    const boundaryReturnIndex = boundarySource.indexOf("return verificationResult");

    expect(source).toContain("const USAGE_BODY_OBJECT_ACL_MANIFEST = Object.freeze([");
    expect(inventoryQuerySource).toContain("dependency_entry.deptype = 'a'");
    expect(inventoryQuerySource).toContain("observed_grantor AS (");
    expect(inventoryQuerySource).toContain("role_entry.rolname = $2::text");
    expect(inventoryQuerySource).toContain("all_explicit_acl.grantee = 0");
    expect(inventoryQuerySource).toContain(
      "all_explicit_acl.grantee IN (SELECT oid FROM target_roles)"
    );
    expect(inventoryQuerySource).toContain(
      "all_explicit_acl.grantor IN (SELECT oid FROM target_roles)"
    );
    expect(inventoryQuerySource).toContain(
      "all_explicit_acl.grantor = (SELECT oid FROM observed_grantor)"
    );
    expect(inventoryQuerySource).toContain(
      "all_explicit_acl.grantee = all_explicit_acl.relowner"
    );
    expect(inventoryQuerySource).toContain(
      "all_explicit_acl.grantor = all_explicit_acl.relowner"
    );
    expect(inventoryQuerySource).not.toContain(
      "all_explicit_acl.grantee <> all_explicit_acl.relowner"
    );
    const ownerSelfFilterIndex = inventoryQuerySource.indexOf(
      "WHERE NOT (\n      all_explicit_acl.grantee = all_explicit_acl.relowner\n      AND all_explicit_acl.grantor = all_explicit_acl.relowner\n    )"
    );
    const systemWideArmIndex = inventoryQuerySource.indexOf(
      "all_explicit_acl.grantee = 0",
      ownerSelfFilterIndex
    );
    expect(inventoryQuerySource).toContain("relation_entry.relowner");
    expect(ownerSelfFilterIndex).toBeGreaterThan(-1);
    expect(systemWideArmIndex).toBeGreaterThan(ownerSelfFilterIndex);
    expect(inventoryQuerySource).toContain("explicit_acl_dependency_sides AS (");
    expect(inventoryQuerySource).toContain("'grantee'::text AS dependency_side");
    expect(inventoryQuerySource).toContain("'grantor'::text AS dependency_side");
    const dependencySidesStart = inventoryQuerySource.indexOf(
      "explicit_acl_dependency_sides AS ("
    );
    const dependencySidesEnd = inventoryQuerySource.indexOf(
      "), relevant_dependencies AS (",
      dependencySidesStart
    );
    const dependencySidesSource = inventoryQuerySource.slice(
      dependencySidesStart,
      dependencySidesEnd
    );
    expect(dependencySidesSource.match(/FROM explicit_acl/g)).toHaveLength(2);
    expect(dependencySidesSource).not.toContain("FROM all_explicit_acl");
    expect(inventoryQuerySource).toContain(
      "dependency_entry.refobjid = explicit_acl.grantee"
    );
    expect(inventoryQuerySource).toContain(
      "dependency_entry.refobjid = explicit_acl.grantor"
    );
    expect(inventoryQuerySource).toContain("grantee_dependency_count");
    expect(inventoryQuerySource).toContain("grantor_dependency_count");
    expect(inventoryQuerySource).not.toContain("shared_dependency_covered");
    expect(inventoryQuerySource).not.toContain("dependency_entry.refobjid IN (");
    expect(source).toContain(
      "USAGE_BODY_ACL_INVENTORY_ROLE_SCOPE,\n      grantorName"
    );
    expect(source).toContain("assertMissingUserUsageExecutionResult(result)");
    expect(source).toContain("GRANTED BY ${grantor}");
    expect(source).not.toMatch(/GRANT\s+ALL\s+ON\s+TABLE/i);
    expect(exactUsageBodyAclGrantContract).not.toContain("PUBLIC");
    expect(exactUsageBodyAclGrantContract).not.toContain(testUsageBodyAclRoles.denied);
    expect(exactUsageBodyAclGrantContract).not.toContain(testUsageBodyAclRoles.member);
    expect(exactUsageBodyAclGrantContract).not.toContain(
      testUsageBodyAclRoles.productionRuntime
    );
    expect(grantWindowIndex).toBeGreaterThan(-1);
    expect(revokeIndex).toBeGreaterThan(-1);
    expect(zeroResidueIndex).toBeGreaterThan(revokeIndex);
    expect(boundaryReturnIndex).toBeGreaterThan(zeroResidueIndex);
    expect(runtimeAclIndex).toBeGreaterThan(grantWindowIndex);
    expect(boundarySource).toContain(
      "assertUsageBodyAclMutationClientIdentity("
    );
    expect(boundarySource).toContain(
      "usageBodyAclCleanupReserveMilliseconds(context.limits)"
    );
    expect(boundarySource).toContain("createReservedDeadlineContext(");
    expect(boundarySource).not.toContain("createDeadlineContext(");
    expect(boundarySource).not.toContain("performance.now() +");
    expect(boundarySource).not.toContain("configuration.role");
    expect(applySource).toContain(
      "async verificationOperation(businessContext)"
    );
    expect(applySource).toContain(
      "verifyUsageAclInheritance(\n            businessContext"
    );
    expect(applySource).toContain(
      "verifyPlanResolution(businessContext, clientFactory, configuration)"
    );
    expect(applySource).toContain(
      "verifyReservationLifecycle(\n            businessContext"
    );
  });
});

describe("connection-only external fixture boundary", () => {
  it("has no database lifecycle authority or lifecycle adapter seam", async () => {
    expect(harnessAuthorityBoundaryForTests()).toEqual({
      databaseProcessAuthority: 0,
      databasePortAuthority: 0,
      databaseFilesystemAuthority: 0,
      databaseTerminationAuthority: 0,
      databaseLifecycleAdapters: 0,
      fixtureOwner: "github_actions_service_container",
      connectionInputs: [
        "ACTUSTUBE_STAGING_HARNESS_DATABASE_URL",
        "ACTUSTUBE_STAGING_HARNESS_EXPECTED_DATABASE",
        "ACTUSTUBE_STAGING_HARNESS_EXPECTED_ROLE",
        "ACTUSTUBE_STAGING_HARNESS_EXPECTED_MAJOR",
        "ACTUSTUBE_STAGING_HARNESS_EXPECTED_MIGRATION_MAX",
      ],
    });

    const source = await readFile(postgresHarnessModule, "utf8");
    for (const forbidden of [
      "embedded-postgres",
      "EmbeddedPostgres",
      "node:child_process",
      "test-staging-database-fault-lifecycle",
      "runBenignChildLifecycleProbeForTests",
      "spawn(",
      "spawnSync",
      "taskkill",
      "powershell",
      "postmaster.pid",
      "process.kill",
      "mkdtemp",
      "tmpdir",
      "createServer",
      "node:fs",
      "node:net",
      "node:os",
      "databaseDir",
      "persistent: true",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("github_actions_service_container");
    expect(source).toContain("clientFactory");

    const harnessExports = await import(
      "../scripts/test-staging-database-preflight-postgres.mjs"
    );
    expect(Object.keys(harnessExports).sort()).toEqual(
      [
        "EXTERNAL_FIXTURE_EXTENSION_CONTRACT_FOR_TESTS",
        "HARNESS_DEADLINE_LIMITS_FOR_TESTS",
        "INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS",
        "TEMPORARY_AUTHORITY_INVENTORY_SQL_FOR_TESTS",
        "createIndependentDeadlineContextsForTests",
        "externalFixtureSuccessResultForTests",
        "harnessAuthorityBoundaryForTests",
        "runConnectionOnlyHarness",
        "runExternalFixturePhaseProbeForTests",
        "runGrantInventoryDiagnosticOutputProbeForTests",
        "runHarnessDeadlineProbeForTests",
        "runHarnessTransactionBoundaryProbeForTests",
        "runMigrationOwnerBoundaryProbeForTests",
        "runOwnershipCanonicalizationProbeForTests",
        "runUsageBodyAclBoundaryProbeForTests",
        "validateExternalFixtureConfigurationForTests",
        "validateIndependentExtensionInventoryForTests",
      ].sort()
    );

    const connectionFactory = vi.fn();
    await expect(
      runConnectionOnlyHarness({
        environment: externalFixtureEnvironment({
          ACTUSTUBE_STAGING_HARNESS_DATABASE_URL:
            "postgresql://actustube_ci_fixture:p@localhost:5432/actustube_ci_fixture",
        }),
        clientFactory: connectionFactory,
      })
    ).rejects.toThrow("EXTERNAL_FIXTURE_URL_INVALID");
    expect(connectionFactory).not.toHaveBeenCalled();

    const faultSource = await readFile(faultLifecycleModule, "utf8");
    expect(faultSource).toContain('from "node:child_process"');
    expect(faultSource).toContain("process.execPath");
    expect(faultSource).toContain("shell: false");
    expect(faultSource).toContain('stdio: ["ignore", "ignore", "ignore", "ipc"]');
    for (const forbidden of [
      "embedded-postgres",
      'from "pg"',
      "drizzle",
      "postgres",
      "node:fs",
      "node:net",
      "createServer",
      "process.kill(",
      "taskkill",
    ]) {
      expect(faultSource.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("fixes every harness-owned deadline at or below the authorized maximum", () => {
    expect(HARNESS_DEADLINE_LIMITS_FOR_TESTS).toMatchObject({
      totalMilliseconds: 300_000,
      connectMilliseconds: 10_000,
      queryMilliseconds: 30_000,
      statementMilliseconds: 20_000,
      lockMilliseconds: 5_000,
      idleTransactionMilliseconds: 20_000,
      closeMilliseconds: 5_000,
    });
    expect(HARNESS_DEADLINE_LIMITS_FOR_TESTS.phaseMilliseconds).toBeLessThanOrEqual(
      HARNESS_DEADLINE_LIMITS_FOR_TESTS.totalMilliseconds
    );
    expect(
      HARNESS_DEADLINE_LIMITS_FOR_TESTS.migrationMilliseconds
    ).toBeLessThanOrEqual(HARNESS_DEADLINE_LIMITS_FOR_TESTS.totalMilliseconds);
  });

  it.each([
    [
      "wrong privilege",
      "ALTER DEFAULT PRIVILEGES REVOKE USAGE ON FUNCTIONS FROM PUBLIC",
      [],
    ],
    [
      "wrong object category",
      "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON TABLES FROM PUBLIC",
      [],
    ],
    [
      "wrong grantee",
      'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "actustube_ci_other_role"',
      [],
    ],
    [
      "unexpected parameter",
      exactProductionDefaultPrivilegeContract.statement,
      ["unexpected"],
    ],
    [
      "trailing executable SQL",
      `${exactProductionDefaultPrivilegeContract.statement}; SELECT 1`,
      [],
    ],
    ["prefix only", "ALTER DEFAULT PRIVILEGES", []],
  ] as const)(
    "rejects a non-exact ALTER DEFAULT PRIVILEGES oracle for %s",
    async (_label, statement, parameters) => {
      const fake = createMigrationOwnerFakeClient();
      await fake.client.query(statement, [...parameters]);
      expect(fake.state.labels).toEqual(["unknown-fixed-query"]);
      expect(fake.state.defaultPrivilegeAttemptCount).toBe(1);
      expect(fake.state.defaultPrivilegeMutationCount).toBe(0);
    }
  );

  it("rejects ALTER DEFAULT PRIVILEGES QueryConfig values outside the exact empty parameter contract", async () => {
    const fake = createMigrationOwnerFakeClient();
    await fake.client.query({
      text: exactProductionDefaultPrivilegeContract.statement,
      values: ["unexpected"],
    });
    expect(fake.state.labels).toEqual(["unknown-fixed-query"]);
    expect(fake.state.parameters).toEqual([["unexpected"]]);
    expect(fake.state.defaultPrivilegeAttemptCount).toBe(1);
    expect(fake.state.defaultPrivilegeMutationCount).toBe(0);
  });

  describe(
    "production pre-mutation wrapper ALTER DEFAULT PRIVILEGES production mutation order",
    () => {
  it("exercises the distinct owner boundary in the fixed production order", async () => {
    const fake = createMigrationOwnerFakeClient();
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    const labels = fake.state.labels;
    expect(result).toMatchObject({
      failureMarker: null,
      timedOut: false,
      activeClientCount: 0,
      productionApplyInvocations: 1,
      migrationCallbackInvocations: 3,
      laterVerificationStubInvocations: 1,
      observedIdentityFrozen: true,
      observedIdentityReferencePreserved: true,
      boundaryReobservationDistinct: true,
    });
    expect(labels.slice(0, 6)).toEqual([
      "observed-session-identity",
      "production-alter-default-privileges",
      "create-fixed-roles",
      "observed-session-identity",
      "initial-role-contract",
      "minimal-grants",
    ]);
    expect(
      labels.filter((label) => label === "observed-session-identity")
    ).toHaveLength(2);
    expect(
      labels.filter(
        (label) => label === "production-alter-default-privileges"
      )
    ).toHaveLength(1);
    expect(
      labels.filter((label) => label === "create-fixed-roles")
    ).toHaveLength(1);
    expect(
      labels.filter((label) => label === "minimal-grants")
    ).toHaveLength(1);
    const semanticMilestones = [
      "set-migration-executor",
      "migration-executor-identity",
      "migration-callback-baseline",
      "reset-role",
      "legacy-owner-baseline",
      "legacy-owner-membership",
      "before-final-boundary",
      "set-migration-executor",
      "role-precondition",
      "public-acl-failure-migration",
      "reset-role",
      "legacy-acl-hash",
      "set-migration-executor",
      "role-precondition",
      "migration-callback-final",
      "reset-role",
      "owner-postcondition",
      "set-migration-executor",
      "role-precondition",
      "migration-callback-replay",
      "reset-role",
      "owner-postcondition",
    ];
    let previousMilestoneIndex = 5;
    for (const milestone of semanticMilestones) {
      const milestoneIndex = labels.indexOf(
        milestone,
        previousMilestoneIndex + 1
      );
      expect(milestoneIndex).toBeGreaterThan(previousMilestoneIndex);
      previousMilestoneIndex = milestoneIndex;
    }
    expect(result.operationStarts).toMatchObject({
      connect: 1,
      close: 1,
      migration: 4,
    });
    expect(result.operationStarts.query).toBe(fake.state.query.length);
    expect(result.operationStarts.query).toBeGreaterThan(23);
    expect(fake.state).toMatchObject({
      connect: 1,
      end: 1,
      destroy: 0,
      usable: false,
      identityQueryCount: 2,
      defaultPrivilegeAttemptCount: 1,
      defaultPrivilegeMutationCount: 1,
      migrationRunCount: 4,
    });
    expect(fake.state.migrationLedger).toHaveLength(7);
    expect(
      normalizeExactRevokeSql(fake.state.query[1])
    ).toBe(
      normalizeExactRevokeSql(
        exactProductionDefaultPrivilegeContract.statement
      )
    );
    expect(fake.state.parameters[1]).toEqual(
      exactProductionDefaultPrivilegeContract.parameters
    );
    expect(fake.state.callbackObservations).toHaveLength(3);
    expect(fake.state.callbackObservations.map((entry) => entry.kind)).toEqual([
      "baseline",
      "final",
      "replay",
    ]);
    expect(
      fake.state.callbackObservations.every(
        (entry) =>
          entry.client === fake.client &&
          entry.activeRole === testMigrationExecutor
      )
    ).toBe(true);
    const baselineIndex = labels.indexOf("migration-callback-baseline");
    const finalIndex = labels.indexOf("migration-callback-final");
    const replayIndex = labels.indexOf("migration-callback-replay");
    expect(baselineIndex).toBeGreaterThan(labels.indexOf("set-migration-executor"));
    expect(baselineIndex).toBeLessThan(labels.indexOf("reset-role"));
    expect(finalIndex).toBeGreaterThan(labels.indexOf("role-precondition"));
    expect(finalIndex).toBeLessThan(labels.indexOf("reset-role", finalIndex + 1));
    expect(replayIndex).toBeGreaterThan(
      labels.lastIndexOf("role-precondition")
    );
    expect(replayIndex).toBeLessThan(labels.lastIndexOf("reset-role"));
    const preconditionParameterIndexes = labels
      .map((label, index) => (label === "role-precondition" ? index : -1))
      .filter((index) => index >= 0);
    expect(preconditionParameterIndexes).toHaveLength(3);
    for (const index of preconditionParameterIndexes) {
      expect(fake.state.parameters[index]).toEqual([
        testUsageOwnerIdentities[0],
        testLegacyOwner,
        testMigrationExecutor,
      ]);
    }
    const postconditionParameterIndexes = labels
      .map((label, index) => (label === "owner-postcondition" ? index : -1))
      .filter((index) => index >= 0);
    expect(postconditionParameterIndexes).toHaveLength(2);
    for (const index of postconditionParameterIndexes) {
      expect(fake.state.parameters[index]).toEqual([testUsageOwnerIdentities]);
    }
    const grantStatement = fake.state.query[labels.indexOf("minimal-grants")];
    expect(grantStatement).toContain("GRANT USAGE, CREATE ON SCHEMA drizzle");
    expect(grantStatement).toContain(testMigrationExecutor);
    expect(labels.indexOf("minimal-grants")).toBeLessThan(baselineIndex);
    expect(JSON.stringify(result)).not.toMatch(
      /actustube_ci_usage_|alter function|grant create|owner to/i
    );

    const source = await readFile(postgresHarnessModule, "utf8");
    expect(
      source.match(/async function orchestrateUsageMigrationOwnerBoundary/g)
    ).toHaveLength(1);
    expect(source).not.toContain("() => Promise.resolve()");
    const probeBody = source.slice(
      source.indexOf(
        "export async function runMigrationOwnerBoundaryProbeForTests"
      ),
      source.indexOf(
        "export async function runOwnershipCanonicalizationProbeForTests"
      )
    );
    expect(probeBody).toContain("applyMigrationsAndRuntimeAcl(");
    expect(probeBody).not.toContain(
      "runPreMutationSessionIdentityBoundary("
    );
    expect(probeBody).not.toContain(
      "orchestrateUsageMigrationOwnerBoundary("
    );
    const applyBody = source.slice(
      source.indexOf("async function applyMigrationsAndRuntimeAcl"),
      source.indexOf("function usageSignatureArraySql")
    );
    const identityBoundaryIndex = applyBody.indexOf(
      "runPreMutationSessionIdentityBoundary("
    );
    const defaultPrivilegeIndex = applyBody.indexOf(
      exactProductionDefaultPrivilegeContract.statement
    );
    const ownerBoundaryIndex = applyBody.indexOf(
      "orchestrateUsageMigrationOwnerBoundary("
    );
    expect(identityBoundaryIndex).toBeGreaterThanOrEqual(0);
    expect(defaultPrivilegeIndex).toBeGreaterThan(identityBoundaryIndex);
    expect(ownerBoundaryIndex).toBeGreaterThan(defaultPrivilegeIndex);
    expect(applyBody).toContain("applyMigrationCountWithinBoundary(");
    expect(applyBody).toContain("verifyPublicAclMigrationFailure(");
    expect(applyBody).not.toContain("fixed_migration_callback_probe");
    expect(applyBody).not.toContain("fixed_before_final_boundary");
  });
    }
  );

  it("rejects a same-value replacement of the original pre-mutation identity reference", async () => {
    const fake = createMigrationOwnerFakeClient();
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testCallerConfigurationRole,
      replaceObservedIdentityForTest: true,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result).toMatchObject({
      failureMarker:
        "EXTERNAL_FIXTURE_OBSERVED_SESSION_IDENTITY_REFERENCE_MISMATCH",
      productionApplyInvocations: 1,
      migrationCallbackInvocations: 0,
      laterVerificationStubInvocations: 0,
      observedIdentityReferencePreserved: false,
      boundaryReobservationDistinct: false,
      timedOut: false,
    });
    expect(fake.state.labels).toEqual(["observed-session-identity"]);
    expect(fake.state.labels).not.toContain("create-fixed-roles");
    expect(fake.state.labels).not.toContain("minimal-grants");
    expect(fake.state.callbackObservations).toEqual([]);
    expect(fake.state.defaultPrivilegeAttemptCount).toBe(0);
    expect(fake.state.defaultPrivilegeMutationCount).toBe(0);
    expect(result.operationStarts.migration).toBe(0);
    expect(JSON.stringify(result)).not.toContain(testFixtureSessionRole);
  });

  it("uses the Migration-boundary re-observation only as a value comparison", async () => {
    const fake = createMigrationOwnerFakeClient({
      boundaryObservedIdentityRows: validObservedSessionIdentityRows({
        sessionRole: "actustube_ci_boundary_changed",
        effectiveRole: "actustube_ci_boundary_changed",
      }),
    });
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_INITIAL_SESSION_IDENTITY_MISMATCH"
    );
    expect(fake.state.labels).toEqual([
      "observed-session-identity",
      "production-alter-default-privileges",
      "create-fixed-roles",
      "observed-session-identity",
    ]);
    expect(result.observedIdentityReferencePreserved).toBe(true);
    expect(result).toMatchObject({
      productionApplyInvocations: 1,
      migrationCallbackInvocations: 0,
      laterVerificationStubInvocations: 0,
    });
    expect(fake.state.defaultPrivilegeMutationCount).toBe(1);
    expect(fake.state.labels).not.toContain("minimal-grants");
    expect(fake.state.callbackObservations).toEqual([]);
    expect(result.operationStarts.migration).toBe(0);
  });

  describe("production wrapper identity failure", () => {
  it.each([
    [
      "caller role differs from observed session role",
      "actustube_ci_other_caller",
      validObservedSessionIdentityRows(),
    ],
    [
      "caller role differs from observed current role",
      testCallerConfigurationRole,
      validObservedSessionIdentityRows({
        sessionRole: testInitialObservedSessionRole,
        effectiveRole: "actustube_ci_other_current",
      }),
    ],
    [
      "observed session and current roles differ",
      testCallerConfigurationRole,
      validObservedSessionIdentityRows({
        sessionRole: "actustube_ci_other_session",
        effectiveRole: testInitialObservedCurrentRole,
      }),
    ],
    ["missing row", testCallerConfigurationRole, []],
    [
      "duplicate row",
      testCallerConfigurationRole,
      [
        ...validObservedSessionIdentityRows(),
        ...validObservedSessionIdentityRows(),
      ],
    ],
    [
      "missing key",
      testCallerConfigurationRole,
      [{ session_role: testInitialObservedSessionRole }],
    ],
    [
      "extra key",
      testCallerConfigurationRole,
      [
        {
          ...validObservedSessionIdentityRows()[0],
          unexpected_key: true,
        },
      ],
    ],
    [
      "null role",
      testCallerConfigurationRole,
      validObservedSessionIdentityRows({ sessionRole: null }),
    ],
    [
      "non-string role",
      testCallerConfigurationRole,
      validObservedSessionIdentityRows({ sessionRole: 42 }),
    ],
    [
      "empty role",
      testCallerConfigurationRole,
      validObservedSessionIdentityRows({ sessionRole: "" }),
    ],
    [
      "invalid identifier",
      testCallerConfigurationRole,
      validObservedSessionIdentityRows({ sessionRole: "invalid role" }),
    ],
  ] as const)(
    "rejects the initial DB-observed identity when %s",
    async (_label, callerRole, observedIdentityRows) => {
      const fake = createMigrationOwnerFakeClient({
        initialObservedIdentityRows: [...observedIdentityRows],
      });
      const result = await runMigrationOwnerBoundaryProbeForTests({
        client: fake.client,
        expectedSessionRole: callerRole,
        deadlineLimits: {
          totalMilliseconds: 500,
          connectMilliseconds: 100,
          queryMilliseconds: 100,
          closeMilliseconds: 100,
          phaseMilliseconds: 100,
          migrationMilliseconds: 100,
        },
      });
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_INITIAL_SESSION_IDENTITY_MISMATCH"
      );
      expect(result).toMatchObject({
        productionApplyInvocations: 1,
        migrationCallbackInvocations: 0,
        laterVerificationStubInvocations: 0,
      });
      expect(fake.state.labels).toEqual(["observed-session-identity"]);
      expect(fake.state.labels).not.toContain("create-fixed-roles");
      expect(fake.state.labels).not.toContain("minimal-grants");
      expect(fake.state.callbackObservations).toEqual([]);
      expect(fake.state.defaultPrivilegeAttemptCount).toBe(0);
      expect(fake.state.defaultPrivilegeMutationCount).toBe(0);
      expect(result.operationStarts.migration).toBe(0);
      expect(result.observedIdentityFrozen).toBe(false);
      expect(fake.state.destroy).toBe(0);
      expect(fake.state.end).toBe(1);
      const publicResult = JSON.stringify(result);
      expect(publicResult).not.toContain(callerRole);
      expect(publicResult).not.toContain(testInitialObservedSessionRole);
    }
  );

  it("fails closed when the initial DB-observed identity query rejects", async () => {
    const fake = createMigrationOwnerFakeClient({
      rejectOnLabel: "observed-session-identity",
    });
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe("EXTERNAL_FIXTURE_VERIFICATION_FAILED");
    expect(result).toMatchObject({
      productionApplyInvocations: 1,
      migrationCallbackInvocations: 0,
      laterVerificationStubInvocations: 0,
    });
    expect(fake.state.labels).toEqual(["observed-session-identity"]);
    expect(fake.state.labels).not.toContain("create-fixed-roles");
    expect(fake.state.labels).not.toContain("minimal-grants");
    expect(fake.state.callbackObservations).toEqual([]);
    expect(fake.state.defaultPrivilegeAttemptCount).toBe(0);
    expect(fake.state.defaultPrivilegeMutationCount).toBe(0);
    expect(result.operationStarts.migration).toBe(0);
    expect(fake.state.end).toBe(1);
    expect(fake.state.destroy).toBe(0);
  });
  });

  describe("production wrapper timeout", () => {
  it("bounds the initial DB-observed identity query timeout before grants", async () => {
    vi.useFakeTimers();
    try {
      const fake = createMigrationOwnerFakeClient({
        hangOnLabel: "observed-session-identity",
      });
      const unrelated = createMigrationOwnerFakeClient();
      const unhandledRejectionListeners = process.listenerCount(
        "unhandledRejection"
      );
      const pending = runMigrationOwnerBoundaryProbeForTests({
        client: fake.client,
        unrelatedClient: unrelated.client,
        expectedSessionRole: testCallerConfigurationRole,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 20,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      await vi.advanceTimersByTimeAsync(120);
      const result = await pending;
      expect(result).toMatchObject({
        failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
        timedOut: true,
        destroyed: true,
        productionApplyInvocations: 1,
        migrationCallbackInvocations: 0,
        laterVerificationStubInvocations: 0,
        unrelatedActiveClientCount: 0,
        unrelatedUsable: false,
        unrelatedDestroyed: false,
        observedIdentityFrozen: false,
      });
      expect(fake.state.labels).toEqual(["observed-session-identity"]);
      expect(fake.state.labels).not.toContain("create-fixed-roles");
      expect(fake.state.labels).not.toContain("minimal-grants");
      expect(fake.state.callbackObservations).toEqual([]);
      expect(fake.state.defaultPrivilegeAttemptCount).toBe(0);
      expect(fake.state.defaultPrivilegeMutationCount).toBe(0);
      expect(result.operationStarts.migration).toBe(0);
      expect(fake.state.destroy).toBe(1);
      expect(fake.state.end).toBe(0);
      expect(fake.state.queriesAtDestroy).toBe(fake.state.query.length);
      expect(unrelated.state).toMatchObject({
        connect: 1,
        query: [],
        end: 1,
        destroy: 0,
        usable: false,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(process.listenerCount("unhandledRejection")).toBe(
        unhandledRejectionListeners
      );
    } finally {
      vi.useRealTimers();
    }
  });
  });

  it.each([
    ["missing legacy owner", validInitialMigrationBoundaryRoles().slice(1)],
    [
      "duplicate role row",
      [
        validInitialMigrationBoundaryRoles()[0],
        validInitialMigrationBoundaryRoles()[0],
      ],
    ],
    [
      "duplicate role OID",
      validInitialMigrationBoundaryRoles().map((row, index) =>
        index === 1 ? { ...row, role_oid: testLegacyOwnerOid } : row
      ),
    ],
    [
      "noncanonical role OID",
      validInitialMigrationBoundaryRoles().map((row, index) =>
        index === 1 ? { ...row, role_oid: "081002" } : row
      ),
    ],
    [
      "elevated legacy owner",
      validInitialMigrationBoundaryRoles().map((row, index) =>
        index === 0 ? { ...row, role_restricted: false } : row
      ),
    ],
    [
      "session or runtime OID collision",
      validInitialMigrationBoundaryRoles().map((row, index) =>
        index === 0 ? { ...row, oid_is_separated: false } : row
      ),
    ],
    [
      "unknown catalog key",
      validInitialMigrationBoundaryRoles().map((row, index) =>
        index === 1 ? { ...row, unknown_key: true } : row
      ),
    ],
  ])("rejects the initial dual-role contract when %s", async (_label, rows) => {
    const fake = createMigrationOwnerFakeClient({ initialRoleRows: rows });
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_INITIAL_ROLE_CONTRACT_MISMATCH"
    );
    expect(fake.state.labels).toEqual([
      "observed-session-identity",
      "production-alter-default-privileges",
      "create-fixed-roles",
      "observed-session-identity",
      "initial-role-contract",
    ]);
    expect(fake.state.callbackObservations).toEqual([]);
    expect(fake.state.defaultPrivilegeMutationCount).toBe(1);
    expect(result).toMatchObject({
      productionApplyInvocations: 1,
      migrationCallbackInvocations: 0,
      laterVerificationStubInvocations: 0,
    });
    expect(result.operationStarts.migration).toBe(0);
    expect(fake.state.destroy).toBe(0);
    expect(fake.state.end).toBe(1);
  });

  it("grants only the fixed executor USAGE and CREATE on drizzle before baseline Migration", async () => {
    const fake = createMigrationOwnerFakeClient();
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBeNull();
    const grantIndex = fake.state.labels.indexOf("minimal-grants");
    const grantStatement = fake.state.query[grantIndex];
    expect(grantStatement).toMatch(
      /GRANT USAGE, CREATE ON SCHEMA drizzle\s+TO "actustube_ci_usage_migration_executor";/
    );
    expect(grantStatement).not.toMatch(
      /GRANT USAGE, CREATE ON SCHEMA drizzle[\s\S]*?(?:PUBLIC|actustube_ci_fixture_runtime|actustube_ci_usage_legacy_owner)/
    );
    expect(fake.state.labels.indexOf("initial-role-contract")).toBeLessThan(
      grantIndex
    );
    expect(grantIndex).toBeLessThan(
      fake.state.labels.indexOf("migration-callback-baseline")
    );
  });

  it("rejects a Migration callback that attempts to replace the shared Client", async () => {
    const fake = createMigrationOwnerFakeClient();
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testCallerConfigurationRole,
      callbackScenario: "replace-client",
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_MIGRATION_CALLBACK_REPLACEMENT"
    );
    expect(fake.state.callbackObservations.map((entry) => entry.kind)).toEqual([
      "baseline",
    ]);
    expect(fake.state.labels).not.toContain("migration-callback-final");
    expect(fake.state.labels).not.toContain("migration-callback-replay");
  });

  it("starts no later callback after a finite final callback failure", async () => {
    const fake = createMigrationOwnerFakeClient({
      rejectOnLabel: "migration-callback-final",
    });
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe("EXTERNAL_FIXTURE_VERIFICATION_FAILED");
    expect(fake.state.callbackObservations.map((entry) => entry.kind)).toEqual([
      "baseline",
      "final",
    ]);
    expect(fake.state.labels).not.toContain("migration-callback-replay");
    expect(fake.state.labels).not.toContain("owner-postcondition");
  });

  it("starts no reset or later callback after a baseline callback timeout", async () => {
    vi.useFakeTimers();
    try {
      const fake = createMigrationOwnerFakeClient({
        hangOnLabel: "migration-callback-baseline",
      });
      const pending = runMigrationOwnerBoundaryProbeForTests({
        client: fake.client,
        expectedSessionRole: testCallerConfigurationRole,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 20,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      await vi.advanceTimersByTimeAsync(120);
      const result = await pending;
      expect(result).toMatchObject({
        failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
        timedOut: true,
        destroyed: true,
      });
      expect(fake.state.callbackObservations.map((entry) => entry.kind)).toEqual([
        "baseline",
      ]);
      expect(fake.state.labels).not.toContain("reset-role");
      expect(fake.state.labels).not.toContain("migration-callback-final");
      expect(fake.state.labels).not.toContain("migration-callback-replay");
      expect(fake.state.queriesAtDestroy).toBe(fake.state.query.length);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      "legacy owner equals Migration executor",
      [
        validMigrationRolePrecondition({
          legacy_function_owner_oid: testMigrationExecutorOid,
          legacy_owner_oid: testMigrationExecutorOid,
          legacy_owner_name: testMigrationExecutor,
        }),
      ],
    ],
    [
      "legacy owner equals session role",
      [validMigrationRolePrecondition({ legacy_owner_name: testFixtureSessionRole })],
    ],
    [
      "legacy function remains owned by Migration executor",
      [
        validMigrationRolePrecondition({
          legacy_function_owner_oid: testMigrationExecutorOid,
        }),
      ],
    ],
    [
      "Migration effective role is legacy owner",
      [validMigrationRolePrecondition({ effective_role: testLegacyOwner })],
    ],
    [
      "legacy membership is missing",
      [validMigrationRolePrecondition({ has_legacy_membership: false })],
    ],
    ["precondition row is missing", []],
    [
      "precondition row is duplicated",
      [validMigrationRolePrecondition(), validMigrationRolePrecondition()],
    ],
    [
      "precondition row has an unknown key",
      [validMigrationRolePrecondition({ unknown_key: true })],
    ],
  ])("rejects %s before the final Migration phase", async (_label, rows) => {
    const fake = createMigrationOwnerFakeClient({ preconditionRows: rows });
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_MIGRATION_ROLE_PRECONDITION_MISMATCH"
    );
    const labels = fake.state.labels;
    expect(labels).toContain("role-precondition");
    expect(labels).not.toContain("owner-postcondition");
    expect(result.operationStarts.migration).toBe(1);
    expect(fake.state.destroy).toBe(0);
    expect(fake.state.end).toBe(1);
  });

  it.each([
    [
      "all targets owned by Migration executor",
      validUsageOwnerPostcondition().map((row) => ({
        ...row,
        owner_oid: testMigrationExecutorOid,
        owner_name: testMigrationExecutor,
      })),
    ],
    [
      "all targets owned by session role",
      validUsageOwnerPostcondition().map((row) => ({
        ...row,
        owner_oid: "81003",
        owner_name: testFixtureSessionRole,
      })),
    ],
    [
      "one target owner name mismatch",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 3 ? { ...row, owner_name: "actustube_ci_wrong_owner" } : row
      ),
    ],
    [
      "one target owner OID mismatch",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 4 ? { ...row, owner_oid: "81999" } : row
      ),
    ],
    [
      "duplicate function OID",
      validUsageOwnerPostcondition().map((row, index, rows) =>
        index === 4 ? { ...row, function_oid: rows[0].function_oid } : row
      ),
    ],
    [
      "zero function OID",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 1 ? { ...row, function_oid: "0" } : row
      ),
    ],
    [
      "negative function OID",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 2 ? { ...row, function_oid: "-1" } : row
      ),
    ],
    [
      "noncanonical function OID",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 3 ? { ...row, function_oid: "082004" } : row
      ),
    ],
    [
      "one SECURITY DEFINER function",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 2 ? { ...row, security_definer: true } : row
      ),
    ],
    ["one function missing", validUsageOwnerPostcondition().slice(0, -1)],
    [
      "one unknown function",
      validUsageOwnerPostcondition().map((row, index) =>
        index === 4
          ? { ...row, function_identity: "public.unknown_fixture_function()" }
          : row
      ),
    ],
  ])("rejects the owner postcondition when %s", async (_label, rows) => {
    const fake = createMigrationOwnerFakeClient({ postconditionRows: rows });
    const result = await runMigrationOwnerBoundaryProbeForTests({
      client: fake.client,
      expectedSessionRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_OWNER_POSTCONDITION_MISMATCH"
    );
    expect(fake.state.labels).toContain("owner-postcondition");
    expect(fake.state.destroy).toBe(0);
    expect(fake.state.end).toBe(1);
  });

  it("starts no reset, owner, grant, or postcondition query after a role precondition timeout", async () => {
    vi.useFakeTimers();
    try {
      const fake = createMigrationOwnerFakeClient({
        hangOnLabel: "role-precondition",
      });
      const pending = runMigrationOwnerBoundaryProbeForTests({
        client: fake.client,
        expectedSessionRole: testCallerConfigurationRole,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 20,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      await vi.advanceTimersByTimeAsync(120);
      const result = await pending;
      const labels = fake.state.labels;
      expect(result).toMatchObject({
        failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
        timedOut: true,
        activeClientCount: 0,
        destroyed: true,
      });
      expect(labels.at(-1)).toBe("role-precondition");
      expect(labels.filter((label) => label === "reset-role")).toHaveLength(1);
      expect(labels).not.toContain("owner-postcondition");
      expect(fake.state.queriesAtDestroy).toBe(fake.state.query.length);
      expect(fake.state.destroy).toBe(1);
      expect(fake.state.end).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds every explicit ACL catalog branch to grantor and grantee coverage with a shared-dependency backstop", () => {
    const sql = TEMPORARY_AUTHORITY_INVENTORY_SQL_FOR_TESTS;
    const aclSources = [
      "database_entry.datacl",
      "namespace_entry.nspacl",
      "relation_entry.relacl",
      "attribute_entry.attacl",
      "procedure_entry.proacl",
      "type_entry.typacl",
      "default_acl.defaclacl",
    ];
    for (const source of aclSources) {
      expect(sql).toContain(`aclexplode(${source})`);
    }
    expect(
      sql.match(
        /target_role\.oid = acl\.grantee OR target_role\.oid = acl\.grantor/g
      )
    ).toHaveLength(14);
    expect(sql).toContain("dependency_entry.deptype = 'a'");
    expect(sql).toContain("coverage.dbid = dependency_entry.dbid");
    expect(sql).toContain("coverage.classid = dependency_entry.classid");
    expect(sql).toContain("coverage.objid = dependency_entry.objid");
    expect(sql).toContain("coverage.objsubid = dependency_entry.objsubid");
    expect(sql).toContain(
      "coverage.target_role_oid = dependency_entry.refobjid"
    );
    expect(sql).toContain("attribute_entry.attrelid");
    expect(sql).toContain("attribute_entry.attnum::integer");
    expect(sql).toContain("dependency_entry.deptype = 'o'");
  });

  it("binds the temporary-authority grantor to the propagated DB-observed identity", async () => {
    const source = await readFile(postgresHarnessModule, "utf8");
    expect(source).toContain("session_user AS session_role");
    expect(source).toContain("current_user AS effective_role");
    expect(source).toMatch(
      /const boundaryObservedIdentity = await runMigrationBoundaryIdentityPhase\([\s\S]{0,180}assertInitialMigrationBoundaryRoles\(/
    );
    expect(source).toContain(
      "return Object.freeze({ beforeFinalResult })"
    );
    expect(source).toContain(
      "const identityAuthority = await applyMigrationsAndRuntimeAcl"
    );
    expect(source).toContain("runPreMutationSessionIdentityBoundary");
    expect(source).toContain(
      "identityAuthority.observedSessionIdentity === observedSessionIdentity"
    );
    expect(source).toContain("grantorName: observedSessionRole");
    expect(source).not.toContain("grantorName: configuration.role");
    expect(source).not.toContain(
      "observedSessionIdentity = boundaryResult.observedSessionIdentity"
    );
    expect(source).not.toMatch(
      /observedSession(?:Identity|Role)\s*(?:\?\?|\|\|)\s*configuration\.role/
    );
    expect(source).toMatch(
      /observeSessionIdentity\([\s\S]*?"EXTERNAL_FIXTURE_CLEANUP_SESSION_IDENTITY_MISMATCH"/
    );
  });

  it("canonicalizes only the fixed repository objects before starting postflight once", async () => {
    const events: string[] = [];
    const canonical = createOwnershipCanonicalizationFakeClient({ events });
    const postflight = createPostflightBoundaryFakeClient(events);
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result).toMatchObject({
      failureMarker: null,
      timedOut: false,
      activeClientCount: 0,
      observedIdentityReferencePreserved: true,
    });
    expect(canonical.state.labels[0]).toBe("observed-session-identity");
    expect(canonical.state.labels[1]).toBe("pre-canonical-inventory");
    expect(canonical.state.labels.at(-1)).toBe("post-canonical-snapshot");
    expect(canonical.state.snapshotCount).toBe(2);
    expect(canonical.state.cleanupIdentityCount).toBe(1);
    expect(canonical.state.authorityInventoryCount).toBe(2);
    expect(canonical.initialIdentityState).toMatchObject({
      connect: 1,
      end: 1,
      destroy: 0,
    });
    expect(canonical.initialIdentityState.query).toHaveLength(1);
    expect(canonical.initialIdentityState.parameters).toEqual([[]]);
    expect(
      canonical.state.labels.indexOf("observed-session-identity")
    ).toBeLessThan(
      canonical.state.labels.indexOf("temporary-authority-inventory")
    );
    expect(validTemporaryAuthorityRows()).toHaveLength(14);
    const expectedAclRows = validTemporaryAuthorityRows().filter(
      (row) => row.authority_kind === "explicit_acl"
    );
    expect(expectedAclRows).toHaveLength(11);
    expect(
      expectedAclRows.every(
        (row) =>
          row.role_relation === "grantee" &&
          row.grantor_name === testActualAclGrantorRole &&
          row.grantee_name === row.role_name &&
          [testMigrationExecutor, testLegacyOwner].includes(row.role_name)
      )
    ).toBe(true);
    expect(canonical.state.cleanup).toEqual([
      "revoke-database-create",
      "revoke-public-executor",
      "revoke-public-legacy",
      "revoke-drizzle-executor",
      "revoke-ledger-table",
      "revoke-ledger-sequence",
      "revoke-legacy-membership",
    ]);
    const observedRevokeQueries = canonical.state.labels.flatMap(
      (label, index) =>
        label.startsWith("revoke-")
          ? [
              {
                label,
                statement: canonical.state.query[index],
                parameters: canonical.state.parameters[index],
              },
            ]
          : []
    );
    expect(observedRevokeQueries).toHaveLength(7);
    expect(
      observedRevokeQueries.map(({ label, statement, parameters }) => ({
        label,
        statement: normalizeExactRevokeSql(statement),
        parameters,
      }))
    ).toEqual(
      exactRevokeContracts.map(({ label, statement, parameters }) => ({
        label,
        statement: normalizeExactRevokeSql(statement),
        parameters: [...parameters],
      }))
    );
    expect(canonical.state.authorityRows).toEqual([]);
    expect(canonical.state.end).toBe(1);
    expect(canonical.state.destroy).toBe(0);
    expect(canonical.state.ownerChanges).toHaveLength(29);
    expect(
      canonical.state.ownerChanges.every(
        (statement) =>
          statement.endsWith("OWNER TO SESSION_USER") &&
          !statement.includes("REASSIGN OWNED")
      )
    ).toBe(true);
    for (const tableName of testRepositoryTables) {
      expect(canonical.state.ownerChanges).toContain(
        `ALTER TABLE "public"."${tableName}" OWNER TO SESSION_USER`
      );
    }
    for (const enumName of testRepositoryEnums) {
      expect(canonical.state.ownerChanges).toContain(
        `ALTER TYPE "public"."${enumName}" OWNER TO SESSION_USER`
      );
    }
    for (const entry of testCanonicalFunctions) {
      expect(
        canonical.state.ownerChanges.some((statement) =>
          statement.startsWith(`ALTER FUNCTION "public"."${entry.name}"(`)
        )
      ).toBe(true);
    }
    expect(canonical.state.ownerChanges).toContain(
      'ALTER SCHEMA "public" OWNER TO SESSION_USER'
    );
    expect(canonical.state.ownerChanges).toContain(
      'ALTER SCHEMA "drizzle" OWNER TO SESSION_USER'
    );
    expect(canonical.state.ownerChanges).toContain(
      'ALTER TABLE "drizzle"."__drizzle_migrations" OWNER TO SESSION_USER'
    );
    expect(canonical.state.ownerChanges).toContain(
      'ALTER SEQUENCE "drizzle"."__drizzle_migrations_id_seq" OWNER TO SESSION_USER'
    );
    expect(
      canonical.state.parameters[
        canonical.state.labels.indexOf("pre-canonical-inventory")
      ]
    ).toEqual([
      [testLegacyOwner, testMigrationExecutor],
    ]);
    expect(canonical.state.parameters.at(-1)).toEqual([["drizzle", "public"]]);
    expect(postflight.state).toEqual({
      connect: 1,
      query: [
        "SELECT 'fixed_postflight_boundary'::text AS fixed_boundary_probe",
      ],
      end: 1,
      destroy: 0,
    });
    expect(events.lastIndexOf("post-canonical-snapshot")).toBeLessThan(
      events.indexOf("canonical-close")
    );
    expect(events.lastIndexOf("temporary-authority-inventory")).toBeLessThan(
      events.lastIndexOf("post-canonical-snapshot")
    );
    expect(events.indexOf("canonical-close")).toBeLessThan(
      events.indexOf("postflight-connect")
    );
    expect(events.filter((event) => event === "postflight-boundary")).toHaveLength(
      1
    );
  });

  it("rejects a same-value replacement identity before the cleanup Client or ownership work", async () => {
    const canonical = createOwnershipCanonicalizationFakeClient();
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: testCallerConfigurationRole,
      replaceObservedIdentityForTest: true,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result).toMatchObject({
      failureMarker:
        "EXTERNAL_FIXTURE_OBSERVED_SESSION_IDENTITY_REFERENCE_MISMATCH",
      observedIdentityReferencePreserved: false,
      timedOut: false,
    });
    expect(canonical.initialIdentityState.query).toHaveLength(1);
    expect(canonical.state.connect).toBe(0);
    expect(canonical.state.preCanonicalInventoryCount).toBe(0);
    expect(canonical.state.ownerChanges).toEqual([]);
    expect(canonical.state.snapshotCount).toBe(0);
    expect(canonical.state.authorityInventoryCount).toBe(0);
    expect(canonical.state.cleanup).toEqual([]);
    expect(postflight.state.connect).toBe(0);
    expect(JSON.stringify(result)).not.toContain(testFixtureSessionRole);
  });

  it.each([
    [
      "cleanup session role differs",
      validObservedSessionIdentityRows({
        sessionRole: "actustube_ci_cleanup_session_mismatch",
        effectiveRole: testCleanupObservedCurrentRole,
      }),
    ],
    [
      "cleanup current role differs",
      validObservedSessionIdentityRows({
        sessionRole: testCleanupObservedSessionRole,
        effectiveRole: "actustube_ci_cleanup_current_mismatch",
      }),
    ],
    [
      "cleanup session and current roles differ from each other",
      validObservedSessionIdentityRows({
        sessionRole: "actustube_ci_cleanup_session_other",
        effectiveRole: "actustube_ci_cleanup_current_other",
      }),
    ],
    ["cleanup row is missing", []],
    [
      "cleanup row is duplicated",
      [
        ...validObservedSessionIdentityRows(),
        ...validObservedSessionIdentityRows(),
      ],
    ],
    [
      "cleanup row is missing a key",
      [{ session_role: testCleanupObservedSessionRole }],
    ],
    [
      "cleanup row has an extra key",
      [
        {
          session_role: testCleanupObservedSessionRole,
          effective_role: testCleanupObservedCurrentRole,
          unexpected_key: true,
        },
      ],
    ],
    [
      "cleanup row has a null role",
      validObservedSessionIdentityRows({ sessionRole: null }),
    ],
    [
      "cleanup row has a non-string role",
      validObservedSessionIdentityRows({ sessionRole: 42 }),
    ],
    [
      "cleanup row has an empty role",
      validObservedSessionIdentityRows({ sessionRole: "" }),
    ],
    [
      "cleanup row has an invalid identifier",
      validObservedSessionIdentityRows({ sessionRole: "invalid role" }),
    ],
  ] as const)(
    "stops before authority inventory when %s",
    async (_label, cleanupIdentityRows) => {
      const canonical = createOwnershipCanonicalizationFakeClient({
        cleanupIdentityRows: [...cleanupIdentityRows],
      });
      const postflight = createPostflightBoundaryFakeClient();
      const result = await runOwnershipCanonicalizationProbeForTests({
        initialIdentityClient: canonical.initialIdentityClient,
        client: canonical.client,
        postflightClient: postflight.client,
        callerConfigurationRole: testCallerConfigurationRole,
        deadlineLimits: {
          totalMilliseconds: 1_000,
          connectMilliseconds: 100,
          queryMilliseconds: 100,
          closeMilliseconds: 100,
          phaseMilliseconds: 100,
          migrationMilliseconds: 100,
        },
      });
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_CLEANUP_SESSION_IDENTITY_MISMATCH"
      );
      expect(canonical.state.cleanupIdentityCount).toBe(1);
      expect(canonical.state.preCanonicalInventoryCount).toBe(0);
      expect(canonical.state.ownerChanges).toEqual([]);
      expect(canonical.state.authorityInventoryCount).toBe(0);
      expect(canonical.state.cleanup).toEqual([]);
      expect(canonical.state.snapshotCount).toBe(0);
      expect(postflight.state.connect).toBe(0);
      expect(canonical.state.end).toBe(1);
      expect(canonical.state.destroy).toBe(0);
      expect(JSON.stringify(result)).not.toMatch(
        /actustube_ci_(?:fixture|cleanup)/i
      );
    }
  );

  it("rejects cleanup identity even when it matches a changed caller configuration value", async () => {
    const changedCallerRole = "actustube_ci_changed_caller";
    const canonical = createOwnershipCanonicalizationFakeClient({
      cleanupIdentityRows: validObservedSessionIdentityRows({
        sessionRole: changedCallerRole,
        effectiveRole: changedCallerRole,
      }),
    });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: testCallerConfigurationRole,
      cleanupConfigurationRoleForTest: changedCallerRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_CLEANUP_SESSION_IDENTITY_MISMATCH"
    );
    expect(canonical.state.cleanupIdentityCount).toBe(1);
    expect(canonical.state.preCanonicalInventoryCount).toBe(0);
    expect(canonical.state.ownerChanges).toEqual([]);
    expect(canonical.state.snapshotCount).toBe(0);
    expect(canonical.state.authorityInventoryCount).toBe(0);
    expect(canonical.state.cleanup).toEqual([]);
    expect(postflight.state.connect).toBe(0);
  });

  it("fails closed when the cleanup identity query rejects", async () => {
    const canonical = createOwnershipCanonicalizationFakeClient({
      cleanupIdentityReject: true,
    });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe("EXTERNAL_FIXTURE_VERIFICATION_FAILED");
    expect(canonical.state.cleanupIdentityCount).toBe(1);
    expect(canonical.state.preCanonicalInventoryCount).toBe(0);
    expect(canonical.state.ownerChanges).toEqual([]);
    expect(canonical.state.snapshotCount).toBe(0);
    expect(canonical.state.authorityInventoryCount).toBe(0);
    expect(canonical.state.cleanup).toEqual([]);
    expect(postflight.state.connect).toBe(0);
    expect(canonical.state.end).toBe(1);
    expect(canonical.state.destroy).toBe(0);
  });

  it("bounds the cleanup identity timeout and preserves an unrelated Client", async () => {
    const realSetTimeout = setTimeout;
    vi.useFakeTimers();
    try {
      const canonical = createOwnershipCanonicalizationFakeClient({
        cleanupIdentityHang: true,
      });
      const postflight = createPostflightBoundaryFakeClient();
      const unrelated = createDeadlineFakeClient();
      const pending = runOwnershipCanonicalizationProbeForTests({
        initialIdentityClient: canonical.initialIdentityClient,
        client: canonical.client,
        postflightClient: postflight.client,
        unrelatedClient: unrelated.client,
        callerConfigurationRole: testCallerConfigurationRole,
        deadlineLimits: {
          totalMilliseconds: 1_000,
          connectMilliseconds: 20,
          queryMilliseconds: 10,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      for (
        let attempt = 0;
        attempt < 500 && canonical.state.cleanupIdentityCount === 0;
        attempt += 1
      ) {
        await vi.advanceTimersByTimeAsync(1);
        await new Promise<void>((resolveYield) => {
          realSetTimeout(resolveYield, 0);
        });
      }
      expect(canonical.state.cleanupIdentityCount).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      const result = await pending;
      expect(result).toMatchObject({
        failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
        timedOut: true,
        activeClientCount: 0,
      });
      expect(canonical.state.cleanupIdentityCount).toBe(1);
      expect(canonical.state.preCanonicalInventoryCount).toBe(0);
      expect(canonical.state.ownerChanges).toEqual([]);
      expect(canonical.state.snapshotCount).toBe(0);
      expect(canonical.state.authorityInventoryCount).toBe(0);
      expect(canonical.state.cleanup).toEqual([]);
      expect(canonical.state.destroy).toBe(1);
      expect(canonical.state.end).toBe(0);
      expect(canonical.state.queriesAtDestroy).toBe(canonical.state.query.length);
      expect(postflight.state.connect).toBe(0);
      expect(canonical.initialIdentityState).toMatchObject({
        connect: 1,
        end: 1,
        destroy: 0,
      });
      expect(unrelated.counters).toEqual({
        connect: 1,
        query: [],
        end: 1,
        destroy: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops before canonicalization when caller and DB-observed identity differ", async () => {
    const canonical = createOwnershipCanonicalizationFakeClient();
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: "actustube_ci_other_caller",
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_INITIAL_SESSION_IDENTITY_MISMATCH"
    );
    expect(canonical.state.connect).toBe(0);
    expect(canonical.state.authorityInventoryCount).toBe(0);
    expect(canonical.state.cleanup).toEqual([]);
    expect(postflight.state.connect).toBe(0);
  });

  it("keeps fake ACL grantor state independent from observed identity propagation", async () => {
    const independentObservedRole = "actustube_ci_independent_observed";
    const postRows = validPostCanonicalOwnershipRows().map((row) => ({
      ...row,
      owner_name: independentObservedRole,
    }));
    const canonical = createOwnershipCanonicalizationFakeClient({
      initialIdentityRows: validObservedSessionIdentityRows({
        sessionRole: independentObservedRole,
        effectiveRole: independentObservedRole,
      }),
      cleanupIdentityRows: validObservedSessionIdentityRows({
        sessionRole: independentObservedRole,
        effectiveRole: independentObservedRole,
      }),
      postRows,
      maintenanceRows: postRows,
    });
    const postflight = createPostflightBoundaryFakeClient();
    expect(
      canonical.state.authorityRows
        .filter((row) => row.authority_kind === "explicit_acl")
        .every((row) => row.grantor_name === testActualAclGrantorRole)
    ).toBe(true);
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: independentObservedRole,
      cleanupConfigurationRoleForTest: independentObservedRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_PRE_CLEANUP_AUTHORITY_MISMATCH"
    );
    expect(canonical.state.cleanupIdentityCount).toBe(1);
    expect(canonical.state.authorityInventoryCount).toBe(1);
    expect(canonical.state.cleanup).toEqual([]);
    expect(postflight.state.connect).toBe(0);
  });

  it.each([
    ["missing expected authority", validTemporaryAuthorityRows().slice(1)],
    [
      "extra database authority",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          object_kind: "database",
          object_name: "other_database",
          privilege_type: "CONNECT",
        }),
      ]),
    ],
    [
      "duplicate authority",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        validTemporaryAuthorityRows()[0],
      ]),
    ],
    [
      "wrong privilege",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, privilege_type: "CONNECT" } : row
        )
      ),
    ],
    [
      "grant option",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, grant_option: true } : row
        )
      ),
    ],
    [
      "wrong object",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, object_name: "wrong_database" } : row
        )
      ),
    ],
    [
      "wrong grantee",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, grantee_name: testLegacyOwner } : row
        )
      ),
    ],
    [
      "wrong grantor",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, grantor_name: testMigrationExecutor } : row
        )
      ),
    ],
    [
      "unknown ACL relation",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0 ? { ...row, role_relation: "unknown" } : row
        )
      ),
    ],
    ...([
      [
        "grantor-only database ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "database",
          object_name: "actustube_ci_fixture",
          privilege_type: "CREATE",
        }),
      ],
      [
        "grantor-only schema ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
        }),
      ],
      [
        "grantor-only relation ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "table",
          schema_name: "drizzle",
          object_name: "__drizzle_migrations",
          privilege_type: "SELECT",
        }),
      ],
      [
        "grantor-only column ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "column",
          schema_name: "public",
          object_name: "users",
          column_name: "email",
          privilege_type: "SELECT",
        }),
      ],
      [
        "grantor-only function ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "function",
          schema_name: "public",
          object_name: "reserve_usage_limits",
          function_identity:
            "uuid,integer,usage_metric,timestamp with time zone",
          privilege_type: "EXECUTE",
        }),
      ],
      [
        "grantor-only type ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "type",
          schema_name: "public",
          object_name: "usage_metric",
        }),
      ],
      [
        "grantor-only default ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "default_acl",
          schema_name: "public",
          object_name: "r",
          privilege_type: "SELECT",
        }),
      ],
      [
        "grantor-only ACL to PUBLIC",
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
          grantee_name: "PUBLIC",
        }),
      ],
      [
        "grantor-and-grantee ACL",
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
          role_relation: "both",
          grantee_name: testMigrationExecutor,
        }),
      ],
    ] as Array<[string, TestTemporaryAuthorityRow]>).map(
      ([label, row]): [string, TestTemporaryAuthorityRow[]] => [
        label,
        sortTestTemporaryAuthorityRows([
          ...validTemporaryAuthorityRows(),
          row,
        ]),
      ]
    ),
    [
      "duplicate grantor row",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
        }),
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
        }),
      ]),
    ],
    [
      "uncovered ACL dependency",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        uncoveredAclDependencyRow(),
      ]),
    ],
    [
      "unknown catalog ACL dependency",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        uncoveredAclDependencyRow({ object_name: "pg_catalog.pg_unknown" }),
      ]),
    ],
    [
      "column ACL dependency",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        uncoveredAclDependencyRow({ column_name: "column" }),
      ]),
    ],
    [
      "duplicate ACL dependency",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        uncoveredAclDependencyRow(),
        uncoveredAclDependencyRow(),
      ]),
    ],
    [
      "column ACL",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          object_kind: "column",
          schema_name: "public",
          object_name: "users",
          column_name: "email",
          privilege_type: "SELECT",
        }),
      ]),
    ],
    [
      "function ACL",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          object_kind: "function",
          schema_name: "public",
          object_name: "reserve_usage_limits",
          function_identity: "uuid,integer,usage_metric,timestamp with time zone",
          privilege_type: "EXECUTE",
        }),
      ]),
    ],
    [
      "type ACL",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          object_kind: "type",
          schema_name: "public",
          object_name: "usage_metric",
          privilege_type: "USAGE",
        }),
      ]),
    ],
    [
      "default ACL",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          object_kind: "default_acl",
          schema_name: "public",
          object_name: "r",
          privilege_type: "SELECT",
        }),
      ]),
    ],
    [
      "wrong direct membership options",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row) =>
          row.authority_kind === "direct_membership"
            ? { ...row, grant_option: true, set_option: false }
            : row
        )
      ),
    ],
    [
      "unexpected recursive membership",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          authority_kind: "recursive_membership",
          object_kind: "role",
          object_name: "unexpected_parent_role",
          privilege_type: "MEMBER",
          granted_role: "unexpected_parent_role",
        }),
      ]),
    ],
    [
      "owned object",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          authority_kind: "ownership",
          object_kind: "table",
          schema_name: "public",
          object_name: "unexpected_owned_table",
          privilege_type: "OWNER",
        }),
      ]),
    ],
    [
      "unsupported shared ownership",
      sortTestTemporaryAuthorityRows([
        ...validTemporaryAuthorityRows(),
        testTemporaryAuthorityRow({
          authority_kind: "ownership",
          object_kind: "unsupported_owned_object",
          object_name: "pg_subscription",
          privilege_type: "OWNER",
        }),
      ]),
    ],
    [
      "unknown row key",
      sortTestTemporaryAuthorityRows(
        validTemporaryAuthorityRows().map((row, index) =>
          index === 0
            ? ({ ...row, unexpected_key: "blocked" } as TestTemporaryAuthorityRow)
            : row
        )
      ),
    ],
  ])(
    "stops before cleanup when the temporary-authority inventory has %s",
    async (_label, preAuthorityRows) => {
      const canonical = createOwnershipCanonicalizationFakeClient({
        preAuthorityRows,
      });
      const postflight = createPostflightBoundaryFakeClient();
      const result = await runOwnershipCanonicalizationProbeForTests({
        initialIdentityClient: canonical.initialIdentityClient,
        client: canonical.client,
        postflightClient: postflight.client,
        callerConfigurationRole: testCallerConfigurationRole,
        deadlineLimits: {
          totalMilliseconds: 1_000,
          connectMilliseconds: 100,
          queryMilliseconds: 100,
          closeMilliseconds: 100,
          phaseMilliseconds: 100,
          migrationMilliseconds: 100,
        },
      });
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_PRE_CLEANUP_AUTHORITY_MISMATCH"
      );
      expect(result).toMatchObject({
        timedOut: false,
        activeClientCount: 0,
      });
      expect(canonical.state.cleanup).toEqual([]);
      expect(canonical.state.authorityInventoryCount).toBe(1);
      expect(canonical.state.end).toBe(1);
      expect(canonical.state.destroy).toBe(0);
      expect(postflight.state.connect).toBe(0);
    }
  );

  it.each([
    [
      "database ACL",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.object_kind === "database"
        )!,
      ],
    ],
    [
      "schema ACL",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.object_kind === "schema"
        )!,
      ],
    ],
    [
      "table ACL",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.object_kind === "table"
        )!,
      ],
    ],
    [
      "sequence ACL",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.object_kind === "sequence"
        )!,
      ],
    ],
    [
      "column ACL",
      [
        testTemporaryAuthorityRow({
          object_kind: "column",
          schema_name: "public",
          object_name: "users",
          column_name: "email",
          privilege_type: "SELECT",
        }),
      ],
    ],
    [
      "function ACL",
      [
        testTemporaryAuthorityRow({
          object_kind: "function",
          schema_name: "public",
          object_name: "reserve_usage_limits",
          function_identity:
            "uuid,integer,usage_metric,timestamp with time zone",
          privilege_type: "EXECUTE",
        }),
      ],
    ],
    [
      "type ACL",
      [
        testTemporaryAuthorityRow({
          object_kind: "type",
          schema_name: "public",
          object_name: "usage_metric",
        }),
      ],
    ],
    [
      "default ACL",
      [
        testTemporaryAuthorityRow({
          object_kind: "default_acl",
          schema_name: "public",
          object_name: "r",
          privilege_type: "SELECT",
        }),
      ],
    ],
    [
      "direct membership",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.authority_kind === "direct_membership"
        )!,
      ],
    ],
    [
      "recursive membership",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.authority_kind === "recursive_membership"
        )!,
      ],
    ],
    [
      "effective membership",
      [
        validTemporaryAuthorityRows().find(
          (row) => row.authority_kind === "effective_membership"
        )!,
      ],
    ],
    [
      "owned object",
      [
        testTemporaryAuthorityRow({
          authority_kind: "ownership",
          object_kind: "table",
          schema_name: "public",
          object_name: "unexpected_owned_table",
          privilege_type: "OWNER",
        }),
      ],
    ],
    [
      "unsupported owned object",
      [
        testTemporaryAuthorityRow({
          authority_kind: "ownership",
          object_kind: "unsupported_owned_object",
          object_name: "pg_subscription",
          privilege_type: "OWNER",
        }),
      ],
    ],
    [
      "grantor-side ACL residue",
      [
        grantorSideTemporaryAuthorityRow({
          object_kind: "schema",
          schema_name: "public",
          object_name: "public",
        }),
      ],
    ],
    ["uncovered ACL dependency", [uncoveredAclDependencyRow()]],
    [
      "column ACL dependency",
      [uncoveredAclDependencyRow({ column_name: "column" })],
    ],
    [
      "unknown row key",
      [
        {
          ...testTemporaryAuthorityRow({
            object_kind: "column",
            schema_name: "public",
            object_name: "users",
            column_name: "email",
            privilege_type: "SELECT",
          }),
          unexpected_key: "blocked",
        } as TestTemporaryAuthorityRow,
      ],
    ],
    [
      "duplicate residue",
      [validTemporaryAuthorityRows()[0], validTemporaryAuthorityRows()[0]],
    ],
  ])(
    "does not start postflight when cleanup leaves %s",
    async (_label, postAuthorityRows) => {
      const canonical = createOwnershipCanonicalizationFakeClient({
        postAuthorityRows,
      });
      const postflight = createPostflightBoundaryFakeClient();
      const result = await runOwnershipCanonicalizationProbeForTests({
        initialIdentityClient: canonical.initialIdentityClient,
        client: canonical.client,
        postflightClient: postflight.client,
        callerConfigurationRole: testCallerConfigurationRole,
        deadlineLimits: {
          totalMilliseconds: 1_000,
          connectMilliseconds: 100,
          queryMilliseconds: 100,
          closeMilliseconds: 100,
          phaseMilliseconds: 100,
          migrationMilliseconds: 100,
        },
      });
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_TEMPORARY_AUTHORITY_RESIDUE"
      );
      expect(result).toMatchObject({
        timedOut: false,
        activeClientCount: 0,
      });
      expect(canonical.state.cleanup).toHaveLength(7);
      expect(canonical.state.snapshotCount).toBe(1);
      expect(canonical.state.labels.at(-1)).toBe(
        "temporary-authority-inventory"
      );
      expect(canonical.state.end).toBe(1);
      expect(canonical.state.destroy).toBe(0);
      expect(postflight.state.connect).toBe(0);
    }
  );

  it.each([
    ["ledger privileges", "revoke-ledger-table", 2],
    ["legacy membership", "revoke-legacy-membership", 3],
  ])(
    "proves the success fixture depends on the %s revoke",
    async (_label, skipCleanupLabel, expectedResidueCount) => {
      const canonical = createOwnershipCanonicalizationFakeClient({
        skipCleanupLabel,
      });
      const postflight = createPostflightBoundaryFakeClient();
      const result = await runOwnershipCanonicalizationProbeForTests({
        initialIdentityClient: canonical.initialIdentityClient,
        client: canonical.client,
        postflightClient: postflight.client,
        callerConfigurationRole: testCallerConfigurationRole,
        deadlineLimits: {
          totalMilliseconds: 1_000,
          connectMilliseconds: 100,
          queryMilliseconds: 100,
          closeMilliseconds: 100,
          phaseMilliseconds: 100,
          migrationMilliseconds: 100,
        },
      });
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_TEMPORARY_AUTHORITY_RESIDUE"
      );
      expect(canonical.state.authorityRows).toHaveLength(expectedResidueCount);
      expect(postflight.state.connect).toBe(0);
    }
  );

  it.each([
    [
      "wrong database DO body",
      "revoke-database-create",
      exactRevokeContracts[0].statement.replace(
        "REVOKE CREATE",
        "REVOKE CONNECT"
      ),
    ],
    [
      "wrong database role",
      "revoke-database-create",
      exactRevokeContracts[0].statement.replace(
        testMigrationExecutor,
        "wrong_fixture_role"
      ),
    ],
    [
      "missing current_database()",
      "revoke-database-create",
      exactRevokeContracts[0].statement.replace(
        "pg_catalog.current_database()",
        "'actustube_ci_fixture'"
      ),
    ],
    [
      "wrong schema",
      "revoke-public-executor",
      `REVOKE USAGE, CREATE ON SCHEMA private FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong public-schema role",
      "revoke-public-executor",
      'REVOKE USAGE, CREATE ON SCHEMA public FROM "wrong_fixture_role"',
    ],
    [
      "wrong drizzle-schema role",
      "revoke-drizzle-executor",
      'REVOKE USAGE, CREATE ON SCHEMA drizzle FROM "wrong_fixture_role"',
    ],
    [
      "wrong table",
      "revoke-ledger-table",
      `REVOKE SELECT, INSERT ON TABLE drizzle.wrong_ledger FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong table role",
      "revoke-ledger-table",
      'REVOKE SELECT, INSERT ON TABLE drizzle.__drizzle_migrations FROM "wrong_fixture_role"',
    ],
    [
      "wrong sequence",
      "revoke-ledger-sequence",
      `REVOKE USAGE, SELECT ON SEQUENCE drizzle.wrong_sequence FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong sequence role",
      "revoke-ledger-sequence",
      'REVOKE USAGE, SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq FROM "wrong_fixture_role"',
    ],
    [
      "wrong privilege",
      "revoke-ledger-table",
      `REVOKE SELECT, UPDATE ON TABLE drizzle.__drizzle_migrations FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong privilege order",
      "revoke-ledger-table",
      `REVOKE INSERT, SELECT ON TABLE drizzle.__drizzle_migrations FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong membership granted role",
      "revoke-legacy-membership",
      `REVOKE "wrong_granted_role" FROM "${testMigrationExecutor}"`,
    ],
    [
      "wrong membership member role",
      "revoke-legacy-membership",
      `REVOKE "${testLegacyOwner}" FROM "wrong_member_role"`,
    ],
    [
      "reversed membership direction",
      "revoke-legacy-membership",
      `REVOKE "${testMigrationExecutor}" FROM "${testLegacyOwner}"`,
    ],
    [
      "marker only",
      "revoke-database-create",
      "SELECT 'fixture_database_revoke'::text",
    ],
    [
      "prefix only",
      "revoke-ledger-table",
      "REVOKE SELECT, INSERT ON TABLE drizzle.",
    ],
    [
      "extra trailing executable SQL",
      "revoke-ledger-sequence",
      `REVOKE USAGE, SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq FROM "${testMigrationExecutor}"; SELECT 1`,
    ],
  ] as const)(
    "keeps authority residue and blocks postflight for %s",
    async (_caseName, label, wrongStatement) => {
      const canonical = createOwnershipCanonicalizationFakeClient({
        cleanupStatementOverrides: { [label]: wrongStatement },
      });
      const postflight = createPostflightBoundaryFakeClient();
      const result = await runOwnershipCanonicalizationProbeForTests({
        initialIdentityClient: canonical.initialIdentityClient,
        client: canonical.client,
        postflightClient: postflight.client,
        callerConfigurationRole: testCallerConfigurationRole,
        deadlineLimits: {
          totalMilliseconds: 1_000,
          connectMilliseconds: 100,
          queryMilliseconds: 100,
          closeMilliseconds: 100,
          phaseMilliseconds: 100,
          migrationMilliseconds: 100,
        },
      });
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_TEMPORARY_AUTHORITY_RESIDUE"
      );
      expect(canonical.state.cleanup).not.toContain(label);
      expect(canonical.state.authorityRows.length).toBeGreaterThan(0);
      expect(postflight.state.connect).toBe(0);
      expect(result).not.toHaveProperty("temporaryAuthorityCleanup");
      const publicResult = JSON.stringify(result);
      expect(publicResult).not.toContain("REVOKE");
      expect(publicResult).not.toContain(testFixtureSessionRole);
      expect(publicResult).not.toContain(testMigrationExecutor);
      expect(publicResult).not.toContain(testLegacyOwner);
    }
  );

  it("requires the exact empty parameter contract before mutating fake authority state", async () => {
    const canonical = createOwnershipCanonicalizationFakeClient({
      cleanupParameterOverrides: { "revoke-ledger-table": ["unexpected"] },
    });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_TEMPORARY_AUTHORITY_RESIDUE"
    );
    expect(canonical.state.cleanup).not.toContain("revoke-ledger-table");
    expect(canonical.state.authorityRows).toHaveLength(2);
    expect(postflight.state.connect).toBe(0);
  });

  it.each([
    "revoke-database-create",
    "revoke-public-executor",
    "revoke-public-legacy",
    "revoke-drizzle-executor",
    "revoke-ledger-table",
    "revoke-ledger-sequence",
    "revoke-legacy-membership",
  ])("fails closed when %s rejects", async (rejectOnCleanupLabel) => {
    const canonical = createOwnershipCanonicalizationFakeClient({
      rejectOnCleanupLabel,
    });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe("EXTERNAL_FIXTURE_VERIFICATION_FAILED");
    expect(result).toMatchObject({
      timedOut: false,
      activeClientCount: 0,
    });
    expect(canonical.state.cleanup.at(-1)).toBe(rejectOnCleanupLabel);
    expect(canonical.state.end).toBe(1);
    expect(canonical.state.destroy).toBe(0);
    expect(postflight.state.connect).toBe(0);
  });

  it("rechecks canonical owners after the zero-residue snapshot", async () => {
    const maintenanceRows = validPostCanonicalOwnershipRows().map((row, index) =>
      index === 0 ? { ...row, owner_name: testMigrationExecutor } : row
    );
    const canonical = createOwnershipCanonicalizationFakeClient({
      maintenanceRows,
    });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_POST_CANONICAL_SNAPSHOT_MISMATCH"
    );
    expect(canonical.state.authorityRows).toEqual([]);
    expect(canonical.state.snapshotCount).toBe(2);
    expect(postflight.state.connect).toBe(0);
  });

  it.each([
    ["missing object", validPreCanonicalOwnershipRows().slice(1)],
    [
      "extra object",
      [
        ...validPreCanonicalOwnershipRows(),
        {
          object_kind: "table",
          schema_name: "public",
          object_name: "unexpected_table",
          function_identity: null,
          owner_name: testMigrationExecutor,
        },
      ],
    ],
    [
      "duplicate object",
      [
        ...validPreCanonicalOwnershipRows(),
        validPreCanonicalOwnershipRows()[0],
      ],
    ],
    [
      "unexpected object kind",
      validPreCanonicalOwnershipRows().map((row, index) =>
        index === 0 ? { ...row, object_kind: "unexpected_relation" } : row
      ),
    ],
    [
      "unexpected executor-owned object",
      [
        ...validPreCanonicalOwnershipRows(),
        {
          object_kind: "function",
          schema_name: "public",
          object_name: "unexpected_executor_function",
          function_identity: "",
          owner_name: testMigrationExecutor,
        },
      ],
    ],
    [
      "unexpected legacy-owned object",
      [
        ...validPreCanonicalOwnershipRows(),
        {
          object_kind: "sequence",
          schema_name: "public",
          object_name: "unexpected_legacy_sequence",
          function_identity: null,
          owner_name: testLegacyOwner,
        },
      ],
    ],
    [
      "shared database ownership",
      [
        ...validPreCanonicalOwnershipRows(),
        {
          object_kind: "shared_database",
          schema_name: null,
          object_name: "current_database",
          function_identity: null,
          owner_name: testMigrationExecutor,
        },
      ],
    ],
    [
      "owner mismatch",
      validPreCanonicalOwnershipRows().map((row, index) =>
        index === 0 ? { ...row, owner_name: testFixtureSessionRole } : row
      ),
    ],
  ])("stops before owner changes when pre-canonical inventory has %s", async (_label, rows) => {
    const canonical = createOwnershipCanonicalizationFakeClient({ preRows: rows });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_PRE_CANONICAL_INVENTORY_MISMATCH"
    );
    expect(canonical.state.ownerChanges).toEqual([]);
    expect(postflight.state).toEqual({
      connect: 0,
      query: [],
      end: 0,
      destroy: 0,
    });
  });

  it("does not start postflight after a finite canonicalization failure", async () => {
    const canonical = createOwnershipCanonicalizationFakeClient({
      rejectOwnerChangeAt: 5,
    });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe("EXTERNAL_FIXTURE_VERIFICATION_FAILED");
    expect(canonical.state.ownerChanges).toHaveLength(5);
    expect(canonical.state.end).toBe(1);
    expect(canonical.state.destroy).toBe(0);
    expect(postflight.state.connect).toBe(0);
  });

  it.each([
    ["missing object", validPostCanonicalOwnershipRows().slice(1)],
    [
      "duplicate object",
      [
        ...validPostCanonicalOwnershipRows(),
        validPostCanonicalOwnershipRows()[0],
      ],
    ],
    [
      "executor residue",
      validPostCanonicalOwnershipRows().map((row, index) =>
        index === 1 ? { ...row, owner_name: testMigrationExecutor } : row
      ),
    ],
    [
      "legacy owner residue",
      validPostCanonicalOwnershipRows().map((row, index) =>
        index === 2 ? { ...row, owner_name: testLegacyOwner } : row
      ),
    ],
    [
      "unknown owner",
      validPostCanonicalOwnershipRows().map((row, index) =>
        index === 3 ? { ...row, owner_name: "unknown_fixture_owner" } : row
      ),
    ],
    [
      "session owner mismatch",
      validPostCanonicalOwnershipRows().map((row, index) =>
        index === 4 ? { ...row, owner_name: "wrong_session_owner" } : row
      ),
    ],
  ])("does not start postflight when post-canonical snapshot has %s", async (_label, rows) => {
    const canonical = createOwnershipCanonicalizationFakeClient({ postRows: rows });
    const postflight = createPostflightBoundaryFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      callerConfigurationRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 1_000,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(result.failureMarker).toBe(
      "EXTERNAL_FIXTURE_POST_CANONICAL_SNAPSHOT_MISMATCH"
    );
    expect(canonical.state.ownerChanges).toHaveLength(29);
    expect(postflight.state.connect).toBe(0);
  });

  it.each([
    ["owner change", { hangOwnerChangeAt: 5 }],
    ["post-canonical snapshot", { hangOnSnapshot: true }],
    ["pre-cleanup authority inventory", { hangOnAuthorityInventoryAt: 1 }],
    [
      "temporary authority cleanup",
      { hangOnCleanupLabel: "revoke-ledger-table" },
    ],
    ["zero-residue snapshot", { hangOnAuthorityInventoryAt: 2 }],
    ["maintenance owner snapshot", { hangOnMaintenanceSnapshot: true }],
  ])("bounds a %s timeout and preserves an unrelated Client", async (_label, options) => {
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    const canonical = createOwnershipCanonicalizationFakeClient(options);
    const postflight = createPostflightBoundaryFakeClient();
    const unrelated = createDeadlineFakeClient();
    const result = await runOwnershipCanonicalizationProbeForTests({
      initialIdentityClient: canonical.initialIdentityClient,
      client: canonical.client,
      postflightClient: postflight.client,
      unrelatedClient: unrelated.client,
      callerConfigurationRole: testCallerConfigurationRole,
      deadlineLimits: {
        totalMilliseconds: 100,
        connectMilliseconds: 20,
        queryMilliseconds: 10,
        closeMilliseconds: 20,
        phaseMilliseconds: 20,
        migrationMilliseconds: 20,
      },
    });
    expect(result).toMatchObject({
      failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
      timedOut: true,
      activeClientCount: 0,
    });
    expect(canonical.state.destroy).toBe(1);
    expect(canonical.state.queriesAtDestroy).toBe(canonical.state.query.length);
    expect(postflight.state.connect).toBe(0);
    expect(unrelated.counters).toEqual({
      connect: 1,
      query: [],
      end: 1,
      destroy: 0,
    });
    expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
  });

  it.each([
    "connect-hang",
    "raw-query-hang",
    "transaction-hang",
    "migration-hang",
    "preflight-hang",
    "postflight-hang",
    "independent-inventory-hang",
    "cleanup-query-hang",
    "end-hang",
    "total-deadline-exhausted",
    "operation-start-expired",
  ] as const)(
    "bounds the non-settling fake Client case %s and destroys only the owned socket",
    async (scenario) => {
      vi.useFakeTimers();
      try {
        const fake = createDeadlineFakeClient({
          connectHang: scenario === "connect-hang",
          queryHang: [
            "raw-query-hang",
            "independent-inventory-hang",
            "cleanup-query-hang",
          ].includes(scenario),
          hangOnStatement:
            scenario === "transaction-hang"
              ? "SELECT fixed_transaction_body_probe"
              : null,
          endHang: scenario === "end-hang",
        });
        const pending = runHarnessDeadlineProbeForTests({
          scenario,
          client: fake.client,
          deadlineLimits: {
            totalMilliseconds: 100,
            connectMilliseconds: 20,
            queryMilliseconds: 20,
            closeMilliseconds: 20,
            phaseMilliseconds: 20,
            migrationMilliseconds: 20,
          },
        });
        await vi.advanceTimersByTimeAsync(120);
        const result = await pending;
        expect(result).toMatchObject({
          scenario,
          failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
          finiteFailure: true,
          destroyCount: 1,
          activeClientCount: 0,
          postTimeoutOperationStarts: 0,
        });
        expect(fake.counters.destroy).toBe(1);
        expect(fake.counters.query).not.toContain("SELECT blocked_after_timeout");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("isolates a timed-out Client from a simultaneously registered unrelated context", async () => {
    vi.useFakeTimers();
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    try {
      const target = createDeadlineFakeClient({
        hangOnStatement: "SELECT fixed_independent_context_probe",
      });
      const unrelated = createDeadlineFakeClient();
      const contexts = await createIndependentDeadlineContextsForTests({
        targetClient: target.client,
        unrelatedClient: unrelated.client,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 20,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      expect(contexts.inspectTargetForTests()).toMatchObject({
        timedOut: false,
        activeClientCount: 1,
        registered: true,
        usable: true,
        destroyed: false,
      });
      expect(contexts.inspectUnrelatedForTests()).toMatchObject({
        timedOut: false,
        activeClientCount: 1,
        registered: true,
        usable: true,
        destroyed: false,
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(await contexts.targetOperation).toBe(
        "EXTERNAL_FIXTURE_OPERATION_TIMEOUT"
      );
      expect(target.counters).toMatchObject({
        connect: 1,
        query: ["SELECT fixed_independent_context_probe"],
        end: 0,
        destroy: 1,
      });
      expect(target.state).toMatchObject({
        usable: false,
        destroyed: true,
        queriesAtDestroy: 1,
      });
      expect(contexts.inspectTargetForTests()).toMatchObject({
        timedOut: true,
        activeClientCount: 0,
        registered: false,
        usable: false,
        destroyed: true,
        destroyCount: 1,
        operationStarts: { connect: 1, query: 1, close: 0 },
      });
      expect(unrelated.counters).toEqual({
        connect: 1,
        query: [],
        end: 0,
        destroy: 0,
      });
      expect(unrelated.state).toMatchObject({
        usable: true,
        destroyed: false,
        ended: false,
      });
      expect(contexts.inspectUnrelatedForTests()).toMatchObject({
        timedOut: false,
        activeClientCount: 1,
        registered: true,
        usable: true,
        destroyed: false,
        operationStarts: { connect: 1, query: 0, close: 0 },
      });

      await contexts.closeUnrelatedForTests();
      expect(unrelated.counters).toEqual({
        connect: 1,
        query: [],
        end: 1,
        destroy: 0,
      });
      expect(contexts.inspectUnrelatedForTests()).toMatchObject({
        timedOut: false,
        activeClientCount: 0,
        registered: false,
        usable: false,
        destroyed: false,
        closed: true,
        operationStarts: { connect: 1, query: 0, close: 1 },
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses withRollback and starts no ROLLBACK after a transaction body timeout", async () => {
    vi.useFakeTimers();
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    try {
      const fake = createDeadlineFakeClient({
        hangOnStatement: "SELECT fixed_transaction_body_probe",
      });
      const pending = runHarnessTransactionBoundaryProbeForTests({
        client: fake.client,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 20,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;
      expect(fake.counters.query).toEqual([
        "BEGIN",
        "SELECT fixed_transaction_body_probe",
      ]);
      expect(fake.counters.query.filter((query) => query === "ROLLBACK")).toHaveLength(
        0
      );
      expect(fake.counters.query.filter((query) => query === "COMMIT")).toHaveLength(
        0
      );
      expect(fake.counters).toMatchObject({ end: 0, destroy: 1 });
      expect(fake.state.queriesAtDestroy).toBe(2);
      expect(result).toMatchObject({
        failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
        timedOut: true,
        activeClientCount: 0,
        destroyed: true,
        closed: false,
        operationStarts: { connect: 1, query: 2, close: 0 },
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same withRollback path and performs one rollback for a finite body error", async () => {
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    const fake = createDeadlineFakeClient({
      rejectOnStatement: "SELECT fixed_transaction_body_probe",
    });
    const result = await runHarnessTransactionBoundaryProbeForTests({
      client: fake.client,
      deadlineLimits: {
        totalMilliseconds: 500,
        connectMilliseconds: 100,
        queryMilliseconds: 100,
        closeMilliseconds: 100,
        phaseMilliseconds: 100,
        migrationMilliseconds: 100,
      },
    });
    expect(fake.counters.query).toEqual([
      "BEGIN",
      "SELECT fixed_transaction_body_probe",
      "ROLLBACK",
    ]);
    expect(fake.counters.query.filter((query) => query === "ROLLBACK")).toHaveLength(
      1
    );
    expect(fake.counters.query.filter((query) => query === "COMMIT")).toHaveLength(
      0
    );
    expect(fake.counters).toMatchObject({ end: 1, destroy: 0 });
    expect(result).toMatchObject({
      failureMarker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED",
      timedOut: false,
      activeClientCount: 0,
      destroyed: false,
      closed: true,
      operationStarts: { connect: 1, query: 3, close: 1 },
    });
    expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
  });

  it("uses a short real timer for a non-settling query and handles its late rejection", async () => {
    const fake = createDeadlineFakeClient({ lateQueryRejection: true });
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    const beforeListeners = process.listenerCount("unhandledRejection");
    process.on("unhandledRejection", listener);
    try {
      const result = await runHarnessDeadlineProbeForTests({
        scenario: "raw-query-hang",
        client: fake.client,
        deadlineLimits: {
          totalMilliseconds: 100,
          connectMilliseconds: 20,
          queryMilliseconds: 10,
          closeMilliseconds: 20,
          phaseMilliseconds: 20,
          migrationMilliseconds: 20,
        },
      });
      expect(result).toMatchObject({
        failureMarker: "EXTERNAL_FIXTURE_OPERATION_TIMEOUT",
        finiteFailure: true,
        destroyCount: 1,
        activeClientCount: 0,
        postTimeoutOperationStarts: 0,
      });
      expect(result.elapsedMilliseconds).toBeLessThan(1_000);
      await new Promise((resolveWait) => setTimeout(resolveWait, 60));
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(
        /credential|late-rejection|select fixed_deadline_probe/i
      );
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(process.listenerCount("unhandledRejection")).toBe(beforeListeners);
  });

  it("uses a fixed independent extension oracle instead of the production query result", async () => {
    expect(EXTERNAL_FIXTURE_EXTENSION_CONTRACT_FOR_TESTS).toEqual([
      { name: "plpgsql", schema: "pg_catalog", version: "1.0" },
    ]);
    expect(
      validateIndependentExtensionInventoryForTests([
        { name: "plpgsql", schema: "pg_catalog", version: "1.0" },
      ])
    ).toEqual({ match: true });
    expect(INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS).toContain(
      "pg_catalog.pg_extension"
    );
    expect(INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS).toContain(
      "pg_catalog.pg_namespace"
    );
    expect(INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS).toContain("ORDER BY");
    expect(sameSql(
      INDEPENDENT_EXTENSION_INVENTORY_SQL_FOR_TESTS,
      PREFLIGHT_SQL_FOR_TESTS.extensionInventory
    )).toBe(false);
    const source = await readFile(postgresHarnessModule, "utf8");
    expect(source).not.toContain("expectedExtensionInventory(client)");
    expect(source).toContain("fixedExpectedExtensionInventory()");
  });

  it.each([
    ["missing", []],
    [
      "extra",
      [
        { name: "plpgsql", schema: "pg_catalog", version: "1.0" },
        { name: "extra", schema: "public", version: "1.0" },
      ],
    ],
    ["name", [{ name: "wrong", schema: "pg_catalog", version: "1.0" }]],
    ["version", [{ name: "plpgsql", schema: "pg_catalog", version: "2.0" }]],
    ["schema", [{ name: "plpgsql", schema: "public", version: "1.0" }]],
    [
      "unknown key",
      [
        {
          name: "plpgsql",
          schema: "pg_catalog",
          version: "1.0",
          extra: true,
        },
      ],
    ],
  ])("rejects an independent inventory %s mismatch", (_label, rows) => {
    expect(() =>
      validateIndependentExtensionInventoryForTests(rows)
    ).toThrow("EXTERNAL_FIXTURE_EXTENSION_INVENTORY_MISMATCH");
  });

  it.each([
    ["empty inventory / missing row", []],
    ["name mismatch", [{ name: "wrong", schema: "pg_catalog", version: "1.0" }]],
    ["version mismatch", [{ name: "plpgsql", schema: "pg_catalog", version: "2.0" }]],
    ["schema mismatch", [{ name: "plpgsql", schema: "public", version: "1.0" }]],
  ])("rejects the production extension query %s", async (_label, extensions) => {
    const state = baseState();
    state.extensionInventory = extensions;
    const environment = validEnvironment();
    environment.ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS = JSON.stringify({
      schemaVersion: 1,
      extensions: EXTERNAL_FIXTURE_EXTENSION_CONTRACT_FOR_TESTS,
    });
    const report = await runPreflight(
      createAdapter({ directState: state, pooledState: state }),
      environment
    );
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
  });

  it("preserves every migrated usage-contract assertion without a caller-supplied Migration path", async () => {
    const source = await readFile(postgresHarnessModule, "utf8");
    for (const required of [
      "verifyOldMigrationCompatibility",
      "verifyPublicAclMigrationFailure",
      "verifyUsageAclInheritance",
      "verifyPlanResolution",
      "verifyReservationLifecycle",
      "EXTERNAL_FIXTURE_PUBLIC_ACL_FAILURE_NOT_ATOMIC",
      "EXTERNAL_FIXTURE_PLAN_FAILURE_CHANGED_STATE",
      "EXTERNAL_FIXTURE_CONCURRENT_RESERVATION_MISMATCH",
      "EXTERNAL_FIXTURE_ONE_TIME_RELEASE_MISMATCH",
      "EXTERNAL_FIXTURE_FINALIZATION_MISMATCH",
      "EXTERNAL_FIXTURE_STALE_RECOVERY_MISMATCH",
      "readMigrationFiles(configuration)",
      "migrations.slice(0, expectedCount)",
    ]) {
      expect(source).toContain(required);
    }
    for (const forbidden of [
      "migrationsFolder =",
      "migrationPath",
      "migrationSql",
      "callerMigration",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it.each(["postgres", "postgresql"])(
    "accepts only the canonical %s numeric-loopback shape",
    (protocol) => {
      const credential = "ci_fixture_only_not_a_secret";
      const result = validateExternalFixtureConfigurationForTests(
        externalFixtureEnvironment({
          ACTUSTUBE_STAGING_HARNESS_DATABASE_URL:
            `${protocol}://actustube_ci_fixture:${credential}@127.0.0.1:5432/actustube_ci_fixture`,
        })
      );
      expect(result).toEqual({
        valid: true,
        numericLoopback: true,
        explicitPort: true,
        databaseIdentity: "match",
        roleIdentity: "match",
        postgresqlMajor: 18,
        migrationMax: 6,
      });
      expect(JSON.stringify(result)).not.toContain(credential);
    }
  );

  it.each([
    ["uppercase protocol", "Postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube_ci_fixture"],
    ["localhost", "postgresql://actustube_ci_fixture:p@localhost:5432/actustube_ci_fixture"],
    ["DNS host", "postgresql://actustube_ci_fixture:p@db.example.test:5432/actustube_ci_fixture"],
    ["IPv6", "postgresql://actustube_ci_fixture:p@[::1]:5432/actustube_ci_fixture"],
    ["mapped IPv6", "postgresql://actustube_ci_fixture:p@[::ffff:127.0.0.1]:5432/actustube_ci_fixture"],
    ["encoded host", "postgresql://actustube_ci_fixture:p@127%2e0%2e0%2e1:5432/actustube_ci_fixture"],
    ["missing port", "postgresql://actustube_ci_fixture:p@127.0.0.1/actustube_ci_fixture"],
    ["zero port", "postgresql://actustube_ci_fixture:p@127.0.0.1:0/actustube_ci_fixture"],
    ["overflow port", "postgresql://actustube_ci_fixture:p@127.0.0.1:65536/actustube_ci_fixture"],
    ["noncanonical port", "postgresql://actustube_ci_fixture:p@127.0.0.1:05432/actustube_ci_fixture"],
    ["database mismatch", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/other_fixture"],
    ["role mismatch", "postgresql://other_fixture:p@127.0.0.1:5432/actustube_ci_fixture"],
    ["query", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube_ci_fixture?sslmode=disable"],
    ["fragment", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube_ci_fixture#fragment"],
    ["multi-host", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432,127.0.0.1:5433/actustube_ci_fixture"],
    ["whitespace", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube_ci_fixture "],
    ["control", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube_ci_fixture\n"],
    ["missing user", "postgresql://:p@127.0.0.1:5432/actustube_ci_fixture"],
    ["missing password", "postgresql://actustube_ci_fixture@127.0.0.1:5432/actustube_ci_fixture"],
    ["encoded user", "postgresql://actustube%5fci_fixture:p@127.0.0.1:5432/actustube_ci_fixture"],
    ["encoded password", "postgresql://actustube_ci_fixture:p%21@127.0.0.1:5432/actustube_ci_fixture"],
    ["encoded database", "postgresql://actustube_ci_fixture:p@127.0.0.1:5432/actustube%5fci_fixture"],
  ])("rejects %s before the connection factory is called", async (_label, url) => {
    const clientFactory = vi.fn();
    await expect(
      runConnectionOnlyHarness({
        environment: externalFixtureEnvironment({
          ACTUSTUBE_STAGING_HARNESS_DATABASE_URL: url,
        }),
        clientFactory,
      })
    ).rejects.toThrow(/EXTERNAL_FIXTURE_/);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["ACTUSTUBE_STAGING_HARNESS_EXPECTED_DATABASE", "other_fixture"],
    ["ACTUSTUBE_STAGING_HARNESS_EXPECTED_ROLE", "other_fixture"],
    ["ACTUSTUBE_STAGING_HARNESS_EXPECTED_MAJOR", "17"],
    ["ACTUSTUBE_STAGING_HARNESS_EXPECTED_MIGRATION_MAX", "7"],
    ["ACTUSTUBE_STAGING_HARNESS_UNEXPECTED", "1"],
  ])("rejects a mismatched %s before any connection", async (key, value) => {
    const clientFactory = vi.fn();
    await expect(
      runConnectionOnlyHarness({
        environment: externalFixtureEnvironment({ [key]: value }),
        clientFactory,
      })
    ).rejects.toThrow(/EXTERNAL_FIXTURE_/);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("emits the fixed missing-fixture marker and never attempts a connection", async () => {
    const clientFactory = vi.fn();
    await expect(
      runConnectionOnlyHarness({
        environment: {
          NODE_ENV: "test",
          DATABASE_URL:
            "postgresql://generic:ignored@127.0.0.1:5432/generic",
        },
        clientFactory,
      })
    ).rejects.toThrow("EXTERNAL_FIXTURE_NOT_CONFIGURED");
    expect(clientFactory).not.toHaveBeenCalled();

    await expect(
      runDirectHarnessInvocation({
        DATABASE_URL:
          "postgresql://generic:ignored@127.0.0.1:5432/generic",
      })
    ).resolves.toEqual({
      code: 1,
      stdout: "",
      stderr: "EXTERNAL_FIXTURE_NOT_CONFIGURED\n",
    });
  });

  it("keeps credentials and target identity out of all validation output", async () => {
    const environment = externalFixtureEnvironment();
    const publicResult =
      validateExternalFixtureConfigurationForTests(environment);
    const serialized = JSON.stringify(publicResult);
    for (const forbidden of [
      environment.ACTUSTUBE_STAGING_HARNESS_DATABASE_URL,
      "ci_fixture_only_not_a_secret",
      "actustube_ci_fixture",
      "127.0.0.1",
      "5432",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const success = externalFixtureSuccessResultForTests();
    expect(success).toEqual(externalFixturePublicSuccessOracle);
    expect(Object.keys(success).sort()).toEqual(
      [
        "extensionClassification",
        "independentExtensionInventory",
        "fixtureConfigured",
        "lifecycleOwner",
        "migrationCount",
        "migrationOrderAndReplay",
        "temporaryAuthorityCleanup",
        "usageMigrationSemantics",
        "deadlineBounded",
        "outputRedaction",
        "postflight",
        "postflightDriftRejected",
        "postgresqlMajor",
        "snapshotDriftRejected",
        "stablePreflight",
        "success",
        "transactionRollback",
        "verifierQueriesReadOnly",
      ].sort()
    );
    const successSerialized = JSON.stringify(success);
    expect(successSerialized).not.toContain("ci_fixture_only_not_a_secret");
    expect(successSerialized).not.toContain("actustube_ci_fixture");
    expect(successSerialized).not.toContain("127.0.0.1");

    const credential = "credential_must_not_be_reported";
    const cli = await runDirectHarnessInvocation(
      externalFixtureEnvironment({
        ACTUSTUBE_STAGING_HARNESS_DATABASE_URL:
          `postgresql://actustube_ci_fixture:${credential}@localhost:5432/actustube_ci_fixture`,
      })
    );
    expect(cli).toEqual({
      code: 1,
      stdout: "",
      stderr: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN\n",
    });
    expect(JSON.stringify(cli)).not.toContain(credential);
  });
});

describe("external PostgreSQL public-safe phase observability oracle", () => {
  const actualLifecyclePhases: readonly string[] = [
    "FIXTURE_CLIENT_CONNECT",
    "FIXTURE_CLIENT_CLOSE",
    "PRE_MUTATION_CLIENT_CONNECT",
    "MIGRATION_CLIENT_CLOSE",
    "CLEANUP_CLIENT_CONNECT",
    "CANONICAL_CLIENT_CLOSE",
  ];
  const transcriptKeys = [
    "activeClientCount",
    "connectionFactoryCallCount",
    "exitCode",
    "failureMarker",
    "operationStartCount",
    "phaseStartCount",
    "phaseTrace",
    "postflightStartCount",
    "probeStateRemoved",
    "publicResult",
    "skippedOperationCount",
    "stderr",
    "stdout",
    "targetConnectCount",
    "targetDestroyCount",
    "targetEndCount",
    "targetHitCount",
    "targetQueryCount",
    "unrelatedDestroyCount",
  ].sort();

  it("keeps the independent literal oracle complete and duplicate-free", () => {
    expect(externalFixturePhaseMarkerOracle).toHaveLength(78);
    expect(
      new Set(externalFixturePhaseMarkerOracle.map((entry) => entry.scenario)).size
    ).toBe(78);
    expect(
      new Set(externalFixturePhaseMarkerOracle.map((entry) => entry.phase)).size
    ).toBe(78);
    expect(
      new Set(externalFixturePhaseMarkerOracle.map((entry) => entry.marker)).size
    ).toBe(78);
    expect(externalFixtureUnknownMarkerOracle).toHaveLength(5);
    expect(
      new Set(externalFixtureUnknownMarkerOracle.map((entry) => entry.scenario))
        .size
    ).toBe(5);
    expect(
      externalFixturePhaseMarkerOracle.some(
        (entry) => entry.phase === "FIXTURE_LEDGER_SETUP"
      )
    ).toBe(true);
    const oraclePhases: readonly string[] =
      externalFixturePhaseMarkerOracle.map((entry) => entry.phase);
    expect(oraclePhases).not.toContain("PREFLIGHT_INITIAL");
    expect(oraclePhases).not.toContain("MIGRATION_POSTCONDITIONS");
  });

  it("maps the migration postcondition subphase matrix without marker swaps", async () => {
    const matrix = [
      [
        "migration-final-owner-postcondition-failure",
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL_OWNER_POSTCONDITION",
      ],
      [
        "migration-replay-owner-postcondition-failure",
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_REPLAY_OWNER_POSTCONDITION",
      ],
      [
        "migration-usage-body-acl-grant-failure",
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT",
      ],
      [
        "migration-usage-body-acl-grant-inventory-failure",
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_GRANT_INVENTORY",
      ],
      [
        "migration-usage-acl-inheritance-failure",
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_ACL_INHERITANCE",
      ],
      [
        "migration-plan-resolution-failure",
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_PLAN_RESOLUTION",
      ],
      [
        "migration-reservation-lifecycle-failure",
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RESERVATION_LIFECYCLE",
      ],
      [
        "migration-usage-body-acl-revoke-failure",
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_REVOKE",
      ],
      [
        "migration-usage-body-acl-zero-residue-failure",
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE",
      ],
      [
        "migration-runtime-acl-configuration-failure",
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_RUNTIME_ACL_CONFIGURATION",
      ],
    ] as const;
    const observedMarkers: string[] = [];
    for (const [scenario, expectedMarker] of matrix) {
      const result = await runExternalFixturePhaseProbeForTests(scenario);
      expect(result.failureMarker).toBe(expectedMarker);
      expect(result.stderr).toBe(`${expectedMarker}\n`);
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
      observedMarkers.push(result.failureMarker);
    }
    expect(new Set(observedMarkers).size).toBe(matrix.length);
  });

  it.each(externalFixturePhaseMarkerOracle)(
    "maps the fixed $scenario scenario to its independent literal marker",
    async ({ scenario, phase, marker }) => {
      const result = await runExternalFixturePhaseProbeForTests(scenario);
      const targetIndex = externalFixtureProductionPhaseOrder.indexOf(phase);
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      const expectedTrace = externalFixtureProductionPhaseOrder.slice(
        0,
        targetIndex + 1
      );
      const bodyAclGrantIndex = externalFixtureProductionPhaseOrder.indexOf(
        "MIGRATION_USAGE_BODY_ACL_GRANT"
      );
      const bodyAclRevokeIndex = externalFixtureProductionPhaseOrder.indexOf(
        "MIGRATION_USAGE_BODY_ACL_REVOKE"
      );
      const bodyAclZeroResidueIndex = externalFixtureProductionPhaseOrder.indexOf(
        "MIGRATION_USAGE_BODY_ACL_ZERO_RESIDUE"
      );
      const bodyAclCleanupRunsAfterPrimaryFailure =
        targetIndex >= bodyAclGrantIndex && targetIndex < bodyAclRevokeIndex;
      if (bodyAclCleanupRunsAfterPrimaryFailure) {
        expectedTrace.push(
          ...externalFixtureProductionPhaseOrder.slice(
            bodyAclRevokeIndex,
            bodyAclZeroResidueIndex + 1
          )
        );
      }
      const fixtureCloseIndex = externalFixtureProductionPhaseOrder.indexOf(
        "FIXTURE_CLIENT_CLOSE"
      );
      const preMutationConnectIndex = externalFixtureProductionPhaseOrder.indexOf(
        "PRE_MUTATION_CLIENT_CONNECT"
      );
      const migrationCloseIndex = externalFixtureProductionPhaseOrder.indexOf(
        "MIGRATION_CLIENT_CLOSE"
      );
      const usageContainerIndex = externalFixtureProductionPhaseOrder.indexOf(
        "MIGRATION_USAGE_ACL_INHERITANCE"
      );
      const cleanupConnectIndex = externalFixtureProductionPhaseOrder.indexOf(
        "CLEANUP_CLIENT_CONNECT"
      );
      const canonicalCloseIndex = externalFixtureProductionPhaseOrder.indexOf(
        "CANONICAL_CLIENT_CLOSE"
      );
      const probeContainerPhases = [
        "MIGRATION_USAGE_ACL_INHERITANCE",
        "MIGRATION_PLAN_RESOLUTION",
        "MIGRATION_RESERVATION_LIFECYCLE",
      ];
      if (targetIndex > 0 && targetIndex < fixtureCloseIndex) {
        expectedTrace.push("FIXTURE_CLIENT_CLOSE");
      } else if (
        targetIndex > preMutationConnectIndex &&
        targetIndex < migrationCloseIndex
      ) {
        expectedTrace.push("MIGRATION_CLIENT_CLOSE");
      } else if (
        targetIndex > cleanupConnectIndex &&
        targetIndex < canonicalCloseIndex
      ) {
        expectedTrace.push("CANONICAL_CLIENT_CLOSE");
      }
      const expectedSkippedOperationCount =
        externalFixtureProductionPhaseOrder
          .slice(0, targetIndex)
          .filter(
            (candidate) =>
              !actualLifecyclePhases.includes(candidate) &&
              !probeContainerPhases.includes(candidate)
          )
          .length + (bodyAclCleanupRunsAfterPrimaryFailure ? 2 : 0);
      const expectedClientCount =
        1 +
        (targetIndex >= preMutationConnectIndex ? 1 : 0) +
        (targetIndex > usageContainerIndex ? 1 : 0) +
        (targetIndex >= cleanupConnectIndex ? 1 : 0);
      const expectedOperationStartCount =
        expectedTrace.filter((candidate) =>
          actualLifecyclePhases.includes(candidate)
        ).length +
        externalFixtureProductionPhaseOrder
          .slice(0, targetIndex)
          .filter((candidate) => probeContainerPhases.includes(candidate)).length;

      expect(result.failureMarker).toBe(marker);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`${marker}\n`);
      expect(
        result.stderr.split(/\r?\n/).filter((line) => line.length > 0)
      ).toEqual([marker]);
      expect(result.stdout).not.toContain(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_"
      );
      expect(result.publicResult).toBeNull();
      expect(result.phaseTrace).toEqual(expectedTrace);
      expect(result.phaseStartCount).toBe(expectedTrace.length);
      expect(result.targetHitCount).toBe(1);
      expect(result.operationStartCount).toBe(expectedOperationStartCount);
      expect(result.skippedOperationCount).toBe(
        expectedSkippedOperationCount
      );
      expect(result.postflightStartCount).toBe(
        phase === "POSTFLIGHT_DRIFT" ? 2 : phase === "POSTFLIGHT" ? 1 : 0
      );
      expect(result.connectionFactoryCallCount).toBe(expectedClientCount);
      expect(result.targetConnectCount).toBe(expectedClientCount);
      expect(result.targetEndCount).toBe(expectedClientCount);
      expect(result.targetQueryCount).toBe(0);
      expect(result.targetDestroyCount).toBe(0);
      expect(result.activeClientCount).toBe(0);
      expect(result.probeStateRemoved).toBe(true);
      expect(Object.keys(result).sort()).toEqual(transcriptKeys);
    }
  );

  it.each(externalFixtureUnknownMarkerOracle)(
    "maps the fixed $scenario scenario to UNKNOWN without trusting its message",
    async ({ scenario, marker }) => {
      const result = await runExternalFixturePhaseProbeForTests(scenario);

      expect(result).toMatchObject({
        failureMarker: marker,
        exitCode: 1,
        stdout: "",
        stderr: `${marker}\n`,
        publicResult: null,
        phaseTrace: [],
        phaseStartCount: 0,
        targetHitCount: 0,
        operationStartCount: 0,
        postflightStartCount: 0,
        connectionFactoryCallCount: 0,
        activeClientCount: 0,
        probeStateRemoved: true,
      });
      expect(
        result.stderr.split(/\r?\n/).filter((line) => line.length > 0)
      ).toEqual([marker]);
      expect(Object.keys(result).sort()).toEqual(transcriptKeys);
    }
  );

  it("rejects the retired broad migration postcondition marker message as UNKNOWN", async () => {
    const result = await runExternalFixturePhaseProbeForTests(
      "old-broad-marker-message"
    );
    expect(result).toMatchObject({
      failureMarker: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN",
      exitCode: 1,
      stdout: "",
      stderr: "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN\n",
      phaseTrace: [],
      phaseStartCount: 0,
      targetHitCount: 0,
      operationStartCount: 0,
      postflightStartCount: 0,
      activeClientCount: 0,
      probeStateRemoved: true,
    });
  });

  it("keeps the public success result unchanged and emits no marker", async () => {
    const expected = externalFixturePublicSuccessOracle;
    const result = await runExternalFixturePhaseProbeForTests("success");

    expect(result).toMatchObject({
      failureMarker: null,
      exitCode: 0,
      stderr: "",
      publicResult: expected,
      phaseTrace: externalFixtureProductionPhaseOrder,
      phaseStartCount: externalFixtureProductionPhaseOrder.length,
      targetHitCount: 0,
      operationStartCount: 9,
      skippedOperationCount: 70,
      postflightStartCount: 2,
      connectionFactoryCallCount: 4,
      targetConnectCount: 4,
      targetQueryCount: 0,
      targetEndCount: 4,
      targetDestroyCount: 0,
      activeClientCount: 0,
      probeStateRemoved: true,
    });
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
    expect(result.stdout).not.toContain(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_"
    );
    expect(Object.keys(result.publicResult || {}).sort()).toEqual(
      Object.keys(expected).sort()
    );
    expect(Object.keys(result).sort()).toEqual(transcriptKeys);
  });

  it("preserves the final-owner subphase marker through outer wrappers", async () => {
    const result = await runExternalFixturePhaseProbeForTests(
      "migration-final-through-outer-wrappers"
    );

    expect(result).toMatchObject({
      failureMarker:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL_OWNER_POSTCONDITION",
      exitCode: 1,
      stdout: "",
      stderr:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL_OWNER_POSTCONDITION\n",
      phaseTrace: [
        "MIGRATION_USAGE_ACL_INHERITANCE",
        "MIGRATION_FINAL_OWNER_POSTCONDITION",
      ],
      phaseStartCount: 2,
      targetHitCount: 1,
      operationStartCount: 1,
      postflightStartCount: 0,
      activeClientCount: 0,
      probeStateRemoved: true,
    });
  });

  it("preserves the primary marker while canonical close still runs and fails", async () => {
    const result = await runExternalFixturePhaseProbeForTests(
      "migration-final-plus-canonical-close"
    );

    expect(result).toMatchObject({
      failureMarker:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL_OWNER_POSTCONDITION",
      exitCode: 1,
      stdout: "",
      stderr:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_FINAL_OWNER_POSTCONDITION\n",
      phaseTrace: [
        "CLEANUP_CLIENT_CONNECT",
        "MIGRATION_USAGE_ACL_INHERITANCE",
        "MIGRATION_FINAL_OWNER_POSTCONDITION",
        "CANONICAL_CLIENT_CLOSE",
      ],
      phaseStartCount: 4,
      targetHitCount: 1,
      operationStartCount: 3,
      postflightStartCount: 0,
      targetConnectCount: 1,
      targetEndCount: 1,
      targetDestroyCount: 0,
      activeClientCount: 0,
      probeStateRemoved: true,
    });
  });

  it("uses canonical-client-close only for a close-only failure", async () => {
    const result = await runExternalFixturePhaseProbeForTests(
      "canonical-close-only"
    );

    expect(result).toMatchObject({
      failureMarker:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_CANONICAL_CLIENT_CLOSE",
      exitCode: 1,
      stdout: "",
      stderr:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_CANONICAL_CLIENT_CLOSE\n",
      phaseTrace: ["CLEANUP_CLIENT_CONNECT", "CANONICAL_CLIENT_CLOSE"],
      phaseStartCount: 2,
      targetHitCount: 0,
      operationStartCount: 2,
      postflightStartCount: 0,
      targetConnectCount: 1,
      targetEndCount: 1,
      targetDestroyCount: 0,
      activeClientCount: 0,
      probeStateRemoved: true,
    });
  });

  it("rebrands a private token replayed from another context at the current phase", async () => {
    const result = await runExternalFixturePhaseProbeForTests(
      "cross-context-token-replay"
    );

    expect(result).toMatchObject({
      failureMarker:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_REPLAY_OWNER_POSTCONDITION",
      exitCode: 1,
      stdout: "",
      stderr:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_REPLAY_OWNER_POSTCONDITION\n",
      publicResult: null,
      phaseTrace: ["MIGRATION_REPLAY_OWNER_POSTCONDITION"],
      phaseStartCount: 1,
      targetHitCount: 0,
      operationStartCount: 1,
      skippedOperationCount: 0,
      postflightStartCount: 0,
      activeClientCount: 0,
      probeStateRemoved: true,
    });
    expect(result.stderr).not.toContain("MIGRATION_FINAL_OWNER_POSTCONDITION");
  });

  it("keeps unknown, forgery, and secret-shaped errors fully redacted", async () => {
    for (const { scenario } of externalFixtureUnknownMarkerOracle) {
      const result = await runExternalFixturePhaseProbeForTests(scenario);
      const serialized = JSON.stringify(result);
      expect(result.failureMarker).toBe(
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_UNKNOWN"
      );
      for (const forbidden of [
        "fixed-private-unknown-failure",
        "MIGRATION_FINAL",
        "MIGRATION_POSTCONDITIONS",
        "credential://",
        "127.0.0.1",
        "5432",
        "private_db",
        "SELECT private_role",
        "private_catalog",
        "stack",
        "cause",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(Object.keys(result).sort()).toEqual(transcriptKeys);
    }
  });

  it("rejects missing, extra, and unknown scenarios before running a probe", async () => {
    await expect(
      Reflect.apply(runExternalFixturePhaseProbeForTests, undefined, [])
    ).rejects.toThrow("EXTERNAL_FIXTURE_PHASE_PROBE_INVALID");
    await expect(
      Reflect.apply(runExternalFixturePhaseProbeForTests, undefined, [
        "success",
        "unexpected-extra-argument",
      ])
    ).rejects.toThrow("EXTERNAL_FIXTURE_PHASE_PROBE_INVALID");
    await expect(
      runExternalFixturePhaseProbeForTests("unknown-scenario-name")
    ).rejects.toThrow("EXTERNAL_FIXTURE_PHASE_PROBE_INVALID");
  });

  it("keeps the intentional PUBLIC-ACL rejection inside its successful control", async () => {
    const expected = externalFixturePublicSuccessOracle;
    const result = await runExternalFixturePhaseProbeForTests(
      "intentional-public-acl-negative-control"
    );

    expect(result).toMatchObject({
      failureMarker: null,
      exitCode: 0,
      stderr: "",
      publicResult: expected,
      phaseTrace: ["MIGRATION_PUBLIC_ACL_NEGATIVE_CONTROL"],
      phaseStartCount: 1,
      targetHitCount: 0,
      operationStartCount: 1,
      postflightStartCount: 0,
      activeClientCount: 0,
      probeStateRemoved: true,
    });
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
  });

  it("bounds timeout cleanup to the owned client and leaves unrelated state intact", async () => {
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    const beforeUncaught = process.listenerCount("uncaughtException");
    const unhandled: unknown[] = [];
    const unhandledListener = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", unhandledListener);
    try {
      const result = await runExternalFixturePhaseProbeForTests(
        "fixture-identity-timeout"
      );

      expect(result).toMatchObject({
        failureMarker:
          "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_IDENTITY",
        exitCode: 1,
        stdout: "",
        stderr:
          "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_IDENTITY\n",
        phaseTrace: ["FIXTURE_IDENTITY"],
        phaseStartCount: 1,
        targetHitCount: 0,
        operationStartCount: 1,
        postflightStartCount: 0,
        targetConnectCount: 1,
        targetQueryCount: 1,
        targetEndCount: 0,
        targetDestroyCount: 1,
        unrelatedDestroyCount: 0,
        activeClientCount: 0,
        probeStateRemoved: true,
      });
      await Promise.resolve();
      expect(unhandled).toEqual([]);
      expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught);
    } finally {
      process.off("unhandledRejection", unhandledListener);
    }
    expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
    expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught);
  });

  it("isolates concurrent probe contexts without marker or trace crossover", async () => {
    const [identity, revoke] = await Promise.all([
      runExternalFixturePhaseProbeForTests("fixture-identity-rejects"),
      runExternalFixturePhaseProbeForTests("bounded-revoke-rejects"),
    ]);

    expect(identity).toMatchObject({
      failureMarker:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_IDENTITY",
      phaseTrace: [
        "FIXTURE_CLIENT_CONNECT",
        "FIXTURE_IDENTITY",
        "FIXTURE_CLIENT_CLOSE",
      ],
      targetHitCount: 1,
      probeStateRemoved: true,
    });
    expect(revoke).toMatchObject({
      failureMarker:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_BOUNDED_REVOKE",
      phaseTrace: [
        ...externalFixtureProductionPhaseOrder.slice(
          0,
          externalFixtureProductionPhaseOrder.indexOf("BOUNDED_REVOKE") + 1
        ),
        "CANONICAL_CLIENT_CLOSE",
      ],
      targetHitCount: 1,
      probeStateRemoved: true,
    });
    expect(identity.stderr).not.toContain("BOUNDED_REVOKE");
    expect(revoke.stderr).not.toContain("FIXTURE_IDENTITY");
  });

  it("removes probe state after success, failure, close failure, and timeout", async () => {
    for (const scenario of [
      "success",
      "fixture-identity-rejects",
      "canonical-close-only",
      "fixture-identity-timeout",
    ]) {
      const result = await runExternalFixturePhaseProbeForTests(scenario);
      expect(result.probeStateRemoved).toBe(true);
      expect(result.activeClientCount).toBe(0);
    }
  });

  it("routes a fixed scenario through the actual exported production harness path", async () => {
    const result = await runExternalFixturePhaseProbeForTests(
      "production-fixture-client-connect-path"
    );

    expect(result).toMatchObject({
      failureMarker:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_CLIENT_CONNECT",
      exitCode: 1,
      stdout: "",
      stderr:
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_FIXTURE_CLIENT_CONNECT\n",
      phaseTrace: ["FIXTURE_CLIENT_CONNECT"],
      phaseStartCount: 1,
      targetHitCount: 1,
      operationStartCount: 1,
      postflightStartCount: 0,
      connectionFactoryCallCount: 1,
      targetConnectCount: 1,
      targetEndCount: 1,
      activeClientCount: 0,
      probeStateRemoved: true,
    });
  });

  it("binds every non-UNKNOWN phase wrapper to the production operation graph", async () => {
    const source = await readFile(postgresHarnessModule, "utf8");
    const productionSource = sourceSection(
      source,
      "const EXTERNAL_FIXTURE_PHASES = Object.freeze({",
      "const INTERNAL_PHASE_PROBE_SCENARIOS = Object.freeze({"
    );
    const exactProductionOccurrences = Object.freeze({
      runFixtureClientConnectPhase: 2,
      runFixtureIdentityPhase: 2,
      runFixtureLedgerSetupPhase: 2,
      runExtensionInventoryPhase: 2,
      runFixtureClientClosePhase: 2,
      runPreflightStabilityPhase: 2,
      runSnapshotDriftControlPhase: 2,
      runExtensionClassificationPhase: 2,
      runPreMutationClientConnectPhase: 2,
      runPreMutationIdentityPhase: 2,
      runDefaultPrivilegeRevokePhase: 2,
      runFixtureRoleSetupPhase: 3,
      runMigrationBoundaryIdentityPhase: 2,
      runMigrationBaselinePhase: 2,
      runMigrationPublicAclNegativeControlPhase: 2,
      runMigrationFinalPhase: 2,
      runMigrationReplayPhase: 2,
      runMigrationFinalOwnerPostconditionPhase: 2,
      runMigrationReplayOwnerPostconditionPhase: 2,
      runMigrationUsageAclInheritancePhase: 2,
      runMigrationUsageOwnerPostconditionPhase: 2,
      runMigrationUsageOwnerInheritancePhase: 2,
      runMigrationUsageLegacyAclPreservationPhase: 2,
      runMigrationUsageAclComparisonPhase: 2,
      runMigrationUsageExplicitRuntimePrivilegePhase: 2,
      runMigrationUsageMembershipRuntimePrivilegePhase: 2,
      runMigrationUsageDeniedRuntimePrivilegePhase: 2,
      runMigrationUsagePublicRuntimePrivilegePhase: 2,
      runMigrationUsageSecurityModePhase: 2,
      runMigrationUsageSearchPathPhase: 2,
      runMigrationUsageExplicitRuntimeExecutionPhase: 2,
      runMigrationUsageMembershipRuntimeExecutionPhase: 2,
      runMigrationUsageDeniedRuntimeExecutionPhase: 2,
      runMigrationUsagePublicRuntimeExecutionPhase: 2,
      runMigrationPlanResolutionPhase: 2,
      runMigrationPlanFreeFallbackPhase: 2,
      runMigrationPlanInactiveFallbackPhase: 2,
      runMigrationPlanFailurePhase: 2,
      runMigrationReservationLifecyclePhase: 2,
      runMigrationReservationConcurrencySetupPhase: 2,
      runMigrationReservationConcurrentLimitPhase: 2,
      runMigrationReservationBucketPostconditionPhase: 2,
      runMigrationReservationConcurrencyCleanupPhase: 2,
      runMigrationReservationReleaseSetupPhase: 2,
      runMigrationReservationReleaseCreatePhase: 2,
      runMigrationReservationReleaseIdempotencyPhase: 2,
      runMigrationReservationFinalizationCreatePhase: 2,
      runMigrationReservationFinalizationPhase: 2,
      runMigrationReservationStaleSetupPhase: 2,
      runMigrationReservationStaleRecoveryPhase: 2,
      runMigrationReservationLifecycleCleanupPhase: 2,
      runMigrationRuntimeAclConfigurationPhase: 2,
      runMigrationClientClosePhase: 2,
      runTransactionRollbackControlPhase: 2,
      runCleanupClientConnectPhase: 2,
      runCleanupIdentityPhase: 2,
      runOwnershipPreInventoryPhase: 2,
      runOwnershipCanonicalizationPhase: 2,
      runOwnershipPostSnapshotPhase: 2,
      runAuthorityPreInventoryPhase: 2,
      runBoundedRevokePhase: 2,
      runAuthorityZeroResiduePhase: 2,
      runMaintenanceOwnerSnapshotPhase: 2,
      runCanonicalClientClosePhase: 2,
      runPostflightPhase: 2,
      runPostflightDriftPhase: 2,
    });
    for (const [wrapper, expectedCount] of Object.entries(
      exactProductionOccurrences
    )) {
      expect(literalOccurrenceCount(productionSource, `${wrapper}(`)).toBe(
        expectedCount
      );
    }

    const withClientSection = sourceSection(
      productionSource,
      "async function withClient(",
      "function fixtureCredentials("
    );
    expect(withClientSection).toMatch(
      /INITIAL_FIXTURE_CLIENT_LIFECYCLE[\s\S]{0,120}runFixtureClientConnectPhase\(context, openOperation\)/
    );
    expect(withClientSection).toMatch(
      /MIGRATION_CLIENT_LIFECYCLE[\s\S]{0,120}runPreMutationClientConnectPhase\(context, openOperation\)/
    );
    expect(withClientSection).toMatch(
      /CANONICAL_CLEANUP_CLIENT_LIFECYCLE[\s\S]{0,120}runCleanupClientConnectPhase\(context, openOperation\)/
    );
    expect(withClientSection).toMatch(
      /INITIAL_FIXTURE_CLIENT_LIFECYCLE[\s\S]{0,160}runFixtureClientClosePhase\(context,[\s\S]{0,80}closeOwnedClient\(context, ownedClient\)/
    );
    expect(withClientSection).toMatch(
      /MIGRATION_CLIENT_LIFECYCLE[\s\S]{0,160}runMigrationClientClosePhase\(context,[\s\S]{0,80}closeOwnedClient\(context, ownedClient\)/
    );
    expect(withClientSection).toMatch(
      /CANONICAL_CLEANUP_CLIENT_LIFECYCLE[\s\S]{0,160}runCanonicalClientClosePhase\(context,[\s\S]{0,80}closeOwnedClient\(context, ownedClient\)/
    );
    expect(withClientSection).toMatch(
      /if \(primaryFailed\) throw primaryFailure;\s*if \(closeFailed\) throw closeFailure;/
    );

    const preMutationSection = sourceSection(
      productionSource,
      "async function runPreMutationSessionIdentityBoundary({",
      "function validateInitialMigrationBoundaryRoles("
    );
    expect(preMutationSection).toMatch(
      /runPreMutationIdentityPhase\([\s\S]{0,180}observeSessionIdentity\(/
    );
    expect(preMutationSection).toMatch(/MIGRATION_CLIENT_LIFECYCLE/);

    const migrationSection = sourceSection(
      productionSource,
      "async function orchestrateUsageMigrationOwnerBoundary({",
      "function usageSignatureArraySql("
    );
    for (const binding of [
      /runFixtureRoleSetupPhase\([\s\S]{0,100}createUsageFixtureRoles\(/,
      /runMigrationBoundaryIdentityPhase\([\s\S]{0,180}assertInitialMigrationBoundaryRoles\(/,
      /runFixtureRoleSetupPhase\([\s\S]{0,100}grantUsageMigrationPrivileges\(/,
      /runMigrationBaselinePhase\([\s\S]{0,220}runMigrationCallback\([\s\S]{0,80}"baseline"/,
      /runMigrationPublicAclNegativeControlPhase\([\s\S]{0,100}beforeFinalMigration\(/,
      /runMigrationFinalPhase\([\s\S]{0,220}runMigrationCallback\(context, client, "final"/,
      /runMigrationReplayPhase\([\s\S]{0,220}runMigrationCallback\(context, client, "replay"/,
      /runMigrationFinalOwnerPostconditionPhase\([\s\S]{0,120}assertUsageOwnerPostcondition\(/,
      /runMigrationReplayOwnerPostconditionPhase\([\s\S]{0,120}assertUsageOwnerPostcondition\(/,
      /runDefaultPrivilegeRevokePhase\([\s\S]{0,120}client\.query\(/,
      /runMigrationUsageAclInheritancePhase\([\s\S]{0,160}verifyUsageAclInheritance\(/,
      /runMigrationPlanResolutionPhase\([\s\S]{0,120}verifyPlanResolution\(/,
      /runMigrationReservationLifecyclePhase\([\s\S]{0,140}verifyReservationLifecycle\(/,
      /runMigrationRuntimeAclConfigurationPhase\([\s\S]{0,220}configureRuntimeAcl\(/,
    ]) {
      expect(migrationSection).toMatch(binding);
    }

    const usageSubphaseSection = sourceSection(
      productionSource,
      "async function verifyUsageAclInheritance(",
      "async function withRollback("
    );
    for (const wrapper of [
      "runMigrationUsageOwnerPostconditionPhase",
      "runMigrationUsageOwnerInheritancePhase",
      "runMigrationUsageLegacyAclPreservationPhase",
      "runMigrationUsageAclComparisonPhase",
      "runMigrationUsageExplicitRuntimePrivilegePhase",
      "runMigrationUsageMembershipRuntimePrivilegePhase",
      "runMigrationUsageDeniedRuntimePrivilegePhase",
      "runMigrationUsagePublicRuntimePrivilegePhase",
      "runMigrationUsageSecurityModePhase",
      "runMigrationUsageSearchPathPhase",
      "runMigrationUsageExplicitRuntimeExecutionPhase",
      "runMigrationUsageMembershipRuntimeExecutionPhase",
      "runMigrationUsageDeniedRuntimeExecutionPhase",
      "runMigrationUsagePublicRuntimeExecutionPhase",
    ]) {
      expect(literalOccurrenceCount(usageSubphaseSection, `${wrapper}(`)).toBe(1);
    }

    const planSubphaseSection = sourceSection(
      productionSource,
      "async function verifyPlanResolution(",
      "async function executeFixtureQuery("
    );
    expect(planSubphaseSection).toContain("runMigrationPlanFreeFallbackPhase(");
    expect(planSubphaseSection).toContain("runMigrationPlanInactiveFallbackPhase(");
    expect(planSubphaseSection).toContain(
      "runMigrationPlanFailurePhase(context, index"
    );
    for (const phase of [
      "MIGRATION_PLAN_FUTURE_ASSIGNMENT_REJECTION",
      "MIGRATION_PLAN_EXPIRED_ASSIGNMENT_REJECTION",
      "MIGRATION_PLAN_UNKNOWN_REFERENCE_REJECTION",
      "MIGRATION_PLAN_DUPLICATE_ASSIGNMENT_REJECTION",
      "MIGRATION_PLAN_MISSING_BASELINE_REJECTION",
      "MIGRATION_PLAN_DUPLICATE_BASELINE_REJECTION",
      "MIGRATION_PLAN_INACTIVE_BASELINE_REJECTION",
      "MIGRATION_PLAN_LIMIT_MISMATCH_REJECTION",
      "MIGRATION_PLAN_INVALID_LIMIT_REJECTION",
    ]) {
      expect(literalOccurrenceCount(productionSource, `"${phase}"`)).toBe(1);
    }

    const reservationSubphaseSection = sourceSection(
      productionSource,
      "async function verifyReservationLifecycle(",
      "async function verifyTransactionRollback("
    );
    for (const wrapper of [
      "runMigrationReservationConcurrencySetupPhase",
      "runMigrationReservationConcurrentLimitPhase",
      "runMigrationReservationBucketPostconditionPhase",
      "runMigrationReservationConcurrencyCleanupPhase",
      "runMigrationReservationReleaseSetupPhase",
      "runMigrationReservationReleaseCreatePhase",
      "runMigrationReservationReleaseIdempotencyPhase",
      "runMigrationReservationFinalizationCreatePhase",
      "runMigrationReservationFinalizationPhase",
      "runMigrationReservationStaleSetupPhase",
      "runMigrationReservationStaleRecoveryPhase",
      "runMigrationReservationLifecycleCleanupPhase",
    ]) {
      expect(literalOccurrenceCount(reservationSubphaseSection, `${wrapper}(`)).toBe(
        1
      );
    }

    const canonicalSection = sourceSection(
      productionSource,
      "async function runCanonicalOwnershipBoundary({",
      "async function configureRuntimeAcl("
    );
    for (const binding of [
      /runCleanupIdentityPhase\([\s\S]{0,120}observeSessionIdentity\(/,
      /runOwnershipPreInventoryPhase\([\s\S]{0,100}assertPreCanonicalOwnershipInventory\(/,
      /runOwnershipCanonicalizationPhase\([\s\S]{0,100}canonicalizeFixtureOwnership\(/,
      /runOwnershipPostSnapshotPhase\([\s\S]{0,100}assertPostCanonicalOwnershipSnapshot\(/,
      /runAuthorityPreInventoryPhase\([\s\S]{0,140}assertPreCleanupTemporaryAuthorityInventory\(/,
      /runBoundedRevokePhase\([\s\S]{0,100}revokeTemporaryMigrationAuthorities\(/,
      /runAuthorityZeroResiduePhase\([\s\S]{0,100}assertZeroTemporaryAuthorityResidue\(/,
      /runMaintenanceOwnerSnapshotPhase\([\s\S]{0,100}assertPostCanonicalOwnershipSnapshot\(/,
      /CANONICAL_CLEANUP_CLIENT_LIFECYCLE/,
      /runPostflightPhase\(context, postflightOperation\)/,
    ]) {
      expect(canonicalSection).toMatch(binding);
    }

    const connectionHarnessSection = sourceSection(
      productionSource,
      "async function runConnectionOnlyHarnessWithinContext(options, context)",
      "export async function runConnectionOnlyHarness(options = {})"
    );
    for (const binding of [
      /runFixtureIdentityPhase\([\s\S]{0,100}assertFixtureIdentity\(/,
      /runFixtureLedgerSetupPhase\([\s\S]{0,100}createEmptyMigrationLedger\(/,
      /runExtensionInventoryPhase\([\s\S]{0,100}verifyIndependentExtensionInventory\(/,
      /INITIAL_FIXTURE_CLIENT_LIFECYCLE/,
      /runPreflightStabilityPhase\([\s\S]{0,180}runStablePreflight\(/,
      /runSnapshotDriftControlPhase\([\s\S]{0,180}runStablePreflight\(/,
      /runExtensionClassificationPhase\([\s\S]{0,120}verifyExtensionClassificationMatrix\(/,
      /runTransactionRollbackControlPhase\([\s\S]{0,120}verifyTransactionRollback\(/,
      /runCanonicalOwnershipBoundary\([\s\S]{0,500}runPostflight\(/,
      /runPostflightDriftPhase\([\s\S]{0,500}runPostflight\(/,
    ]) {
      expect(connectionHarnessSection).toMatch(binding);
    }

    expect(productionSource).not.toContain("PREFLIGHT_INITIAL");
    expect(productionSource).not.toContain("migrationPostconditions");
    expect(productionSource).not.toContain(
      "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_POSTCONDITIONS"
    );
    expect(
      literalOccurrenceCount(
        source,
        "EXTERNAL_FIXTURE_VERIFICATION_FAILED_PHASE_MIGRATION_POSTCONDITIONS"
      )
    ).toBe(1);
    expect(
      literalOccurrenceCount(
        productionSource,
        "const EXTERNAL_FIXTURE_PHASE_MARKERS = Object.freeze({"
      )
    ).toBe(1);

    const probeEntrySection = sourceSection(
      source,
      "export async function runExternalFixturePhaseProbeForTests(scenario)",
      "const DEADLINE_PROBE_SCENARIOS = new Set(["
    );
    expect(probeEntrySection).toMatch(
      /requireHarness\([\s\S]{0,180}arguments\.length === 1[\s\S]{0,180}INTERNAL_PHASE_PROBE_SCENARIOS/
    );
    expect(probeEntrySection.indexOf("requireHarness(")).toBeLessThan(
      probeEntrySection.indexOf("const specification")
    );
    expect(probeEntrySection.indexOf("const specification")).toBeLessThan(
      probeEntrySection.indexOf("createDeadlineContext(")
    );
    expect(probeEntrySection).not.toMatch(
      /process\.env|process\.argv|callerPhase|callerMarker|callbackScenario/
    );

    const directInvocationSection = source.slice(
      source.indexOf("const invokedDirectly =")
    );
    expect(directInvocationSection).toMatch(
      /if \(invokedDirectly\) \{\s*try \{[\s\S]*?const result = await runConnectionOnlyHarness\(\);[\s\S]*?process\.stdout\.write\(`\$\{JSON\.stringify\(result\)\}\\n`\);\s*\} catch \(error\) \{\s*process\.stderr\.write\(externalFixtureFailureOutput\(error\)\);\s*process\.exitCode = 1;\s*\}\s*\}/
    );
    expect(
      literalOccurrenceCount(
        directInvocationSection,
        "externalFixtureFailureOutput(error)"
      )
    ).toBe(1);
    expect(
      literalOccurrenceCount(directInvocationSection, "process.stderr.write(")
    ).toBe(1);
  });
});

describe("benign child parent-observed P3 oracle", () => {
  it.each([
    ["correct-nonzero", true, 70, null, ["created", "running", "terminal"]],
    ["correct-signal", true, null, "SIGTERM", ["created", "signal_ready"]],
    ["deadline", true, null, "SIGTERM", ["created", "deadline_pending"]],
    ["wrong-nonzero", false, 71, null, ["created", "running", "terminal"]],
    ["exit-zero", false, 0, null, ["created", "running", "terminal"]],
    ["wrong-signal", false, null, "SIGKILL", ["created", "signal_ready"]],
    ["normal-before-deadline", false, 0, null, ["created", "deadline_pending"]],
    ["pre-phase-failure", false, 73, null, []],
    ["unexpected-normal-after-phase", false, 0, null, ["created", "running"]],
    ["forged-terminal-reason", false, 71, null, ["created", "running"]],
    ["duplicate-phase", false, 70, null, ["created"]],
    ["malformed-phase", false, 70, null, ["created"]],
    ["replayed-phase", false, 70, null, ["created", "running"]],
  ] as const)("classifies the actual %s child from parent events", async (
    mode,
    accepted,
    expectedCode,
    expectedSignal,
    expectedPhases
  ) => {
    const result = await runBenignChildLifecycleProbeForTests(mode);
    expect(result.accepted).toBe(accepted);
    expect(result.authenticatedPhases).toEqual(expectedPhases);
    expect(result.exitObservation).toMatchObject({
      count: 1,
      code: expectedCode,
      signal: expectedSignal,
      timestampMilliseconds: expect.any(Number),
    });
    expect(result.closeObservation).toMatchObject({
      count: 1,
      code: expectedCode,
      signal: expectedSignal,
      timestampMilliseconds: expect.any(Number),
    });
    expect(result.closeObservation.timestampMilliseconds).toBeGreaterThanOrEqual(
      result.exitObservation.timestampMilliseconds
    );
    expect(result.errorObservation).toEqual({
      count: 0,
      timestampMilliseconds: null,
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        "accepted",
        "authenticatedPhases",
        "closeObservation",
        "deadlineAlive",
        "errorObservation",
        "exitObservation",
        "messageContract",
        "mode",
        "phaseContract",
        "schemaVersion",
        "terminalContract",
      ].sort()
    );
    for (const key of ["exitObservation", "closeObservation"] as const) {
      expect(Object.keys(result[key]).sort()).toEqual(
        ["code", "count", "signal", "timestampMilliseconds"].sort()
      );
    }
    expect(Object.keys(result.errorObservation).sort()).toEqual(
      ["count", "timestampMilliseconds"].sort()
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/pid|ppid|capabilityToken|occurrenceId/i);
  }, 10_000);

  it("requires the deadline child to be alive at the parent deadline", async () => {
    const result = await runBenignChildLifecycleProbeForTests("deadline", {
      deadlineMilliseconds: 100,
    });
    expect(result).toMatchObject({
      accepted: true,
      messageContract: true,
      phaseContract: true,
      terminalContract: true,
      deadlineAlive: true,
      authenticatedPhases: ["created", "deadline_pending"],
      exitObservation: {
        count: 1,
        code: null,
        signal: "SIGTERM",
        timestampMilliseconds: expect.any(Number),
      },
      closeObservation: {
        count: 1,
        code: null,
        signal: "SIGTERM",
        timestampMilliseconds: expect.any(Number),
      },
    });
  });

  it("accepts the exact nonzero code and exact signal only", async () => {
    const nonzero = await runBenignChildLifecycleProbeForTests("correct-nonzero");
    expect(nonzero).toMatchObject({
      accepted: true,
      exitObservation: {
        count: 1,
        code: 70,
        signal: null,
        timestampMilliseconds: expect.any(Number),
      },
      closeObservation: {
        count: 1,
        code: 70,
        signal: null,
        timestampMilliseconds: expect.any(Number),
      },
    });
    const signaled = await runBenignChildLifecycleProbeForTests("correct-signal");
    expect(signaled).toMatchObject({
      accepted: true,
      exitObservation: {
        count: 1,
        code: null,
        signal: "SIGTERM",
        timestampMilliseconds: expect.any(Number),
      },
      closeObservation: {
        count: 1,
        code: null,
        signal: "SIGTERM",
        timestampMilliseconds: expect.any(Number),
      },
    });
  });

  it("closes every fixed benign child that this suite actually spawned", () => {
    expect(benignChildLifecycleCountersForTests()).toEqual({
      spawned: 16,
      closed: 16,
    });
  });
});

describe("terminal abort propagation", () => {
  it("rejects an already-aborted run before DB open", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = createAdapter();
    const report = await (verifyStagingDatabasePreflight as any)({
      environment: validEnvironment(),
      repositoryRoot,
      adapter: fixture,
      signal: controller.signal,
    });

    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("DATABASE_OPERATION_ABORTED");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("stops scheduling main queries after abort and uses cleanup", async () => {
    const controller = new AbortController();
    const fixture = createAdapter();
    const statements: string[] = [];
    const report = await (verifyStagingDatabasePreflight as any)({
      environment: validEnvironment(),
      repositoryRoot,
      adapter: fixture,
      signal: controller.signal,
      onQuery: (statement: string) => {
        statements.push(statement);
        if (sameSql(statement, PREFLIGHT_SQL_FOR_TESTS.extensionInventory)) {
          controller.abort();
        }
      },
    });

    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("DATABASE_OPERATION_ABORTED");
    expect(fixture.connect).toHaveBeenCalledTimes(2);
    expect(fixture.connect.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
    expect(fixture.connect.mock.calls[1]?.[2]?.signal).toBe(controller.signal);
    expect(
      countSqlCalls(fixture.directConnection, PREFLIGHT_SQL_FOR_TESTS.extensionInventory)
    ).toBe(0);
    expect(
      countSqlCalls(fixture.directConnection, PREFLIGHT_SQL_FOR_TESTS.migrationCatalog)
    ).toBe(0);
    expect(fixture.directConnection.close).toHaveBeenCalledOnce();
    expect(statements.some((statement) => sameSql(statement, POSTFLIGHT_SQL_FOR_TESTS.rollback))).toBe(true);
  });
});

describe("staging extension inventory", () => {
  const extensions = [
    { name: "plpgsql", schema: "pg_catalog", version: "1.0" },
    { name: "vector", schema: "extensions", version: "0.8.0" },
  ];

  it("accepts an order-independent exact inventory", async () => {
    const state = baseState();
    state.extensionInventory = [...extensions].reverse();
    const environment = {
      ...validEnvironment(),
      ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
        schemaVersion: 1,
        extensions,
      }),
    };
    const report = await runPreflight(createAdapter({ directState: state }), environment);
    expect(report.exitCode).toBe(0);
    expect(report.extensionInventory).toBe("match");
  });

  it("preserves no-env precedence and requires the inventory", async () => {
    const noEnvFixture = createAdapter();
    const noEnv = await runPreflight(noEnvFixture, {});
    expect(noEnv.failure.checkId).toBe("STAGING_ENVIRONMENT_REQUIRED");
    expect(noEnvFixture.connect).not.toHaveBeenCalled();

    const environment = validEnvironment();
    delete environment.ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS;
    const missingFixture = createAdapter();
    const missing = await runPreflight(missingFixture, environment);
    expect(missing.exitCode).toBe(2);
    expect(missing.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_REQUIRED");
    expect(missingFixture.connect).not.toHaveBeenCalled();
  });

  it("rejects malformed, dangerous, duplicate, and bounded input", async () => {
    const invalidValues = [
      "",
      "{",
      JSON.stringify({ schemaVersion: 1, extensions: [], extra: true }),
      '{"schemaVersion":1,"extensions":[],"__proto__":{}}',
      JSON.stringify({ schemaVersion: 1, extensions: [{ name: "x", schema: "public", version: "1" }, { name: "x", schema: "public", version: "2" }] }),
      JSON.stringify({ schemaVersion: 1, extensions: [{ name: "bad/name", schema: "public", version: "1" }] }),
      JSON.stringify({ schemaVersion: 1, extensions: [{ name: "bad\u0000name", schema: "public", version: "1" }] }),
      JSON.stringify({ schemaVersion: 1, extensions: "not-an-array" }),
      " ".repeat(STAGING_EXTENSION_INVENTORY_LIMITS.jsonBytes + 1),
    ];
    for (const raw of invalidValues) {
      const fixture = createAdapter();
      const report = await runPreflight(fixture, {
        ...validEnvironment(),
        ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: raw,
      });
      expect(report.exitCode).toBe(2);
      expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_INVALID");
      expect(fixture.connect).not.toHaveBeenCalled();
    }
    expect(() =>
      parseExpectedStagingExtensions({
        ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
          schemaVersion: 1,
          extensions: Array.from(
            { length: STAGING_EXTENSION_INVENTORY_LIMITS.entries + 1 },
            (_, index) => ({ name: `x${index}`, schema: "public", version: "1" })
          ),
        }),
      })
    ).toThrow("STAGING_EXTENSION_INVENTORY_INVALID");
  });

  it("fails closed when actual inventory is unavailable", async () => {
    const state = baseState();
    state.extensionInventory = null;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_UNAVAILABLE");
  });

  it("rejects an unexpected actual extension", async () => {
    const state = baseState();
    state.extensionInventory = [extensions[0]];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
  });

  it("rejects an extension version mismatch", async () => {
    const state = baseState();
    state.extensionInventory = [{ ...extensions[0], version: "2.0" }];
    const environment = {
      ...validEnvironment(),
      ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
        schemaVersion: 1,
        extensions: [extensions[0]],
      }),
    };
    const report = await runPreflight(createAdapter({ directState: state }), environment);
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
  });

  it("rejects an extension schema mismatch", async () => {
    const state = baseState();
    state.extensionInventory = [{ ...extensions[0], schema: "public" }];
    const environment = {
      ...validEnvironment(),
      ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
        schemaVersion: 1,
        extensions: [extensions[0]],
      }),
    };
    const report = await runPreflight(createAdapter({ directState: state }), environment);
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
  });

  it("rejects direct, pooled, and after-snapshot drift", async () => {
    const expected = {
      ...validEnvironment(),
      ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS: JSON.stringify({
        schemaVersion: 1,
        extensions: [extensions[0]],
      }),
    };
    const matching = baseState();
    matching.extensionInventory = [extensions[0]];
    const pooledMismatch = baseState();
    pooledMismatch.extensionInventory = [extensions[1]];
    const pooledReport = await runPreflight(
      createAdapter({ directState: matching, pooledState: pooledMismatch }),
      expected
    );
    expect(pooledReport.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
    expect(pooledReport.extensionInventory).toBe("not_verified");

    const afterMismatch = baseState();
    afterMismatch.extensionInventoryForRead = (read: number) =>
      read === 1 ? [extensions[0]] : [extensions[1]];
    const afterReport = await runPreflight(
      createAdapter({ directState: afterMismatch, pooledState: matching }),
      expected
    );
    expect(afterReport.failure.checkId).toBe("STAGING_EXTENSION_INVENTORY_MISMATCH");
    expect(afterReport.extensionInventory).toBe("not_verified");
  });
});

describe("staging database preflight safety gate", () => {
  it("passes a pristine database without a migration schema", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture);
    expect(report).toMatchObject({
      exitCode: 0,
      directConnection: "pass",
      pooledConnection: "pass",
      directPooledIdentity: "match",
      postgresqlVersion: {
        direct: "supported",
        pooled: "supported",
        directAfter: "supported",
        pooledAfter: "supported",
      },
      expectedIdentity: "match",
      initialState: "pristine",
      applicationTables: 0,
      applicationFunctions: 0,
      applicationData: 0,
      partialSchema: "none",
      readOnlyInvariant: "pass",
      cleanup: "pass",
      secretRedaction: "pass",
    });
    expect(report.userDefinedObjects.direct.total).toBe(0);
    expect(report.userDefinedObjects.pooled.total).toBe(0);
    expect(report.userDefinedObjects.directAfter.total).toBe(0);
    expect(report.userDefinedObjects.pooledAfter.total).toBe(0);
    expect(report.migrationHistory).toMatchObject({
      applied: 0,
      pending: 7,
      duplicates: 0,
      unknown: 0,
    });
    expect(report.migrationHistory.pendingTags).toHaveLength(7);
  });

  it("passes the exact Drizzle migration table with zero rows", async () => {
    const fixture = createAdapter({ directState: emptyMigrationTableState() });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(0);
    expect(report.initialState).toBe("empty_migration_table");
    expect(report.migrationHistory.applied).toBe(0);
  });

  it.each([
    ["missing environment", { ACTUSTUBE_DB_ENV: undefined }, 2],
    ["wrong environment", { ACTUSTUBE_DB_ENV: "production" }, 2],
    ["case mismatch", { ACTUSTUBE_DB_ENV: "Staging" }, 2],
    ["missing confirmation", { ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT: undefined }, 2],
    ["bad confirmation", { ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT: "true" }, 2],
    ["missing direct URL", { DIRECT_DATABASE_URL: undefined }, 2],
    ["missing pooled URL", { DATABASE_URL: undefined }, 2],
    ["missing expected identity", { ACTUSTUBE_EXPECTED_STAGING_IDENTITY: undefined }, 3],
  ])("rejects %s before connecting", async (_label, override, exitCode) => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      ...override,
    });
    expect(report.exitCode).toBe(exitCode);
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("rejects a pooled URL in the direct slot", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      DIRECT_DATABASE_URL: pooledUrl,
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("DIRECT_ENDPOINT_KIND_REJECTED");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("rejects a direct URL in the pooled slot", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      DATABASE_URL: directUrl,
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("POOLED_ENDPOINT_KIND_REJECTED");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("rejects an unknown query before it can supply a staging marker", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      DIRECT_DATABASE_URL:
        "postgresql://migration:dummy-password@ep-actustube-safe.example.test/app?application_name=staging",
      DATABASE_URL:
        "postgresql://runtime:dummy-password@ep-actustube-safe-pooler.example.test/app?application_name=staging",
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("DIRECT_URL_QUERY_REJECTED");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["direct", "DIRECT_URL_AUTHORITY_REJECTED"],
    ["pooled", "POOLED_URL_AUTHORITY_REJECTED"],
    ["both", "DIRECT_URL_AUTHORITY_REJECTED"],
  ] as const)(
    "rejects an encoded database authority in %s before connecting",
    async (side, checkId) => {
      const fixture = createAdapter();
      const environment = validEnvironment();
      if (side === "direct" || side === "both") {
        environment.DIRECT_DATABASE_URL = directUrl.replace(
          "staging_database",
          "app%2Fstaging"
        );
      }
      if (side === "pooled" || side === "both") {
        environment.DATABASE_URL = pooledUrl.replace(
          "staging_database",
          "app%2Fstaging"
        );
      }
      const report = await runPreflight(fixture, environment);
      expect(report.exitCode).toBe(2);
      expect(report.failure.checkId).toBe(checkId);
      expect(fixture.connect).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain("app%2Fstaging");
    }
  );

  it("rejects direct and pooled URL target mismatch", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      DATABASE_URL: pooledUrl.replace("staging_database", "other_staging"),
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("DIRECT_POOLED_TARGET_MISMATCH");
  });

  it("rejects expected provider identity mismatch", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture, {
      ...validEnvironment(),
      ACTUSTUBE_EXPECTED_STAGING_IDENTITY: "ep-other-staging",
    });
    expect(report.exitCode).toBe(2);
    expect(report.failure.checkId).toBe("EXPECTED_STAGING_IDENTITY_MISMATCH");
    expect(report.expectedIdentity).toBe("fail");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("keeps a missing expected provider identity not verified", async () => {
    const fixture = createAdapter();
    const environment = validEnvironment();
    delete environment.ACTUSTUBE_EXPECTED_STAGING_IDENTITY;
    const report = await runPreflight(fixture, environment);
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("EXPECTED_STAGING_IDENTITY_REQUIRED");
    expect(report.expectedIdentity).toBe("not_verified");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("rejects different logical databases behind direct and pooled endpoints", async () => {
    const pooledState = baseState();
    pooledState.identity = { database_oid: "101", system_identifier: "200" };
    const fixture = createAdapter({ pooledState });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(1);
    expect(report.directPooledIdentity).toBe("fail");
    expect(report.failure.checkId).toBe("LOGICAL_DATABASE_IDENTITY_MISMATCH");
  });

  it("rejects an actual database role that differs from the validated URL role", async () => {
    const directState = baseState();
    directState.roleIdentityForRead = () => ({
      role_name: "different_staging_role",
    });
    const report = await runPreflight(
      createAdapter({ directState, pooledState: baseState() })
    );
    expect(report.exitCode).toBe(1);
    expect(report.databaseRoleIdentity).toBe("fail");
    expect(report.failure.checkId).toBe("DIRECT_ROLE_IDENTITY_MISMATCH");
  });

  it("rejects a logical database identity change between before and after reads", async () => {
    const directState = baseState();
    directState.identityForRead = (read: number) => ({
      database_oid: read === 1 ? "100" : "101",
      system_identifier: "200",
    });
    const report = await runPreflight(
      createAdapter({ directState, pooledState: baseState() })
    );
    expect(report.exitCode).toBe(1);
    expect(report.directPooledIdentity).toBe("fail");
    expect(report.failure.checkId).toBe("LOGICAL_DATABASE_IDENTITY_MISMATCH");
  });

  it("rejects different logical databases in the after snapshots", async () => {
    const pooledState = baseState();
    pooledState.identityForRead = (read: number) => ({
      database_oid: read === 1 ? "100" : "101",
      system_identifier: "200",
    });
    const report = await runPreflight(
      createAdapter({ directState: baseState(), pooledState })
    );
    expect(report.exitCode).toBe(1);
    expect(report.directPooledIdentity).toBe("fail");
    expect(report.failure.checkId).toBe("LOGICAL_DATABASE_IDENTITY_MISMATCH");
  });

  it("accepts PostgreSQL 18 and reports only a fixed support status", async () => {
    const report = await runPreflight(createAdapter());
    expect(report.exitCode).toBe(0);
    expect(report.postgresqlVersion).toEqual({
      direct: "supported",
      pooled: "supported",
      directAfter: "supported",
      pooledAfter: "supported",
    });
    expect(JSON.stringify(report)).not.toContain("180004");
  });

  it("prohibits migration on PostgreSQL 17 before version-specific catalog queries", async () => {
    const state = baseState();
    state.serverVersion.server_version_num = "170009";
    const fixture = createAdapter({ directState: state });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("POSTGRESQL_VERSION_UNSUPPORTED");
    expect(countSqlCalls(fixture.directConnection, PREFLIGHT_SQL_FOR_TESTS.identity)).toBe(0);
  });

  it("fails closed when the PostgreSQL version is unavailable", async () => {
    const state = baseState();
    delete state.serverVersion.server_version_num;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("POSTGRESQL_VERSION_UNAVAILABLE");
  });

  it("rejects a direct and pooled PostgreSQL version difference", async () => {
    const directState = baseState();
    const pooledState = baseState();
    pooledState.serverVersion.server_version_num = "180005";
    const report = await runPreflight(
      createAdapter({ directState, pooledState })
    );
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("POSTGRESQL_VERSION_MISMATCH");
  });

  it("rejects a PostgreSQL version change between before and after reads", async () => {
    const state = baseState();
    state.serverVersionForRead = (read: number) => ({
      server_version_num: read === 1 ? "180004" : "180005",
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("POSTGRESQL_VERSION_CHANGED");
  });
});

describe("empty migration and application state", () => {
  it("rejects a migration schema without the migration table", async () => {
    const state = baseState();
    state.migrationCatalog.schema_exists = true;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SCHEMA_PARTIAL");
  });

  it("rejects unexpected objects in an otherwise empty migration schema", async () => {
    const state = emptyMigrationTableState();
    state.migrationCatalog.objects.push("r:unexpected");
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SCHEMA_PARTIAL");
  });

  it("rejects an invalid empty migration table shape", async () => {
    const state = emptyMigrationTableState();
    state.migrationColumns = state.migrationColumns.slice(1);
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_HISTORY_COLUMN_COUNT_MISMATCH");
  });

  it("accepts the three exact fresh Drizzle migration columns", async () => {
    const report = await runPreflight(
      createAdapter({ directState: emptyMigrationTableState() })
    );
    expect(report.exitCode).toBe(0);
  });

  it.each([
    ["generated hash column", 1, "generated_kind", "s"],
    ["generated created_at column", 2, "generated_kind", "s"],
    ["identity column", 0, "identity_kind", "d"],
    ["domain-backed column", 1, "type_kind", "d"],
    ["noncanonical collation", 1, "collation_is_canonical", false],
    ["inherited column", 2, "inherited_count", 1],
    ["nonlocal column", 2, "is_local", false],
    ["column ACL", 1, "acl_is_default", false],
    ["column option", 1, "options_are_default", false],
    ["column FDW option", 1, "fdw_options_are_default", false],
    ["column storage drift", 1, "storage_kind", "p"],
    ["column compression drift", 1, "compression_kind", "p"],
    ["column statistics drift", 1, "statistics_are_default", false],
    ["column relation mapping drift", 1, "relation_is_canonical", false],
    ["column type length drift", 0, "type_length", 8],
    ["column pass-by-value drift", 0, "passed_by_value", false],
    ["column alignment drift", 2, "alignment", "i"],
    ["column default-presence drift", 1, "has_default", true],
  ])("rejects %s", async (_label, index, field, value) => {
    const state = emptyMigrationTableState();
    state.migrationColumnExact[index][field] = value;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_COLUMN_CATALOG_MISMATCH");
  });

  it("rejects a physically retained dropped column", async () => {
    const state = emptyMigrationTableState();
    state.migrationColumnExact.push({
      ...state.migrationColumnExact[2],
      position: 4,
      column_name: "dropped",
      is_dropped: true,
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_COLUMN_CATALOG_MISMATCH");
  });

  it("fails closed when an exact column catalog field is unavailable", async () => {
    const state = emptyMigrationTableState();
    delete state.migrationColumnExact[1].generated_kind;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("MIGRATION_COLUMN_CATALOG_UNAVAILABLE");
  });

  it("rejects a direct and pooled exact-column catalog difference", async () => {
    const directState = emptyMigrationTableState();
    const pooledState = emptyMigrationTableState();
    pooledState.migrationColumnExact[1].storage_kind = "p";
    const report = await runPreflight(
      createAdapter({ directState, pooledState })
    );
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_COLUMN_CATALOG_MISMATCH");
  });

  it("rejects a before and after exact-column catalog change", async () => {
    const state = emptyMigrationTableState();
    state.migrationColumnExactForRead = (read: number) => {
      const rows = migrationColumnExact.map((row) => ({ ...row }));
      if (read > 1) rows[1].storage_kind = "p";
      return rows;
    };
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("READ_ONLY_INVARIANT_MISMATCH");
  });

  it("rejects one partially applied known migration", async () => {
    const specification = await loadRepositorySpecification(repositoryRoot);
    const state = emptyMigrationTableState();
    state.migrationHistory = [
      {
        id: "1",
        hash: specification.migrations[0].hash,
        created_at: specification.migrations[0].createdAt,
      },
    ];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_HISTORY_NOT_EMPTY");
  });

  it("rejects all seven already applied migrations", async () => {
    const specification = await loadRepositorySpecification(repositoryRoot);
    const state = emptyMigrationTableState();
    state.migrationHistory = specification.migrations.map((entry, index) => ({
      id: String(index + 1),
      hash: entry.hash,
      created_at: entry.createdAt,
    }));
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_HISTORY_NOT_EMPTY");
  });

  it("rejects an unknown migration", async () => {
    const state = emptyMigrationTableState();
    state.migrationHistory = [
      { id: "1", hash: "0".repeat(64), created_at: "1" },
    ];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_HISTORY_UNKNOWN");
  });

  it("rejects duplicate migration history", async () => {
    const specification = await loadRepositorySpecification(repositoryRoot);
    const state = emptyMigrationTableState();
    const migration = specification.migrations[0];
    state.migrationHistory = [
      { id: "1", hash: migration.hash, created_at: migration.createdAt },
      { id: "1", hash: migration.hash, created_at: migration.createdAt },
    ];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_HISTORY_DUPLICATE");
  });

  it.each([
    ["unknown public table", "relation_count"],
    ["view", "relation_count"],
    ["materialized view", "relation_count"],
    ["foreign table", "relation_count"],
    ["partitioned table", "relation_count"],
    ["sequence", "relation_count"],
    ["index", "relation_count"],
    ["separate user schema", "schema_count"],
    ["unknown function or procedure", "routine_count"],
    ["enum, domain, or composite type", "type_count"],
    ["trigger", "trigger_count"],
    ["rule", "rule_count"],
    ["policy", "policy_count"],
    ["constraint", "constraint_count"],
    ["other user-defined catalog object", "other_count"],
  ])("rejects residual %s", async (_label, field) => {
    const state = residualState(field);
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("USER_DEFINED_OBJECT_PRESENT");
    expect(report.userDefinedObjects.direct.total).toBe(1);
  });

  it("rejects an unknown table with residual data", async () => {
    const state = residualState("relation_count", {
      estimatedDataRows: "2",
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("USER_DEFINED_DATA_PRESENT");
    expect(report.userDefinedObjects.direct.estimatedDataRows).toBe(2);
  });

  it("fails closed when catalog rows cannot be completely classified", async () => {
    const state = residualState("relation_count");
    state.userDefinedObjects.object_signature = [];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("limits extension exclusions to direct membership and two catalog-proven internal classes", async () => {
    const sql = PREFLIGHT_SQL_FOR_TESTS.userDefinedObjects;
    expect(sql).toContain("pg_depend");
    expect(sql).toContain("pg_extension");
    expect(sql).toContain("extension_direct");
    expect(sql).toContain("extension_internal");
    expect(sql).toContain("extension_classification");
    expect(sql).toContain("extension_managed");
    expect(sql).toContain("dependency_entry.deptype = 'e'");
    expect(sql).toContain("dependency_entry.deptype = 'i'");
    expect(sql).not.toMatch(/deptype\s+(?:IN\s*\([^)]*'a'|=\s*'a')/i);
    expect(sql).not.toContain("extnamespace");
    expect(sql).toContain("rule_entry.rulename = '_RETURN'");
    expect(sql).toContain("relation_entry.relkind IN ('v', 'm')");
    expect(sql).toContain("trigger_entry.tgconstraint = constraint_entry.oid");
    expect(sql).toContain("constraint_entry.contype = 'f'");
    expect(sql).toContain("extension_classification_evidence");
    expect(sql).toContain("extension_candidate_signature");
    expect(sql).toContain("extension_managed_signature");
    expect(sql).toContain("extension_residual_signature");
    expect(sql).toContain("pg_catalog");
    expect(sql).toContain("information_schema");
    expect(sql).toContain("^pg_toast");
    expect(sql).toContain("^pg_temp");
    for (const catalog of [
      "pg_class",
      "pg_proc",
      "pg_type",
      "pg_trigger",
      "pg_rewrite",
      "pg_policy",
      "pg_constraint",
      "pg_event_trigger",
      "pg_foreign_data_wrapper",
      "pg_publication",
      "pg_subscription",
      "pg_default_acl",
      "pg_largeobject_metadata",
    ]) {
      expect(sql).toContain(catalog);
    }
    expect(sql).not.toMatch(/owner/i);
    expect(sql).not.toMatch(/provider/i);
    expect(sql).not.toContain("$1");
    const report = await runPreflight(createAdapter());
    expect(report.exitCode).toBe(0);
  });

  it("binds the external fixture gate to the production classification SQL", async () => {
    expect(PREFLIGHT_SQL_FOR_TESTS.userDefinedObjects).toContain(
      PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS
    );
    const source = await readFile(postgresHarnessModule, "utf8");
    expect(source).toContain("PREFLIGHT_EXTENSION_CLASSIFICATION_SQL_FOR_TESTS");
    expect(source).toContain("unclassified_count");
    expect(source).toContain("ambiguous_count");
    expect(source).toContain("classification_count");
    expect(source).toContain("complete_dependency_count");
  });

  it.each([
    [
      "direct extension member",
      {
        dependencyType: "e",
        dependentClass: "other_catalog",
        referencedClass: "pg_extension",
      },
      true,
      "other_count",
      0,
    ],
    [
      "view return rule with an internal dependency on a direct member",
      {
        dependencyType: "i",
        dependentClass: "pg_rewrite",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
        ruleName: "_RETURN",
        relationKind: "v",
      },
      true,
      "rule_count",
      0,
    ],
    [
      "foreign-key enforcement trigger with an internal dependency on a direct constraint",
      {
        dependencyType: "i",
        dependentClass: "pg_trigger",
        referencedClass: "pg_constraint",
        referencedIsDirectExtensionMember: true,
        triggerConstraintMatches: true,
        constraintType: "f",
      },
      true,
      "trigger_count",
      0,
    ],
    [
      "named constraint added to an extension table",
      {
        dependencyType: "a",
        dependentClass: "pg_constraint",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      },
      false,
      "constraint_count",
      1,
    ],
    [
      "index added to an extension table",
      {
        dependencyType: "a",
        dependentClass: "pg_class",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      },
      false,
      "relation_count",
      1,
    ],
    [
      "trigger added to an extension table",
      {
        dependencyType: "a",
        dependentClass: "pg_trigger",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      },
      false,
      "trigger_count",
      1,
    ],
    [
      "schema matching only extnamespace",
      {
        dependencyType: "n",
        dependentClass: "pg_namespace",
        referencedClass: "pg_extension",
      },
      false,
      "schema_count",
      1,
    ],
    [
      "provider or extension-like name without membership",
      {
        dependencyType: "n",
        dependentClass: "pg_namespace",
        referencedClass: "other_catalog",
      },
      false,
      "schema_count",
      1,
    ],
  ])(
    "classifies %s through the Production catalog validation path",
    async (_label, evidence, managed, residualField, expectedExit) => {
      const state = extensionClassificationState(evidence, {
        managed,
        residualField,
      });
      const report = await runPreflight(
        createAdapter({ directState: state })
      );
      expect(report.exitCode).toBe(expectedExit);
      if (expectedExit === 1) {
        expect(report.failure.checkId).toBe("USER_DEFINED_OBJECT_PRESENT");
      }
    }
  );

  it("fails closed when extension classification evidence is incomplete", async () => {
    const state = extensionClassificationState(
      { referencedClass: "pg_extension" },
      { managed: true }
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects false-clean SQL residual signatures for residual classifier evidence", async () => {
    const state = extensionClassificationState(
      {
        dependencyType: "a",
        dependentClass: "pg_class",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      },
      { residualField: "relation_count" }
    );
    state.userDefinedObjects.total_count = 0;
    state.userDefinedObjects.relation_count = 0;
    state.userDefinedObjects.object_signature = [];
    state.userDefinedObjects.extension_residual_signature = [];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects a managed signature that SQL also reports as residual", async () => {
    const signature = "1259:90004:0";
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature }
    );
    state.userDefinedObjects.total_count = 1;
    state.userDefinedObjects.relation_count = 1;
    state.userDefinedObjects.object_signature = [`relation:${signature}`];
    state.userDefinedObjects.extension_residual_signature = [signature];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects direct membership mixed with residual dependency evidence", async () => {
    const signature = "1259:90010:0";
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature }
    );
    state.userDefinedObjects.extension_classification_evidence.push(
      dependencyEvidence(signature, "residual", {
        dependencyType: "a",
        dependentClass: "pg_class",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      })
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects approved internal dependency mixed with residual evidence", async () => {
    const signature = "2618:90011:0";
    const state = extensionClassificationState(
      {
        dependencyType: "i",
        dependentClass: "pg_rewrite",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
        ruleName: "_RETURN",
        relationKind: "v",
      },
      { managed: true, signature }
    );
    state.userDefinedObjects.extension_classification_evidence.push(
      dependencyEvidence(signature, "residual", {
        dependencyType: "a",
        dependentClass: "pg_rewrite",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      })
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("accepts managed support with normal neutral dependency evidence", async () => {
    const signature = "1259:90015:0";
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature }
    );
    state.userDefinedObjects.extension_classification_evidence.push(
      dependencyEvidence(signature, "neutral", {
        dependencyType: "n",
        dependentClass: "pg_class",
        referencedClass: "pg_namespace",
      })
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(0);
  });

  it("classifies residual support with normal neutral evidence as residual", async () => {
    const signature = "1259:90016:0";
    const state = extensionClassificationState(
      {
        dependencyType: "n",
        dependentClass: "pg_class",
        referencedClass: "pg_namespace",
      },
      { signature, residualField: "relation_count" }
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("USER_DEFINED_OBJECT_PRESENT");
  });

  it("rejects mixed evidence even when SQL reports only residual", async () => {
    const signature = "1259:90012:0";
    const state = extensionClassificationState(
      {
        dependencyType: "a",
        dependentClass: "pg_class",
        referencedClass: "pg_class",
        referencedIsDirectExtensionMember: true,
      },
      { signature, residualField: "relation_count" }
    );
    state.userDefinedObjects.extension_classification_evidence.push(
      dependencyEvidence(signature, "managed", {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      })
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects neutral-only evidence as unclassified", async () => {
    const signature = "1259:90013:0";
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature }
    );
    state.userDefinedObjects.extension_classification_evidence =
      state.userDefinedObjects.extension_classification_evidence.filter(
        (entry: any) => entry.evidenceKind === "candidate"
      );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects an unknown evidence classification", async () => {
    const state = extensionClassificationState(
      {
        evidenceKind: "unknown",
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true }
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects duplicate evidence signatures", async () => {
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true }
    );
    state.userDefinedObjects.extension_classification_evidence.push({
      ...state.userDefinedObjects.extension_classification_evidence[1],
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects evidence linked to a candidate outside the candidate set", async () => {
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true }
    );
    state.userDefinedObjects.extension_classification_evidence.push(
      dependencyEvidence("1259:90014:0", "orphan", {
        dependencyType: "e",
        referencedClass: "pg_extension",
      })
    );
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects a candidate with no evidence", async () => {
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true }
    );
    state.userDefinedObjects.extension_classification_evidence = [];
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it.each([
    ["missing", []],
    ["duplicate", ["1259:90002:0", "1259:90002:0"]],
  ])("rejects a %s classification candidate", async (_label, candidates) => {
    const state = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true }
    );
    state.userDefinedObjects.extension_candidate_signature = candidates;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("USER_OBJECT_CATALOG_UNCLASSIFIED");
  });

  it("rejects a valid direct and pooled classification difference", async () => {
    const directState = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature: "1259:90005:0" }
    );
    const pooledState = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature: "1259:90006:0" }
    );
    const report = await runPreflight(
      createAdapter({ directState, pooledState })
    );
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("DIRECT_POOLED_STATE_MISMATCH");
  });

  it("rejects a valid classification change between before and after reads", async () => {
    const first = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature: "1259:90007:0" }
    ).userDefinedObjects;
    const second = extensionClassificationState(
      {
        dependencyType: "e",
        dependentClass: "pg_class",
        referencedClass: "pg_extension",
      },
      { managed: true, signature: "1259:90008:0" }
    ).userDefinedObjects;
    const state = baseState();
    state.userDefinedObjectsForRead = (read: number) =>
      read === 1 ? first : second;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("READ_ONLY_INVARIANT_MISMATCH");
  });

  it("rejects a provider-like name without catalog extension ownership", async () => {
    const internalSignature = "2615:90009:0";
    const state = residualState("schema_count", {
      signature: internalSignature,
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("USER_DEFINED_OBJECT_PRESENT");
    expect(JSON.stringify(report)).not.toContain(internalSignature);
  });

  it("rejects direct clean and pooled dirty", async () => {
    const report = await runPreflight(
      createAdapter({ pooledState: residualState("relation_count") })
    );
    expect(report.exitCode).toBe(1);
    expect(report.userDefinedObjects.direct.total).toBe(0);
    expect(report.userDefinedObjects.pooled.total).toBe(1);
  });

  it("rejects direct dirty and pooled clean", async () => {
    const report = await runPreflight(
      createAdapter({
        directState: residualState("routine_count"),
        pooledState: baseState(),
      })
    );
    expect(report.exitCode).toBe(1);
    expect(report.userDefinedObjects.direct.total).toBe(1);
    expect(report.userDefinedObjects.pooled.total).toBe(0);
  });

  it("rejects an added CHECK constraint on the empty migration table", async () => {
    const state = emptyMigrationTableState();
    state.migrationExact.constraint_count = 4;
    state.migrationExact.unexpected_constraint_count = 1;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_CONSTRAINT_SHAPE_MISMATCH");
  });

  it("rejects an altered serial sequence", async () => {
    const state = emptyMigrationTableState();
    state.migrationExact.sequence_increment = "2";
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SEQUENCE_SHAPE_MISMATCH");
  });

  it("accepts only the unused current sequence state", async () => {
    const state = emptyMigrationTableState();
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(0);
    expect(report.migrationSequenceState).toEqual({
      direct: "unused",
      pooled: "unused",
      directAfter: "unused",
      pooledAfter: "unused",
    });
  });

  it.each([
    ["advanced last_value", "sequence_last_value", "2"],
    ["is_called true", "sequence_is_called", true],
  ])("rejects sequence current state with %s", async (_label, field, value) => {
    const state = emptyMigrationTableState();
    state.migrationExact[field] = value;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SEQUENCE_STATE_MISMATCH");
  });

  it("rejects differing direct and pooled sequence current state", async () => {
    const directState = emptyMigrationTableState();
    const pooledState = emptyMigrationTableState();
    pooledState.migrationExact.sequence_is_called = true;
    const report = await runPreflight(
      createAdapter({ directState, pooledState })
    );
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SEQUENCE_STATE_MISMATCH");
  });

  it("rejects a before/after sequence current-state change", async () => {
    const state = emptyMigrationTableState();
    state.migrationExactForRead = (read: number) => ({
      ...state.migrationExact,
      sequence_is_called: read === 1 ? false : true,
    });
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("MIGRATION_SEQUENCE_STATE_MISMATCH");
  });

  it("fails closed when sequence current state is unavailable", async () => {
    const state = emptyMigrationTableState();
    delete state.migrationExact.sequence_last_value;
    delete state.migrationExact.sequence_is_called;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe(
      "MIGRATION_SEQUENCE_STATE_UNAVAILABLE"
    );
  });

  it.each([
    ["trigger", "trigger_count", 1, "MIGRATION_TRIGGER_PRESENT"],
    ["rule", "rule_count", 1, "MIGRATION_RULE_PRESENT"],
    ["policy", "policy_count", 1, "MIGRATION_POLICY_PRESENT"],
    [
      "table relation property",
      "table_row_security",
      true,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table physical attribute count",
      "table_attribute_count",
      4,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table index flag",
      "table_has_index",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table ACL",
      "table_acl_is_default",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table tablespace",
      "table_tablespace_is_default",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table shared flag",
      "table_is_shared",
      true,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table rewrite mapping",
      "table_rewrite_is_zero",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table row type mapping",
      "table_row_type_is_canonical",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table TOAST mapping",
      "table_toast_mapping_is_canonical",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "table access method",
      "table_access_method",
      "unexpected",
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "catalog namespace mapping",
      "object_namespaces_are_canonical",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "NOT NULL constraint metadata",
      "not_null_constraints_exact",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "object owner relationship",
      "object_owner_is_consistent",
      false,
      "MIGRATION_TABLE_PROPERTY_MISMATCH",
    ],
    [
      "index relation property",
      "index_is_valid",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index exclusion flag",
      "index_is_exclusion",
      true,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index tablespace",
      "index_tablespace_is_default",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index shared flag",
      "index_is_shared",
      true,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index rewrite mapping",
      "index_rewrite_is_zero",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index row type mapping",
      "index_row_type_is_zero",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index replica identity",
      "index_replica_identity",
      "d",
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index fixed boolean",
      "index_is_ready",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index vector coverage",
      "index_vector_lengths_are_canonical",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index relation mapping",
      "index_relation_mapping_is_canonical",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index immediate flag",
      "index_is_immediate",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "index operator class",
      "index_operator_class_is_canonical",
      false,
      "MIGRATION_INDEX_SHAPE_MISMATCH",
    ],
    [
      "sequence ACL",
      "sequence_acl_is_default",
      false,
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "sequence access method",
      "sequence_access_method_is_zero",
      false,
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "sequence tablespace",
      "sequence_tablespace_is_default",
      false,
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "sequence replica identity",
      "sequence_replica_identity",
      "d",
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "sequence ownership",
      "sequence_owned_by_count",
      0,
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "sequence default dependency",
      "default_sequence_dependency_count",
      0,
      "MIGRATION_SEQUENCE_SHAPE_MISMATCH",
    ],
    [
      "constraint enforcement",
      "constraint_enforcement_is_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint period",
      "constraint_period_is_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint namespace relation index mapping",
      "constraint_mapping_is_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint action chars",
      "constraint_action_fields_are_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint foreign-key arrays",
      "constraint_foreign_key_fields_are_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint exclusion array",
      "constraint_exclusion_fields_are_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "constraint expression",
      "constraint_expression_fields_are_canonical",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "NOT NULL constraint conkey set",
      "not_null_constraint_keys_exact",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
    [
      "NOT NULL constraint canonical names",
      "not_null_constraint_names_exact",
      false,
      "MIGRATION_CONSTRAINT_SHAPE_MISMATCH",
    ],
  ])(
    "rejects an unexpected migration-table %s",
    async (_label, field, value, checkId) => {
      const state = emptyMigrationTableState();
      state.migrationExact[field] = value;
      const report = await runPreflight(createAdapter({ directState: state }));
      expect(report.exitCode).toBe(1);
      expect(report.failure.checkId).toBe(checkId);
    }
  );

  it("fails closed when an exact PostgreSQL 18 catalog field is unavailable", async () => {
    const state = emptyMigrationTableState();
    delete state.migrationExact.constraint_enforcement_is_canonical;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(3);
    expect(report.failure.checkId).toBe("MIGRATION_EXACT_CATALOG_UNAVAILABLE");
  });
});

describe("connections, read-only invariant, cleanup, and output", () => {
  it("rolls back and closes both connections after success", async () => {
    const fixture = createAdapter();
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(0);
    for (const connection of [
      fixture.directConnection,
      fixture.pooledConnection,
    ]) {
      expect(
        countSqlCalls(connection, POSTFLIGHT_SQL_FOR_TESTS.rollback)
      ).toBe(2);
      expect(
        countSqlCalls(connection, POSTFLIGHT_SQL_FOR_TESTS.begin)
      ).toBe(2);
      expect(connection.close).toHaveBeenCalledOnce();
    }
  });

  it("cleans up both connections after a verified state failure", async () => {
    const fixture = createAdapter({
      directState: residualState("relation_count"),
    });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(1);
    for (const connection of [
      fixture.directConnection,
      fixture.pooledConnection,
    ]) {
      expect(
        countSqlCalls(connection, POSTFLIGHT_SQL_FOR_TESTS.rollback)
      ).toBe(1);
      expect(connection.close).toHaveBeenCalledOnce();
    }
  });

  it("classifies a direct connection failure without exposing its error", async () => {
    const fixture = createAdapter({
      directFailure: new Error(`${fakeSecret} ${directUrl}`),
    });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(3);
    expect(report.directConnection).toBe("fail");
    expect(report.failure.status).toBe("not_verified");
    expect(JSON.stringify(report)).not.toContain(fakeSecret);
  });

  it("classifies a pooled connection failure and closes direct", async () => {
    const fixture = createAdapter({
      pooledFailure: new AggregateError([new Error(`${fakeSecret} ${pooledUrl}`)]),
    });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(3);
    expect(report.pooledConnection).toBe("fail");
    expect(report.failure.status).toBe("not_verified");
    expect(fixture.directConnection.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain(fakeSecret);
  });

  it("fails closed on a bounded query timeout", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: any, timeout?: number, ...args: any[]) =>
        nativeSetTimeout(
          handler,
          timeout === 20_000 ? 0 : timeout,
          ...args
        )) as typeof setTimeout);
    try {
      const fixture = createAdapter({ directOptions: { hangAt: "identity" } });
      const report = await runPreflight(fixture);
      expect(report.exitCode).toBe(3);
      expect(report.failure.checkId).toBe("DATABASE_QUERY_TIMEOUT");
      expect(report.failure.status).toBe("not_verified");
      for (const connection of [
        fixture.directConnection,
        fixture.pooledConnection,
      ]) {
        expect(
          countSqlCalls(connection, POSTFLIGHT_SQL_FOR_TESTS.rollback)
        ).toBe(1);
        expect(connection.close).toHaveBeenCalledOnce();
      }
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("fails closed when connection cleanup fails", async () => {
    const fixture = createAdapter({ pooledOptions: { failCleanup: true } });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(3);
    expect(report.cleanup).toBe("not_verified");
    expect(report.failure.checkId).toBe("CONNECTION_CLEANUP_UNVERIFIED");
  });

  it("fails closed when connection cleanup times out", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((handler: any, timeout?: number, ...args: any[]) =>
        nativeSetTimeout(
          handler,
          timeout === 5_000 ? 0 : timeout,
          ...args
        )) as typeof setTimeout);
    try {
      const fixture = createAdapter({ pooledOptions: { hangCleanup: true } });
      try {
        const report = await runPreflight(fixture);
        expect(report.exitCode).toBe(3);
        expect(report.cleanup).toBe("not_verified");
        expect(report.failure.checkId).toBe("CONNECTION_CLEANUP_UNVERIFIED");
        expect(fixture.connect).toHaveBeenCalledTimes(2);
        expect(
          countSqlCalls(
            fixture.directConnection,
            POSTFLIGHT_SQL_FOR_TESTS.rollback
          )
        ).toBe(2);
        expect(fixture.directConnection.close).toHaveBeenCalledOnce();
      } finally {
        fixture.directConnection.clearCleanupHandle();
        fixture.pooledConnection.clearCleanupHandle();
      }
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("does not retry a failed connection", async () => {
    const fixture = createAdapter({
      directFailure: new Error(fakeSecret),
    });
    const report = await runPreflight(fixture);
    expect(report.exitCode).toBe(3);
    expect(fixture.connect).toHaveBeenCalledOnce();
  });

  it("detects a before/after state change", async () => {
    const state = baseState();
    state.userDefinedObjectsForRead = (read: number) =>
      read === 1
        ? state.userDefinedObjects
        : residualState("relation_count").userDefinedObjects;
    const report = await runPreflight(createAdapter({ directState: state }));
    expect(report.exitCode).toBe(1);
    expect(report.failure.checkId).toBe("READ_ONLY_INVARIANT_MISMATCH");
    expect(report.userDefinedObjects.direct.total).toBe(0);
    expect(report.userDefinedObjects.directAfter.total).toBe(1);
  });

  it("emits no write-capable SQL", async () => {
    const statements: string[] = [];
    const fixture = createAdapter();
    const report = await (verifyStagingDatabasePreflight as any)({
      environment: validEnvironment(),
      repositoryRoot,
      adapter: fixture as any,
      onQuery: (statement: string) => statements.push(statement),
    });
    expect(report.exitCode).toBe(0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(() => assertReadOnlySql(statement)).not.toThrow();
      expect(statement).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO)\b/i
      );
    }
  });

  it("keeps fake secrets out of stdout for nested driver errors", async () => {
    const output: string[] = [];
    const fixture = createAdapter({
      directFailure: Object.assign(new Error(`${fakeSecret} ${directUrl}`), {
        cause: new AggregateError([new Error(encodeURIComponent(directUrl))]),
      }),
    });
    const report = await (executeStagingDatabasePreflight as any)({
      environment: validEnvironment(),
      repositoryRoot,
      adapter: fixture,
      stdout: (line: string) => output.push(line),
    });
    expect(report.exitCode).toBe(3);
    const serialized = output.join("\n");
    expect(serialized).toContain(PARENT_ENVIRONMENT_NOTICE);
    for (const secret of [
      fakeSecret,
      directUrl,
      pooledUrl,
      encodeURIComponent(directUrl),
      "staging_direct",
      "staging_runtime",
      "staging_database",
      "ep-actustube-safe",
      "sslmode=require",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("preserves exit code 3 after a fatal event", () => {
    const assigned: number[] = [];
    const output: string[] = [];
    const fatal = createFatalExitLatch({
      stdout: (line: string) => {
        output.push(line);
      },
      setExitCode: (code: number) => assigned.push(code),
    });
    fatal.latch("UNCAUGHT_EXCEPTION");
    fatal.setReportExitCode(0);
    expect(assigned).toEqual([3, 3]);
    expect(output.join("\n")).not.toContain(fakeSecret);
  });

  it.each([0, 1, 2])(
    "removes fatal listeners after resolved CLI exit %i",
    async (exitCode) => {
      const processObject = Object.assign(new EventEmitter(), {
        exitCode: undefined as number | undefined,
      });
      const mainReport =
        exitCode === 0
          ? await runPreflight(createAdapter())
          : {
              ...createPreflightBaseReport(),
              overallStatus: "fail",
              failure: {
                checkId:
                  exitCode === 1
                    ? "USER_DEFINED_OBJECT_PRESENT"
                    : "STAGING_ENVIRONMENT_REQUIRED",
                status: "fail",
              },
              exitCode,
            };
      await (runPreflightCli as any)({
        mainFunction: async () => mainReport,
        processObject,
        stdout: vi.fn(),
      });
      expect(processObject.exitCode).toBe(exitCode);
      expect(processObject.listenerCount("uncaughtException")).toBe(0);
      expect(processObject.listenerCount("unhandledRejection")).toBe(0);
    }
  );

  it("removes fatal listeners and redacts a top-level failure", async () => {
    const processObject = Object.assign(new EventEmitter(), {
      exitCode: undefined as number | undefined,
    });
    const output: string[] = [];
    await (runPreflightCli as any)({
      mainFunction: async () => {
        throw Object.assign(new AggregateError([new Error(fakeSecret)]), {
          cause: new Error(fakeSecret),
          stack: fakeSecret,
        });
      },
      processObject,
      stdout: (line: string) => output.push(line),
    });
    expect(processObject.exitCode).toBe(3);
    expect(processObject.listenerCount("uncaughtException")).toBe(0);
    expect(processObject.listenerCount("unhandledRejection")).toBe(0);
    expect(output.join("\n")).not.toContain(fakeSecret);
  });

  it("keeps exit 3 latched after a fatal process event", async () => {
    const processObject = Object.assign(new EventEmitter(), {
      exitCode: undefined as number | undefined,
    });
    let resolveMain:
      | ((report: ReturnType<typeof createPreflightBaseReport>) => void)
      | undefined;
    const output: string[] = [];
    const running = (runPreflightCli as any)({
      mainFunction: () =>
        new Promise<ReturnType<typeof createPreflightBaseReport>>(
          (resolvePromise) => {
            resolveMain = resolvePromise;
          }
        ),
      processObject,
      stdout: (line: string) => output.push(line),
    });
    processObject.emit("uncaughtException", new Error(fakeSecret));
    resolveMain?.(createPreflightBaseReport());
    await running;
    expect(processObject.exitCode).toBe(3);
    expect(processObject.listenerCount("uncaughtException")).toBe(0);
    expect(processObject.listenerCount("unhandledRejection")).toBe(0);
    expect(output.join("\n")).not.toContain(fakeSecret);
  });

  it.each([
    ["pristine", 0],
    ["residual", 1],
    ["safety", 2],
    ["connection_unknown", 3],
    ["catalog_unknown", 3],
  ])(
    "runs the real CLI core/formatter/cleanup path for %s with OS code %i",
    async (scenario, exitCode) => {
      const result = await runCliChild(scenario);
      expect(result.exitCode).toBe(exitCode);
      expect(result.stdout).not.toContain(fakeSecret);
      expect(result.stderr).not.toContain(fakeSecret);
      expect(result.stderr).toBe("");
      const jsonLines = result.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("{"));
      expect(jsonLines).toHaveLength(1);
      const report = JSON.parse(jsonLines[0]);
      expect(report.exitCode).toBe(exitCode);
      expect(Object.keys(report.userDefinedObjects).sort()).toEqual([
        "direct",
        "directAfter",
        "pooled",
        "pooledAfter",
      ]);
      expect(
        result.stdout.match(/ActusTube staging database preflight/g) || []
      ).toHaveLength(1);
      expect(result.stdout).toContain(`exit code: ${exitCode}`);
    }
  );

  it("emits exit 1 JSON and human summary exactly once without escalation", async () => {
    const result = await runCliChild("residual");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.split(/\r?\n/).filter((line) => line.startsWith("{"))).toHaveLength(1);
    expect(
      result.stdout.match(/ActusTube staging database preflight/g) || []
    ).toHaveLength(1);
    expect(result.stdout.match(/exit code: 1/g) || []).toHaveLength(1);
    expect(result.stdout).not.toContain("PREFLIGHT_TOP_LEVEL_FAILURE");
  });

  it("forces only the reported exit 3 path to end an active cleanup handle", async () => {
    const result = await runCliChild("cleanup_timeout");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(fakeSecret);
    const report = JSON.parse(
      result.stdout.split(/\r?\n/).find((line) => line.startsWith("{")) || "{}"
    );
    expect(report.failure).toEqual({
      checkId: "CONNECTION_CLEANUP_UNVERIFIED",
      status: "not_verified",
    });
    expect(result.stdout).toContain("exit code: 3");
  });

  it("converts a formatter exception to one secret-safe exit 3 report", async () => {
    const result = await runCliChild("formatter_failure");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(fakeSecret);
    const jsonLines = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("{"));
    expect(jsonLines).toHaveLength(1);
    expect(JSON.parse(jsonLines[0]).failure.checkId).toBe(
      "PREFLIGHT_FORMATTER_FAILURE"
    );
    expect(
      result.stdout.match(/ActusTube staging database preflight/g) || []
    ).toHaveLength(1);
  });

  it("does not report unverified database counts as zero", async () => {
    const output: string[] = [];
    const fixture = createAdapter();
    const report = await (executeStagingDatabasePreflight as any)({
      environment: {},
      repositoryRoot,
      adapter: fixture,
      stdout: (line: string) => output.push(line),
    });
    expect(report.exitCode).toBe(2);
    expect(report.migrationHistory.status).toBe("not_verified");
    expect(report.migrationHistory.applied).toBe("not_verified");
    expect(report.applicationTables).toBe("not_verified");
    expect(output.join("\n")).not.toContain("application tables: 0");
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("formats a partial verified-failure report defensively", () => {
    const summary = formatHumanSummary({
      exitCode: 1,
      failure: { checkId: "USER_DEFINED_OBJECT_PRESENT", status: "fail" },
    } as any);
    expect(summary).toContain("user-defined objects (direct): not_verified");
    expect(summary).toContain("user-defined objects (pooled after): not_verified");
    expect(summary).toContain("failure check: USER_DEFINED_OBJECT_PRESENT");
    expect(summary).toContain("exit code: 1");
  });

  it("covers exit codes 0, 1, 2, and 3", async () => {
    const valid = await runPreflight(createAdapter());
    const stateMismatch = residualState("relation_count");
    const invalidState = await runPreflight(
      createAdapter({ directState: stateMismatch })
    );
    const invalidSafety = await runPreflight(createAdapter(), {
      ...validEnvironment(),
      ACTUSTUBE_DB_ENV: "production",
    });
    const unknown = await runPreflight(
      createAdapter({ directFailure: new Error(fakeSecret) })
    );
    expect([valid.exitCode, invalidState.exitCode, invalidSafety.exitCode, unknown.exitCode])
      .toEqual([0, 1, 2, 3]);
  });

  it("does not invoke migration or postflight commands", async () => {
    const packageJson = JSON.parse(
      await readFile("package.json", "utf8")
    );
    expect(packageJson.scripts["db:preflight:staging"]).toBe(
      "node scripts/verify-staging-database-preflight.mjs"
    );
    const entry = await readFile(
      "scripts/verify-staging-database-preflight.mjs",
      "utf8"
    );
    expect(entry).not.toContain("drizzle-kit");
    expect(entry).not.toContain("db:migrate");
    expect(entry).not.toContain("db:verify:staging");
    expect(entry).not.toContain("verify-staging-database-postflight");
  });
});
