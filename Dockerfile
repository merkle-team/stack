# TERRAFORM

FROM hashicorp/terraform:1.9.8 AS terraform

## BASE ########################################################################

FROM node:22.7.0-slim AS base

WORKDIR /usr/src/app

COPY --from=terraform /bin/terraform /usr/local/bin/terraform

RUN <<EOF
apt-get update && apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce-cli docker-compose-plugin fzf ssh python3 make g++ unzip

curl -fsSL https://bun.sh/install | bash -s "bun-v1.1.27"
EOF

ENV PATH=/root/.bun/bin:$PATH

## INSTALL #####################################################################

# Install dependencies into temp directory cache, speeding up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lockb /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# Install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lockb /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

## PRERELEASE ##################################################################

# Copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .
ENV NODE_ENV=production
RUN bun run build

# RELEASE ######################################################################

# Copy production dependencies and source code into final image
FROM base AS release

RUN npm config set update-notifier false

# Install dependencies for AWS CLI
RUN apt-get update && apt-get install -y \
  curl unzip groff less && \
  rm -rf /var/lib/apt/lists/*

# Install AWS CLI
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip" && \
  unzip awscliv2.zip && \
  ./aws/install && \
  rm -rf awscliv2.zip aws

COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/build/. .
COPY --from=prerelease /usr/src/app/package.json .
COPY ./bin/aws-ec2-ssh /usr/local/bin/aws-ec2-ssh

# Silence annoying punycode deprecation warning, and increase heap size for CDKTF
ENV NODE_OPTIONS="--disable-warning=DEP0040 --max-old-space-size=4096"

ENTRYPOINT ["bun", "cli.js", "--workdir", "./workspace"]
