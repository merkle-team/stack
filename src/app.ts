import { $ } from "bun";
import { parse as parseYaml } from "yaml";
import { promises as fsPromises } from "fs";
import { Construct } from "constructs";
import { App as CdkApp, TerraformStack } from "cdktf";
import { provider, alb, lb } from "@cdktf/provider-aws";
import {
  AutoScaling,
  AutoScalingGroup,
  Instance,
  LifecycleState,
} from "@aws-sdk/client-auto-scaling";
import { EC2 } from "@aws-sdk/client-ec2";
import {
  ElasticLoadBalancingV2,
  ProtocolEnum,
  TargetGroup,
  TargetGroupNotFoundException,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { sleep } from "./util";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TypeCompiler } from "@sinclair/typebox/compiler";

const DOCKER_COMPOSE_VERSION = "2.24.6";
const AMI_ID = "ami-0a330430a1504ef77"; // 64-bit ARM Amazon Linux 2023 with Docker + Docker Compose already installed
const HOST_USER = "ec2-user";
const AWS_ACCOUNT_ID = "526236635984";
const CIDR_BLOCK = "10.0.0.0/16";

const DeployConfigSchema = Type.Object({
  stack: Type.String(),

  "load-balancers": Type.Record(
    Type.String(),
    Type.Object({
      type: Type.Union([Type.Literal("application"), Type.Literal("network")]),
      public: Type.Optional(Type.Boolean({ default: false })),
    }),
    { additionalProperties: false, default: {} },
  ),

  pods: Type.Record(
    Type.String(),
    Type.Object({
      image: Type.String({ pattern: "^ami-[a-f0-9]+$" }),
      instance: Type.Union([
        Type.Literal("t4g.medium"),
        Type.Literal("t4g.large"),
      ]), // TODO: Generate dynamically somehow

      "health-check-grace-period": Type.Optional(Type.Integer({ minimum: 0 })),

      compose: Type.String(),

      endpoints: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            "load-balancer": Type.Optional(Type.String()),
            protocol: Type.Union([
              Type.Literal("HTTP"),
              Type.Literal("HTTPS"),
              Type.Literal("TCP"),
              Type.Literal("UDP"),
              Type.Literal("TCP_UDP"),
              Type.Literal("TLS"),
            ]),
            port: Type.Integer({ minimum: 1, maximum: 65535 }),
            cert: Type.String(),
            "idle-timeout": Type.Optional(
              Type.Integer({ minimum: 1, default: 60 }),
            ),
            deregistration: Type.Optional(
              Type.Object({
                delay: Type.Integer({ minimum: 0 }),
                action: Type.Optional(
                  Type.Union(
                    [
                      Type.Literal("do-nothing"),
                      Type.Literal("force-terminate-connection"),
                    ],
                    { default: "do-nothing" },
                  ),
                ),
              }),
            ),
            target: Type.Object({
              port: Type.Integer({ minimum: 1, maximum: 65535 }),
              protocol: Type.Union([
                Type.Literal("HTTP"),
                Type.Literal("HTTPS"),
                Type.Literal("TCP"),
                Type.Literal("UDP"),
                Type.Literal("TCP_UDP"),
                Type.Literal("TLS"),
              ]),
              "health-check": Type.Object({
                path: Type.String(),
                "success-codes": Type.Union([
                  Type.Integer({ minimum: 200, maximum: 599 }),
                  Type.String(),
                ]),
                "healthy-threshold": Type.Integer({ minimum: 1 }),
                "unhealthy-threshold": Type.Integer({ minimum: 1 }),
                timeout: Type.Integer({ minimum: 1 }),
                interval: Type.Integer({ minimum: 5 }),
              }),
            }),
          }),
        ),
      ),
    }),
  ),

  network: Type.Object({
    id: Type.String({ pattern: "^vpc-[a-f0-9]+$" }),

    subnets: Type.Object({
      public: Type.Array(Type.String({ pattern: "^subnet-[a-f0-9]+$" })),
      private: Type.Array(Type.String({ pattern: "^subnet-[a-f0-9]+$" })),
    }),
  }),
});

const DEPLOY_CONFIG_COMPILER = TypeCompiler.Compile(DeployConfigSchema);

type DeployConfig = Static<typeof DeployConfigSchema>;

