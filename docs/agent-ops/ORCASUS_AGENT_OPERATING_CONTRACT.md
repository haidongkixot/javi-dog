# Agent Operating Contract: Discovery and Efficient Testing

Copy and adapt the workflow, role expectations, and stop conditions below into the target project's root CLAUDE.md. Installing skills alone does not guarantee that they will be invoked in every session.

The consuming project should copy the templates into docs/agent-ops/templates/. Store task-specific records at:
- docs/agent-ops/READINESS_MATRIX.md
- docs/agent-ops/DISCOVERY_SUMMARY.md
- docs/agent-ops/TEST_PLAN.md
- docs/agent-ops/adr/ for significant architecture decisions

## Required workflow

For every new feature, redesign, integration, migration, or material bug fix:

1. **Discover before designing.** Invoke /project-discovery before choosing architecture or implementation. Inspect the repository, stack, existing components/assets, integrations, test framework, environments, available credentials/scopes, permissions and budget. Do not ask the owner for facts already discoverable in the repository.
2. **Create a readiness record.** Use docs/agent-ops/templates/READINESS_MATRIX_TEMPLATE.md or the project-approved equivalent. Record evidence for AVAILABLE; UNKNOWN is not AVAILABLE. Write the task record to docs/agent-ops/READINESS_MATRIX.md.
3. **Stop at real blockers.** If an essential asset, account, secret, permission, API, runtime, device, budget or product decision is missing, report BLOCKED for the affected work. Present 2–3 feasible options, trade-offs and a recommendation to the owner. Continue only independent and reversible work. Never silently invent a substitute or degrade required quality.
4. **Approve the plan before risky implementation.** Compare options, document significant decisions in an ADR under docs/agent-ops/adr/ and define acceptance criteria, owners, dependencies and tests. Do not install major dependencies, incur costs, expand permissions or change production resources without authorization.
5. **Plan tests before implementing.** Invoke /efficient-testing and use docs/agent-ops/templates/TEST_PLAN_TEMPLATE.md to create docs/agent-ops/TEST_PLAN.md. Choose the lowest-cost reliable test layer for each criterion. Reuse the existing runner and fixtures unless a documented gap justifies change.
6. **No screenshot-first testing.** The default screenshot budget is zero. Use assertions, API/DOM state, accessibility semantics, logs and network checks first. Capture real app screenshots only for a named visual question or approved visual regression. Never use AI-generated imagery as proof of app functionality.
7. **Bound visual artifacts.** Before any visual test run, write down the question, representative pages/viewports/themes, maximum screenshot count, output path and retention policy. Prefer failure-only screenshots and traces on first retry where supported. Do not capture every screen/state by default or commit transient artifacts.
8. **Diagnose before retry.** Preserve the first failure evidence, identify the cause, then make a targeted retry. Do not loop blindly, skip tests, soften assertions or update snapshots merely to get green.
9. **Verify actual resources at runtime.** If an assumption about access, assets, permissions or services fails, update the readiness record and return to the owner. Do not introduce an unapproved workaround.
10. **Report truthfully.** Record commands, exit codes, duration where available, test counts, screenshot/trace/video counts, coverage gaps and unverified integrations. Use PASS, FAIL, BLOCKED and NOT RUN distinctly.

## Role-specific expectations

- The orchestrator ensures discovery and test planning happen before implementation and includes them in delegated task prompts.
- Architect/Designer cannot finalize a design based on unverified asset, platform or integration assumptions.
- Developer cannot substitute a mock, placeholder, local-only implementation or degraded feature for a required production capability without explicit approval.
- QA selects tests by risk and cost, and must state why each higher-cost browser/device/visual test is necessary.
- Reviewer verifies the readiness matrix and test evidence, not only code quality.
- Team Secretary records blocker decisions, approved deviations, test-plan changes and screenshot budgets in the meeting log.

## Stop conditions

Pause affected work and request owner input if:
- required permissions, credentials, licenses or external accounts are unavailable;
- requirements conflict or a quality/cost/security trade-off is material;
- a proposed workaround changes product behavior, data fidelity, integration behavior or supported platforms;
- the test environment cannot validate the claimed capability;
- a requested visual test has no explicit question or artifact budget.

Do not pause unrelated safe work that does not depend on the unresolved decision.
