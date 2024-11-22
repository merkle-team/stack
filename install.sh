#!/bin/bash

# Installs/upgrades Stack in /usr/local/bin/stack, requiring sudo password only
# if necessary.
#
# You can run it anywhere by executing:
#
# /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/warpcast/stack/main/HEAD/install.sh)"

set -euo pipefail

if ! which curl; then
  echo "curl not found in PATH"
  exit 1
fi

if ! which jq; then
  echo "jq not found in PATH"
  exit 1
fi

if ! which sudo; then
  echo "sudo not found in PATH"
  exit 1
fi

location=/usr/local/bin/stack
sudo=""

auth-sudo() {
  if ! sudo -n >/dev/null 2>&1; then
    echo "Enter your sudo password to install Dock in $location"
    sudo -v
    sudo="sudo"
  fi
}

if [ ! -d $(dirname $location) ]; then
  mkdir_cmd="mkdir -p $location"
  if ! $mkdir_cmd >/dev/null 2>&1; then
    auth-sudo
    sudo $mkdir_cmd
  fi
fi

if ! touch $location; then
  auth-sudo
  sudo touch $location
  sudo chown $(id -u):$(id -g) $location
fi

if ! chmod +x $location; then
  auth-sudo
  sudo chmod +x $location
fi

download_url=$(curl -s https://api.github.com/repos/warpcast/stack/releases/latest | jq -r ".assets[] | select(.name  == (\"stack-$(uname -o)-$(uname -m)\" | ascii_downcase)) | .browser_download_url")
if [ -z "$download_url" ]; then
  echo "Could not find download URL for stack-`uname -o`-`uname -m`"
  echo "It's possible your platform isn't supported"
  exit 1
fi

$sudo curl -fsSL "$download_url" --output $location
