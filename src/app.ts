import { $ } from "bun";
import { readFileSync } from "node:fs";
import { DeployConfig, parseConfig } from "./config";
import { Construct } from "constructs";
import { App as CdkApp, S3Backend, TerraformStack } from "cdktf";
import { EC2, Instance } from "@aws-sdk/client-ec2";
import {
  provider,
  lb,
  autoscalingGroup,
  launchTemplate,
  vpcSecurityGroupEgressRule,
  vpcSecurityGroupIngressRule,
} from "@cdktf/provider-aws";
import { SecurityGroup } from "@cdktf/provider-aws/lib/security-group";
import { LbTargetGroup } from "@cdktf/provider-aws/lib/lb-target-group";
import { LbListener } from "@cdktf/provider-aws/lib/lb-listener";
import { IamRole } from "@cdktf/provider-aws/lib/iam-role";
import { DataAwsAcmCertificate } from "@cdktf/provider-aws/lib/data-aws-acm-certificate";
import { DataAwsIamPolicyDocument } from "@cdktf/provider-aws/lib/data-aws-iam-policy-document";
import { DataAwsVpc } from "@cdktf/provider-aws/lib/data-aws-vpc";
import { spawn } from "child_process";
import { DataAwsCallerIdentity } from "@cdktf/provider-aws/lib/data-aws-caller-identity";
import { IamRolePolicyAttachment } from "@cdktf/provider-aws/lib/iam-role-policy-attachment";
import { IamPolicy } from "@cdktf/provider-aws/lib/iam-policy";
import { IamInstanceProfile } from "@cdktf/provider-aws/lib/iam-instance-profile";
import { sleep } from "./util";
import { AutoScaling, LifecycleState } from "@aws-sdk/client-auto-scaling";
import inquirer from "inquirer";

const CDK_OUT_DIR = ".stack";
const HOST_USER = "ec2-user";
const MAX_RELEASES_TO_KEEP = 1;
const TF_ENVARS = { TF_IN_AUTOMATION: "1" };

const generateEnvVarsForPod = (config: DeployConfig, podName: string) => {
  const podEnvVars = (config.pods[podName].environment || [])
    .map((envName) => `${envName}=${process.env[envName]}`)
    .join("\n");
  return podEnvVars;
};

const generateDeployScript = (
  stackName: string,
  config: DeployConfig,
  pod: string,
  releaseId: string,
  composeContents: string,
  secretNames: string[],
) => `#!/bin/bash
set -e -o pipefail

# ${stackName} ${pod} deploy script

# Initialize the release directory if we haven't already
if [ ! -d /home/${HOST_USER}/releases/${releaseId} ]; then
  new_release_dir="/home/${HOST_USER}/releases/${releaseId}"
  mkdir -p "$new_release_dir"
  cd "$new_release_dir" 

  IMDS_TOKEN="\$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")"

  # Create environment file with values that are constant for this deployed instance
  echo "# Instance environment variables (constant for the lifetime of this instance)" > .static.env
  echo "RELEASE=${releaseId}" >> .static.env
  INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
  echo "INSTANCE_ID=\$INSTANCE_ID" >> .static.env
  echo "\$INSTANCE_ID" | sudo tee /etc/instance-id > /dev/null
  sudo chmod 444 /etc/instance-id
  echo "INSTANCE_MARKET=\$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-life-cycle)" >> .static.env
  echo "PRIVATE_IPV4=\$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)" >> .static.env
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
  echo "${Buffer.from(generateEnvVarsForPod(config, pod)).toString("base64")}" | base64 -d >> .pod.env
  echo "" >> .pod.env # Ensure newline between envars and secrets
  # Write secrets this instance currently has access to
  # TODO: Handle case where there are more than 100 secrets
  aws secretsmanager batch-get-secret-value --secret-id-list ${secretNames.join(" ")} --output json | jq -r '.SecretValues[] | .Name + "=" + .SecretString' >> .pod.env
  chmod 400 .pod.env

  # Append instance environment variables
  cat .static.env > .env
  echo "" >> .env # Add newline in case newlines are missing from the end of the file
  cat .pod.env >> .env
  chmod 400 .env

  # Convert compose file into base64 so we don't interpolate environment variables
  echo "${Buffer.from(composeContents).toString("base64")}" | base64 -d > docker-compose.yml

  # Sometimes necessary to avoid weird errors on first boot
  # See https://github.com/moby/moby/issues/22074#issuecomment-856551466
  sudo systemctl restart docker

  if [ -f /home/${HOST_USER}/releases/current ]; then
    # Instance was already deployed to, so there's currently containers running.
    # Download/build any images we need to in preparation for the switchover (blocks until finished)
    docker compose build --pull
  else 
    echo "Starting Docker containers $(cat /proc/uptime | awk '{ print $1 }') seconds after boot"

    # Otherwise, no containers are running so start them up now
    # Will wait forever until all containers running/healthy
    docker compose up --detach --wait 

    echo "Finished starting Docker containers $(cat /proc/uptime | awk '{ print $1 }') seconds after boot"
    echo "Updating latest release"
    echo "$new_release_dir" > /home/${HOST_USER}/releases/current
  fi
fi
`;

