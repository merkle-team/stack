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

if [ "$1" = "update" ]; then
  echo "Updating Stack to latest version..."
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/merkle-team/stack/refs/heads/main/install.sh)"
  echo "Stack now on version:"
  exec stack --version
fi

# If no envars, try to load credentials from config file
if [ -z "$AWS_ACCESS_KEY_ID" ] && [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
  # Get profile name from the first script argument
  PROFILE_NAME="${AWS_PROFILE:-default}"
  AWS_ACCESS_KEY_ID=$(awk -v profile="[$PROFILE_NAME]" '$0 == profile {getline; print $3}' ~/.aws/credentials 2>/dev/null)
  AWS_SECRET_ACCESS_KEY=$(awk -v profile="[$PROFILE_NAME]" '$0 == profile {getline; getline; print $3}' ~/.aws/credentials 2>/dev/null)
fi

if [ -t 0 ]; then
  interactive_flags="-it"
else
  interactive_flags=""
fi

if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
  # No AWS envars specified, so assume we'll get it via Instance MetaData Service
  exec docker run --rm $interactive_flags \
    --env-file <(env | grep -E '^STACK_') \
    -v$(pwd):/usr/src/app/workspace \
    -e "CI=$CI" \
    -v "${SSH_AUTH_SOCK:-/ssh-agent}:/ssh-agent" \
    -e SSH_AUTH_SOCK=/ssh-agent \
    farcasterxyz/stack:$STACK_VERSION "$@"
else
  # Otherwise explicitly forward AWS auth envars
  exec docker run --rm $interactive_flags \
    --env-file <(env | grep -E '^STACK_') \
    --env-file <(env | grep -E '^AWS') \
    -v$(pwd):/usr/src/app/workspace \
    -e "CI=$CI" \
    -v "${SSH_AUTH_SOCK:-/ssh-agent}:/ssh-agent" \
    -e SSH_AUTH_SOCK=/ssh-agent \
    farcasterxyz/stack:$STACK_VERSION "$@"
fi

# Build process will append the version tag to this file so it can be used
__DATA__
