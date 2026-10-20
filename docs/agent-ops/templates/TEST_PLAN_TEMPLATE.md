# Risk-Based Test Plan

> Complete before implementation/testing. Default screenshot budget: **0**. Add visual artifacts only when they answer a specific approved question.

## 1. Change and acceptance criteria

- Feature / change:
- Owner:
- Risk level: LOW / MEDIUM / HIGH / CRITICAL
- Primary user journeys:
- In-scope platforms/browsers:
- Out of scope:
- Existing test runner/config:
- Existing baseline runtime/artifact count, if available:

## 2. Test selection matrix

| Requirement / acceptance criterion | Risk | Lowest-cost reliable test layer | Test case / assertion | Existing fixture/service | Higher-cost test needed? Why? | Expected runtime / impact | Result |
|---|---|---|---|---|---|---|---|
| | | Static / Unit / API / Component / E2E / Visual | | | | | NOT RUN |

Use the lowest-cost reliable layer. Do not repeat identical assertions across layers unless each layer covers a distinct failure mode.

## 3. Visual/screenshot authorization (default: none)

- Is visual verification necessary? YES / NO
- Exact visual question to answer:
- Why DOM, semantic assertions, geometry checks, accessibility queries or logs are insufficient:
- Representative pages/states:
- Required viewports/devices/themes and why:
- Maximum screenshots:
- Capture policy: NONE / FAILURE ONLY / APPROVED BASELINE
- Output directory:
- Retention/cleanup:
- Owner approval / rationale:
- Expected additional runtime/storage cost:

If no specific question and budget have been recorded, do not start screenshot-generating tests. Do not use AI-generated pictures as app test evidence. Do not capture every page/state/viewport by default.

## 4. Resource and access check

| Resource | Required? | Available? | Evidence | Owner action if missing |
|---|---|---|---|---|
| Browser / emulator / device | | | | |
| Credentials / permission scopes | | | Do not record secret values | |
| API / database / third-party service | | | | |
| Test data / fixtures | | | | |
| CI / staging / preview | | | | |
| Paid service / device farm / storage | | | | |

If a required resource is missing, mark dependent tests BLOCKED or NOT RUN; do not silently substitute a mock unless it is appropriate for that test layer and clearly labelled.

## 5. Execution sequence

1. Static checks (format, lint, typecheck, schema/config).
2. Unit tests for changed logic.
3. Focused integration/API/component tests.
4. Critical E2E user journeys only where needed.
5. Visual/extended regression only when the risk and approved plan justify them.

Run the smallest credible suite during implementation. Expand coverage at agreed release gates, not after every edit.

## 6. Failure policy

- Preserve the first failure output and minimum diagnostic evidence.
- Diagnose root cause before retrying.
- State retry count and whether a retry is for a suspected flake.
- Do not weaken assertions, skip failures, or update snapshots without review.
- After repeated failures, stop and report a blocker rather than loop indefinitely.

## 7. Results and evidence

| Command / test | Exit code | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifact count and justification |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| | | | | | | | | |

### Final report

- Defects found and fixed:
- Unresolved defects:
- Screenshot / trace / video counts and rationale:
- Coverage gaps:
- Permissions/resources not validated:
- Deviations from plan and authorization:
- Release recommendation: PASS / FAIL / BLOCKED / NOT READY
