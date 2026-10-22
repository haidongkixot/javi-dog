-- Prove "stored only as a hash / encrypted / not stored" without reading values.
-- Guru skill `prove-secrets-and-pii-minimization`. Postgres syntax; verified on PGlite at
-- G2-prep. Every query returns counts, booleans or lengths — never a column value — so the
-- output is safe to paste into a sprint record.

-- 1. Plaintext scan across EVERY column of EVERY row.
--    `t::text` renders the whole row (all columns) as one string. Use strpos, not LIKE:
--    `_` and `%` in token prefixes are LIKE wildcards.
--    Run it twice per issued secret: once with the public prefix (e.g. 'tok_') and once
--    with a slice of the random part, because a bug could store the secret without its prefix.
select count(*) as rows_containing_marker
from api_tokens t
where strpos(t::text, $1) > 0;

-- 2. Hash shape: every stored hash is lowercase SHA-256 hex.
select
  count(*) as total,
  count(*) filter (where token_hash ~ '^[0-9a-f]{64}$') as sha256_hex
from api_tokens;

-- 3. Shape of third-party credentials (e.g. OAuth tokens kept for API calls).
--    Encrypted values should not start with the provider's documented plaintext prefix.
--    Fill the prefix list from the provider docs; extend it per provider.
select
  provider_id,
  count(*) as accounts,
  count(*) filter (where access_token is not null) as with_access_token,
  count(*) filter (
    where left(access_token, 4) in ('gho_', 'ghu_', 'ya29')
  ) as access_token_plaintext_prefix,
  count(*) filter (where id_token is not null) as with_id_token
from accounts
group by provider_id;

-- 4. Columns you decided not to keep must be NULL everywhere (minimization).
select count(*) as rows_with_dropped_field
from accounts
where id_token is not null;
