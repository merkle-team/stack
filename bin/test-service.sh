#!/bin/bash

# Runs a Stack command against infra/test-service using an image built from
# this checkout, so a change can be deployed end to end before it is released.
#
# Usage:
#   bin/test-service.sh plan
#   bin/test-service.sh deploy --yes
#   bin/test-service.sh destroy --yes
#
# Requires:
#
# - super-admin AWS credentials, via AWS_PROFILE or AWS_* envars
# - infra repo checked out in a sibling directory to this repo, or
#   TEST_SERVICE_DIR set to its test-service directory

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
workspace="${TEST_SERVICE_DIR:-$root/../infra/test-service}"
image="stack:test-service"

if [ ! -f "$workspace/.stack/deploy.yml" ]; then
  echo "No test-service config at $workspace/.stack/deploy.yml"
  echo "Check out the infra repo next to this one, or set TEST_SERVICE_DIR."
  exit 1
fi

docker build -t "$image" "$root"

# The container has no ~/.aws, so resolve profiles and SSO sessions to envars
creds="$(mktemp)"
trap 'rm -f "$creds"' EXIT
aws configure export-credentials --format env-no-export > "$creds"
echo "AWS_REGION=${AWS_REGION:-us-east-1}" >> "$creds"

# Without a TTY, docker run -it fails and Stack's prompts would hang
if [ -t 0 ]; then
  interactive_flags="-it"
  ci=""
else
  interactive_flags=""
  ci="true"
fi

docker run --rm $interactive_flags \
  -v "$workspace:/usr/src/app/workspace" \
  --env-file "$creds" \
  -e "CI=${CI:-$ci}" \
  "$image" "$@"
