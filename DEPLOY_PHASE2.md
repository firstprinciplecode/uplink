# Deployment Guide - Security Phase 2

**Date:** January 2025  
**Branch:** `feature/security-phase2` (to be created)  
**Status:** Ready for testing

---

## 📋 Pre-Deployment Checklist

- [x] All security improvements implemented
- [x] TypeScript compilation verified
- [x] Test script created (`scripts/test-security-phase2.sh`)
- [x] Documentation updated (`docs/SECURITY_PHASE2.md`)
- [ ] Code reviewed
- [ ] Tested locally (if possible)
- [ ] Deployed to server
- [ ] Verified on production

---

## 🚀 Deployment Steps

### 1. Create Feature Branch
```bash
git checkout -b feature/security-phase2
git add backend/src/middleware/ backend/src/routes/tunnels.ts backend/src/schemas/validation.ts backend/src/server.ts backend/src/utils/logger.ts docs/ scripts/test-security-phase2.sh
git commit -m "feat(security): Phase 2 hardening - rate limits, timeouts, IP allowlist, token lifetime, body size limits

- Reduced /internal/allow-tls rate limit from 120/min to 60/min
- Added request timeout middleware (30s default, 5min for long ops)
- Added secret redaction in logs (query params, headers)
- Added IP allowlisting for internal endpoints (configurable via INTERNAL_IP_ALLOWLIST)
- Implemented request signing middleware (optional, HMAC-SHA256)
- Enforced token max lifetime (90 days default, configurable via MAX_TOKEN_LIFETIME_DAYS)
- Added per-endpoint body size limits (1MB/5MB/50MB presets)
- Updated security documentation"
```

### 2. Push to GitHub
```bash
git push origin feature/security-phase2
```

### 3. Deploy to Server (Testing)
```bash
# SSH to server
ssh root@178.156.149.124

# Navigate to project directory
cd /opt/agentcloud

# Checkout feature branch
git fetch origin
git checkout feature/security-phase2

# Pull latest changes
git pull origin feature/security-phase2

# Restart services
systemctl restart backend-api
systemctl restart tunnel-relay

# Verify services are running
systemctl status backend-api
systemctl status tunnel-relay
```

### 4. Run Tests
```bash
# On server or local machine (with ADMIN_TOKEN set)
export ADMIN_TOKEN="your-admin-token"
export API_BASE="https://api.uplink.spot"
bash scripts/test-security-phase2.sh
```

### 5. Verify Logs
```bash
# Check that secrets are redacted
journalctl -u backend-api -n 100 | grep -i "redacted\|secret\|token"

# Should see [REDACTED] instead of actual secrets
```

### 6. Test Key Features Manually

#### Rate Limiting
```bash
# Should hit 429 after 60 requests
for i in {1..65}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    "https://api.uplink.spot/internal/allow-tls?domain=test.x.uplink.spot&nonce=$i"
done | sort | uniq -c
```

#### Token Lifetime
```bash
# Should fail with validation error
curl -X POST https://api.uplink.spot/v1/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","expiresInDays":365}'

# Should succeed
curl -X POST https://api.uplink.spot/v1/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"user","expiresInDays":90}'
```

#### System Status
```bash
curl -s https://api.uplink.spot/v1/admin/system/status \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

---

## ⚙️ Optional Configuration

### IP Allowlisting (Optional)
If you want to restrict internal endpoints to specific IPs:

```bash
# On server, edit /opt/agentcloud/.env
echo "INTERNAL_IP_ALLOWLIST=127.0.0.1,10.0.0.0/8" >> /opt/agentcloud/.env

# Restart backend
systemctl restart backend-api
```

### Token Lifetime (Optional)
To change default token lifetime:

```bash
# On server, edit /opt/agentcloud/.env
echo "MAX_TOKEN_LIFETIME_DAYS=60" >> /opt/agentcloud/.env

# Restart backend
systemctl restart backend-api
```

---

## 🔍 Verification Checklist

After deployment, verify:

- [ ] Backend API starts without errors
- [ ] Tunnel relay starts without errors
- [ ] Rate limiting works (test with 65+ requests)
- [ ] Token lifetime enforcement works (test with 365 days)
- [ ] System status endpoint returns correct values
- [ ] Logs show redacted secrets (not actual values)
- [ ] No errors in `journalctl -u backend-api`
- [ ] No errors in `journalctl -u tunnel-relay`

---

## 🐛 Troubleshooting

### Backend won't start
- Check logs: `journalctl -u backend-api -n 50`
- Verify environment variables are set
- Check TypeScript compilation: `npm run migrate` (should not error)

### Rate limiting not working
- Verify middleware is loaded: Check `backend/src/server.ts`
- Check rate limit config: `backend/src/middleware/rate-limit.ts`
- Test with different IPs (rate limits are per-IP)

### IP allowlisting blocking legitimate requests
- Check `INTERNAL_IP_ALLOWLIST` env var
- Verify IP format (comma-separated, CIDR supported)
- Remove env var to disable (defaults to localhost only)

### Token creation failing
- Check validation errors in response
- Verify `MAX_TOKEN_LIFETIME_DAYS` is set correctly
- Check logs for detailed error messages

---

## 📊 Rollback Plan

If issues occur:

```bash
# On server
cd /opt/agentcloud
git checkout master
git pull origin master
systemctl restart backend-api
systemctl restart tunnel-relay
```

---

## 📝 Post-Deployment

After successful deployment:

1. **Merge to master**
   ```bash
   git checkout master
   git merge feature/security-phase2
   git push origin master
   ```

2. **Update version** (if needed)
   ```bash
   npm version patch -m "Release v%s - Security Phase 2 hardening"
   git push origin master --tags
   npm publish
   ```

3. **Update documentation**
   - Update `docs/SECURITY_ASSESSMENT.md` with production status
   - Update `README.md` if needed

---

## ✅ Success Criteria

- All tests pass
- No errors in logs
- Rate limiting active
- Token lifetime enforced
- Secrets redacted in logs
- System status endpoint works
- No performance degradation

---

**Questions?** See `docs/SECURITY_PHASE2.md` for implementation details.