// Script to run both after ini
const generateDeployScript = (
  project: string,
  pod: string,
  releaseId: string,
) => `
# Initialize the release directory if we haven't already
if [ ! -d /home/${HOST_USER}/releases/${releaseId} ]; then
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
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "printf 'GET / HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n' | nc localhost 80"]
      start_period: 5s
      interval: 5s
      timeout: 3s
      retries: 3
    logging:
      driver: "journald"
EOF

  if [ -f /home/${HOST_USER}/releases/current ]; then
    # Instance was already deployed to, so there's currently containers running.
    # Download/build any images we need to in preparation for the switchover (blocks until finished)
    docker compose up --no-start
  else 
    # Otherwise, no containers are running so start them up now
    docker compose up --detach --wait --wait-timeout 60
  fi
fi
`;

export class App {
  private options: Record<string, any>;
  private config: DeployConfig;

  constructor(options: Record<string, any>) {
    this.options = JSON.parse(JSON.stringify(options));
  }

  public async deploy() {
    this.config = parseYaml(
      (await fsPromises.readFile(this.options.config)).toString(),
    );
    const configErrors = [...DEPLOY_CONFIG_COMPILER.Errors(this.config)];
    if (configErrors?.length) {
      for (const error of configErrors) {
        console.log(`${error.message} at ${error.path}`);
      }
      throw new Error("Invalid configuration file");
    }

    // Ensure all defaults are set
    this.config = Value.Default(
      DeployConfigSchema,
      this.config,
    ) as DeployConfig;

    const deployStartTime = Date.now();

    const outdir = "cdktf.out";
    const app = new CdkApp({ outdir });
    const stack = new DeployStack(
      app,
      this.config.stack,
      this.config,
      (stack) => {
        new provider.AwsProvider(stack, "aws", {
          region: "us-east-1",
        });

        for (const [lbName, lbOptions] of Object.entries(
          this.config["load-balancers"],
        )) {
          const fullLbName = `${stack}-${lbName}`;

          const ref = new lb.Lb(stack, lbName, {
            name: fullLbName,
            loadBalancerType: lbOptions.type,
            internal: !lbOptions.public,
            subnets: lbOptions.public
              ? this.config.network.subnets.public
              : this.config.network.subnets.private,
          });
        }

        /*
      new instance.Instance(stack, "Hello", {
        ami: AMI_ID,
        instanceType: "t4g.medium",
        vpcSecurityGroupIds: ["sg-01b670b361df0bd92"],
        subnetId: "subnet-09d8bb56d08618935",
        keyName: "sds2",

        instanceMarketOptions: {
          marketType: 'spot',
        },

        connection: {
          type: 'ssh',
          user: 'ec2-user',
          agent: "true",
          host: "${self.private_ip}",
        },
        
        provisioners: [{
          type: 'remote-exec',
          inline: [
            'date',
          ],
        }],
      });
      */
      },
    );
    app.synth();

    // await $`cdktf plan ${stack} --skip-synth --output=${outdir}`;
    await $`cdktf apply ${stack} --skip-synth --output=${outdir}`;
    // await $`cdktf destroy ${stack} --skip-synth --output=${outdir}`;

    process.exit(1);

    const ec2 = new EC2({
      region: "us-east-1",
    });
    const elb = new ElasticLoadBalancingV2({
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

    const vpcsResult = await ec2.describeVpcs({
      Filters: [
        {
          Name: "cidr",
          Values: [CIDR_BLOCK],
        },
      ],
    });
    if (!vpcsResult.Vpcs?.length) {
      throw new Error(`No VPC found for CIDR ${CIDR_BLOCK}`);
    }
    const vpc = vpcsResult.Vpcs[0];

    // Ensure the defined load balancer exists
    const loadBalancerName = "test-lb"; // `${project}-${pod}-lb`; TODO: Create load balancer if it doesn't exist?
    const loadBalancersResult = await elb.describeLoadBalancers({
      Names: [loadBalancerName],
    });
    if (!loadBalancersResult.LoadBalancers?.length) {
      throw new Error(`Load balancer ${loadBalancerName} does not exist`);
    }

    const targetGroupName = `${project}-${pod}-lb`;
    let tg: TargetGroup;
    try {
      const tgsResult = await elb.describeTargetGroups({
        Names: [targetGroupName],
      });
      tg = tgsResult.TargetGroups[0];
    } catch (e) {
      // Annoying that this is how the API works
      if (!(e instanceof TargetGroupNotFoundException)) throw e;

      console.warn(
        `Target group ${targetGroupName} does not exist, creating...`,
      );
      const tgsResult = await elb.createTargetGroup({
        Name: targetGroupName,
        VpcId: vpc.VpcId,
        Protocol: ProtocolEnum.HTTP,
        ProtocolVersion: "HTTP1",
        Port: 80,
        HealthCheckEnabled: true,
        HealthCheckIntervalSeconds: 5, // Minimum
        HealthyThresholdCount: 2, // Minimum
        UnhealthyThresholdCount: 2, // Minimum
        HealthCheckTimeoutSeconds: 2,
        HealthCheckPath: "/",
        HealthCheckProtocol: ProtocolEnum.HTTP,
        Matcher: {
          HttpCode: "200",
        },
        Tags: [
          {
            Key: "Project",
            Value: project,
          },
          {
            Key: "Pod",
            Value: pod,
          },
        ],
      });

      tg = tgsResult.TargetGroups[0];
    }

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
        // TODO: Update launch template after each deploy

        console.debug("No launch template found, creating one...");
        const ltCreateResult = await ec2.createLaunchTemplate({
          LaunchTemplateName: launchTemplateName,
          ClientToken: releaseId,
          LaunchTemplateData: {
            // EbsOptimized: true,
            // HibernationOptions: {},
            // IamInstanceProfile: {},
            ImageId: AMI_ID,
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
set -x -e -o pipefail

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

cd /home/${HOST_USER}
cat <<INIT > initialize.sh
${generateDeployScript(project, pod, releaseId)}
INIT
chmod +x /home/${HOST_USER}/initialize.sh

# Since we're using cloud-init, run the script as ec2-user so permissions are correct
su ${HOST_USER} /home/${HOST_USER}/initialize.sh
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

        // Subnet IDs (required)
        VPCZoneIdentifier: [
          "subnet-09d8bb56d08618935", // private-1b
          "subnet-0fdd713886476d21c", // private-1d
          "subnet-0d4f99e3a3569ec11", // private-1f
        ].join(","),

        // Which load balancers? (not required on initial creation)
        TrafficSources: [
          {
            Identifier: tg.TargetGroupArn,
            Type: "TargetGroup",
          },
        ],
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

    console.info(
      `Waiting for ${privateIps.length} instances to enter InService state...`,
    );
    await Promise.all(
      instanceDetails.map(
        async ({ InstanceId: instanceId, PrivateIpAddress: ip }) => {
          let inserviceStartTime = Date.now();
          for (;;) {
            let standbyInstances = await asg.describeAutoScalingInstances({
              InstanceIds: [instanceId],
            });
            const standbyDetails = standbyInstances.AutoScalingInstances || [];
            if (
              standbyDetails.every(
                (i) => i.LifecycleState === LifecycleState.IN_SERVICE,
              )
            ) {
              break;
            }
            if (Date.now() - inserviceStartTime > 60_000) {
              throw new Error(
                `Instance ${instanceId} (${ip}) did not enter InService state within 60 seconds. Aborting deploy`,
              );
            }
            console.info(
              `Waiting for instance ${instanceId} (${ip}) to enter InService state...`,
            );
            await sleep(5000);
          }
        },
      ),
    );

    console.info("Preparing release to the following IPs:", privateIps);
    await Promise.all(
      instanceDetails.map(async ({ PrivateIpAddress: ip }) => {
        const startTime = Date.now();
        while (Date.now() - startTime < 120_000) {
          try {
            const connectResult =
              await $`ssh -o StrictHostKeychecking=no -a ${HOST_USER}@${ip} bash -s < ${new Response(`
# Execute these commands on the remote server in a Bash shell
set -e -o pipefail

ip="$(hostname -I | awk '{print $1}')"
echo Connected to $ip
while [ ! -f /home/${HOST_USER}/.docker/config.json ]; do 
  echo "Waiting for $ip to finish initialization via cloud-init..."
  sleep 5
done

${generateDeployScript(project, pod, releaseId)}
            `)}`;
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
              e,
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
set -x -e -o pipefail

# Stop the current release if there is one
if [ -f /home/${HOST_USER}/releases/current ]; then
  cd "$(cat /home/${HOST_USER}/releases/current)"
  docker compose down --timeout 30 # Blocks until finished or timed out
fi

new_release_dir="/home/${HOST_USER}/releases/${releaseId}"
cd "$new_release_dir" 

# Start the pod and wait for all containers to be healthy
docker compose up --detach --wait --wait-timeout 60

# Update "current" location to point to the new release
cd ..
echo "$new_release_dir" > current
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
              e,
            );
            throw e;
          }
          console.warn(
            `Unable to deploy to ${ip}. Retrying in 5 seconds...`,
            e,
          );
          await sleep(5000);
        }
      }
    }

    console.info(`Total time: ${Date.now() - deployStartTime}ms`);
  }
}

class DeployStack extends TerraformStack {
  constructor(
    scope: Construct,
    id: string,
    config: DeployConfig,
    fn: (stack: DeployStack) => void,
  ) {
    super(scope, id);

    fn(this);
  }
}
