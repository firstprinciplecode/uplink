# Security Improvements - Phase 2

**Date:** January 2025  
**Status:** ✅ Completed

---

## Overview

Phase 2 implements additional security hardening measures identified in the Phase 1 security assessment. These improvements address token enumeration, request timeouts, secret exposure in logs, IP allowlisting, request signing, token lifetime limits, and per-endpoint body size limits.

---

## ✅ Implemented Improvements

### 1. **Reduced Rate Limit for `/internal/allow-tls`**
   - **Before**: 120 requests/minute per IP
   - **After**: 60 requests/minute per IP
   - **File**: `backend/src/middleware/rate-limit.ts`
   - **Impact**: Reduces token enumeration attack surface by 50%

### 2. **Request Timeout Middleware**
   - **Default**: 30 seconds for all requests
   - **Long operations**: 5 minutes (for database provisioning, etc.)
   - **File**: `backend/src/middleware/timeout.ts`
   - **Impact**: Prevents slow-request DoS attacks

### 3. **Secret Redaction in Logs**
   - **Automatic**: Secrets, tokens, passwords redacted from all logs
   - **Scope**: Query params, headers, nested objects
   - **File**: `backend/src/utils/logger.ts`
   - **Impact**: Prevents secret exposure in log files, even if query params contain secrets

### 4. **IP Allowlisting for Internal Endpoints**
   - **Default**: Localhost only (`127.0.0.1`, `::1`)
   - **Configurable**: Via `INTERNAL_IP_ALLOWLIST` env var (comma-separated IPs or CIDR ranges)
   - **File**: `backend/src/middleware/ip-allowlist.ts`
   - **Usage**: `INTERNAL_IP_ALLOWLIST=127.0.0.1,10.0.0.0/8`
   - **Impact**: Adds defense-in-depth for internal endpoints (even if secret leaks)

### 5. **Request Signing Middleware (Optional)**
   - **Algorithm**: HMAC-SHA256 with timestamp
   - **Replay protection**: Rejects requests older than 5 minutes
   - **File**: `backend/src/middleware/request-signing.ts`
   - **Status**: Implemented but not enforced (for Caddy compatibility)
   - **Impact**: Available for relay-to-backend communication if needed

### 6. **Token Max Lifetime Enforcement**
   - **Default**: 90 days (configurable via `MAX_TOKEN_LIFETIME_DAYS`)
   - **Hard limit**: 365 days (never exceed 1 year)
   - **File**: `backend/src/schemas/validation.ts`
   - **Impact**: Prevents indefinitely-lived tokens, reduces risk of long-term compromise

### 7. **Per-Endpoint Body Size Limits**
   - **Small**: 1MB (tunnel creation, token operations)
   - **Medium**: 5MB (database operations)
   - **Large**: 50MB (file uploads, bulk data)
   - **File**: `backend/src/middleware/body-size.ts`
   - **Usage**: Applied to tunnel creation route (1MB limit)
   - **Impact**: Prevents memory exhaustion from oversized requests

---

## 📝 Configuration

### New Environment Variables

```bash
# IP allowlist for internal endpoints (optional, defaults to localhost)
INTERNAL_IP_ALLOWLIST=127.0.0.1,10.0.0.0/8

# Max token lifetime in days (optional, defaults to 90)
MAX_TOKEN_LIFETIME_DAYS=90
```

### Existing Variables (Still Required)

```bash
# Required in production
RELAY_INTERNAL_SECRET=your-secret-here
CONTROL_PLANE_TOKEN_PEPPER=your-pepper-here
```

---

## 🔍 Testing

### Verify Rate Limiting
```bash
# Should return 429 after 60 requests in 1 minute
for i in {1..65}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://api.uplink.spot/internal/allow-tls?domain=test.x.uplink.spot"
done | sort | uniq -c
```

### Verify IP Allowlisting
```bash
# From non-localhost IP, should return 403
curl -H "x-relay-internal-secret: $RELAY_INTERNAL_SECRET" \
  https://api.uplink.spot/internal/allow-tls?domain=test.x.uplink.spot
```

### Verify Token Lifetime Enforcement
```bash
# Should fail with validation error if expiresInDays > 90
curl -X POST https://api.uplink.spot/v1/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","expiresInDays":365}'
```

### Verify Secret Redaction
```bash
# Check logs - secrets should appear as "[REDACTED]"
# Query params and headers with "secret", "token", "password" are automatically redacted
```

---

## 📊 Security Posture Update

| Category | Before Phase 2 | After Phase 2 |
|----------|----------------|---------------|
| **Rate Limiting** | ✅ Good | ✅ Excellent (stricter limits) |
| **Request Timeouts** | ❌ None | ✅ Implemented |
| **Secret Exposure** | 🟡 Moderate (logs) | ✅ Protected (redacted) |
| **IP Allowlisting** | ❌ None | ✅ Implemented |
| **Request Signing** | ❌ None | ✅ Available (optional) |
| **Token Lifetime** | 🟡 Moderate (no limit) | ✅ Enforced (90 days) |
| **Body Size Limits** | 🟡 Moderate (global only) | ✅ Per-endpoint limits |

---

## 🚀 Deployment Notes

1. **Backward Compatible**: All changes are backward compatible
2. **Optional Features**: IP allowlisting and request signing are optional (fail-open if not configured)
3. **No Breaking Changes**: Existing tokens and configurations continue to work
4. **Environment Variables**: New env vars are optional (sensible defaults provided)

---

## 📚 Files Changed

- `backend/src/middleware/rate-limit.ts` - Reduced rate limit
- `backend/src/middleware/timeout.ts` - New file
- `backend/src/middleware/ip-allowlist.ts` - New file
- `backend/src/middleware/request-signing.ts` - New file
- `backend/src/middleware/body-size.ts` - New file
- `backend/src/utils/logger.ts` - Added secret redaction
- `backend/src/server.ts` - Integrated new middlewares
- `backend/src/schemas/validation.ts` - Added token lifetime enforcement
- `backend/src/routes/tunnels.ts` - Applied body size limit
- `docs/SECURITY_ASSESSMENT.md` - Updated with Phase 2 status

---

## 🎯 Next Steps (Future Phases)

1. **Enable request signing** for relay-to-backend (if relay supports custom headers)
2. **Add progressive rate limiting** (exponential backoff)
3. **Migrate internal comms to HTTPS** (self-signed certs or mTLS)
4. **Add token rotation CLI command** (`uplink token rotate`)
5. **Add token expiry warnings** (notify users when tokens approach expiry)

---

**Questions?** See `docs/SECURITY_ASSESSMENT.md` for detailed security analysis.
