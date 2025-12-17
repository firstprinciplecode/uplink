# DNS Setup for Tunnel Service

## Required DNS Records

To use the tunnel service with `uplink.spot`, you need to configure DNS records in your domain registrar (Namecheap).

### Wildcard A Record (Required)

Add a wildcard A record so that any subdomain like `abc123.dev.uplink.spot` resolves to your server:

**Record Type:** `A`  
**Host:** `*.dev`  
**Value:** `64.227.30.146`  
**TTL:** `Automatic` (or `3600`)

This allows any token-based subdomain to resolve to your server.

### Base Domain (Optional, for health checks)

**Record Type:** `A`  
**Host:** `dev`  
**Value:** `64.227.30.146`  
**TTL:** `Automatic` (or `3600`)

## Namecheap Instructions

1. Log into Namecheap
2. Go to **Domain List** → Select `uplink.spot`
3. Click **Advanced DNS**
4. Add the wildcard record:
   - Click **Add New Record**
   - Type: `A Record`
   - Host: `*.dev`
   - Value: `64.227.30.146`
   - TTL: `Automatic`
   - Click **Save**
5. (Optional) Add base domain record:
   - Click **Add New Record**
   - Type: `A Record`
   - Host: `dev`
   - Value: `64.227.30.146`
   - TTL: `Automatic`
   - Click **Save**

## Verify DNS

After adding records, wait 5-10 minutes for propagation, then verify:

```bash
# Check wildcard (should resolve to 64.227.30.146)
dig test123.dev.uplink.spot +short

# Check base domain
dig dev.uplink.spot +short
```

## Caddy Certificate Status

Once DNS is configured, Caddy will automatically obtain SSL certificates from Let's Encrypt. Check status:

```bash
ssh root@64.227.30.146
journalctl -u caddy -f
```

You should see certificate acquisition messages. If there are errors, they'll appear in the logs.





