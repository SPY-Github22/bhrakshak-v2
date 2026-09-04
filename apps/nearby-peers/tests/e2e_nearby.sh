#!/usr/bin/env bash
# Live e2e check of the nearby feature against the real bhrakshak API.
# Usage: bash e2e_nearby.sh [base_url]   (default http://localhost:8001)
set -e
BASE="${1:-http://localhost:8001}"

echo "== 1. citizen login =="
CTOK=$(curl -s -X POST "$BASE/api/v1/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"citizen@bhrakshak.in","password":"Citizen@123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
echo "citizen token: ${CTOK:0:24}…"

echo "== 2. citizen announces (consent implied by the announce itself) =="
curl -s -X POST "$BASE/api/v1/nearby/announce" -H "Content-Type: application/json" -H "Authorization: Bearer $CTOK" \
  -d '{"peer_id":"e2e01a2b","alias":"C-E2E","role":"citizen","lat":24.8105,"lon":93.6820,"accuracy_m":8,"needs_help":true,"battery_pct":66}'
echo

echo "== 3. second citizen, 350 m south, no SOS =="
curl -s -X POST "$BASE/api/v1/nearby/announce" -H "Content-Type: application/json" -H "Authorization: Bearer $CTOK" \
  -d '{"peer_id":"e2e02c3d","alias":"C-CALM","role":"citizen","lat":24.8073,"lon":93.6820,"accuracy_m":10,"needs_help":false,"battery_pct":40}'
echo

echo "== 4. field rescuer logs in and queries within 500 m =="
FTOK=$(curl -s -X POST "$BASE/api/v1/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"field.noney@bhrakshak.in","password":"Field@123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -X POST "$BASE/api/v1/nearby/query" -H "Content-Type: application/json" -H "Authorization: Bearer $FTOK" \
  -d '{"lat":24.8105,"lon":93.6820,"radius_m":500,"self_peer_id":"ffffffff"}'
echo

echo "== 5. stats (no coordinates leak) =="
curl -s "$BASE/api/v1/nearby/stats" -H "Authorization: Bearer $FTOK"
echo

echo "== 6. consent revoked → forget + empty query =="
curl -s -X DELETE "$BASE/api/v1/nearby/e2e01a2b" -H "Authorization: Bearer $CTOK"
echo
curl -s -X POST "$BASE/api/v1/nearby/query" -H "Content-Type: application/json" -H "Authorization: Bearer $FTOK" \
  -d '{"lat":24.8105,"lon":93.6820,"radius_m":500,"self_peer_id":"ffffffff"}'
echo
echo "== e2e done =="
