# Security Assessment: Phase 1 & Recommendations

**Last Updated:** January 2025  
**Phase 1 Status:** ✅ Completed and deployed

---

## 🔒 Phase 1 Security Improvements

### 1. **Hardened On-Demand TLS Endpoint** (`/internal/allow-tls`)
   - ✅ **Secret Protection**: Requires `RELAY_INTERNAL_SECRET` (header or query param)
   - ✅ **Hostname Validation**: Validates token format (`/^[a-zA-Z0-9]{3,64}$/`) and alias format (`ALIAS_REGEX`)
   - ✅ **Reserved Alias Protection**: Blocks reserved aliases (`www`, `api`, `x`, `t`, etc.)
   - ✅ **Database Verification**: Checks token/alias existence before allowing TLS issuance
   - ✅ **Rate Limiting**: 120 requests/minute per IP (prevents enumeration/DoS)

### 2. **System Diagnostics** (`/v1/admin/system/status`)
   - ✅ **Configuration Visibility**: Detects missing `RELAY_INTERNAL_SECRET`
   - ✅ **Relay Health Check**: Verifies relay connectivity and connection count
   - ✅ **TLS Mode Detection**: Reports DNS-01 wildcard vs on-demand TLS status
   - ✅ **No Secret Exposure**: Returns only boolean flags, never raw secrets

### 3. **Production Security Enforcement**
   - ✅ **Required Secrets**: Production fails to start without `RELAY_INTERNAL_SECRET` and `CONTROL_PLANE_TOKEN_PEPPER`
   - ✅ **Token Hashing**: Uses HMAC-SHA256 with server-side pepper (prevents offline brute-force if DB leaks)
   - ✅ **Environment Isolation**: Systemd services load secrets from `.env` file

### 4. **Caddy Integration**
   - ✅ **On-Demand TLS Ask Block**: Caddy validates hosts via backend before issuing certs
   - ✅ **Rate Limits**: `interval 2m`, `burst 5` prevents certificate spam
   - ✅ **Primary Fallback**: DNS-01 wildcard remains primary; on-demand is optional enhancement

---

## ✅ Existing Security Measures (Pre-Phase 1)

### Authentication & Authorization
- ✅ **Token-Based Auth**: Bearer tokens with role-based access control (admin/user)
- ✅ **Token Revocation**: Tokens can be revoked and expire
- ✅ **Audit Logging**: All auth attempts logged (success/failure with IP)
- ✅ **Break-Glass Admin**: `ADMIN_TOKENS` env var for emergency access (deprecated in favor of DB tokens)

### Rate Limiting
- ✅ **API Routes**: 100 requests/15min per IP
- ✅ **Auth Endpoints**: 10 attempts/15min per IP
- ✅ **Token Creation**: 20/hour per IP
- ✅ **Tunnel Creation**: 50/hour per IP
- ✅ **Signup**: 5/hour per IP (strictest)

### Input Validation
- ✅ **Schema Validation**: Zod-based validation middleware
- ✅ **SQL Injection Protection**: Parameterized queries (via `pool.query()`)
- ✅ **Alias Validation**: Regex + reserved name checks
- ✅ **Port Validation**: Numeric range checks

### HTTP Security
- ✅ **Helmet.js**: Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.)
- ✅ **Body Size Limits**: 10MB max request body
- ✅ **Compression**: Gzip/deflate with threshold
- ✅ **CORS**: Configured for public endpoints only

### Infrastructure
- ✅ **HTTPS Only**: Caddy enforces TLS (DNS-01 wildcard certs)
- ✅ **Secret Scanning**: GitHub Actions scans for committed secrets
- ✅ **Error Handling**: Generic error messages (no stack traces in production)

---

## ⚠️ Remaining Security Gaps & Recommendations

### 🔴 High Priority

