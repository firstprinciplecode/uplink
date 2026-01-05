#!/usr/bin/env bash
set -euo pipefail

# Minimal smoke test for Hosting v1 public API (control plane only).
# Requires:
# - AGENTCLOUD_API_BASE (optional; defaults to https://api.uplink.spot)
# - AGENTCLOUD_TOKEN (required for non-local)

API_BASE="${AGENTCLOUD_API_BASE:-https://api.uplink.spot}"
TOKEN="${AGENTCLOUD_TOKEN:-}"

if [[ -z "${TOKEN}" ]]; then
  echo "Missing AGENTCLOUD_TOKEN" >&2
  exit 10
fi

hdr_auth=(-H "Authorization: Bearer ${TOKEN}")
hdr_json=(-H "Content-Type: application/json")

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "${tmp_dir}"; }
trap cleanup EXIT

payload_path="${tmp_dir}/artifact.bin"
printf "uplink-hosting-test-%s" "$(date +%s)" > "${payload_path}"
size_bytes="$(wc -c < "${payload_path}" | tr -d ' ')"
sha256="$(shasum -a 256 "${payload_path}" | awk '{print $1}')"

echo "1) Create app"
app_json="$(curl -sS -X POST "${API_BASE}/v1/apps" "${hdr_auth[@]}" "${hdr_json[@]}" -d "{\"name\":\"hosting-smoke\"}")"
app_id="$(node -e "const j=${app_json@Q};const o=JSON.parse(eval(j));process.stdout.write(o.id)")"
echo "   app_id=${app_id}"

echo "2) Create release"
rel_json="$(curl -sS -X POST "${API_BASE}/v1/apps/${app_id}/releases" "${hdr_auth[@]}" "${hdr_json[@]}" -d "{\"sha256\":\"${sha256}\",\"sizeBytes\":${size_bytes}}")"
release_id="$(node -e "const j=${rel_json@Q};const o=JSON.parse(eval(j));process.stdout.write(o.release.id)")"
upload_url="$(node -e "const j=${rel_json@Q};const o=JSON.parse(eval(j));process.stdout.write(o.uploadUrl)")"
echo "   release_id=${release_id}"

echo "3) Upload artifact"
curl -sS -X PUT "${upload_url}" "${hdr_auth[@]}" -H "Content-Type: application/octet-stream" --data-binary @"${payload_path}" >/dev/null
echo "   uploaded"

echo "4) Create deployment"
dep_json="$(curl -sS -X POST "${API_BASE}/v1/apps/${app_id}/deployments" "${hdr_auth[@]}" "${hdr_json[@]}" -d "{\"releaseId\":\"${release_id}\"}")"
dep_id="$(node -e "const j=${dep_json@Q};const o=JSON.parse(eval(j));process.stdout.write(o.id)")"
echo "   deployment_id=${dep_id}"

echo "5) Status"
curl -sS -X GET "${API_BASE}/v1/apps/${app_id}/status" "${hdr_auth[@]}" >/dev/null
echo "   ok"

echo "6) Logs"
curl -sS -X GET "${API_BASE}/v1/apps/${app_id}/logs" "${hdr_auth[@]}" >/dev/null
echo "   ok"

echo "✅ hosting api smoke ok"

