# Project Readiness Matrix

> Complete during discovery before architecture or implementation. Record evidence, not assumptions. Duplicate rows as needed.

| Area | Requirement / capability | Resource / permission required | Status (AVAILABLE / MISSING / UNKNOWN / BLOCKED / NOT NEEDED) | Evidence / path / source | Impact if missing | Feasible options and trade-offs | Recommended action | Owner decision required? |
|---|---|---|---|---|---|---|---|---|
| Product | Requirements and acceptance criteria | Product brief / owner decisions | UNKNOWN | | | | | Yes/No |
| Repo & stack | Framework, runtime, package manager, scripts | Local repository | UNKNOWN | | | | | Yes/No |
| UX / assets | Design system, fonts, logos, icons, licensed assets | Files, source, usage rights | UNKNOWN | | | | | Yes/No |
| Integrations | API, database, SSO, email, payments, analytics | Endpoint, account, scopes | UNKNOWN | | | | | Yes/No |
| Secrets | Required environment variables | Secret manager / local env | UNKNOWN | Record presence only; never paste values | | | | Yes/No |
| Permissions | Tool/MCP/API operations available to this session | Granted scopes / policy | UNKNOWN | | | | | Yes/No |
| Environments | Local, preview, staging, production separation | URLs, access, configuration | UNKNOWN | | | | | Yes/No |
| Data | Fixtures, seed data, schema, migrations, rollback | Approved test data and backups | UNKNOWN | | | | | Yes/No |
| Testing | Existing test runner, scripts, fixtures, CI | Dependencies and CI access | UNKNOWN | | | | | Yes/No |
| Browser/mobile | Supported browsers, devices, emulators | Runtime/device access | UNKNOWN | | | | | Yes/No |
| Observability | Logs, error tracking, network inspection | Local tools/authorized services | UNKNOWN | | | | | Yes/No |
| Security | Roles, authorization boundaries, sensitive data | Requirements and test cases | UNKNOWN | | | | | Yes/No |
| Performance | Target latency, concurrency, bundle size | Acceptance thresholds and measurement tools | UNKNOWN | | | | | Yes/No |
| Budget | Paid services, CI minutes, device farms, artifact storage | Budget and approval | UNKNOWN | | | | | Yes/No |
| Delivery | Release target, approvals, rollback | Deployment access and owner approval | UNKNOWN | | | | | Yes/No |

## Readiness decision

- **Ready:** no unresolved blockers for the proposed scope.
- **Ready with accepted risks:** high-risk gaps and owner acceptance are recorded.
- **Blocked:** at least one required resource or owner decision prevents safe delivery.
- **Partial:** independent work can proceed, but explicitly listed tasks are blocked.

### Blockers and decisions

| ID | Blocker / unknown | Evidence | Option A | Option B | Option C | Recommendation | Decision owner | Decision / date |
|---|---|---|---|---|---|---|---|---|

### Gate before implementation

- [ ] Existing resources, reusable components, assets and licenses inspected.
- [ ] Permissions and integrations checked using available evidence.
- [ ] Missing resources and unknowns remain explicitly labelled.
- [ ] Alternatives and material trade-offs presented to owner.
- [ ] No workaround silently changes required behavior or quality.
- [ ] Architecture decision and acceptance criteria recorded.
- [ ] Test plan and artifact budget approved.