export class App {
  private options: Record<string, any>;
  private config: DeployConfig;

  constructor(options) {
    this.options = JSON.parse(JSON.stringify(options));
  }

  private generateReleaseId() {
    return `${new Date().toISOString().replace(/\:/g, "-").replace(/\./g, "-").replace("Z", "z")}`;
  }

  private parseConfig() {
    if (this.config) return;
    this.config = parseConfig(this.options.config);
  }

  public async init(
    options: { upgrade?: boolean; release?: string } = { upgrade: false },
  ) {
    await this.synth(options.release);
    const cwd = `${CDK_OUT_DIR}/stacks/${this.config.stack}`;
    const child = await this.runCommand(
      [
        "terraform",
        "init",
        "-input=false",
        ...(options.upgrade ? ["-upgrade"] : []),
      ],
      { cwd, env: { ...process.env, ...TF_ENVARS } },
    );
    return child;
  }

  public async plan() {
    await this.init();
    const cwd = `${CDK_OUT_DIR}/stacks/${this.config.stack}`;
    const child = await this.runCommand(
      ["terraform", "plan", "-input=false", "-out=plan.out"],
      { cwd, env: { ...process.env, ...TF_ENVARS } },
    );
    process.exit(child.exitCode);
  }

  public async deploy() {
    const release = this.generateReleaseId();

    this.parseConfig(); // Need this so `this.config` is set
    for (const [podName, podConfig] of Object.entries(this.config.pods)) {
      if (podConfig.environment) {
        for (const envName of podConfig.environment) {
          if (process.env[envName] === undefined) {
            throw new Error(
              `Environment variable ${envName} is required by pod ${podName}, but was not provided in the environment`,
            );
          }
        }
      }
    }

    await this.init({ release });

    const alreadyRunningInstances = await this.alreadyRunningInstances();

    const cwd = `${CDK_OUT_DIR}/stacks/${this.config.stack}`;
    const planCmd = await this.runCommand(
      [
        "terraform",
        "plan",
        "-detailed-exitcode",
        "-input=false",
        "-out=plan.out",
      ],
      { cwd, env: { ...process.env, ...TF_ENVARS } },
    );
    if (![0, 2].includes(planCmd.exitCode)) process.exit(planCmd.exitCode); // 0 = no changes, 2 = changes to apply

    if (planCmd.exitCode === 2 && !this.options.yes) {
      console.error(
        "Changes detected in Terraform plan. Check above to make sure they are intentional.",
      );
      const answers = await inquirer.prompt([
        {
          name: "proceed",
          message: "Apply infra changes and then proceed with deploy?",
        },
      ]);

      if (!(answers.proceed === "yes" || answers.proceed === "y")) {
        console.error(
          `Canceling deploy due to user answering ${answers.proceed} to prompt`,
        );
        process.exit(1);
      }
    }

    const applyCmd = await this.runCommand(
      ["terraform", "apply", "-input=false", "plan.out"],
      {
        cwd,
        env: { ...process.env, ...TF_ENVARS },
      },
    );

    // Only perform a swap if there are already running instances.
    if (alreadyRunningInstances.length) {
      await this.swapContainers(release, alreadyRunningInstances);
    }

    // TODO: Wait until all ASGs are healthy and at desired count

    process.exit(applyCmd.exitCode);
  }

  private async alreadyRunningInstances() {
    const ec2 = new EC2({ region: "us-east-1" });
    const result = await ec2.describeInstances({
      Filters: [
        {
          Name: "tag:stack",
          Values: [this.config.stack],
        },
        {
          Name: "instance-state-name",
          Values: ["running"],
        },
      ],
    });

    const instances = result.Reservations?.flatMap(
      (reservation) => reservation.Instances || [],
    );

    return instances;
  }

