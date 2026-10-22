-- Composite foreign key that keeps a child row inside its parent's tenant.
-- Guru skill `tenant-isolation-by-construction`. Postgres syntax; verified on PGlite at G2-prep.
--
-- Problem: a child table carries a denormalized tenant column (for scoped lookups) and a
-- parent reference. Two independent foreign keys (child.parent_id -> parent.id and
-- child.tenant_id -> tenant.id) are each satisfied by a row whose parent belongs to ANOTHER
-- tenant. Nothing ties the two columns together.
--
-- Fix: reference the parent by (id, tenant_id). The parent needs a unique constraint on
-- that pair (id alone is already unique, so the pair is too; the constraint makes it a
-- valid FK target).

create table tenants (
  id uuid primary key default gen_random_uuid()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  constraint projects_id_tenant_key unique (id, tenant_id)
);

create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  tenant_id uuid not null,
  constraint api_tokens_project_tenant_fk
    foreign key (project_id, tenant_id) references projects (id, tenant_id) on delete cascade
);

-- Negative test (run it in your test suite, expect the constraint name in the error):
--
--   insert into api_tokens (project_id, tenant_id) values (<project of tenant A>, <tenant B>);
--   -- ERROR: ... violates foreign key constraint "api_tokens_project_tenant_fk"
--
-- Cascade still flows: deleting a tenant deletes its projects, which deletes their tokens.
