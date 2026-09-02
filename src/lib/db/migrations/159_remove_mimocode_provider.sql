-- MiMoCode is no longer part of the upstream runtime, but existing
-- installations may still contain a configured account and provider-scoped
-- state. Preserve that state for migration, rollback, and auditability.
--
-- The connection is fail-closed because the provider implementation is gone:
-- keep the encrypted credentials and all related rows, but do not let the
-- removed provider be selected by normal routing.

UPDATE exclusive_connection_leases
SET state = 'INVALIDATED',
    ended_at = COALESCE(ended_at, datetime('now')),
    end_reason = COALESCE(end_reason, 'CONNECTION_INELIGIBLE')
WHERE state = 'ACTIVE'
  AND (
    lower(trim(provider)) IN ('mimocode', 'mcode')
    OR connection_id IN (
      SELECT id
      FROM provider_connections
      WHERE lower(trim(provider)) IN ('mimocode', 'mcode')
    )
  );

UPDATE provider_connections
SET is_active = 0,
    test_status = 'unavailable',
    error_code = 'PROVIDER_REMOVED',
    last_error = 'Provider integration retired from OmniRoute; credentials retained.',
    last_error_type = 'provider_removed',
    last_error_source = 'migration:preserve-mimocode',
    last_error_at = COALESCE(last_error_at, datetime('now')),
    updated_at = datetime('now')
WHERE lower(trim(provider)) IN ('mimocode', 'mcode');

-- Deliberately do not delete provider_connections, registered_keys,
-- provider_key_limits, discovery_results, custom model metadata, or any
-- historical usage/call-log rows.