  private async swapContainers(releaseId: string, instances: Instance[]) {
    const instanceIds = new Set(instances.map((i) => i.InstanceId));
    const asg = new AutoScaling({ region: this.config.region });
    const instancesForPod: Record<string, Instance[]> = {};

    const updateResults = await Promise.allSettled(
      Object.entries(this.config.pods).map(async ([podName, podOptions]) => {
        const asgName = `${this.config.stack}-${podName}`;
        const asgResult = await asg.describeAutoScalingGroups({
          AutoScalingGroupNames: [asgName],
        });
        const group = asgResult.AutoScalingGroups?.find(
          (asg) => asg.AutoScalingGroupName === asgName,
        );

        if (group.DesiredCapacity === 0) {
          console.warn(`Desired capacity for ${asgName} is 0. Skipping`);
          return;
        }

        const ec2 = new EC2({ region: this.config.region });
        const describeResult = await ec2.describeInstances({
          Filters: [
            {
              Name: "tag:stack",
              Values: [this.config.stack],
            },
            {
              Name: "tag:pod",
              Values: [podName],
            },
            {
              Name: "instance-state-name",
              Values: ["running"],
            },
          ],
        });

        const instances = describeResult.Reservations?.flatMap(
          (reservation) => reservation.Instances || [],
        ).filter(
          (instance) =>
            instance.Tags?.find((tag) => tag.Key === "release")?.Value !==
            releaseId, // Skip instances on the latest release already
        );

        if (instances.length === 0) {
          console.error(
            `No existing instances found for pod ${podName}, but desired capacity is > 0. Canceling deploy.`,
          );
          throw new Error(
            `No existing instances found for pod ${podName}, but desired capacity is > 0`,
          );
        }
        // Filter down to instances that were already running, since new instances were likely created brand new by ASG itself
        instancesForPod[podName] = instances.filter(({ InstanceId }) =>
          instanceIds.has(InstanceId),
        );

        const composeContents = readFileSync(podOptions.compose).toString();
        await Promise.all(
          instances.map(async ({ InstanceId, PrivateIpAddress: ip }) => {
            const startTime = Date.now();
            while (Date.now() - startTime < 120_000) {
              try {
                const connectResult =
                  await $`ssh -o LogLevel=ERROR -o StrictHostKeychecking=no -o UserKnownHostsFile=/dev/null -a ${HOST_USER}@${ip} bash -s < ${new Response(`
  # Execute these commands on the remote server in a Bash shell
  set -e -o pipefail
  
  echo Pulling containers on ${InstanceId} ${ip}
  
  ${generateDeployScript(this.config.stack, this.config, podName, releaseId, composeContents, this.allowedPodSecrets(podName))}
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
                console.error(
                  `Unable to connect to ${ip}. Retrying in 5 seconds...`,
                  e,
                );
                await sleep(5000);
              }
            }
          }),
        );
      }),
    );

    let updateFailed = false;
    for (const result of updateResults) {
      if (result.status === "rejected") {
        updateFailed = true;
        console.error(result.reason);
      }
    }
    if (updateFailed) {
      console.error(
        "One or more pods failed to download the latest images specified in their respective Docker Compose file(s). Aborting deploy.",
      );
      process.exit(1);
    }

    // Swap all instances to start using the new containers
    const swapResults = await Promise.allSettled(
      Object.entries(this.config.pods).map(async ([podName, podOptions]) => {
        const asgName = `${this.config.stack}-${podName}`;

        for (const {
          PrivateIpAddress: ip,
          InstanceId: instanceId,
        } of instancesForPod[podName]) {
          if (podOptions.deploy.detachBeforeContainerSwap) {
            // Detach from ASG so that traffic from LB is not sent to the instance
            // Stop sending load balancer traffic to instance
            await asg.enterStandby({
              AutoScalingGroupName: asgName,
              ShouldDecrementDesiredCapacity: true,
              InstanceIds: [instanceId],
            });

            const beginTime = Date.now();
            for (;;) {
              const standbyInstances = await asg.describeAutoScalingInstances({
                InstanceIds: [instanceId],
              });
              const standbyDetails =
                standbyInstances.AutoScalingInstances || [];
              if (
                standbyDetails.every(
                  (i) => i.LifecycleState === LifecycleState.STANDBY,
                )
              ) {
                break;
              }
              if (Date.now() - beginTime > 60_000) {
                throw new Error(
                  `Instance ${instanceId} (${ip}) did not enter Standby state within 60 seconds.`,
                );
              }
              console.info(
                `Waiting for instance ${instanceId} (${ip}) to enter Standby state...`,
              );
              await sleep(5000);
            }
          }

          // Swap the containers
          const connectResult =
            await $`ssh -o LogLevel=ERROR -o StrictHostKeychecking=no -o UserKnownHostsFile=/dev/null -a ${HOST_USER}@${ip} bash -s < ${new Response(
              `# Execute these commands on the remote server in a Bash shell
  set -e -o pipefail

  echo Swapping containers on ${instanceId} ${ip}

  # Stop the current release if there is one
  if [ -f /home/${HOST_USER}/releases/current ]; then
    cd "$(cat /home/${HOST_USER}/releases/current)"
    docker compose down --timeout ${podOptions.deploy.shutdownTimeout} # Blocks until finished or timed out
  fi

  new_release_dir="/home/${HOST_USER}/releases/${releaseId}"
  cd "$new_release_dir" 

  # Start the pod and wait for all containers to be healthy
  docker compose up --detach --wait --wait-timeout 30 # If timeout exceeded, proceed. TODO: Abort deploy?

  # Update "current" location to point to the new release
  echo "$new_release_dir" > /home/${HOST_USER}/releases/current

  # Update tags so we know which release this instance is currently on
  aws ec2 create-tags --tags "Key=release,Value=${releaseId}" "Key=Name,Value=${asgName}-${releaseId}" --resource "\$(cat /etc/instance-id)"

  # Clean up old releases 
  cd /home/${HOST_USER}
  ls -I current releases | sort | head -n ${MAX_RELEASES_TO_KEEP} | xargs -I{} rm -rf releases/{}
          `,
            )}`;
          if (connectResult.exitCode !== 0) {
            throw new Error(
              `Error connecting to ${ip} (exit code ${connectResult.exitCode})`,
            );
          }

          if (podOptions.deploy.detachBeforeContainerSwap) {
            // Re-attach to ASG so we start receiving traffic again
            await asg.exitStandby({
              AutoScalingGroupName: asgName,
              InstanceIds: [instanceId],
            });
          }
        }
      }),
    );

    let deployFailed = false;
    for (const result of swapResults) {
      if (result.status === "rejected") {
        deployFailed = true;
        console.error(result.reason);
      }
    }
    if (deployFailed) {
      console.error(
        "One or more pods failed to start up the latest containers. Aborting deploy.",
      );
      process.exit(1);
    }
  }

