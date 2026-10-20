---
name: efficient-testing
description: Design and run cost-efficient, risk-based tests for web/mobile applications. Use before creating tests and after changes, especially when screenshots are proliferating or visual snapshots are replacing functional assertions.
---

# Efficient, Layered Testing

## Goal
Maximize defect detection and confidence per unit of runtime, token use, artifact storage and maintenance. Tests should prove behavior against requirements. Screenshot generation is not the default testing strategy.

## 1. Inspect before adding tests
- Read the package manifest, scripts, existing runner/config, test fixtures, CI workflows and current screenshot artifacts.
- Reuse the existing test stack where reasonable. Do not add a second runner, browser framework, dependency or device farm without a documented gap and approval when material.
- Identify untested acceptance criteria and failure history before creating new tests.
- Establish a baseline for runtime/artifact count when possible.

## 2. Use the test pyramid
Choose the lowest-cost layer that reliably proves the requirement:
1. Static checks: formatting, lint, typecheck, schema/config validation.
2. Unit tests: business rules, validation, permission logic, calculation, reducers and pure functions.
3. Integration/API tests: service boundaries, routes, database queries, contracts, auth, migrations and error handling.
4. Component tests: interactive states, keyboard behavior, semantics and accessibility queries.
5. Browser/mobile E2E: a small suite of critical user journeys on supported targets.
6. Visual regression: only for a clearly stated visual requirement or meaningful changes to high-value UI/layout surfaces.

Do not test all behavior through a browser if unit/API/component tests can reliably prove it. Avoid duplicating the same assertion across layers unless each layer covers a distinct failure mode.

## 3. Screenshot and visual artifact policy
- Default: no screenshot on successful tests; no generated screenshots for every screen, component, state, test or run.
- Do not use image-generation models to synthesize screenshots as evidence that the app works. Test evidence must come from the real application/environment.
- Prefer behavioral assertions, accessible role/name/label queries, DOM state, API responses, console/network errors and geometry checks where appropriate.
- Capture a real application screenshot only to answer a named question, such as clipping/overlap, responsive layout, typography, contrast, visual asset correctness or an approved visual regression baseline.
- For E2E diagnostics, prefer screenshots only on failure and traces on first retry when supported by the existing framework.
- If Playwright is already installed, use `screenshot: 'only-on-failure'` or `'off'` according to project policy; do not enable `'on'` globally without explicit approval.
- Use a minimal representative visual matrix: important pages × key breakpoints × required themes. Do not multiply all states and viewports without a risk-based reason.
- Define maximum screenshot count, output path and retention/cleanup before visual runs. Store artifacts outside source-controlled directories unless a reviewed baseline is intentionally required.
- Never update/accept visual baselines merely to turn a failing test green. Review the difference and record the reason.

## 4. Plan tests against risk and acceptance criteria
For every feature, record:
- Requirement and acceptance criterion.
- Risk/impact and primary user journey.
- Lowest-cost reliable test layer.
- Required fixtures/data/services.
- Any necessary higher-level test and the additional failure mode it covers.
- Browser/device coverage justified by supported-platform requirements.
- Whether a screenshot is needed, the precise question it answers, and artifact budget.
- Estimated runtime and CI impact when available.

Prioritize authentication/authorization, data integrity, money/calculation, destructive flows, critical business processes and integrations by risk, not by visual prominence.

## 5. Execute incrementally
1. Run tests for changed functions/modules.
2. Run relevant lint, typecheck and build checks.
3. Run focused integration/API tests.
4. Run critical E2E journeys.
5. Run broad regressions only when scope/risk or release gates justify them.
6. Record commands, exit codes, durations and artifacts.

Do not start every suite automatically after every edit. Select the smallest credible test set for feedback during development; expand before release.

## 6. Resource/access gate for testing
Before running tests that need browsers, emulators, third-party APIs, credentials, external services, device farms, large fixtures or paid infrastructure, check readiness.
- If a resource/access is missing, report BLOCKED and return to Project Discovery.
- Do not create a fake substitute that changes what is being validated without approval.
- Mocking is acceptable for fast isolated tests when labelled and complemented by contract/integration tests where required.
- Never print secrets or attempt to bypass access controls.

## 7. Failure handling
- Preserve the first failure log and only the artifact needed to diagnose it.
- Diagnose root cause before retrying. Do not run repeated blind retries.
- Define flaky-test retry policy and report flake rate separately from independent passes.
- Do not skip tests, soften assertions, or rewrite snapshots purely to obtain a green result.
- If the test environment is unavailable, mark BLOCKED/NOT RUN instead of PASS.

## 8. Evidence-based report
Report:
- Commands actually executed and exit codes.
- Passed, failed, skipped, blocked and not-run counts.
- Duration where available.
- Screenshot/trace/video count and why each type was retained.
- Key logs and failure evidence.
- Coverage gaps and unverified platforms/integrations.
- Added dependencies/config changes and justification.
- Deviations from the planned test strategy and their approval.

Never claim a test passed unless execution evidence confirms it. Keep NOT RUN distinct from PASS.
