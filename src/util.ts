import { stringToBase64 } from "uint8array-extras";
import { DeployConfig } from "./config";

type ValueOf<T> = T[keyof T];
type Entries<T> = [keyof T, ValueOf<T>][];

// Same as `Object.entries()` but with type inference
export function objectEntries<T extends object>(obj: T): Entries<T> {
  return Object.entries(obj) as Entries<T>;
}

export function sleep(millis: number) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

export function generateDeployScript(
  namespace: string,
  pod: string,
  podOptions: DeployConfig["pods"][string],
  releaseId: string,
  composeContents: string,
  secretNameMappings: Record<string, string>
) {
  const sshUser = podOptions.sshUser;

  const secretNames = Object.keys(secretNameMappings);
  const secretBatchSize = 20;

  return `#!/bin/bash
set -e -o pipefail

# ${namespace} ${pod} deploy script

# Initialize the release directory if we haven't already
if [ ! -d /home/${sshUser}/releases/${releaseId} ]; then
  new_release_dir="/home/${sshUser}/releases/${releaseId}"
  mkdir -p "$new_release_dir"
  cd "$new_release_dir"

  IMDS_TOKEN="\$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")"

  # Create environment file with values that are constant for this deployed instance
  echo "# Instance environment variables (constant for the lifetime of this instance)" > .static.env
  echo "PROJECT=${namespace}" >> .static.env
  echo "RELEASE=${releaseId}" >> .static.env
  echo "POD_NAME=${pod}" >> .static.env
  REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/dynamic/instance-identity/document | jq -r .region)
  echo "REGION=\$REGION" >> .static.env
  INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
  echo "INSTANCE_ID=\$INSTANCE_ID" >> .static.env
  echo "\$INSTANCE_ID" | sudo tee /etc/instance-id > /dev/null
  sudo chmod 444 /etc/instance-id
  echo "INSTANCE_MARKET=\$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-life-cycle)" >> .static.env
  private_ipv4="\$(curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)"
  echo "PRIVATE_IPV4=\$private_ipv4" >> .static.env
  public_ipv4="\$(curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || echo "")"
  if [ -n "\$public_ipv4" ]; then
    echo "PUBLIC_IPV4=\$public_ipv4" >> .static.env
  fi
  ipv6="\$(curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/ipv6 || echo "")"
  if [ -n "\$public_ipv4" ]; then
    echo "IPV6=\$ipv6" >> .static.env
  fi
  chmod 400 .static.env

  # Write current values of environment variables current set for this pod
  echo "# Pod environment variables (can change with each deploy)" > .pod.env
  echo "${stringToBase64(
    generateEnvVarsForPod(podOptions)
  )}" | base64 -d >> .pod.env
  echo "" >> .pod.env

  # Fetch secrets in batches and write to .pod.env
  ${Array.from(
    { length: Math.ceil(secretNames.length / secretBatchSize) },
    (_, i) => secretNames.slice(i * secretBatchSize, (i + 1) * secretBatchSize)
  )
    .map(
      (batch) =>
        `aws secretsmanager batch-get-secret-value --secret-id-list ${batch.join(
          " "
        )} --output json | jq -r '.SecretValues[] | .Name + "=" + .SecretString' >> .pod.env`
    )
    .join("\n")}
  chmod 400 .pod.env

  # Replace envar names with mapped names for this pod
  ${Object.entries(secretNameMappings)
    .filter(([secretName, mappedName]) => secretName !== mappedName)
    .map(
      ([secretName, mappedName]) =>
        `sed -i.bak "s/^${secretName}=/${mappedName}=/" .pod.env`
    )
    .join("\n")}
  rm -f .pod.env.bak

  cat .static.env > .env
  echo "" >> .env
  cat .pod.env >> .env
  chmod 400 .env
  rm .static.env .pod.env

  echo "${stringToBase64(composeContents)}" | base64 -d > docker-compose.yml

  if [ -f /home/${sshUser}/releases/current ]; then
    echo "Downloading and preparing Docker images on \$INSTANCE_ID \$private_ipv4 before swapping containers"
    # Work around a Docker Compose bug where it doesn't use ECR credentials on subsequent pulls (sometimes)
    source <(cat .env | grep "^STACK_DOCKER_IMAGE=")
    if [ -n "$STACK_DOCKER_IMAGE" ]; then
      docker pull $STACK_DOCKER_IMAGE
    fi
    docker compose build
    docker compose pull --quiet --ignore-buildable --policy=missing # Specify "missing" so we don't re-pull images we already have cached
  else
    # Avoid weird errors on first boot; see https://github.com/moby/moby/issues/22074#issuecomment-856551466
    sudo systemctl restart docker

    COMPOSE_PROFILES="${pod}" docker compose up --detach --quiet-pull --pull=missing
    echo "Finished starting Docker containers $(cat /proc/uptime | awk '{ print $1 }') seconds after boot"
    echo "$new_release_dir" > /home/${sshUser}/releases/current
  fi
fi`;
}

function generateEnvVarsForPod(podOptions: DeployConfig["pods"][string]) {
  const environment = podOptions.environment;

  if (Array.isArray(environment || [])) {
    const podEnvVars = ((environment as string[]) || [])
      .map((envName) => `${envName}=${process.env[envName]}`)
      .join("\n");
    return podEnvVars;
  } else if (typeof environment === "object") {
    const podEnvVars = Object.entries(environment)
      .map(([envName, envValue]) =>
        envValue === undefined || envValue === null
          ? `${envName}=${process.env[envName]}`
          : `${envName}=${envValue}`
      )
      .join("\n");
    return podEnvVars;
  }

  return "";
}

export async function inBatchesOf<T>(
  items: T[],
  batchSize: number,
  fn: (batch: T[]) => unknown
) {
  let offset = 0;
  while (offset < items.length) {
    const batch = items.slice(offset, offset + batchSize);
    await fn(batch);
    offset += batchSize;
  }
}