  public async destroy() {
    await this.init();
    const cwd = `${CDK_OUT_DIR}/stacks/${this.config.stack}`;

    const destroyPlanCmd = await this.runCommand(
      [
        "terraform",
        "plan",
        "-destroy",
        "-detailed-exitcode",
        "-input=false",
        "-out=destroy-plan.out",
      ],
      { cwd, env: { ...process.env, ...TF_ENVARS } },
    );
    if (![0, 2].includes(destroyPlanCmd.exitCode))
      process.exit(destroyPlanCmd.exitCode); // 0 = no changes, 2 = changes to apply

    if (destroyPlanCmd.exitCode === 2 && !this.options.yes) {
      console.error(
        "WARNING: This is not quickly reversible! It will actually delete infrastructure resources!",
      );
      const answers = await inquirer.prompt([
        { name: "proceed", message: "Destroy ALL resources for this stack?" },
      ]);

      if (!(answers.proceed === "yes" || answers.proceed === "y")) {
        console.error(
          `Canceling destroy due to user answering ${answers.proceed} to prompt`,
        );
        process.exit(1);
      }
    }

    const applyCmd = await this.runCommand(
      ["terraform", "apply", "-input=false", "destroy-plan.out"],
      { cwd, env: { ...process.env, ...TF_ENVARS } },
    );
    process.exit(applyCmd.exitCode);
  }

  public async lint() {
    this.parseConfig();
    console.info(`Stack configuration '${this.options.config}' is valid`);
    process.exit(0);
  }

  public async console(pod?: string) {
    this.parseConfig();

    if (pod && !this.config.pods[pod]) {
      console.error(`Stack does not have a pod named ${pod}`);
      process.exit(1);
    }

    const ec2 = new EC2({ region: "us-east-1" });
    const result = await ec2.describeInstances({
      Filters: [
        {
          Name: "tag:stack",
          Values: [this.config.stack],
        },
        {
          Name: "instance-state-name",
          Values: ["running"],
        },
        ...(pod
          ? [
              {
                Name: "tag:pod",
                Values: [pod],
              },
            ]
          : []),
      ],
    });

    const instances = result.Reservations?.flatMap(
      (reservation) => reservation.Instances || [],
    );
    if (instances.length === 0) {
      if (pod) {
        console.error(`No running instances found for pod ${pod}`);
      } else {
        console.error("No running instances found in this stack");
      }
      process.exit(1);
    }

    if (instances.length === 1) {
      // Only one to chose from, so select automatically
      this.sshInto(instances[0].PrivateIpAddress);
    }

    const candidates = [];
    for (const instance of instances) {
      const instancePod = instance.Tags.findLast(
        (tag) => tag.Key === "pod",
      )?.Value;
      const release = instance.Tags.findLast(
        (tag) => tag.Key === "release",
      )?.Value;
      candidates.push(
        [
          instance.InstanceId.padEnd(20, " "),
          instance.PrivateIpAddress.padEnd(16, " "),
          release.padEnd(25, " "),
          instancePod.padEnd(25, " ").slice(0, 25),
        ].join(" "),
      );
    }

    const fzf = spawn(`echo "${candidates.join("\n")}" | fzf --height=~10`, {
      stdio: ["inherit", "pipe", "inherit"],
      shell: true,
    });

    const output = [];
    fzf.stdout.setEncoding("utf-8");
    fzf.stdout.on("readable", function () {
      const chunk = fzf.stdout.read();
      if (chunk !== null) output.push(chunk);
    });

    fzf.on("exit", (code) => {
      const choice = output.join("").trim();
      if (code === 0) {
        const [instanceId, privateIp, , pod] = choice.split(/\s+/);
        console.info(
          `Connecting to pod ${pod} (${instanceId}) at ${privateIp}...`,
        );
        this.sshInto(privateIp);
      } else {
        console.error("No instance selected");
      }
      process.exit(0);
    });
  }