#### 1. **Internal Communication Not Encrypted** ✅ Partially Addressed
   **Issue**: Backend ↔ Relay communication is HTTP (not HTTPS) on localhost  
   **Risk**: If localhost is compromised, internal secrets could be intercepted  
   **Status**: ✅ **Request signing middleware implemented** (optional, can be enabled)  
   **Remaining Work**: 
   - Use HTTPS with self-signed certs for internal communication (future)
   - Or use Unix domain sockets with file permissions (future)
   - ✅ Request signing (HMAC) middleware available but not enforced (for Caddy compatibility)

#### 2. **Token Enumeration via `/internal/allow-tls`** ✅ Improved
   **Issue**: Even with rate limiting, attackers can enumerate valid tokens by probing hostnames  
   **Risk**: Discover active tunnel tokens  
   **Status**: ✅ **Rate limit reduced from 120/min to 60/min**  
   **Status**: ✅ **IP allowlist added** (defaults to localhost only, configurable via `INTERNAL_IP_ALLOWLIST`)  
   **Remaining Work**:
   - Consider progressive delays after failed attempts (future enhancement)

#### 3. **Secret in Query String** ✅ Improved
   **Issue**: `RELAY_INTERNAL_SECRET` can be passed in query string (for Caddy compatibility)  
   **Risk**: May appear in logs, browser history, referrer headers  
   **Status**: ✅ **Secrets now redacted in logs** (query params, headers automatically sanitized)  
   **Remaining Work**:
   - Prefer header-only in future (requires Caddy module support)

### 🟡 Medium Priority

#### 4. **No Request Timeouts** ✅ Fixed
   **Issue**: Long-running requests can tie up server resources  
   **Risk**: DoS via slow requests  
   **Status**: ✅ **Request timeout middleware added** (30 seconds default, 5 minutes for long operations)  
   **Implementation**: `backend/src/middleware/timeout.ts`

#### 5. **No Token Rotation Enforcement** ✅ Improved
   **Issue**: Tokens can be long-lived without forced rotation  
   **Risk**: Compromised tokens remain valid indefinitely  
   **Status**: ✅ **Max token lifetime enforced** (90 days default, configurable via `MAX_TOKEN_LIFETIME_DAYS`)  
   **Status**: ✅ **Hard limit of 365 days** (never exceed 1 year)  
   **Remaining Work**:
   - Add `uplink token rotate` command (future)
   - Warn users when tokens approach expiry (future)

#### 6. **No IP Allowlisting for Internal Endpoints** ✅ Fixed
   **Issue**: Internal endpoints rely solely on secret, not source IP  
   **Risk**: If secret leaks, any IP can access internal endpoints  
   **Status**: ✅ **IP allowlist middleware added** (defaults to localhost, configurable via `INTERNAL_IP_ALLOWLIST`)  
   **Implementation**: `backend/src/middleware/ip-allowlist.ts`  
   **Usage**: Supports IP addresses and CIDR ranges (e.g., `127.0.0.1,10.0.0.0/8`)

#### 7. **No Request Signing for Internal Endpoints** ✅ Implemented (Optional)
   **Issue**: Internal endpoints use simple secret comparison  
   **Risk**: Replay attacks if secret is intercepted  
   **Status**: ✅ **HMAC request signing middleware implemented** (optional, not enforced for Caddy compatibility)  
   **Implementation**: `backend/src/middleware/request-signing.ts`  
   **Note**: Can be enabled for relay-to-backend communication, but Caddy may not support custom headers

### 🟢 Low Priority

