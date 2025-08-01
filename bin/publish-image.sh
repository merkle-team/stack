#!/bin/bash

# Builds and publishes image to Docker Hub.
# This is intended to be run by our GitHub Actions workflow.
#
# MUST be run from the root of the repository so the Docker build context is correct.
#
# You must `docker login ...` first so that we have the necessary permissions to
# push the image layers + tags to Docker Hub.

STACK_VERSION=${STACK_VERSION:-$(git rev-parse HEAD)}

echo "Publishing Stack $STACK_VERSION"

depot build -f Dockerfile \
  --platform "linux/amd64,linux/arm64" \
  --push \
  -t merklemanufactory/stack:${STACK_VERSION} \
  -t merklemanufactory/stack:latest \
  .
