# Deployment Checklist for uplink.spot

## Quick Start Checklist

### ✅ Step 1: Get a Server
- [ ] Choose provider (DigitalOcean/AWS/etc.)
- [ ] Create VM/instance (Ubuntu 22.04, 1GB+ RAM)
- [ ] Note the public IP address
- [ ] Ensure ports 22, 80, 443 are open

### ✅ Step 2: Configure DNS
- [ ] Go to your domain registrar (where you bought `uplink.spot`)
- [ ] Add A record:
  - Name: `*` (wildcard) OR `dev`
  - Type: `A`
  - Value: Your server's IP
  - TTL: 300
- [ ] Wait 5-10 minutes for DNS propagation
- [ ] Test: `dig dev.uplink.spot` should return your IP

### ✅ Step 3: Server Setup
- [ ] SSH into server: `ssh root@YOUR_IP`
- [ ] Install Node.js 20.x
- [ ] Install Caddy
- [ ] Clone/upload your code
- [ ] Run `npm install`

### ✅ Step 4: Configure Caddy
- [ ] Create `/etc/caddy/Caddyfile` with wildcard config
- [ ] Start Caddy: `sudo systemctl start caddy`
- [ ] Verify TLS certs are issued (check logs)

### ✅ Step 5: Deploy Tunnel Relay
- [ ] Use `scripts/tunnel/relay-host.js` (host-based routing)
- [ ] Create systemd service file
- [ ] Start service: `sudo systemctl start tunnel-relay`
- [ ] Check logs: `sudo journalctl -u tunnel-relay -f`

### ✅ Step 6: Update Local Config
- [ ] Update `.env`:
  ```
  TUNNEL_CTRL=tunnel.dev.uplink.spot:7071
  TUNNEL_DOMAIN=dev.uplink.spot
  ```
- [ ] Or use IP if DNS not ready: `TUNNEL_CTRL=YOUR_IP:7071`

### ✅ Step 7: Test
- [ ] Start control plane: `npm run dev:api`
- [ ] Start local app: `python -m http.server 3000`
- [ ] Create tunnel: `npx tsx cli/src/index.ts dev --tunnel --port 3000`
- [ ] Visit the URL (should be `https://abc123.dev.uplink.spot`)

## Troubleshooting

**DNS not working:**
```bash
dig dev.uplink.spot
nslookup dev.uplink.spot
# Should show your server IP
```

**Caddy not starting:**
```bash
sudo journalctl -u caddy -f
# Look for Let's Encrypt errors
```

**Tunnel not connecting:**
```bash
sudo journalctl -u tunnel-relay -f
# Check for connection errors
```

**Firewall issues:**
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## Next Steps After Deployment

1. **Add real tunnel endpoints** to control plane API (not stub)
2. **Set up monitoring** (logs, metrics)
3. **Add rate limiting** to prevent abuse
4. **Consider authentication** for tunnel access
5. **Set up backups** for control plane database