#### 8. **No CSRF Protection**
   **Issue**: API-only service, but no explicit CSRF tokens  
   **Risk**: Low (APIs typically don't need CSRF), but worth noting  
   **Status**: Not needed for API-only service  
   **Recommendation**: Add CSRF tokens if web UI is added

#### 9. **No Per-Endpoint Request Size Limits** ✅ Fixed
   **Issue**: Global 10MB limit may be too large for some endpoints  
   **Risk**: Memory exhaustion on large uploads  
   **Status**: ✅ **Per-endpoint body size limits added**  
   **Implementation**: `backend/src/middleware/body-size.ts`  
   **Usage**: Tunnel creation limited to 1MB, other endpoints can use `small` (1MB), `medium` (5MB), or `large` (50MB)

#### 10. **No Account Lockout**
   **Issue**: Rate limiting prevents brute force, but no progressive delays  
   **Risk**: Determined attackers can still attempt over long periods  
   **Recommendation**: Add exponential backoff after repeated failures

#### 11. **Dev Token Still Available**
   **Issue**: `AGENTCLOUD_TOKEN_DEV` works in SQLite mode  
   **Risk**: Low (dev-only), but could be accidentally enabled in production  
   **Recommendation**: Remove dev token support or require explicit `NODE_ENV=development`

---

## 📊 Security Posture Summary

| Category | Status | Notes |
|----------|--------|-------|
| **Authentication** | ✅ Strong | Token hashing with pepper, revocation, expiry |
| **Authorization** | ✅ Good | Role-based access control, admin/user separation |
| **Rate Limiting** | ✅ Good | Comprehensive limits on all endpoints |
| **Input Validation** | ✅ Good | Schema validation, SQL injection protection |
| **TLS/HTTPS** | ✅ Good | DNS-01 wildcard certs, on-demand TLS protected |
| **Internal Secrets** | 🟡 Moderate | Protected but could be stronger (IP allowlist, mTLS) |
| **Audit Logging** | ✅ Good | Auth attempts, token operations logged |
| **Error Handling** | ✅ Good | Generic errors, no stack traces in production |
| **Infrastructure** | 🟡 Moderate | HTTP for internal comms, no request signing |

---

## 🎯 Recommended Next Steps

### ✅ Completed (Phase 2)
1. ✅ **Reduced `/internal/allow-tls` rate limit** to 60/min (from 120/min)
2. ✅ **Added request timeouts** (30s default, 5min for long ops)
3. ✅ **Redacted secrets in logs** (query params, headers automatically sanitized)
4. ✅ **Added IP allowlisting** for internal endpoints (configurable via `INTERNAL_IP_ALLOWLIST`)
5. ✅ **Enforced token max lifetime** (90 days default, configurable via `MAX_TOKEN_LIFETIME_DAYS`)
6. ✅ **Implemented request signing** middleware (optional, available for relay-to-backend)
7. ✅ **Added per-endpoint body size limits** (1MB/5MB/50MB presets)

### Short Term (Next Sprint)
1. **Enable request signing** for relay-to-backend communication (if relay supports custom headers)
2. **Add progressive rate limiting** (exponential backoff after repeated failures)

### Long Term (Future Phases)
3. **Migrate internal comms to HTTPS** (self-signed certs or mTLS)
4. **Add token rotation CLI command** (`uplink token rotate`)
5. **Add token expiry warnings** (notify users when tokens approach expiry)

---

## 🔍 How to Verify Security

### Manual Checks
```bash
# 1. Verify internal secret is set
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.uplink.spot/v1/admin/system/status | jq '.hasInternalSecret'

# 2. Test rate limiting on /internal/allow-tls
for i in {1..130}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://api.uplink.spot/internal/allow-tls?domain=test.x.uplink.spot"
done | sort | uniq -c

# 3. Verify security headers
curl -I https://api.uplink.spot/health | grep -i "x-content-type-options\|x-frame-options\|strict-transport-security"

# 4. Test token enumeration protection
# Should return 403 for invalid tokens, rate-limited after burst
```

### Automated Checks
```bash
# Run security audit script
API_BASE=https://api.uplink.spot node scripts/security-audit.mjs
```

---

## 📝 Notes

- **Phase 1 Focus**: Internal secret protection and TLS hardening
- **Current Threat Model**: Assumes localhost is trusted (backend/relay on same host)
- **Future Considerations**: Multi-host deployments may require stronger internal auth (mTLS, request signing)

---

**Questions or concerns?** Review this document and prioritize based on your threat model and deployment architecture.
