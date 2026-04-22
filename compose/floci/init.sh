#!/bin/sh
set -eu

# Keep bucket/queue setup in sync with
# https://github.com/DEFRA/epr-backend-journey-tests/blob/main/docker/scripts/floci/init.sh

echo "[floci-init] Waiting for Floci to be ready..." >&2
until aws sqs list-queues >/dev/null 2>&1; do
  sleep 1
done
echo "[floci-init] Floci is ready" >&2

mk_bucket() {
  local bucket=$1
  aws s3api create-bucket --bucket "$bucket" >/dev/null 2>&1 || true
  return 0
}

mk_queue() {
  local queue_name=$1
  aws sqs create-queue --queue-name "$queue_name" >/dev/null 2>&1 || true
  return 0
}

echo "[floci-init] Creating buckets" >&2
mk_bucket cdp-uploader-quarantine
mk_bucket re-ex-summary-logs
mk_bucket re-ex-overseas-sites
mk_bucket re-ex-public-register
mk_bucket re-ex-form-uploads

echo "[floci-init] Creating queues" >&2
mk_queue cdp-clamav-results
mk_queue cdp-uploader-download-requests
aws sqs create-queue \
  --queue-name cdp-uploader-scan-results-callback.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}' >/dev/null 2>&1 || true
mk_queue epr_backend_commands_dlq
aws sqs create-queue \
  --queue-name epr_backend_commands \
  --attributes '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:eu-west-2:000000000000:epr_backend_commands_dlq\",\"maxReceiveCount\":\"3\"}"}' >/dev/null 2>&1 || true
mk_queue mock-clamav

echo "[floci-init] Configuring quarantine bucket notifications" >&2
aws s3api put-bucket-notification-configuration \
  --bucket cdp-uploader-quarantine \
  --notification-configuration '{"QueueConfigurations":[{"QueueArn":"arn:aws:sqs:eu-west-2:000000000000:mock-clamav","Events":["s3:ObjectCreated:*"]}]}'

echo "[floci-init] Uploading summary log fixtures" >&2
# Fixtures are bind-mounted from the epr-backend-journey-tests submodule at a
# separate path from this script, so SL_DIR points at /summarylogs here whereas
# the referenced upstream init uses /setup/summarylogs.
SL_DIR=/summarylogs
for pair in \
  "test-upload.xlsx:test-upload-key" \
  "valid-summary-log-input.xlsx:valid-summary-log-input-key" \
  "valid-summary-log-input-2.xlsx:valid-summary-log-input-2-key" \
  "invalid-test-upload.xlsx:invalid-test-upload-key" \
  "invalid-row-id.xlsx:invalid-row-id-key" \
  "invalid-table-name.xlsx:invalid-table-name-key" \
  "reprocessor-output-invalid.xlsx:reprocessor-output-invalid-key" \
  "reprocessor-output-valid.xlsx:reprocessor-output-valid-key" \
  "reprocessor-input-invalid.xlsx:reprocessor-input-invalid-key" \
  "reprocessor-input-valid.xlsx:reprocessor-input-valid-key" \
  "reprocessor-input-adjustments.xlsx:reprocessor-input-adjustments-key" \
  "reprocessor-output-adjustments.xlsx:reprocessor-output-adjustments-key" \
  "reprocessor-input-senton-invalid.xlsx:reprocessor-input-senton-invalid-key" \
  "exporter-invalid.xlsx:exporter-invalid-key" \
  "exporter-adjustments.xlsx:exporter-adjustments-key" \
  "exporter.xlsx:exporter-key" \
  "glass-remelt-input.xlsx:glass-remelt-input-key" \
  "glass-other-output.xlsx:glass-other-output-key" \
  "missing-date-row.xlsx:missing-date-row-key" \
  "reprocessor-regonly-valid.xlsx:reprocessor-regonly-valid-key" \
  "reprocessor-regonly-invalid.xlsx:reprocessor-regonly-invalid-key" \
  "exporter-regonly-valid.xlsx:exporter-regonly-valid-key" \
  "exporter-regonly-invalid.xlsx:exporter-regonly-invalid-key" \
  "valid-summary-log-input.xlsx:staleness-test-file-1-key" \
  "valid-summary-log-input.xlsx:staleness-test-file-2-key"
do
  file="${pair%%:*}"
  key="${pair#*:}"
  aws s3api put-object \
    --bucket re-ex-summary-logs \
    --key "$key" \
    --body "$SL_DIR/$file" >/dev/null
done

echo "[floci-init] Seeding test files in re-ex-form-uploads for Forms API testing" >&2
for i in $(seq -f "%03g" 1 20); do
  printf 'Mock file content for test-file-%s\nTimestamp: %s\nThis is test data for file copy functionality from Forms Submission API.\n' \
    "$i" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  | aws s3 cp - "s3://re-ex-form-uploads/defra-forms-stub/test-file-$i.txt" >/dev/null
done

echo "[floci-init] Done" >&2
