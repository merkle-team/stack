import {
  AutoScaling,
  AutoScalingGroup,
  Instance,
  LifecycleState,
} from "@aws-sdk/client-auto-scaling";
import { EC2, InstanceStateName } from "@aws-sdk/client-ec2";
import { $ } from "bun";
import { sleep } from "./util";

const DOCKER_COMPOSE_VERSION = "2.24.6";
const HOST_USER = "ec2-user";
const MAX_ATTEMPTS = 3;
const AWS_ACCOUNT_ID = "526236635984";

export class App {
  private options: Record<string, any>;

  constructor(options: Record<string, any>) {
    this.options = JSON.parse(JSON.stringify(options));
  }

  public async deploy() {
    const ec2 = new EC2({
      region: "us-east-1",
    });
    const asg = new AutoScaling({
      region: "us-east-1",
    });

    const project = "test";
    const pod = "pod";
    // Want to be able to use release ID as a domain name one day
    const releaseId = `${new Date().toISOString().replace(/\:/g, "-").replace(/\./g, "-").replace("Z", "z")}`; // TODO: Suffix with commit hash
    const asgName = `${project}-${pod}-asg`;

    let asgsResult = await asg.describeAutoScalingGroups({
      AutoScalingGroupNames: [asgName],
    });
    if (!asgsResult.AutoScalingGroups?.length) {
      console.info("No ASG found, creating one...");
      const launchTemplateName = `${project}-${pod}-${releaseId}`;
      const ltExists = await ec2
        .describeLaunchTemplates({
          LaunchTemplateNames: [launchTemplateName],
        })
        .catch((e) => {
          return undefined;
        });
      if (!ltExists?.LaunchTemplates?.length) {
        // TODO: Include Docker Compose file preparation in launch template, and update launch template after each deploy

        console.debug("No launch template found, creating one...");
        const ltCreateResult = await ec2.createLaunchTemplate({
          LaunchTemplateName: launchTemplateName,
          ClientToken: releaseId,
          LaunchTemplateData: {
            // EbsOptimized: true,
            // HibernationOptions: {},
            // IamInstanceProfile: {},
            ImageId: "ami-0f93c02efd1974b8b", // 64-bit ARM Amazon Linux 2023
            InstanceInitiatedShutdownBehavior: "terminate",
            // InstanceMarketOptions: {}, // Spot?
            InstanceType: "t4g.medium", // 2 vCPUs, 4 GB RAM
            KeyName: "sds2",
            MetadataOptions: {
              HttpTokens: "required", // Require more secure V2 tokens
              HttpPutResponseHopLimit: 2, // Allows Docker containers to reach metadata service
            },
            SecurityGroupIds: [
              "sg-08093b534df170012", // ingress-all egress-all
              "sg-01b670b361df0bd92", // ingress-ssh egress-all
            ],
            // TagSpecifications: [],
            UserData: Buffer.from(
              `#!/bin/bash
set -x

dnf update -y
dnf install -y docker
usermod -a -G docker ${HOST_USER}
newgrp docker
systemctl enable docker.service
systemctl start docker.service

mkdir -p /home/${HOST_USER}/.docker/cli-plugins
curl -L https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m) > /home/${HOST_USER}/.docker/cli-plugins/docker-compose
chmod +x /home/${HOST_USER}/.docker/cli-plugins/docker-compose

dnf install -y amazon-ecr-credential-helper

cat <<EOF > /home/${HOST_USER}/.docker/config.json
{
  "credsStore": "ecr-login",
  "credHelpers": {
		"public.ecr.aws": "ecr-login",
		"${AWS_ACCOUNT_ID}.dkr.ecr.<region>.amazonaws.com": "ecr-login"
	}
}
EOF
  `,
            ).toString("base64"),
          },
        });
      }

      const asgCreateResult = await asg.createAutoScalingGroup({
        AutoScalingGroupName: asgName,
        LaunchTemplate: {
          LaunchTemplateName: launchTemplateName,
          Version: "$Latest",
        },

        MinSize: 2,
        MaxSize: 2,
        DesiredCapacity: 2,

        DefaultInstanceWarmup: 0, // AWS recommends to always set this, even if zero
        HealthCheckGracePeriod: 60,

        // InstanceMaintenancePolicy:
        // MaxInstanceLifetime:
        // NewInstancesProtectedFromScaleIn: true,
        // TerminationPolicies:

        Tags: [
          {
            Key: "Project",
            PropagateAtLaunch: true,
            ResourceId: asgName,
            ResourceType: "auto-scaling-group",
            Value: project,
          },
          {
            Key: "Pod",
            PropagateAtLaunch: true,
            ResourceId: asgName,
            ResourceType: "auto-scaling-group",
            Value: pod,
          },
          {
            Key: "ReleaseId",
            PropagateAtLaunch: true,
            ResourceId: asgName,
            ResourceType: "auto-scaling-group",
            Value: releaseId,
          },
        ],

        // TargetGroupARNs: [], // Probably don't need to specify this on initial creation

        // Subnet IDs (required)
        VPCZoneIdentifier: [
          "subnet-09d8bb56d08618935", // private-1b
          "subnet-0fdd713886476d21c", // private-1d
          "subnet-0d4f99e3a3569ec11", // private-1f
        ].join(","),

        // Which load balancers? (not required on initial creation)
        // TrafficSources:
      });

      asgsResult = await asg.describeAutoScalingGroups({
        AutoScalingGroupNames: [asgName],
      });
    }

    let group: AutoScalingGroup | undefined;
    let startTime = Date.now();
    for (;;) {
      group = asgsResult.AutoScalingGroups?.find(
        (asg) => asg.AutoScalingGroupName === asgName,
      );
      if (group) break;

      if (Date.now() - startTime > 30_000) {
        throw new Error(`ASG ${asgName} was not created within 30 seconds`);
      }
      console.debug(`Waiting for ASG ${asgName} to be created...`);
      await sleep(1000);
      asgsResult = await asg.describeAutoScalingGroups({
        AutoScalingGroupNames: [asgName],
      });
    }

    if (group.DesiredCapacity === 0) {
      console.warn(
        `ASG ${asgName} has a desired capacity of 0. Nothing left to do.`,
      );
      return; // Nothing to do
    }

    let healthyInstances: Instance[] = [];
    startTime = Date.now();
    for (;;) {
      healthyInstances =
        group.Instances?.filter((i) => i.HealthStatus === "Healthy") || [];
      if (healthyInstances.length === group.DesiredCapacity) break;

      if (Date.now() - startTime > 300_000) {
        throw new Error(
          `ASG ${asgName} is not healthy. You can try redeploying once all instances in the ASG are healthy`,
        );
      }
      console.log(
        `Waiting up to 5 minutes for ASG ${asgName} to have the desired number of healthy instances (${group.DesiredCapacity})...`,
      );
      await sleep(10_000);
      asgsResult = await asg.describeAutoScalingGroups({
        AutoScalingGroupNames: [asgName],
      });
      group = asgsResult.AutoScalingGroups?.find(
        (asg) => asg.AutoScalingGroupName === asgName,
      );
    }

    const instanceIds = healthyInstances.map((i) => i.InstanceId as string);
    const instancesResult = await ec2.describeInstances({
      InstanceIds: instanceIds,
    });
    const instanceDetails = instancesResult.Reservations?.flatMap(
      (r) => r.Instances || [],
    );
    const privateIps =
      instanceDetails?.map((i) => i.PrivateIpAddress as string) || [];
    if (privateIps.length === 0) {
      // Should never happen, but just in case
      throw new Error(`No private IPs found for ASG ${asgName}`);
    }

    console.info("Preparing release to the following IPs:", privateIps);
    await Promise.all(
      instanceDetails.map(async ({ PrivateIpAddress: ip }) => {
        const startTime = Date.now();
        while (Date.now() - startTime < 120_000) {
          try {
            const connectResult =
              await $`ssh -o StrictHostKeychecking=accept-new -a ${HOST_USER}@${ip} bash -s < ${new Response(
                `# Execute these commands on the remote server in a Bash shell
set -e -o pipefail

echo Connected to ${ip}
while [ ! -f /home/${HOST_USER}/.docker/config.json ]; do 
  echo "Waiting for ${ip} to finish initializing via cloud-init..."
  sleep 1
done

new_release_dir="/home/${HOST_USER}/releases/${releaseId}"
mkdir -p "$new_release_dir"
cd "$new_release_dir" 

cat <<EOF > docker-compose.yml
version: "3.8"

services:
  test:
    image: caddy:2
    command: ["caddy", "file-server", "--debug", "--browse"]
    #image: ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/${project}-${pod}:${releaseId}
    network_mode: host
    ports:
      - "80:80"
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "printf 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n' | nc localhost 80"]
      start_period: 5s
      interval: 5s
      timeout: 3s
      retries: 3
    #logging:
    #  driver: "json-file"
    #  options:
    #    max-size: "10m"
    #    max-file: "5"
EOF

# Download/build any images we need to in preparation for the switchover (blocks until finished)
docker compose up --no-start
            `,
              )}`;
            if (connectResult.exitCode !== 0) {
              throw new Error(
                `Error connecting to ${ip} (exit code ${connectResult.exitCode})`,
              );
            }
            break; // Otherwise we were successful
          } catch (e: unknown) {
            if (Date.now() - startTime > 120_000) {
              console.error(
                `Unable to connect to ${ip} after 2 minutes. Aborting deploy.`,
              );
              throw e;
            }
            console.warn(
              `Unable to connect to ${ip}. Retrying in 5 seconds...`,
            );
            await sleep(5000);
          }
        }
      }),
    );

