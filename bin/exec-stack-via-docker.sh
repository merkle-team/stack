#!/bin/bash

# Executes Stack via Docker.
#
# Makes it easier to get started since you don't need to have Terraform or
# Terraform CDK already set up, since the Docker image includes these for you.

# Read the data blob after the '__DATA__' marker
while IFS= read -r line; do
  if [[ "$line" == "__DATA__" ]]; then
    # Start reading data after the marker
    while IFS= read -r data; do
      STACK_VERSION=$data
      break # Only one line of data to read
    done
    break
  fi
done < "$0"

if [ -z "$STACK_VERSION" ]; then
  echo "Invalid executable: no version was specified."
  echo "You should not run this directly from the repo."
  echo "Download and execute the final built version from one of the published releases instead."
  exit 1
fi

# If no envars, try to load credentials from config file
if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
  AWS_ACCESS_KEY_ID=$(cat ~/.aws/credentials | sed -n 's/.*aws_access_key_id\s*=\s*\([a-zA-Z0-9+-_]*\).*/\1/p')
  AWS_SECRET_ACCESS_KEY=$(cat ~/.aws/credentials | sed -n 's/.*aws_secret_access_key\s*=\s*\([a-zA-Z0-9+-_]*\).*/\1/p')
fi

if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
  # No AWS envars specified, so assume we'll get it via Instance MetaData Service
  exec docker run --rm -it \
    --env-file <(env | grep -v -E '^PATH=' | grep -v -E '^SHELL=') \
    -v$(pwd):/usr/src/app/workspace \
    -v $SSH_AUTH_SOCK:/ssh-agent \
    -e SSH_AUTH_SOCK=/ssh-agent \
    warpcast/stack:$STACK_VERSION "$@"
else
  # Otherwise explicitly forward AWS auth envars
  exec docker run --rm -it \
    --env-file <(env | grep -v -E '^PATH=' | grep -v -E '^SHELL=') \
    -v$(pwd):/usr/src/app/workspace \
    -e AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY \
    -v $SSH_AUTH_SOCK:/ssh-agent \
    -e SSH_AUTH_SOCK=/ssh-agent \
    warpcast/stack:$STACK_VERSION "$@"
fi

# Build process will append the version tag to this file so it can be used
__DATA__
