import {
  AutoScaling,
  AutoScalingGroup,
  Instance,
} from "@aws-sdk/client-auto-scaling";
import { EC2 } from "@aws-sdk/client-ec2";
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

        MinSize: 1,
        MaxSize: 1,
        DesiredCapacity: 1,

        DefaultInstanceWarmup: 0, // AWS recommends to always set this, even if zero
        HealthCheckGracePeriod: 60,

        // InstanceMaintenancePolicy:
        // MaxInstanceLifetime:
        NewInstancesProtectedFromScaleIn: true,
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

    await Promise.all(
      privateIps.map(async (ip) => {
        let attempts = 0;
        while (attempts < MAX_ATTEMPTS) {
          attempts += 1;
          try {
            const connectResult =
              await $`ssh -o StrictHostKeychecking=accept-new -a ${HOST_USER}@${privateIps[0]} bash -s < ${new Response(
                `# Execute these commands on the remote server in a Bash shell
set -e -o pipefail

echo Connected to $(hostname -I | awk '{print $1}')

mkdir -p /home/${HOST_USER}/releases/${releaseId}
cd /home/${HOST_USER}/releases/${releaseId}

cat <<EOF > docker-compose.yml
version: "3.8"

services:
  test:
    image: caddy:2
    #image: ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/${project}-${pod}:${releaseId}
    ports:
      - "80"
    restart: always
    healthcheck:
      disable: true
    #  test: ["CMD", "curl", "-f", "http://localhost:80/"]
    #  interval: 30s
    #  timeout: 10s
    #  retries: 3
    #  start_period: 30s
    #logging:
    #  driver: "json-file"
    #  options:
    #    max-size: "10m"
    #    max-file: "5"
EOF
            `,
              )}`;
            if (connectResult.exitCode !== 0) {
              throw new Error(
                `Error connecting to ${ip} (exit code ${connectResult.exitCode})`,
              );
            }
            break; // Otherwise we were successful
          } catch (e: unknown) {
            if (attempts >= MAX_ATTEMPTS) {
              console.error(
                `Unable to connect to ${ip} after ${MAX_ATTEMPTS} attempts. Aborting deploy`,
              );
              throw e;
            }
            console.warn(
              `Unable to connect to ${ip} (attempt ${attempts}/${MAX_ATTEMPTS}). Retrying in 5 seconds...`,
            );
            await sleep(5000);
          }
        }
      }),
    );
  }
}
