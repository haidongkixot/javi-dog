// JD-M10 public contract. Import from '@javis-dog/github-bridge' only (ADR-0001).
export { verifyGithubSignature, type SignatureResult } from './signature.ts';
export {
  CI_APP_SLUGS,
  CI_CONCLUSIONS,
  classifyDelivery,
  DELIVERY_MAX_AGE_MS,
  deliveryTimestamp,
  INSTALLATION_ACTIONS,
  INSTALLATION_REPOSITORIES_ACTIONS,
  isTooOld,
  PULL_REQUEST_ACTIONS,
  WORKFLOW_RUN_ACTIONS,
  type CheckSuiteDelivery,
  type CiApp,
  type CiConclusion,
  type ClassifiedDelivery,
  type DeliveryKind,
  type IgnoredDelivery,
  type IgnoredReason,
  type InstallationAction,
  type InstallationDelivery,
  type InstallationRef,
  type InstallationRepositoriesAction,
  type InstallationRepositoriesDelivery,
  type PullRequestAction,
  type PullRequestDelivery,
  type RepoRef,
  type TimedKind,
  type WorkflowRunAction,
  type WorkflowRunDelivery,
} from './classify.ts';
export {
  deliveryEventId,
  GITHUB_EVENT_ID_NAMESPACE,
  githubProducerId,
  isSha256Hex,
  prThreadRef,
  runThreadRef,
  sha256Hex,
  suiteThreadRef,
  UUID_NAMESPACE_URL,
  uuidV5,
} from './ids.ts';
export {
  GITHUB_ACTIONS_TOOL,
  mapDelivery,
  PR_ACTION_ORDINAL,
  type MapContext,
  type MapResult,
} from './map.ts';
export { installationChange, type InstallationChange } from './installations.ts';
export {
  githubDeliveries,
  githubInstallations,
  githubRepositories,
  githubTables,
} from './db/tables.ts';
export {
  createGithubRepository,
  deliveryCutoff,
  deliveryHashKind,
  type ClaimResult,
  type DeliveryHashKind,
  type GithubDb,
  type GithubRepository,
  type LinkResult,
  type RouteTarget,
  type WorkspaceInstallation,
} from './repository.ts';
export { readRawBody, WEBHOOK_MAX_BODY_BYTES, type RawBodyResult } from './raw-body.ts';
export {
  consoleGithubWebhookLog,
  createGithubWebhookHandler,
  githubWebhookNotConfigured,
  type GithubEventRow,
  type GithubWebhookDeps,
  type GithubWebhookHandler,
  type GithubWebhookLog,
  type GithubWebhookLogEntry,
  type GithubWebhookOutcome,
  type GithubWebhookSecrets,
  type GithubWebhookStore,
} from './webhook.ts';
