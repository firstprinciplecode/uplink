# Security Policy

## Reporting a vulnerability
Please report security issues privately.

- Email: `thomas@firstprinciple.co`
- If email is unavailable: open a GitHub issue with **no sensitive details** and request a private contact method.

## Secrets & credentials
Uplink uses environment variables for secrets (API tokens, internal relay secret, provider keys). **Do not commit secrets** to the repo.

If you suspect a secret was committed at any point:
- Rotate it immediately
- Remove it from the repo (and history if needed)

## Automated scanning
This repo runs a secret scan on every push/PR via GitHub Actions (`.github/workflows/secret-scan.yml`).