    // Now that all instances have been prepared, perform the switchover
    console.info("Deploying release to the following IPs:", privateIps);
    for (const {
      PrivateIpAddress: ip,
      InstanceId: instanceId,
    } of instanceDetails) {
      const startTime = Date.now();
      while (Date.now() - startTime < 120_000) {
        try {
          // Stop sending load balancer traffic to instance
          await asg.enterStandby({
            AutoScalingGroupName: asgName,
            ShouldDecrementDesiredCapacity: true,
            InstanceIds: [instanceId],
          });

          let beginTime = Date.now();
          for (;;) {
            let standbyInstances = await asg.describeAutoScalingInstances({
              InstanceIds: [instanceId],
            });
            const standbyDetails = standbyInstances.AutoScalingInstances || [];
            if (
              standbyDetails.every(
                (i) => i.LifecycleState === LifecycleState.STANDBY,
              )
            )
              break;
            if (Date.now() - beginTime > 60_000) {
              throw new Error(
                `Instance ${instanceId} (${ip}) did not enter Standby state within 60 seconds. Aborting deploy`,
              );
            }
            console.info(
              `Waiting for instance ${instanceId} (${ip}) to enter Standby state...`,
            );
            await sleep(5000);
          }

          const connectResult =
            await $`ssh -a ${HOST_USER}@${ip} bash -s < ${new Response(
              `# Execute these commands on the remote server in a Bash shell
set -e -o pipefail

# Stop the current release if there is one
if [ -f /home/${HOST_USER}/releases/current && -d "$(cat /home/${HOST_USER}/releases/current)" ]; then
  cd "$(cat /home/${HOST_USER}/releases/current)"
  docker compose down --timeout 30 # Blocks until finished or timed out
fi

new_release_dir="/home/${HOST_USER}/releases/${releaseId}"
cd "$new_release_dir" 

# Start the pod and wait for all containers to be healthy
docker compose up --detach --wait --wait-timeout 60

# Update "current" location to point to the new release
echo "$new_release_dir" > ../current
          `,
            )}`;
          if (connectResult.exitCode !== 0) {
            throw new Error(
              `Error connecting to ${ip} (exit code ${connectResult.exitCode})`,
            );
          }

          // Start sending load balancer traffic to instance again
          await asg.exitStandby({
            AutoScalingGroupName: asgName,
            InstanceIds: [instanceId],
          });

          beginTime = Date.now();
          for (;;) {
            let standbyInstances = await asg.describeAutoScalingInstances({
              InstanceIds: [instanceId],
            });
            const standbyDetails = standbyInstances.AutoScalingInstances || [];
            if (
              standbyDetails.every(
                (i) => i.LifecycleState === LifecycleState.IN_SERVICE,
              )
            )
              break;
            if (Date.now() - beginTime > 60_000) {
              throw new Error(
                `Instance ${instanceId} (${ip}) did not enter InService state within 60 seconds. Aborting deploy`,
              );
            }
            console.info(
              `Waiting for instance ${instanceId} (${ip}) to enter InService state again...`,
            );
            await sleep(5000);
          }

          break; // Otherwise we were successful
        } catch (e: unknown) {
          if (Date.now() - startTime > 120_000) {
            console.error(
              `Unable to deploy to ${ip} after 2 minutes. Aborting deploy.`,
            );
            throw e;
          }
          console.warn(`Unable to deploy to ${ip}. Retrying in 5 seconds...`);
          await sleep(5000);
        }
      }
    }
  }
}