  private sshInto(host: string) {
    const sshResult = Bun.spawnSync(
      [
        "ssh",
        "-o",
        "LogLevel=ERROR",
        // Gets really annoying to have to clear your known hosts file
        // all the time, so don't bother with host key checking
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        `${HOST_USER}@${host}`,
      ],
      {
        stdio: ["inherit", "inherit", "inherit"],
      },
    );
    process.exit(sshResult.exitCode);
  }

  private async synth(release?: string) {
    this.parseConfig();

    const releaseId = release || this.generateReleaseId();

    const deployStartTime = Date.now();

    const secretsConfig = this.config.secrets || {};

    const app = new CdkApp({ outdir: CDK_OUT_DIR });
    const stack = new DeployStack(app, this.config.stack, (stack) => {
      new S3Backend(stack, {
        bucket: "warpcast-terraform-state",
        key: `${this.config.stack}.tfstate`,
        region: this.config.region,
        encrypt: true,
        dynamodbTable: "warpcast-terraform-locks",
      });

      new provider.AwsProvider(stack, "aws", {
        region: this.config.region,
      });

      const callerIdentity = new DataAwsCallerIdentity(stack, "current", {});

      const vpc = new DataAwsVpc(stack, "vpc", {
        id: this.config.network.id,
      });

      const lbSgs: Record<string, SecurityGroup> = {};
      const lbs: Record<string, lb.Lb> = {};
      for (const [lbName, lbOptions] of Object.entries(
        this.config.loadBalancers || {},
      )) {
        const fullLbName = `${stack}-${lbName}`;

        if (
          lbOptions.idleTimeout !== undefined &&
          lbOptions.type !== "application"
        ) {
          throw new Error(
            `Load balancer ${lbName} has an idle-timeout specified, but is not an application load balancer`,
          );
        }

        const lbSg = new SecurityGroup(stack, fullLbName, {
          name: fullLbName,
          vpcId: this.config.network.id,
          tags: {
            Name: fullLbName,
            stack: this.config.stack,
            loadBalancer: lbName,
          },
          timeouts: {
            delete: "5m",
          },
        });

        new vpcSecurityGroupIngressRule.VpcSecurityGroupIngressRule(
          stack,
          `${fullLbName}-ingress-all-ipv4`,
          {
            securityGroupId: lbSg.id,
            ipProtocol: "-1",
            cidrIpv4: "0.0.0.0/0",
          },
        );
        new vpcSecurityGroupIngressRule.VpcSecurityGroupIngressRule(
          stack,
          `${fullLbName}-ingress-all-ipv6`,
          {
            securityGroupId: lbSg.id,
            ipProtocol: "-1",
            cidrIpv6: "::/0",
          },
        );

        new vpcSecurityGroupEgressRule.VpcSecurityGroupEgressRule(
          stack,
          `${fullLbName}-egress-all-ipv4`,
          {
            securityGroupId: lbSg.id,
            ipProtocol: "-1",
            cidrIpv4: "0.0.0.0/0",
          },
        );
        new vpcSecurityGroupEgressRule.VpcSecurityGroupEgressRule(
          stack,
          `${fullLbName}-egress-all-ipv6`,
          {
            securityGroupId: lbSg.id,
            ipProtocol: "-1",
            cidrIpv6: "::/0",
          },
        );

        lbSgs[lbName] = lbSg;

        const stackLb = new lb.Lb(stack, lbName, {
          name: fullLbName,
          loadBalancerType: lbOptions.type,
          internal: !lbOptions.public,
          subnets: lbOptions.public
            ? this.config.network.subnets.public
            : this.config.network.subnets.private,
          idleTimeout: lbOptions.idleTimeout,
          preserveHostHeader:
            lbOptions.type === "application" ? true : undefined,
          enableCrossZoneLoadBalancing: true,
          ipAddressType: "dualstack",
          securityGroups: [lbSg.id],
        });
        lbs[lbName] = stackLb;
      }

      for (const [podName, podOptions] of Object.entries(this.config.pods)) {
        const fullPodName = `${stack}-${podName}`;

        const podRole = new IamRole(stack, `${fullPodName}-role`, {
          name: `${fullPodName}`,
          assumeRolePolicy: new DataAwsIamPolicyDocument(
            stack,
            `${fullPodName}-assume-role-policy`,
            {
              statement: [
                {
                  actions: ["sts:AssumeRole"],
                  effect: "Allow",
                  principals: [
                    {
                      type: "Service",
                      identifiers: ["ec2.amazonaws.com"],
                    },
                  ],
                  condition: [
                    {
                      test: "StringEquals",
                      variable: "aws:SourceAccount",
                      values: [callerIdentity.accountId],
                    },
                  ],
                },
              ],
            },
          ).json,
        });

        const allowedPodSecrets = this.allowedPodSecrets(podName);
        const anySecrets = allowedPodSecrets.length > 0;

        new IamRolePolicyAttachment(stack, `${fullPodName}-policy-attachment`, {
          role: podRole.name,
          policyArn: new IamPolicy(stack, `${fullPodName}-policy`, {
            name: `${fullPodName}-policy`,
            description: `Policy for pod ${podName} in stack ${this.config.stack}`,
            policy: new DataAwsIamPolicyDocument(
              stack,
              `${fullPodName}-policy-document`,
              {
                statement: [
                  {
                    actions: ["ecr:GetAuthorizationToken"],
                    effect: "Allow",
                    resources: ["*"],
                  },
                  {
                    actions: [
                      "ecr:GetDownloadUrlForLayer",
                      "ecr:BatchGetImage",
                      "ecr:BatchCheckLayerAvailability",
                    ],
                    effect: "Allow",
                    resources: [
                      `arn:aws:ecr:${this.config.region}:${callerIdentity.accountId}:repository/*`,
                    ],
                  },
                  {
                    actions: ["secretsmanager:BatchGetSecretValue"],
                    effect: anySecrets ? "Allow" : "Deny",
                    resources: ["*"], // Doesn't give permission to any secret values; see below
                  },
                  {
                    actions: [
                      "secretsmanager:DescribeSecret",
                      "secretsmanager:GetSecretValue",
                      "secretsmanager:ListSecretVersionIds",
                    ],
                    effect: anySecrets ? "Allow" : "Deny",
                    resources: anySecrets
                      ? allowedPodSecrets.map(
                          (secretName) =>
                            `arn:aws:secretsmanager:${this.config.region}:${callerIdentity.accountId}:secret:${secretName}-*`,
                        )
                      : ["*"],
                  },
                  {
                    actions: ["ec2:CreateTags"],
                    effect: "Allow",
                    // Only allow the user to update their own instance with the `release` tag
                    condition: [
                      {
                        test: "Null",
                        variable: "aws:TagKeys",
                        values: ["false"],
                      },
                      {
                        test: "ForAllValues:StringEquals",
                        variable: "aws:TagKeys",
                        values: ["release", "Name"],
                      },
                      {
                        test: "StringEquals",
                        variable: "aws:ARN",
                        values: ["$${ec2:SourceInstanceARN}"],
                      },
                    ],
                    resources: ["*"], // Above conditions limit this to instance's own tags
                  },
                ],
              },
            ).json,
          }).arn,
        });

        const podSg = new SecurityGroup(stack, fullPodName, {
          name: fullPodName,
          vpcId: this.config.network.id,
          tags: {
            Name: fullPodName,
            stack: this.config.stack,
            pod: podName,
          },
          timeouts: {
            delete: "5m",
          },
        });

        new vpcSecurityGroupIngressRule.VpcSecurityGroupIngressRule(
          stack,
          `${fullPodName}-ingress-ssh`,
          {
            securityGroupId: podSg.id,
            ipProtocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrIpv4: "10.0.0.0/8",
            tags: {
              name: `${fullPodName}-ingress-ssh`,
              stack: this.config.stack,
              pod: podName,
            },
          },
        );
        new vpcSecurityGroupEgressRule.VpcSecurityGroupEgressRule(
          stack,
          `${fullPodName}-egress-all-ipv4`,
          {
            securityGroupId: podSg.id,
            ipProtocol: "-1",
            cidrIpv4: "0.0.0.0/0",
            tags: {
              name: `${fullPodName}-egress-all-ipv4`,
              stack: this.config.stack,
              pod: podName,
            },
          },
        );
        new vpcSecurityGroupEgressRule.VpcSecurityGroupEgressRule(
          stack,
          `${fullPodName}-egress-all-ipv6`,
          {
            securityGroupId: podSg.id,
            ipProtocol: "-1",
            cidrIpv6: "::/0",
            tags: {
              name: `${fullPodName}-egress-all-ipv6`,
              stack: this.config.stack,
              pod: podName,
            },
          },
        );

        const tgs: Record<string, LbTargetGroup> = {};
        for (const [endpointName, endpointOptions] of Object.entries(
          podOptions.endpoints || {},
        )) {
          new vpcSecurityGroupIngressRule.VpcSecurityGroupIngressRule(
            stack,
            `${fullPodName}-ingress-${endpointName}-ipv4`,
            {
              securityGroupId: podSg.id,
              ipProtocol: "tcp",
              fromPort: endpointOptions.target.port,
              toPort: endpointOptions.target.port,
              cidrIpv4: "10.0.0.0/8",
              tags: {
                name: `${fullPodName}-ingress-${endpointName}-ipv4`,
                stack: this.config.stack,
                pod: podName,
              },
            },
          );
          new vpcSecurityGroupIngressRule.VpcSecurityGroupIngressRule(
            stack,
            `${fullPodName}-ingress-${endpointName}-ipv6`,
            {
              securityGroupId: podSg.id,
              ipProtocol: "tcp",
              fromPort: endpointOptions.target.port,
              toPort: endpointOptions.target.port,
              cidrIpv6: vpc.ipv6CidrBlock,
              tags: {
                name: `${fullPodName}-ingress-${endpointName}-ipv6`,
                stack: this.config.stack,
                pod: podName,
              },
            },
          );

          // Don't need to create target group or listeners if there's no load balancer associated
          if (!endpointOptions.loadBalancer) continue;

          const tg = new LbTargetGroup(
            stack,
            `${fullPodName}-${endpointName}`,
            {
              name: `${fullPodName}-${endpointName}`,
              port: endpointOptions.target.port,
              protocol: endpointOptions.target.protocol,
              vpcId: this.config.network.id,
              deregistrationDelay:
                endpointOptions.target.deregistration.delay.toString(),
              connectionTermination:
                endpointOptions.target.deregistration.action ===
                "force-terminate-connection",
              healthCheck: {
                healthyThreshold:
                  endpointOptions.target.healthCheck.healthyThreshold,
                unhealthyThreshold:
                  endpointOptions.target.healthCheck.unhealthyThreshold,
                matcher:
                  endpointOptions.target.healthCheck.successCodes?.toString(),
                path: endpointOptions.target.healthCheck.path,
                port: endpointOptions.target.port.toString(),
                protocol: endpointOptions.target.protocol,
                timeout: endpointOptions.target.healthCheck.timeout,
              },
            },
          );
          tgs[endpointName] = tg;

          const certData = new DataAwsAcmCertificate(
            stack,
            `${fullPodName}-${endpointName}-cert`,
            {
              domain: endpointOptions.loadBalancer.cert,
              statuses: ["ISSUED"],
              types: ["AMAZON_ISSUED"],
              mostRecent: true,
            },
          );

          new LbListener(stack, `${fullPodName}-${endpointName}-listener`, {
            loadBalancerArn: lbs[endpointOptions.loadBalancer.name].arn,
            port: endpointOptions.loadBalancer.port,
            protocol: endpointOptions.loadBalancer.protocol,
            certificateArn: certData.arn,
            defaultAction: [
              {
                type: "forward",
                targetGroupArn: tg.arn,
              },
            ],
            tags: {
              Stack: this.config.stack,
              Pod: podName,
              Endpoint: endpointName,
              LoadBalancer: endpointOptions.loadBalancer.name,
            },
          });
        }

        const composeContents = readFileSync(podOptions.compose).toString();

        const instanceProfile = new IamInstanceProfile(
          stack,
          `${fullPodName}-instance-profile`,
          {
            name: fullPodName,
            role: podRole.name,
            tags: {
              stack: this.config.stack,
              pod: podName,
            },
          },
        );

        const lt = new launchTemplate.LaunchTemplate(
          stack,
          `${fullPodName}-lt`,
          {
            name: fullPodName,
            imageId: podOptions.image,
            instanceInitiatedShutdownBehavior: "terminate",
            instanceType: podOptions.instanceType,
            iamInstanceProfile: {
              name: instanceProfile.name,
            },
            keyName: "sds2", // TODO: Update

            metadataOptions: {
              httpEndpoint: "enabled",
              httpTokens: "required",
              httpPutResponseHopLimit: 2, // IMDS Docker containers
              httpProtocolIpv6: "disabled",
              instanceMetadataTags: "enabled",
            },

            networkInterfaces: [
              {
                associatePublicIpAddress: (!!podOptions.publicIp).toString(),
                ipv6AddressCount: 1, // Assign one IPV6 address
                securityGroups: [podSg.id],
              },
            ],

            tagSpecifications: [
              {
                resourceType: "instance",
                tags: {
                  Name: `${fullPodName}-${releaseId}`, // Purely for visual in AWS console, no functional purpose
                  stack: this.config.stack,
                  pod: podName,
                  release: releaseId,
                },
              },
            ],

            userData: Buffer.from(
              `#!/bin/bash
# These commands are executed by cloud-init when the instance starts up
set -e -o pipefail

# Run any other custom pre-initialization as root.
# Must happen before base initialization below since we might need to mount volumes
# that are used by the base initialization script.
cd /home/${HOST_USER}
echo "${Buffer.from(podOptions.initScript ? readFileSync(podOptions.initScript).toString() : "#/bin/bash\n# No script specified in this deploy configuration's initScript\n").toString("base64")}" | base64 -d > before-init.sh
chmod +x before-init.sh
echo "Starting before-init script $(cat /proc/uptime | awk '{ print $1 }') seconds after boot"
./before-init.sh
echo "Finished before-init script $(cat /proc/uptime | awk '{ print $1 }') seconds after boot"

echo "${Buffer.from(generateDeployScript(this.config.stack, this.config, podName, releaseId, composeContents, allowedPodSecrets)).toString("base64")}" | base64 -d > init.sh
chmod +x init.sh
echo "Starting init script $(cat /proc/uptime | awk '{ print $1 }') seconds after boot"
# Execute as host user so that created file permissions are correct
su ${HOST_USER} /home/${HOST_USER}/init.sh
echo "Finished init script $(cat /proc/uptime | awk '{ print $1 }') seconds after boot"
  `,
            ).toString("base64"),
          },
        );

        const asg = new autoscalingGroup.AutoscalingGroup(stack, podName, {
          name: fullPodName,
          minSize: 1,
          maxSize: 1,
          desiredCapacity: 1,
          defaultInstanceWarmup: 60, // Give 1 minute for the instance to start up, download containers, and start before including in CloudWatch metrics
          defaultCooldown: 0, // Don't wait between scaling actions
          healthCheckGracePeriod: podOptions.healthCheckGracePeriod,
          healthCheckType: Object.keys(podOptions.endpoints || {}).length
            ? "ELB"
            : "EC2",
          waitForCapacityTimeout: `${podOptions.healthCheckGracePeriod}s`,

          trafficSource: Object.values(tgs).map((tg) => ({
            identifier: tg.arn,
            type: "elbv2",
          })),

          vpcZoneIdentifier: podOptions.publicIp
            ? this.config.network.subnets.public
            : this.config.network.subnets.private,
          protectFromScaleIn: false,

          terminationPolicies: ["OldestLaunchTemplate"],

          instanceMaintenancePolicy: {
            minHealthyPercentage: podOptions.minHealthyPercentage,
            maxHealthyPercentage: podOptions.maxHealthyPercentage,
          },
          waitForElbCapacity: podOptions.minHealthyInstances,

          instanceRefresh:
            podOptions.deploy.replaceWith === "new-instances"
              ? {
                  strategy: "Rolling",
                  preferences: {
                    minHealthyPercentage: podOptions.minHealthyPercentage,
                    maxHealthyPercentage: podOptions.maxHealthyPercentage,
                    autoRollback: true,
                    scaleInProtectedInstances: "Wait",
                    standbyInstances: "Wait",
                    instanceWarmup: "0",
                  },
                }
              : undefined,

          mixedInstancesPolicy: {
            instancesDistribution: {
              onDemandAllocationStrategy: "prioritized",
              onDemandBaseCapacity: 1,
              onDemandPercentageAboveBaseCapacity: 0,
              spotAllocationStrategy: "lowest-price",
            },
            launchTemplate: {
              launchTemplateSpecification: {
                launchTemplateName: lt.name,
                version: lt.latestVersion.toString(),
              },
            },
          },

          tag: [
            {
              key: "stack",
              value: this.config.stack,
              propagateAtLaunch: true,
            },
            {
              key: "pod",
              value: podName,
              propagateAtLaunch: true,
            },
          ],

          lifecycle: {
            // After we've created the ASG for the first time, this is managed separately
            ignoreChanges: [
              "min_size",
              "max_size",
              "desired_capacity",
              "wait_for_elb_capacity",
            ],
          },
        });
      }
    });
    app.synth();
  }

  private async runCommand(
    command: string[],
    options: Parameters<typeof Bun.spawn>[1] = {},
  ) {
    const subprocess = Bun.spawn(command, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      ...options,
    });
    await subprocess.exited;
    return subprocess;
  }

  private allowedPodSecrets(podName: string) {
    const allowedSecrets = [];
    for (const [secretName, secretOptions] of Object.entries(
      this.config.secrets || {},
    )) {
      if (
        (secretOptions.podsIncluded?.length &&
          secretOptions.podsIncluded?.includes(podName)) ||
        (secretOptions.podsExcluded?.length &&
          !secretOptions.podsExcluded?.includes(podName))
      ) {
        allowedSecrets.push(secretName);
      }
    }
    return allowedSecrets;
  }
}

class DeployStack extends TerraformStack {
  constructor(scope: Construct, id: string, fn: (stack: DeployStack) => void) {
    super(scope, id);

    fn(this);
  }
}
