# Deployment preservation templates

These files record the previous OmniRoute service optimizations so rebuilding the fork does not lose them. Review exact host paths before applying; no automatic install or service restart is performed by these templates.

- nginx-site.conf and nginx-ui-performance.conf: immutable hashed static assets, gzip_static, HTTP/2, keepalive and SSE buffering policy, while preserving WS and auxiliary routes.
- nginx-responses-guard.conf: the http-level limit_req/limit_conn zones that nginx-site.conf's SSE guard location references; install it (or the equivalent declarations) before nginx -t.
- nginx-logrotate.conf: server log rotation; logs must never include API keys/cookies/query secrets.
- omniroute-db-integrity.py + service/timer: read-only external integrity check, outside the request-serving Node event loop.
- 90-nonblocking-integrity.conf: pair application startup healthcheck skip with the independently verified timer, never remove coverage.
- runtime-wrapper-inventory.json: current deployed wrappers compared to source; new standalone must retain trusted peer-IP/timeout guards.

Templates contain no credentials or database contents. Rollback to the current optimized runtime is documented per release, not the old pre-performance rollback.
