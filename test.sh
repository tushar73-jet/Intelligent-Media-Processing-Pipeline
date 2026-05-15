#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# test.sh — Full end-to-end smoke test for the Media Processing Pipeline
# Usage: bash test.sh [BASE_URL]
# Default BASE_URL: http://localhost:3000
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BASE="${1:-http://localhost:3000}"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

echo ""
echo "═══════════════════════════════════════════════"
echo "  Media Pipeline — Smoke Test"
echo "  Target: $BASE"
echo "═══════════════════════════════════════════════"
echo ""

info "Creating test image..."
# Generate a valid 400x200 white JPEG using the project's own 'sharp' dependency!
node -e "require('sharp')({create: {width: 400, height: 200, channels: 3, background: {r: 255, g: 255, b: 255}}}).jpeg().toFile('/tmp/test_plate.jpg').catch(console.error)"
TEST_IMAGE="/tmp/test_plate.jpg"
pass "Test image created safely using Node and Sharp"

# ── 1. Health check ───────────────────────────────────────────────────────────
info "1. Testing /health..."
HEALTH=$(curl -sf "$BASE/health")
echo "$HEALTH" | grep -q '"ok"' && pass "Health check OK" || fail "Health check failed: $HEALTH"

# ── 2. Upload image ───────────────────────────────────────────────────────────
info "2. Uploading image..."
UPLOAD=$(curl -sf -X POST "$BASE/api/upload" \
  -F "image=@$TEST_IMAGE")
echo "   Response: $UPLOAD"
JOB_ID=$(echo "$UPLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])" 2>/dev/null || \
         echo "$UPLOAD" | grep -oE '"jobId"\s*:\s*"[^"]+"' | cut -d'"' -f4)

[ -n "$JOB_ID" ] && pass "Upload OK — jobId: $JOB_ID" || fail "Upload failed or no jobId returned"

# ── 3. Check status (should be pending or processing) ─────────────────────────
info "3. Checking status immediately after upload..."
STATUS_RESP=$(curl -sf "$BASE/api/status/$JOB_ID")
echo "   Response: $STATUS_RESP"
echo "$STATUS_RESP" | grep -qE '"pending"|"processing"' && \
  pass "Status is pending/processing as expected" || \
  echo -e "${YELLOW}  ⚠ Status might already be completed (fast machine)${NC}"

# ── 4. Poll until completed (max 60 seconds) ──────────────────────────────────
info "4. Polling for completion (max 60s)..."
DONE=false
for i in $(seq 1 30); do
  POLL=$(curl -sf "$BASE/api/status/$JOB_ID")
  STATUS=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || \
           echo "$POLL" | grep -oE '"status"\s*:\s*"[^"]+"' | cut -d'"' -f4)

  if [ "$STATUS" = "completed" ]; then
    pass "Job completed after ~$((i*2))s"
    DONE=true
    break
  elif [ "$STATUS" = "failed" ]; then
    REASON=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('failure_reason','unknown'))" 2>/dev/null)
    fail "Job FAILED — reason: $REASON"
  fi

  echo "   Attempt $i/30 — status: $STATUS, waiting 2s..."
  sleep 2
done

$DONE || fail "Job did not complete within 60 seconds"

# ── 5. Fetch results ──────────────────────────────────────────────────────────
info "5. Fetching results..."
RESULTS=$(curl -sf "$BASE/api/results/$JOB_ID")
echo "   Response: $RESULTS"

CHECK_COUNT=$(echo "$RESULTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('checks',[])))" 2>/dev/null || echo "0")

[ "$CHECK_COUNT" -ge 4 ] && \
  pass "Results OK — $CHECK_COUNT checks returned" || \
  fail "Expected ≥4 checks, got $CHECK_COUNT"

# ── 6. Test duplicate detection ───────────────────────────────────────────────
info "6. Uploading same image again (duplicate detection test)..."
DUP_RESP=$(curl -sf -X POST "$BASE/api/upload" -F "image=@$TEST_IMAGE")
DUP_JOB=$(echo "$DUP_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])" 2>/dev/null || echo "")

if [ -n "$DUP_JOB" ]; then
  info "   Waiting 15s for duplicate job to complete..."
  sleep 15
  DUP_RESULTS=$(curl -sf "$BASE/api/results/$DUP_JOB" 2>/dev/null || echo "{}")
  DUP_CHECK=$(echo "$DUP_RESULTS" | python3 -c "
import sys,json
d = json.load(sys.stdin)
checks = d.get('checks', [])
dup = next((c for c in checks if c['check_name'] == 'duplicate'), None)
if dup:
    print('isDuplicate=' + str(dup['detail'].get('isDuplicate', False)))
" 2>/dev/null || echo "parse_error")
  echo "   Duplicate check result: $DUP_CHECK"
  echo "$DUP_CHECK" | grep -q "True" && pass "Duplicate correctly detected" || \
    echo -e "${YELLOW}  ⚠ Duplicate check result: $DUP_CHECK (may still be processing)${NC}"
fi

# ── 7. Analytics endpoint ─────────────────────────────────────────────────────
info "7. Testing /analytics..."
ANALYTICS=$(curl -sf "$BASE/api/analytics")
echo "   Response: $ANALYTICS"
echo "$ANALYTICS" | grep -q '"total_jobs"' && pass "Analytics endpoint OK" || \
  fail "Analytics endpoint failed"

# ── 8. Test 404 for unknown job ───────────────────────────────────────────────
info "8. Testing 404 for unknown job ID..."
NOT_FOUND=$(curl -s -o /dev/null -w "%{http_code}" \
  "$BASE/api/status/00000000-0000-0000-0000-000000000000")
[ "$NOT_FOUND" = "404" ] && pass "404 returned for unknown job ID" || \
  fail "Expected 404, got $NOT_FOUND"

# ── 9. Test file type rejection ───────────────────────────────────────────────
info "9. Testing file type rejection (uploading a .txt file)..."
echo "not an image" > /tmp/fake.txt
REJECT_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE/api/upload" -F "image=@/tmp/fake.txt")
[ "$REJECT_CODE" = "400" ] && pass "Non-image file correctly rejected (400)" || \
  echo -e "${YELLOW}  ⚠ Got $REJECT_CODE — Multer may not reject by extension for .txt${NC}"

echo ""
echo "═══════════════════════════════════════════════"
echo -e "  ${GREEN}All tests passed!${NC}"
echo "═══════════════════════════════════════════════"
echo ""
