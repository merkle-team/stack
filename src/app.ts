import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { DeployConfig, parseConfig } from "./config";
import { App as CdkApp } from "cdktf";
import { EC2, Instance as EC2Instance } from "@aws-sdk/client-ec2";
import {
  inBatchesOf,
  sleep,
  generateDeployScript,
  objectEntries,
  withTimeout,
} from "./util";
import {
  AutoScaling,
  AutoScalingGroup,
  LifecycleState,
} from "@aws-sdk/client-auto-scaling";
import { ConfiguredRetryStrategy } from "@aws-sdk/util-retry";
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { PodStack } from "./stacks/PodStack";
import { execa } from "execa";
import {
  ListSecretsCommand,
  SecretListEntry,
  SecretsManager,
} from "@aws-sdk/client-secrets-manager";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { AwsCredentialIdentity, Provider } from "@aws-sdk/types";

const MAX_RELEASES_TO_KEEP = 10;
const TF_ENVARS = { TF_IN_AUTOMATION: "1" };

type ExitStatus = number;

export class App {
  private config: DeployConfig;

  constructor(
    private readonly cliPath: string,
    private readonly options: Record<string, string | boolean>
  ) {
    this.options = JSON.parse(JSON.stringify(options));
    // Ensure subprocesses have the same release ID
    if (this.options.release) {
      process.env["RELEASE_ID"] = this.options.release as string;
    }
    this.config = parseConfig(this.options.config as string);
    this.createCdktfJson();
  }

  private createRetryStrategy(serviceName: string): ConfiguredRetryStrategy {
    const maxAttempts = process.env.AWS_MAX_ATTEMPTS
      ? parseInt(process.env.AWS_MAX_ATTEMPTS, 10)
      : 5;

    return new ConfiguredRetryStrategy(maxAttempts, (attempt: number) => {
      const delayMs = 300 * 2 ** attempt;
      if (attempt > 0) {
        console.warn(
          `[WARN] AWS ${serviceName} throttling detected - retrying (attempt ${attempt}/${maxAttempts}, waiting ${delayMs}ms)`
        );
      }
      return delayMs;
    });
  }

  private createCredentialsProvider(): Provider<AwsCredentialIdentity> {
    const maxAttempts = process.env.AWS_MAX_ATTEMPTS
      ? parseInt(process.env.AWS_MAX_ATTEMPTS, 10)
      : 5;
    const baseProvider = defaultProvider();

    return async () => {
      let lastError: Error | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const credentials = await baseProvider();
          if (attempt > 0) {
            console.warn(
              `[INFO] AWS credentials loaded successfully after ${attempt} ${
                attempt === 1 ? "retry" : "retries"
              }`
            );
          }
          return credentials;
        } catch (error: unknown) {
          lastError = error as Error;
          const errorName = (error as Error)?.name;

          // Only retry on credential provider errors
          if (
            errorName === "CredentialsProviderError" ||
            errorName === "ProviderError"
          ) {
            const delayMs = 300 * 2 ** attempt;

            if (attempt < maxAttempts - 1) {
              console.warn(
                `[WARN] AWS credentials loading failed (attempt ${
                  attempt + 1
                }/${maxAttempts}): ${
                  (error as Error).message
                }. Retrying in ${delayMs}ms...`
              );
              await sleep(delayMs);
            } else {
              console.error(
                `[ERROR] AWS credentials loading failed after ${maxAttempts} attempts: ${
                  (error as Error).message
                }`
              );
            }
          } else {
            // For non-credential errors, fail immediately
            throw error;
          }
        }
      }

      // If we exhausted all retries, throw the last error
      throw (
        lastError ||
        new Error("Failed to load AWS credentials after multiple attempts")
      );
    };
  }

  private createAutoScalingClient(): AutoScaling {
    return new AutoScaling({
      region: this.config.region,
      credentials: this.createCredentialsProvider(),
      retryStrategy: this.createRetryStrategy("AutoScaling"),
    });
  }

  private createEC2Client(): EC2 {
    return new EC2({
      region: this.config.region,
      credentials: this.createCredentialsProvider(),
      retryStrategy: this.createRetryStrategy("EC2"),
    });
  }

  private createDynamoDBClient(): DynamoDB {
    return new DynamoDB({
      region: this.config.region,
      credentials: this.createCredentialsProvider(),
      retryStrategy: this.createRetryStrategy("DynamoDB"),
    });
  }

  private createSecretsManagerClient(): SecretsManager {
    return new SecretsManager({
      region: this.config.region,
      credentials: this.createCredentialsProvider(),
      retryStrategy: this.createRetryStrategy("SecretsManager"),
    });
  }

  public async synth(
    stacks: string[] = this.getAllStackIds()
  ): Promise<ExitStatus> {
    const child = await this.runCommand(
      ["bunx", "cdktf", "synth", ...this.normalizeStackIds(stacks)],
      { env: { ...process.env, ...TF_ENVARS } }
    );
    return child.exited;
  }

  public async plan(stacks: string[]): Promise<ExitStatus> {
    const stackIds = stacks.length
      ? this.normalizeStackIds(stacks)
      : this.getAllStackIds();
    console.info("Planning stacks:", stackIds);

    await this._synth();

    const failedStacks: string[] = [];
    // A core assumption with running these in parallel is that each pod does not have dependencies on any other pod.
    // Otherwise we would need to run in serial.
    //
    // We also disable the plugin cache directory since Terraform doesn't support multiple independent
    // processes modifying the plugin cache directory. See:
    // https://github.com/hashicorp/terraform-cdk/issues/2741
    // https://github.com/hashicorp/terraform/issues/31964
    // https://github.com/hashicorp/terraform-cdk/issues/3500#issuecomment-1951827605
    process.env["CDKTF_DISABLE_PLUGIN_CACHE_ENV"] = "1";
    const results = await Promise.allSettled(
      stackIds.map(async (stackId) => {
        console.info(
          "=========================================================================================="
        );
        console.info(`${stackId} plan output`);
        console.info(
          "↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓"
        );
        const result = await execa({
          stdout: "inherit",
          stderr: "inherit",
        })`bunx cdktf plan --skip-synth ${stackId}`;
        console.log("exit status", result.exitCode);
        if (result.exitCode !== 0) {
          failedStacks.push(stackId);
        }
      })
    );

    for (const result of results) {
      if (result.status === "rejected") {
        console.error(result.reason);
        return 1;
      }
    }
    if (failedStacks.length) {
      console.error("Stacks with plan failures:", failedStacks);
      return 1;
    }

    return 0;
  }

  public async deploy(stacks: string[]): Promise<ExitStatus> {
    const deployStartTime = Date.now();

    if (this.options.applyOnly && this.options.skipApply) {
      throw new Error(
        "Cannot specify --apply-only and --skip-apply as they are mutually exclusive"
      );
    }

    let stackIds = stacks.length
      ? this.normalizeStackIds(stacks)
      : this.getAllStackIds();
    const referencedPodNames = this.extractPodNames(stackIds);

    const includedPodNames = referencedPodNames.filter(
      (podName) => !podName.startsWith("-")
    );
    const excludedPodNames = referencedPodNames
      .filter((podName) => podName.startsWith("-"))
      .map((podName) => podName.slice(1));

    let podNames = includedPodNames;
    if (excludedPodNames.length > 0 && includedPodNames.length > 0) {
      throw new Error("Cannot specify both included and excluded pods");
    } else if (excludedPodNames.length > 0) {
      podNames = this.extractPodNames(this.getAllStackIds()).filter(
        (podName) => !excludedPodNames.includes(podName)
      );
      stackIds = this.normalizeStackIds(
        podNames.map((podName) => `${this.config.project}-pod-${podName}`)
      );
    }

    console.info(`Deploying pods:\n${podNames.join("\n")}`);

    const release = this.options.release as string;

    for (const [podName, podConfig] of objectEntries(this.config.pods)) {
      if (podNames.length > 0 && !podNames.includes(podName)) {
        continue;
      }

      if (Array.isArray(podConfig.environment)) {
        for (const envName of podConfig.environment) {
          if (process.env[envName] === undefined) {
            throw new Error(
              `Environment variable ${envName} is required by pod ${podName}, but was not provided in the environment`
            );
          }
          if (envName.includes("=")) {
            throw new Error(
              `Environment variable ${envName} contains an equals sign, which is not allowed. Use a map if you want to provide explicit values`
            );
          }
        }
      } else if (typeof podConfig.environment === "object") {
        for (const [envName, envValue] of Object.entries(
          podConfig.environment
        )) {
          if (
            (envValue === null || envValue === undefined) &&
            (envValue === process.env[envName]) === undefined
          ) {
            throw new Error(
              `Environment variable ${envName} is required by pod ${podName}, but was not provided in the environment`
            );
          }
        }
      }
    }

    // Get current instances before making any changes
    const alreadyRunningInstances = this.options.applyOnly
      ? []
      : await this.alreadyRunningInstances(podNames);

    console.log(
      `Detected ${alreadyRunningInstances.length} already running instances`
    );

    // Terraform apply to ASG will fail if there are currently active instance refreshes, so cancel them
    await this.rollbackActiveInstanceRefreshes(podNames);

    if (!this.options.skipApply) {
      // Allow us to run in parallel since Terraform doesn't support multiple independent processes modifying the plugin cache directory.
      process.env["CDKTF_DISABLE_PLUGIN_CACHE_ENV"] = "1";
      const results = await Promise.allSettled(
        stackIds.map(async (stackId) => {
          const child = await this.runCommand(
            [
              "bunx",
              "cdktf",
              "apply",
              "--auto-approve", // Since we're running in parallel, all these share stdin so we need to auto-approve
              stackId,
            ],
            { env: { ...process.env, ...TF_ENVARS } }
          );
          return child.exitCode;
        })
      );
      // There's a bug in cdktf where the color output is not reset, so reset it manually so the rest of our text isn't colored
      console.log("\x1b[0m");

      for (const result of results) {
        if (result.status === "rejected") {
          console.error(result.reason);
          return 1;
        }
        if (result.value !== null && result.value !== 0) {
          return result.value;
        }
      }
    }

    if (!this.options.applyOnly) {
      const createAsgStatus = await this.createAsgs(podNames);
      if (createAsgStatus !== 0) {
        // Exit early before attempting to swap containers since there's something very wrong with AWS if we can't create ASGs
        return createAsgStatus;
      }
    }

    // Since we may have triggered an instance refresh, wait until all ASGs are healthy
    // and at desired count, or consider the deploy a failure.
    // We do this first since Consul-based health checks usually finish much faster.
    // Note that if there are no instance-refresh-based pods, this will return quickly.
    const waitInstanceRefreshesExitStatus = await this.waitForInstanceRefreshes(
      podNames
    );
    if (waitInstanceRefreshesExitStatus !== 0) {
      await this.deleteAsgs(podNames, true); // Clean up new deploy on failure
      return waitInstanceRefreshesExitStatus;
    }

    // If there are Consul-based pods, wait for their health checks to pass.
    // This ensures it is safe for us to remove the old instances from load balancers etc
    // If there are none, this will return quickly.
    const failedPods = new Set<string>();
    const waitConsulServiceHealthExitStatus =
      await this.waitForConsulServiceHealthChecks(
        podNames,
        release,
        // Pod deploy success callback
        async (podName) => {
          // Only perform a swap if there are already running instances.
          if (!this.options.applyOnly && alreadyRunningInstances.length) {
            // It's possible the above apply command removed instances, so need to check again
            const currentlyRunningInstances =
              await this.alreadyRunningInstances([podName]);

            if (currentlyRunningInstances.length) {
              const currentlyRunningInstancesByPod =
                await this.alreadyRunningInstancesByPod([podName]);
              // Run the pre-terminate script for each pod
              const preTerminateScriptExitStatus =
                await this.runPreContainerShutdownScripts(
                  [podName],
                  currentlyRunningInstancesByPod
                );
              if (preTerminateScriptExitStatus !== 0) {
                console.error(
                  "Failed to run pre-terminate script for one or more pods"
                );
                // Continue with swap even if pre-terminate script fails, since it's optional
              }

              const swapStatus = await this.swapContainers(
                release,
                currentlyRunningInstancesByPod[podName],
                [podName]
              );
              if (swapStatus !== 0) {
                // No need to wait for instance refreshes since we know the deploy is a failure
                // TODO: Cancel existing instance refreshes?
                return swapStatus;
              }
            }
          }
          return 0;
        },
        // Pod deploy failure callback
        async (podName) => {
          failedPods.add(podName);
          return 1;
        }
      );

    // Delete ASGs only for pods that deployed successfully
    const deleteAsgsExitStatus = await this.deleteAsgs([
      ...new Set(podNames).difference(failedPods),
    ]);
    if (deleteAsgsExitStatus !== 0) {
      console.error("Failed to clean up one or more old ASGs");
      return deleteAsgsExitStatus;
    }

    // Return whichever exit status is non-zero, otherwise it'll return 0.
    const exitStatus =
      waitInstanceRefreshesExitStatus === 0
        ? waitConsulServiceHealthExitStatus
        : waitInstanceRefreshesExitStatus; // TODO: Should we return 1 if any of these are non-zero?
    if (exitStatus !== 0) {
      console.error("Deploy failed");
    }
    console.log(
      `Deploy completed successfully in ${Math.floor(
        (Date.now() - deployStartTime) / 1000
      )}s`
    );
    return exitStatus;
  }

  private async runPreContainerShutdownScripts(
    podNames: string[],
    currentlyRunningInstancesByPod: Record<string, EC2Instance[]>
  ): Promise<ExitStatus> {
    const preContainerShutdownScriptPromises = podNames
      .filter((podName) => {
        const podConfig = this.config.pods[podName];
        // Only do this for the new Consul-based pods that use autoscaling
        return (
          podConfig.autoscaling &&
          podConfig.deploy.replaceWith === "new-instances" &&
          podConfig.deploy.orchestrator === "consul" &&
          podConfig.preContainerShutdownScript
        );
      })
      .map(async (podName) => {
        const currentlyRunningPodInstances =
          currentlyRunningInstancesByPod[podName];
        if (!currentlyRunningPodInstances?.length) {
          console.warn(
            `No running instances found for pod ${podName}, skipping pre-container-shutdown script`
          );
          return;
        }

        const podConfig = this.config.pods[podName];
        const deleteOldDeployDelay = podConfig.deploy.deleteOldDeployDelay;
        if (deleteOldDeployDelay) {
          console.log(
            `Waiting ${deleteOldDeployDelay} seconds before running pre-container-shutdown script for pod ${podName}`
          );
          await sleep(deleteOldDeployDelay * 1000);
        }

        await withTimeout(
          this.runPreContainerShutdownScript(
            podName,
            currentlyRunningPodInstances
          ),
          60000, // 1 minute timeout
          new Error(
            `Timeout running pre-container-shutdown script for pod ${podName} after 60 seconds`
          )
        );
      });

    const results = await Promise.allSettled(
      preContainerShutdownScriptPromises
    );
    let preContainerShutdownScriptFailed = false;
    for (const result of results) {
      if (result.status === "rejected") {
        preContainerShutdownScriptFailed = true;
        console.error(
          "Failed to run pre-container-shutdown script:",
          result.reason
        );
      }
    }
    return preContainerShutdownScriptFailed ? 1 : 0;
  }

  private async runPreContainerShutdownScript(
    podName: string,
    currentlyRunningInstances: EC2Instance[]
  ) {
    const podConfig = this.config.pods[podName];
    const sshUser = podConfig.sshUser;

    if (!podConfig.preContainerShutdownScript) {
      return;
    }

    const asgClient = this.createAutoScalingClient();

    // If pod is part of ASG, check desired capacity before proceeding
    if (podConfig.autoscaling) {
      const asgResult = await asgClient.describeAutoScalingGroups({
        Filters: [
          {
            Name: "tag:project",
            Values: [this.config.project],
          },
          {
            Name: "tag:pod",
            Values: [podName],
          },
        ],
      });
      if (!asgResult?.AutoScalingGroups?.length) {
        return; // Nothing to do
      }

      // Most recent ASG is the last deploy
      const group = asgResult.AutoScalingGroups?.sort(
        (a, b) =>
          (b.CreatedTime?.getTime() ?? 0) - (a.CreatedTime?.getTime() ?? 0)
      )[0];
      if (group?.DesiredCapacity === 0) {
        console.warn(
          `Desired capacity for ${group.AutoScalingGroupName} is 0. Skipping running of pre-container-shutdown script`
        );
        return;
      }
    }

    let runPreContainerShutdownScriptFailed = false;
    const sshConnectBatchSize = 5; // Don't open too many simultaneous connections at once
    await inBatchesOf(
      currentlyRunningInstances,
      sshConnectBatchSize,
      async (batchOfInstances) => {
        const runBatchResults = await Promise.allSettled(
          batchOfInstances.map(async (instance) => {
            const ip = instance.PrivateIpAddress;
            if (!ip) {
              // Shouldn't happen, but include for type safety
              throw new Error(
                `Instance ${instance.InstanceId} does not have a private IP address`
              );
            }

            console.log(
              `Running pre-container-shutdown script for pod ${podName} on instance ${instance.InstanceId} ${ip}...`
            );
            const connectResult =
              await $`aws-ec2-ssh -T -F/dev/null -oLogLevel=ERROR -oBatchMode=yes -oStrictHostKeyChecking=no ${sshUser}@${ip} bash -s < ${new Response(
                podConfig.preContainerShutdownScript
              )}`;
            console.log(
              `Completed pre-container-shutdown script for pod ${podName} on instance ${instance.InstanceId} ${ip}...`
            );
            if (connectResult.exitCode !== 0) {
              console.error(
                "STDOUT",
                connectResult.stdout.toString(),
                "STDERR",
                connectResult.stderr.toString()
              );
              throw new Error(
                `Error connecting to ${ip} (exit code ${connectResult.exitCode})`
              );
            }
          })
        );

        for (const runResult of runBatchResults) {
          if (runResult.status === "rejected") {
            runPreContainerShutdownScriptFailed = true;
            console.error(
              "Failed to run pre-container-shutdown script:",
              runResult.reason
            );
          }
        }
      }
    );

    if (runPreContainerShutdownScriptFailed) {
      throw new Error(
        `Failed to run pre-container-shutdown script for one or more instances for pod ${podName}`
      );
    }
  }

  private async createAsgs(podNames: string[]): Promise<ExitStatus> {
    const createAsgPromises = podNames
      .filter((podName) => {
        const podConfig = this.config.pods[podName];
        // Only do this for the new Consul-based pods that use autoscaling
        return (
          podConfig.autoscaling &&
          podConfig.deploy.replaceWith === "new-instances" &&
          podConfig.deploy.orchestrator === "consul"
        );
      })
      .map((podName) => this.createAsg(podName));

    const results = await Promise.allSettled(createAsgPromises);
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Failed to create ASG:", result.reason);
        return 1;
      }
    }
    return 0;
  }

  private async createAsg(podName: string) {
    const podConfig = this.config.pods[podName];
    const releaseId = this.options.release as string;
    const fullPodName = `${this.config.project}-${podName}`;

    const asgClient = this.createAutoScalingClient();
    const ec2Client = this.createEC2Client();

    const launchTemplatesResult = await ec2Client.describeLaunchTemplates({
      Filters: [
        {
          Name: "tag:project",
          Values: [this.config.project],
        },
        {
          Name: "tag:pod",
          Values: [podName],
        },
      ],
    });
    const lt = launchTemplatesResult.LaunchTemplates?.[0];
    if (!lt) {
      // Shouldn't happen, but check for type safety
      throw new Error(
        `No launch template found for pod ${podName} -- unable to create ASG`
      );
    }

    const asgResult = await asgClient.describeAutoScalingGroups({
      Filters: [
        {
          Name: "tag:project",
          Values: [this.config.project],
        },
        {
          Name: "tag:pod",
          Values: [podName],
        },
      ],
    });
    // Get the last created ASG, since there might be multiple ASGs due to other/earlier deployments that haven't yet been cleaned up
    const currentAsg = asgResult.AutoScalingGroups?.sort(
      (a, b) =>
        (b.CreatedTime?.getTime() ?? 0) - (a.CreatedTime?.getTime() ?? 0)
    ).filter(
      (asg) =>
        asg.Status ===
        undefined /* Ignore ASGs in the process of being deleted */
    )[0];
    if (!currentAsg) {
      console.log(
        `No existing ASG found for pod ${podName}, creating new one with default min/max/desired capacity`
      );
    }

    const minSize =
      currentAsg?.MinSize ?? podConfig.autoscaling?.minHealthyInstances ?? 1;
    const maxSize =
      currentAsg?.MaxSize ??
      (podConfig.autoscaling?.minHealthyInstances ?? 1) + 1;
    const desiredCapacity = currentAsg?.DesiredCapacity ?? minSize;

    const defaultSubnetIds = podConfig.singleton
      ? undefined
      : podConfig.publicIp
      ? this.config.network?.subnets?.public
      : this.config.network?.subnets?.private;

    const asgName = `${this.config.project}-${podName}-${releaseId}`;
    await asgClient.createAutoScalingGroup({
      AutoScalingGroupName: asgName,
      MinSize: minSize,
      MaxSize: maxSize,
      DesiredCapacity: desiredCapacity,
      HealthCheckType: "EC2",
      HealthCheckGracePeriod:
        this.config.pods[podName]?.autoscaling?.healthCheckGracePeriod,
      DefaultCooldown: 0,
      DefaultInstanceWarmup: 0,
      NewInstancesProtectedFromScaleIn: false,
      VPCZoneIdentifier: defaultSubnetIds?.join(", "),

      InstanceMaintenancePolicy: {
        MinHealthyPercentage: podConfig?.autoscaling?.minHealthyPercentage,
        MaxHealthyPercentage: podConfig?.autoscaling?.maxHealthyPercentage,
      },

      Tags: [
        {
          Key: "project",
          Value: this.config.project,
          PropagateAtLaunch: true,
          ResourceType: "auto-scaling-group",
          ResourceId: `${fullPodName}-${releaseId}`,
        },
        {
          Key: "pod",
          Value: podName,
          PropagateAtLaunch: true,
          ResourceType: "auto-scaling-group",
          ResourceId: `${fullPodName}-${releaseId}`,
        },
        {
          Key: "release",
          Value: releaseId,
          PropagateAtLaunch: true,
          ResourceType: "auto-scaling-group",
          ResourceId: `${fullPodName}-${releaseId}`,
        },
      ],

      MixedInstancesPolicy: {
        InstancesDistribution: {
          OnDemandAllocationStrategy: "prioritized",
          OnDemandBaseCapacity:
            this.config.pods[podName]?.autoscaling?.onDemandBaseCapacity,
          OnDemandPercentageAboveBaseCapacity:
            this.config.pods[podName]?.autoscaling
              ?.onDemandPercentageAboveBaseCapacity,
          SpotAllocationStrategy: "lowest-price",
        },
        LaunchTemplate: {
          LaunchTemplateSpecification: {
            LaunchTemplateName: fullPodName,
            Version: lt.LatestVersionNumber?.toString() ?? "$Latest",
          },
        },
      },
    });

    console.log(`Created ASG ${asgName} for pod ${podName}`);
  }

  private async deleteAsgs(
    podNames: string[],
    newRelease?: boolean
  ): Promise<ExitStatus> {
    const deleteAsgPromises = podNames
      .filter(
        (podName) =>
          this.config.pods[podName].deploy.replaceWith === "new-instances" &&
          this.config.pods[podName].deploy.orchestrator === "consul"
      )
      .map((podName) => this.deleteAsg(podName, newRelease));
    const results = await Promise.allSettled(deleteAsgPromises);
    let deleteAsgFailed = false;
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Failed to delete ASG:", result.reason);
        deleteAsgFailed = true;
      }
    }
    return deleteAsgFailed ? 1 : 0;
  }

  private async deleteAsg(podName: string, newRelease?: boolean) {
    const releaseId = this.options.release as string;
    const asgClient = this.createAutoScalingClient();

    const asgResult = await asgClient.describeAutoScalingGroups({
      Filters: [
        {
          Name: "tag:project",
          Values: [this.config.project],
        },
        {
          Name: "tag:pod",
          Values: [podName],
        },
      ],
    });
    // Get the last created ASG, since there might be multiple ASGs due to other/earlier deployments that haven't yet been cleaned up
    const asgsToDelete = (
      newRelease
        ? asgResult.AutoScalingGroups?.filter(
            (asg) =>
              asg.Tags?.find((tag) => tag.Key === "release")?.Value ===
              releaseId
          )
        : asgResult.AutoScalingGroups?.filter(
            (asg) =>
              asg.Tags?.find((tag) => tag.Key === "release")?.Value !==
              releaseId
          )
    )?.filter(
      (asg) => asg.Status === undefined /* Ignore ASGs already being deleted */
    );
    if (asgsToDelete?.length) {
      const results = await Promise.allSettled(
        asgsToDelete?.map(async (asg) => {
          const podConfig = this.config.pods[podName];
          const deleteOldDeployDelay = podConfig.deploy.deleteOldDeployDelay;
          const preContainerShutdownScript =
            podConfig.preContainerShutdownScript;
          // Don't wait if there's a pre-container-shutdown script since we will have already waited for the shutdown script
          if (
            !newRelease &&
            !preContainerShutdownScript &&
            deleteOldDeployDelay
          ) {
            console.log(
              `Waiting ${deleteOldDeployDelay} seconds before deleting ASG ${asg.AutoScalingGroupName} for pod ${podName}`
            );
            await sleep(deleteOldDeployDelay * 1000);
          }
          console.log(
            `Deleting ASG ${asg.AutoScalingGroupName} for pod ${podName}`
          );
          await asgClient.deleteAutoScalingGroup({
            AutoScalingGroupName: asg.AutoScalingGroupName,
            ForceDelete: true,
          });
        })
      );
      let deleteAsgFailed = false;
      for (const result of results) {
        if (result.status === "rejected") {
          deleteAsgFailed = true;
          console.error("Failed to delete ASG:", result.reason);
        }
      }
      return deleteAsgFailed ? 1 : 0;
    }
    return 0;
  }

  private async rollbackActiveInstanceRefreshes(
    podNames: string[]
  ): Promise<ExitStatus> {
    const asgs = await this.relevantAutoScalingGroupsForRollback(podNames);
    if (!asgs.length) {
      console.log("No applicable ASGs to wait for instance refreshes");
      return 0; // Nothing to do
    }

    const cancelPromises = asgs.map(({ AutoScalingGroupName, Tags }) => {
      const podName = Tags?.findLast((tag) => tag.Key === "pod")?.Value;
      if (!podName) {
        // Shouldn't happen, but check for type safety
        throw new Error(`ASG ${AutoScalingGroupName} does not have a pod tag`);
      }

      return this.rollbackActiveInstanceRefresh(
        AutoScalingGroupName as string,
        podName
      );
    });

    const results = await Promise.allSettled(cancelPromises);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn(
          "Unable to cancel instance refresh due to error:",
          result.reason
        );
      }
    }

    return 0;
  }

  private async rollbackActiveInstanceRefresh(
    asgName: string,
    podName: string
  ) {
    const asg = this.createAutoScalingClient();
    const refreshes =
      (
        await asg.describeInstanceRefreshes({
          AutoScalingGroupName: asgName,
          MaxRecords: 1, // Only need the most recent
        })
      ).InstanceRefreshes || [];
    if (!refreshes.length) {
      return; // No active refreshes
    }

    // Ignore if there are no active refreshes
    const refresh = refreshes[0];
    if (!["Pending", "InProgress"].includes(refresh.Status || "")) return;

    try {
      console.log(`Canceling active instance refresh for ${podName}...`);
      await asg.cancelInstanceRefresh({
        AutoScalingGroupName: asgName,
      });
      console.log(`Canceled active instance refresh for ${podName}`);
    } catch (e: unknown) {
      console.warn(`Unable to cancel instance refresh for ${podName}:`, e);
    }
  }

  private async relevantAutoScalingGroupsForRollback(podNames: string[]) {
    const asg = this.createAutoScalingClient();

    // Fetch all ASGs for the pods we're deploying in chunks to avoid AWS limits
    const asgs: AutoScalingGroup[] = [];
    const maxPodsPerFetch = 5; // AWS limit
    for (let offset = 0; offset < podNames.length; offset += maxPodsPerFetch) {
      const podTagValues: string[] = podNames.slice(
        offset,
        Math.min(offset + maxPodsPerFetch, podNames.length)
      );
      const asgsResult = await asg.describeAutoScalingGroups({
        Filters: [
          {
            Name: "tag:project",
            Values: [this.config.project],
          },
          {
            Name: "tag:pod",
            Values: podTagValues,
          },
        ],
      });
      for (const asg of asgsResult.AutoScalingGroups || []) {
        const podName = asg.Tags?.findLast((tag) => tag.Key === "pod")?.Value;
        if (!podName) {
          // Shouldn't happen due to above filter, but check for type safety
          console.warn(
            `ASG ${asg.AutoScalingGroupName} for ${this.config.project} project does not have a pod tag`
          );
          continue;
        }
        // If autoscaling is configured for this pod, include it. Otherwise it's a singleton
        if (this.config.pods[podName].autoscaling) {
          asgs.push(asg);
        }
      }
    }

    return asgs;
  }

  private async relevantAutoScalingGroups(podNames: string[]) {
    const asg = this.createAutoScalingClient();

    // Fetch all ASGs for the pods we're deploying in chunks to avoid AWS limits
    const asgs: AutoScalingGroup[] = [];
    const maxPodsPerFetch = 5; // AWS limit
    for (let offset = 0; offset < podNames.length; offset += maxPodsPerFetch) {
      const podTagValues: string[] = podNames.slice(
        offset,
        Math.min(offset + maxPodsPerFetch, podNames.length)
      );
      const asgsResult = await asg.describeAutoScalingGroups({
        Filters: [
          {
            Name: "tag:project",
            Values: [this.config.project],
          },
          {
            Name: "tag:pod",
            Values: podTagValues,
          },
        ],
      });
      for (const asg of asgsResult.AutoScalingGroups || []) {
        const podName = asg.Tags?.findLast((tag) => tag.Key === "pod")?.Value;
        if (!podName) {
          // Shouldn't happen due to above filter, but check for type safety
          console.warn(
            `ASG ${asg.AutoScalingGroupName} for ${this.config.project} project does not have a pod tag`
          );
          continue;
        }
        // If autoscaling is configured for this pod, include it. Otherwise it's a singleton
        if (
          this.config.pods[podName].autoscaling &&
          this.config.pods[podName].deploy.orchestrator !== "consul"
        ) {
          asgs.push(asg);
        }
      }
    }

    return asgs;
  }

  private async getDesiredInstanceCountForPod(
    asgClient: AutoScaling,
    podName: string
  ): Promise<number> {
    const asgsResult = await asgClient.describeAutoScalingGroups({
      Filters: [
        {
          Name: "tag:project",
          Values: [this.config.project],
        },
        {
          Name: "tag:pod",
          Values: [podName],
        },
      ],
    });
    const asg = asgsResult.AutoScalingGroups?.sort(
      (a, b) =>
        (b.CreatedTime?.getTime() ?? 0) - (a.CreatedTime?.getTime() ?? 0)
    )?.[0];
    return (
      asg?.DesiredCapacity ??
      this.config.pods[podName].autoscaling?.minHealthyInstances ??
      1
    );
  }

  private async waitForConsulServiceHealthChecks(
    podNames: string[],
    releaseId: string,
    onSuccess: (podName: string) => Promise<ExitStatus>,
    onFailure: (podName: string) => Promise<ExitStatus>
  ): Promise<ExitStatus> {
    const relevantPodsWithConsulHealthChecks = Object.entries(
      this.config.pods
    ).filter(
      ([podName, podConfig]) =>
        podNames.includes(podName) && podConfig.deploy.orchestrator === "consul"
    );
    if (!relevantPodsWithConsulHealthChecks.length) {
      return 0; // Nothing to do
    }

    console.log(
      `Waiting for Consul service health checks for pods ${relevantPodsWithConsulHealthChecks
        .map(([podName]) => podName)
        .join(", ")}...`
    );

    const ec2Client = this.createEC2Client();
    const instancesResult = await ec2Client.describeInstances({
      Filters: [
        {
          Name: "tag:ConsulServer",
          Values: ["true"],
        },
        {
          Name: "instance-state-name",
          Values: ["running"],
        },
      ],
    });
    const consulServerIps =
      instancesResult.Reservations?.flatMap((reservation) =>
        reservation.Instances?.map((instance) => instance.PrivateIpAddress)
      ).filter((ip) => ip !== undefined) || [];
    if (!consulServerIps.length) {
      throw new Error("No Consul servers found");
    }
    const consulHost = `https://${consulServerIps[0]}:8501`; // TODO: Make this configurable (need a HTTPS load balancer)
    const serviceTag = releaseId;

    const startTime = Date.now();
    const asgClient = this.createAutoScalingClient();
    const results = await Promise.allSettled(
      relevantPodsWithConsulHealthChecks.map(async ([podName, podConfig]) => {
        const serviceName = podConfig.deploy.healthCheckService;
        if (!serviceName) {
          // Shouldn't happen, but check for type safety
          throw new Error(
            `Pod ${podName} has no health check service name configured`
          );
        }

        const healthCheckUrl = new URL(
          `${consulHost}/v1/health/service/${serviceName}`
        );
        healthCheckUrl.searchParams.append("passing", "true");
        healthCheckUrl.searchParams.append(
          "filter",
          `"${serviceTag}" in Service.Tags`
        );

        const deployTimeoutMs =
          (this.config.pods[podName].deploy.timeout ?? 600) * 1000; // Default to 10 minutes if not specified
        while (Date.now() - startTime < deployTimeoutMs) {
          process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"; // TODO: allow configuring cert chain
          const healthCheckResult = await fetch(healthCheckUrl.toString());
          delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
          if (!healthCheckResult.ok) {
            console.error(
              `Failed to check health of ${serviceName} service: ${healthCheckResult.status} - ${healthCheckResult.statusText}`
            );
            // Fall through to try again. If this keeps failing, deploy will eventually time out.
            // What we don't want is to fail the deploy immediately in case this was a transient issue.
          } else {
            const healthCheckData = await healthCheckResult.json();
            if (Array.isArray(healthCheckData)) {
              // We re-check desired instance count since it may have changed manually in the AWS console since the deploy started
              const desiredInstanceCount =
                await this.getDesiredInstanceCountForPod(asgClient, podName);

              if (healthCheckData.length >= desiredInstanceCount) {
                console.log(
                  `Pod ${podName} Consul service [${serviceName}] health checks passed`
                );
                await onSuccess(podName); // Make sure we call pre-shutdown hooks BEFORE deleting the old ASG
                await this.deleteAsgs([podName]); // Immediately clean up the old ASG to reduce open connections to the backend
                return;
              }

              console.log(
                `Waiting for pod ${podName} Consul service [${serviceName}] health checks: ${healthCheckData.length} / ${desiredInstanceCount}`
              );
            } else {
              throw new Error(
                `Unexpected Consul service health check response: ${JSON.stringify(
                  healthCheckData
                )}`
              );
            }
          }

          await sleep(5_000);
        }

        console.error(
          `Waiting for Consul service health checks for pod ${podName} timed out after ${deployTimeoutMs}ms. Tearing down new ASG`
        );
        await this.deleteAsgs([podName], true); // Clean up only the new ASG
        await onFailure(podName);

        throw new Error(
          `Waiting for Consul service health checks for pod ${podName} took longer than ${deployTimeoutMs}ms`
        );
      })
    );

    let deployFailed = false;
    for (const result of results) {
      if (result.status === "rejected") {
        deployFailed = true;
        console.error(result.reason);
      }
    }

    if (deployFailed) {
      console.error(
        "One or more pods failed to pass their Consul service health checks"
      );
      return 1;
    }

    console.log("All Consul service health checks passed");
    return 0;
  }

  private async waitForInstanceRefreshes(
    podNames: string[]
  ): Promise<ExitStatus> {
    // Fetch all ASGs for the pods we're deploying in chunks to avoid AWS limits
    const asgs = await this.relevantAutoScalingGroups(podNames);
    if (!asgs.length) {
      console.log("No applicable ASGs to wait for instance refreshes");
      return 0; // Nothing to do
    }

    console.log(
      `Waiting for ASGs ${podNames.join(",")} to finish instance refresh...`
    );

    const deployPromises = asgs.map(({ AutoScalingGroupName, Tags }) => {
      const podName = Tags?.findLast((tag) => tag.Key === "pod")?.Value;
      if (!podName) {
        // Shouldn't happen, but check for type safety
        throw new Error(`ASG ${AutoScalingGroupName} does not have a pod tag`);
      }

      return this.waitForInstanceRefresh(
        AutoScalingGroupName as string,
        podName,
        (this.config.pods[podName].deploy?.instanceRefreshTimeout || 600) * 1000
      );
    });

    const results = await Promise.allSettled(deployPromises);
    let deployFailed = false;
    for (const result of results) {
      if (result.status === "rejected") {
        deployFailed = true;
        console.error(result.reason);
      }
    }

    if (deployFailed) {
      const errMsg = "One or more ASGs failed to deploy";
      console.error(errMsg);
      return 1;
    }

    console.log("Instance refreshes completed");
    return 0;
  }

  private async waitForInstanceRefresh(
    asgName: string,
    podName: string,
    timeoutMillis: number
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abortController = new AbortController();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const errMsg = `Waiting for instance refresh to complete on ASG ${asgName} timed out after ${timeoutMillis}ms`;
        const err = new Error(errMsg);
        console.error(errMsg);
        abortController.abort(err);
        reject(err);
      }, timeoutMillis);
    });

    return Promise.race([
      timeoutPromise,
      (async () => {
        const asg = this.createAutoScalingClient();
        const refreshes =
          (
            await asg.describeInstanceRefreshes({
              AutoScalingGroupName: asgName,
              MaxRecords: 1, // Only need the most recent
            })
          ).InstanceRefreshes || [];
        if (!refreshes.length) {
          return; // No active refreshes triggered
        }

        // Remember refresh ID so we always monitor the
        // same refresh (in case of multiple deploys)
        const refreshId = refreshes[0].InstanceRefreshId as string;

        while (!abortController.signal.aborted) {
          const refreshes =
            (
              await asg.describeInstanceRefreshes({
                InstanceRefreshIds: [refreshId],
                AutoScalingGroupName: asgName,
                MaxRecords: 1,
              })
            ).InstanceRefreshes || [];

          if (!refreshes.length) {
            // Shouldn't happen, but include for type safety
            const errMsg = `No instance refresh found for refresh ID ${refreshId} for ASG ${asgName}`;
            console.error(errMsg);
            throw new Error(errMsg);
          }

          const [refresh] = refreshes;
          console.log(
            `${podName}: ${refresh.Status} - ${
              refresh.PercentageComplete ?? "?"
            }% - Instances remaining: ${refresh.InstancesToUpdate ?? "?"}. ${
              refresh.StatusReason || "..."
            }`
          );
          if (refresh.Status === "Successful") {
            console.log(`Pod ${podName} deploy completed successfully`);
            return;
          }
          if (refresh.Status === "RollbackSuccessful") {
            const errMsg = `Pod ${podName} deploy rolled back! ${refresh.StatusReason}`;
            console.error(errMsg);
            throw new Error(errMsg);
          }
          if (refresh.Status === "RollbackFailed") {
            const errMsg = `Pod ${podName} deploy failed, and the rollback also failed! ${refresh.StatusReason}`;
            console.error(errMsg);
            throw new Error(errMsg);
          }
          if (refresh.Status === "Failed") {
            const errMsg = `Pod ${podName} deploy failed! ${refresh.StatusReason}`;
            console.error(errMsg);
            throw new Error(errMsg);
          }
          if (refresh.Status === "Cancelled") {
            const errMsg = `Pod ${podName} deploy canceled! Was another deploy initiated? ${refresh.StatusReason}`;
            console.error(errMsg);
            throw new Error(errMsg);
          }

          await sleep(5_000);
        }

        clearTimeout(timeout);
      })(),
    ]);
  }

  private async swapContainers(
    releaseId: string,
    alreadyRunningInstances: EC2Instance[],
    podsToDeploy: string[]
  ): Promise<ExitStatus> {
    const ec2 = this.createEC2Client();
    const asg = this.createAutoScalingClient();
    const instancesForPod: Record<string, EC2Instance[]> = {};

    let updateFailed = false;
    const updateResults = await Promise.allSettled(
      Object.entries(this.config.pods).map(async ([podName, podOptions]) => {
        if (podsToDeploy.length > 0 && !podsToDeploy.includes(podName)) {
          return; // Skip pod
        }

        if (podOptions.deploy.replaceWith !== "new-containers") {
          return; // Nothing to do
        }

        // If pod is part of ASG, check desired capacity before proceeding
        if (podOptions.autoscaling) {
          const asgResult = await asg.describeAutoScalingGroups({
            Filters: [
              {
                Name: "tag:project",
                Values: [this.config.project],
              },
              {
                Name: "tag:pod",
                Values: [podName],
              },
            ],
          });
          if (!asgResult?.AutoScalingGroups?.length) {
            // Shouldn't happen, but include for type safety
            throw new Error(`No ASG found for pod ${podName}`);
          }
          const group = asgResult.AutoScalingGroups[0];

          if (group?.DesiredCapacity === 0) {
            console.warn(
              `Desired capacity for ${group.AutoScalingGroupName} is 0. Skipping`
            );
            return;
          }
        }

        const alreadyRunningPodInstances = alreadyRunningInstances.filter(
          (instance) => {
            const instancePod = instance.Tags?.findLast(
              (tag) => tag.Key === "pod"
            )?.Value;
            return instancePod === podName;
          }
        );

        if (!alreadyRunningPodInstances?.length) {
          if (podOptions.singleton) {
            console.error(
              `No existing instances found for pod ${podName}, but desired capacity is > 0. Canceling deploy.`
            );
            throw new Error(
              `No existing instances found for pod ${podName}, but desired capacity is > 0`
            );
          }
          return; // No instances to swap containers on
        }

        // Remember for later
        instancesForPod[podName] = alreadyRunningPodInstances;

        const composeContents = readFileSync(podOptions.compose).toString();
        const pullInstanceBatchSize = 5; // Constrain number of outbound connections
        await inBatchesOf(
          alreadyRunningPodInstances,
          pullInstanceBatchSize,
          async (batch) => {
            const pullResults = await Promise.allSettled(
              batch.map(async ({ PrivateIpAddress: ip }) => {
                const startTime = Date.now();
                while (Date.now() - startTime < 120_000) {
                  try {
                    const { sshUser } = podOptions;

                    console.log(
                      `About to pull new containers for pod ${podName} on ${sshUser}@${ip}...`
                    );

                    const scriptInput = new Response(`
                      ${generateDeployScript(
                        this.config.project,
                        podName,
                        podOptions,
                        releaseId,
                        composeContents,
                        this.allowedPodSecrets(podName)
                      )}
                    `);
                    const connectResult =
                      await $`aws-ec2-ssh -T -F/dev/null -oLogLevel=ERROR -oBatchMode=yes -oStrictHostKeyChecking=no ${sshUser}@${ip} bash -s < ${scriptInput}`;
                    if (connectResult.exitCode !== 0) {
                      console.error(
                        "STDOUT",
                        connectResult.stdout.toString(),
                        "STDERR",
                        connectResult.stderr.toString()
                      );
                      throw new Error(
                        `Error connecting to ${ip} (exit code ${connectResult.exitCode})`
                      );
                    }

                    break; // Otherwise we were successful
                  } catch (e: unknown) {
                    if (Date.now() - startTime > 120_000) {
                      const searchResult = await ec2.describeInstances({
                        Filters: [
                          {
                            Name: "ip-address",
                            Values: [ip || ""],
                          },
                          {
                            Name: "instance-state-name",
                            Values: ["running"],
                          },
                        ],
                      });
                      if (
                        searchResult.Reservations?.at(0)?.Instances?.at(0)
                          ?.PrivateIpAddress === ip
                      ) {
                        console.error(
                          `Unable to connect to ${ip} after 2 minutes.`
                        );
                        throw e;
                      } else {
                        // Ignore instances that no longer exist -- they might have died naturally
                        // or by someone manually terminating
                        break;
                      }
                    }
                    console.error(
                      `Unable to connect to ${ip}. Retrying in 5 seconds...`,
                      e
                    );
                    await sleep(5000);
                  }
                }
              })
            );
            for (const result of pullResults) {
              if (result.status === "rejected") {
                updateFailed = true;
                console.error(result.reason);
              }
            }
          }
        );
      })
    );

    const failReasons: unknown[] = [];
    for (const result of updateResults) {
      if (result.status === "rejected") {
        updateFailed = true;
        failReasons.push(result.reason);
        console.error(result.reason);
      }
    }
    if (updateFailed) {
      console.error(
        "One or more pods failed to download/start the latest images specified in their respective Docker Compose file(s). Aborting deploy."
      );
      console.error(failReasons);
      return 1;
    }

    // Swap all instances to start using the new containers
    let deployFailed = false;
    const swapResults = await Promise.allSettled(
      Object.entries(this.config.pods).map(async ([podName, podOptions]) => {
        if (podsToDeploy.length > 0 && !podsToDeploy.includes(podName)) return; // Skip pod

        if (podOptions.deploy.replaceWith !== "new-containers") {
          return; // Nothing to do
        }

        let asgName = "...";
        if (podOptions.autoscaling) {
          const asgResult = await asg.describeAutoScalingGroups({
            Filters: [
              {
                Name: "tag:project",
                Values: [this.config.project],
              },
              {
                Name: "tag:pod",
                Values: [podName],
              },
            ],
          });
          if (!asgResult?.AutoScalingGroups?.length) {
            // Shouldn't happen, but include for type safety
            throw new Error(`No ASG found for pod ${podName}`);
          }
          asgName = asgResult.AutoScalingGroups[0]
            .AutoScalingGroupName as string;

          // Make sure all instances are in-service (in case a prior deploy failed)
          const instanceIds = instancesForPod[podName].map(
            (i) => i.InstanceId as string
          );

          const asgInstances = await asg.describeAutoScalingInstances({
            InstanceIds: instanceIds,
          });

          const instancesInStandby =
            asgInstances.AutoScalingInstances?.filter(
              (instance) => instance.LifecycleState === LifecycleState.STANDBY
            ).map((instance) => instance.InstanceId as string) || [];
          if (instancesInStandby.length) {
            await asg.exitStandby({
              AutoScalingGroupName: asgName,
              InstanceIds: instancesInStandby,
            });

            const exitStandbyStartTime = Date.now();
            for (;;) {
              const allInstances = await asg.describeAutoScalingInstances({
                InstanceIds: instanceIds,
              });
              const allInstanceDetails =
                allInstances.AutoScalingInstances || [];
              if (
                allInstanceDetails.every(
                  (i) => i.LifecycleState === LifecycleState.IN_SERVICE
                )
              ) {
                break;
              }
              if (Date.now() - exitStandbyStartTime > 180_000) {
                throw new Error(
                  `Standby Instances [${instancesInStandby.join(
                    ", "
                  )}] did not exit Standby state within 180 seconds.`
                );
              }
              console.info(
                `Waiting for instances [${instancesInStandby.join(
                  ", "
                )}] to exit Standby state...`
              );
              await sleep(5_000);
            }
          }
        }

        const { sshUser } = podOptions;
        const instanceSwapBatchSize = 5;
        await inBatchesOf(
          instancesForPod[podName],
          instanceSwapBatchSize,
          async (batch) => {
            const results = await Promise.allSettled(
              batch.map(
                async ({ PrivateIpAddress: ip, InstanceId: instanceId }) => {
                  if (
                    podOptions.autoscaling &&
                    podOptions.deploy.detachBeforeContainerSwap
                  ) {
                    // Detach from ASG so that traffic from LB is not sent to the instance
                    // Stop sending load balancer traffic to instance
                    await asg.enterStandby({
                      AutoScalingGroupName: asgName,
                      ShouldDecrementDesiredCapacity: true,
                      InstanceIds: [instanceId as string],
                    });

                    const beginTime = Date.now();
                    for (;;) {
                      const standbyInstances =
                        await asg.describeAutoScalingInstances({
                          InstanceIds: [instanceId as string],
                        });
                      const standbyDetails =
                        standbyInstances.AutoScalingInstances || [];
                      if (
                        standbyDetails.every(
                          (i) => i.LifecycleState === LifecycleState.STANDBY
                        )
                      ) {
                        break;
                      }
                      if (Date.now() - beginTime > 180_000) {
                        throw new Error(
                          `Pod ${podName} instance ${instanceId} (${ip}) did not enter Standby state within 180 seconds.`
                        );
                      }
                      console.info(
                        `Waiting for pod ${podName} instance ${instanceId} (${ip}) to enter Standby state...`
                      );
                      await sleep(10_000);
                    }
                  }

                  console.log(
                    `About to swap pod ${podName} containers on ${sshUser}@${ip}`
                  );

                  const scriptInput = new Response(
                    `# Execute these commands on the remote server in a Bash shell
    set -e -o pipefail

    # Stop the current release if there is one
    echo "Stopping containers on pod ${podName} instance ${instanceId} ${ip} for current release $(cat /home/${sshUser}/releases/current)"
    if [ -f /home/${sshUser}/releases/current ] && [ -d "$(cat /home/${sshUser}/releases/current)" ]; then
      cd "$(cat /home/${sshUser}/releases/current)"
    fi
    # Stop all pod containers if any are running
    docker ps --quiet --all | xargs --no-run-if-empty docker stop --time ${podOptions.deploy.shutdownTimeout}
    docker ps --quiet --all | xargs --no-run-if-empty docker rm --force --volumes
    if [ -f docker-compose.yml ]; then
      # Also remove any networks
      docker compose down --volumes --timeout ${podOptions.deploy.shutdownTimeout} # Blocks until finished or timed out
    fi

    new_release_dir="/home/${sshUser}/releases/${releaseId}"
    cd "$new_release_dir"

    # Update "current" location to point to the new release
    echo "$new_release_dir" > /home/${sshUser}/releases/current

    # Update tags so we know which release this instance is currently on
    aws ec2 create-tags --tags "Key=release,Value=${releaseId}" "Key=Name,Value=${this.config.project}-${podName}-${releaseId}" --resource "\$(cat /etc/instance-id)"

    # Start up all pod containers
    echo "Starting new containers for pod ${podName} on ${instanceId} ${ip} for release ${releaseId}"
    COMPOSE_PROFILES="${podName}" docker compose up --detach --quiet-pull --pull=missing

    # Delete old images + containers
    docker system prune --force

    # Clean up old releases
    echo "Deleting old release directories for pod ${podName} on ${instanceId} ${ip}"
    cd /home/${sshUser}
    ls -I current releases | sort | head -n -${MAX_RELEASES_TO_KEEP} | xargs --no-run-if-empty -I{} rm -rf releases/{}`
                  );

                  // Swap the containers
                  const connectResult =
                    await $`aws-ec2-ssh -T -F/dev/null -oLogLevel=ERROR -oBatchMode=yes -oStrictHostKeyChecking=no ${sshUser}@${ip} bash -s < ${scriptInput}`;
                  if (connectResult.exitCode !== 0) {
                    console.error(
                      "STDOUT",
                      connectResult.stdout.toString(),
                      "STDERR",
                      connectResult.stderr.toString()
                    );
                    throw new Error(
                      `Error connecting to ${ip} (exit code ${connectResult.exitCode})`
                    );
                  }

                  if (podOptions.deploy.detachBeforeContainerSwap) {
                    console.log(
                      `Moving pod ${podName} instance ${instanceId} ${ip} in ASG ${asgName} back to InService`
                    );
                    // Re-attach to ASG so we start receiving traffic again
                    await asg.exitStandby({
                      AutoScalingGroupName: asgName,
                      InstanceIds: [instanceId as string],
                    });
                  }

                  if (podOptions.autoscaling) {
                    const latestVersions = (
                      await ec2.describeLaunchTemplateVersions({
                        LaunchTemplateName: `${this.config.project}-${podName}`,
                        MaxResults: 1,
                      })
                    )?.LaunchTemplateVersions;
                    if (!latestVersions?.length) {
                      // Shouldn't happen, but include for type safety
                      throw new Error(
                        `No launch template versions found for ASG ${asgName}`
                      );
                    }

                    const latestVersion = latestVersions[0].VersionNumber;

                    // Manually update the launch template version, since if we do this with Terraform
                    // it causes an instance refresh which we want to avoid when swapping containers
                    await asg.updateAutoScalingGroup({
                      AutoScalingGroupName: asgName,
                      LaunchTemplate: {
                        LaunchTemplateName: `${this.config.project}-${podName}`,
                        Version: latestVersion?.toString(),
                      },
                    });
                  }
                }
              )
            );
            for (const result of results) {
              if (result.status === "rejected") {
                deployFailed = true;
                console.error(result.reason);
              }
            }
          }
        );
      })
    );

    const swapFailures: unknown[] = [];
    for (const result of swapResults) {
      if (result.status === "rejected") {
        deployFailed = true;
        swapFailures.push(result.reason);
        console.error(result.reason);
      }
    }
    if (deployFailed) {
      console.error(
        "One or more pods failed to start up the latest containers. Aborting deploy."
      );
      console.error(swapFailures);
      return 1;
    }

    return 0;
  }

  public async destroy(stacks: string[]): Promise<ExitStatus> {
    const stackIds = stacks.length
      ? this.normalizeStackIds(stacks)
      : this.getAllStackIds();
    console.info("Destroying stacks:", stackIds);

    // Need to kick off ASG deletion before Terrafrom destroy since otherwise it will block waiting on the instances to be terminated
    const podNames = this.extractPodNames(stackIds);
    const deleteAsgsExitStatus = await this.deleteAsgs(podNames);
    if (deleteAsgsExitStatus !== 0) {
      console.error(
        "Failed to clean up one or more ASGs before destroying stacks"
      );
      return deleteAsgsExitStatus;
    }

    const child = await this.runCommand(
      [
        "bunx",
        "cdktf",
        "destroy",
        ...(this.options.yes ? ["--auto-approve"] : []),
        ...stackIds,
      ],
      { env: { ...process.env, ...TF_ENVARS } }
    );
    return child.exited;
  }

  public async unlock(stacks: string[]): Promise<ExitStatus> {
    const stackIds = stacks.length
      ? this.normalizeStackIds(stacks)
      : this.getAllStackIds();
    console.info("Unlocking stacks:", stackIds);

    const failures: unknown[] = [];
    for (const stackId of stackIds) {
      const dynamo = this.createDynamoDBClient();
      try {
        await dynamo.deleteItem({
          TableName: "warpcast-terraform-locks",
          Key: {
            LockID: { S: `warpcast-terraform-state/${stackId}-state.tfstate` },
          },
        });
        await dynamo.deleteItem({
          TableName: "warpcast-terraform-locks",
          Key: {
            LockID: {
              S: `warpcast-terraform-state/${stackId}-state.tfstate-md5`,
            },
          },
        });
      } catch (e: unknown) {
        failures.push(e);
      }
    }
    if (failures.length) {
      console.error("One or more stacks failed to unlock:", failures);
      return 1;
    }

    return 0;
  }

  public async lint(): Promise<ExitStatus> {
    // By the time we reach here the configuration has already been validated
    console.info(`Stack configuration '${this.options.config}' is valid`);
    return 0;
  }

  public async console(pod: string): Promise<ExitStatus> {
    if (pod && !this.config.pods[pod]) {
      console.error(`Stack does not have a pod named ${pod}`);
      return 1;
    }

    const ec2 = this.createEC2Client();
    const result = await ec2.describeInstances({
      Filters: [
        {
          Name: "tag:project",
          Values: [this.config.project],
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

    const instances =
      result.Reservations?.flatMap(
        (reservation) => reservation.Instances || []
      ) || [];
    if (instances.length === 0) {
      if (pod) {
        console.error(`No running instances found for pod ${pod}`);
      } else {
        console.error("No running instances found in this stack");
      }
      return 1;
    }

    if (instances.length === 1) {
      const instancePod = instances[0].Tags?.findLast(
        (tag) => tag.Key === "pod"
      )?.Value;

      if (!instancePod) {
        throw new Error(
          `Unable to determine pod for instance ${instances[0].InstanceId}`
        );
      }
      const { sshUser } = this.config.pods[instancePod];
      // Only one to chose from, so select automatically
      return this.sshInto(sshUser, instances[0].PrivateIpAddress as string);
    }

    const candidates: string[] = [];
    for (const instance of instances) {
      const instancePod = instance.Tags?.findLast(
        (tag) => tag.Key === "pod"
      )?.Value;
      const release = instance.Tags?.findLast(
        (tag) => tag.Key === "release"
      )?.Value;
      if (!instancePod || !release) continue;
      candidates.push(
        [
          instance.InstanceId?.padEnd(20, " "),
          instance.PrivateIpAddress?.padEnd(16, " "),
          release.padEnd(25, " "),
          instancePod.padEnd(25, " ").slice(0, 25),
        ].join(" ")
      );
    }

    const fzf = await $`fzf --height=~10 < ${new Response(
      candidates.join("\n")
    )}`;

    const choice = fzf.stdout.toString().trim();
    if (fzf.exitCode === 0) {
      const [instanceId, privateIp, , pod] = choice.split(/\s+/);
      console.info(
        `Connecting to pod ${pod} (${instanceId}) at ${privateIp}...`
      );
      const { sshUser } = this.config.pods[pod];
      return this.sshInto(sshUser, privateIp);
    } else {
      console.error("No instance selected");
      return 1;
    }
  }

  private async alreadyRunningInstancesByPod(
    pods: string[]
  ): Promise<Record<string, EC2Instance[]>> {
    const ec2 = this.createEC2Client();
    const maxAsgPodSearchBatch = 5; // Limit imposed by AWS API

    const instancesByPod: Record<string, EC2Instance[]> = {};
    await inBatchesOf(pods, maxAsgPodSearchBatch, async (podNameBatch) => {
      const result = await ec2.describeInstances({
        Filters: [
          {
            Name: "tag:project",
            Values: [this.config.project],
          },
          {
            Name: "tag:pod",
            Values: podNameBatch,
          },
          {
            Name: "instance-state-name",
            Values: ["running"],
          },
        ],
      });

      const instances =
        result.Reservations?.flatMap(
          (reservation) => reservation.Instances || []
        ) || [];

      for (const instance of instances) {
        const instanceReleaseTag = instance.Tags?.findLast(
          (tag) => tag.Key === "release"
        )?.Value;
        if (!instanceReleaseTag) {
          // Shouldn't happen, but include for type safety
          throw new Error(
            `Instance ${instance.InstanceId} does not have a "release" tag with any value`
          );
        }
        if (instanceReleaseTag === this.options.release) {
          continue; // Skip instances that are running the latest release
        }

        const instancePodTag = instance.Tags?.findLast(
          (tag) => tag.Key === "pod"
        )?.Value;
        if (!instancePodTag) {
          // Shouldn't happen, but include for type safety
          throw new Error(
            `Instance ${instance.InstanceId} does not have a "pod" tag with any value`
          );
        }

        instancesByPod[instancePodTag] ||= [];
        instancesByPod[instancePodTag].push(instance);
      }
    });

    return instancesByPod;
  }

  private async alreadyRunningInstances(pods: string[]) {
    const ec2 = this.createEC2Client();
    const result = await ec2.describeInstances({
      Filters: [
        {
          Name: "tag:project",
          Values: [this.config.project],
        },
        {
          Name: "tag:pod",
          Values: pods,
        },
        {
          Name: "instance-state-name",
          Values: ["running"],
        },
      ],
    });

    const instances = result.Reservations?.flatMap(
      (reservation) => reservation.Instances || []
    );

    return instances || [];
  }

  private async sshInto(sshUser: string, host: string): Promise<ExitStatus> {
    const sshResult = Bun.spawnSync(
      [
        "aws-ec2-ssh",
        ...(this.options.yes ? ["-oBatchMode=yes"] : []),
        "-oLogLevel=ERROR",
        // Gets really annoying to have to clear your known hosts file
        // all the time, so don't bother with host key checking
        "-oStrictHostKeyChecking=no",
        "-oUserKnownHostsFile=/dev/null",
        `${sshUser}@${host}`,
      ],
      {
        stdio: ["inherit", "inherit", "inherit"],
      }
    );
    return sshResult.exitCode;
  }

  // Internal use only. Exposed for CDKTF interoperability
  public async _synth() {
    const app = new CdkApp();

    const secretsClient = this.createSecretsManagerClient();
    let secrets: SecretListEntry[] = [];
    let nextToken;
    for (;;) {
      const {
        SecretList,
        NextToken,
      }: { SecretList?: SecretListEntry[]; NextToken?: string } =
        await secretsClient.send(
          new ListSecretsCommand({ MaxResults: 100, NextToken: nextToken })
        );
      secrets = [...secrets, ...(SecretList || [])];
      nextToken = NextToken;
      if (!nextToken) break;
    }
    const secretNames = new Set(secrets.map((s) => s.Name as string));

    let secretsMissing = 0;
    for (const [secretName, _secretConfig] of Object.entries(
      this.config.secrets || {}
    )) {
      if (!secretNames.has(secretName)) {
        secretsMissing += 1;
        console.error(`Secret ${secretName} does not exist in Secrets Manager`);
      }
    }
    if (secretsMissing) {
      console.error(
        `${secretsMissing} referenced secret${
          secretsMissing === 1 ? "" : "s"
        } missing from Secrets Manager`
      );
    }

    // TODO: Ensure secrets are referenced in each pod

    // Create separate state file for each pod so we can deploy/update them independently if desired
    // (this would otherwise be very difficult to do with Terraform's -target flag)
    //
    // This has the added benefit of speeding up the deploy for large applications when only a single
    // pod was modified.
    for (const [podName, podOptions] of Object.entries(this.config.pods)) {
      let currentAsg = undefined;
      if (
        podOptions.deploy.replaceWith === "new-instances" &&
        podOptions.deploy.orchestrator === "consul"
      ) {
        // Use the previously existing ASG's min/max/desired capacity
        const asgClient = this.createAutoScalingClient();
        const asgResult = await asgClient.describeAutoScalingGroups({
          Filters: [
            {
              Name: "tag:project",
              Values: [this.config.project],
            },
            {
              Name: "tag:pod",
              Values: [podName],
            },
          ],
        });
        const asg = asgResult.AutoScalingGroups?.sort(
          (a, b) =>
            (b.CreatedTime?.getTime() ?? 0) - (a.CreatedTime?.getTime() ?? 0)
        )[0];
        currentAsg = {
          minSize: asg?.MinSize ?? 1,
          maxSize: asg?.MaxSize ?? 2,
          desiredCapacity: asg?.DesiredCapacity ?? 1,
        };
      }

      new PodStack(app, `${this.config.project}-pod-${podName}`, {
        releaseId: this.options.release as string,
        project: this.config.project,
        shortName: podName,
        region: this.config.region,
        vpcId: this.config.network.id,
        defaultSubnetIds: podOptions.singleton
          ? undefined
          : podOptions.publicIp
          ? this.config.network?.subnets?.public
          : this.config.network?.subnets?.private,
        publicSubnets: this.config.network?.subnets?.public,
        privateSubnets: this.config.network?.subnets?.private,
        secretMappings: this.allowedPodSecrets(podName),
        podOptions,
        currentAsg,
      });
    }
    app.synth();

    return 0;
  }

  private async runCommand(
    command: string[],
    options: Parameters<typeof Bun.spawn>[1] = {}
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
    const allowedSecrets: Record<string, string> = {};
    for (const [secretName, secretOptions] of Object.entries(
      this.config.secrets || {}
    )) {
      // If undefined, assume all pods are included
      const podsToInclude =
        secretOptions?.pods === null || secretOptions?.pods === undefined
          ? Object.keys(this.config.pods)
          : secretOptions.pods;
      if (
        Array.isArray(podsToInclude) &&
        podsToInclude.length &&
        podsToInclude.includes(podName)
      ) {
        // Map to the same name, or rename if "as" is provided
        allowedSecrets[secretName] = secretOptions?.as
          ? secretOptions?.as
          : secretName;
      }
    }
    return allowedSecrets;
  }

  private createCdktfJson() {
    writeFileSync(
      "./cdktf.json",
      JSON.stringify({
        app: `bun ${this.cliPath} --config ${this.options.config} _cdktf-synth`,
        language: "typescript",
      })
    );
  }

  private getAllStackIds() {
    const stackIds = Object.keys(this.config.pods || {}).map(
      (podName) => `${this.config.project}-pod-${podName}`
    );
    return stackIds;
  }

  private normalizeStackIds(stacks: string[]) {
    return stacks.map((stackId) => {
      if (stackId.startsWith(`${this.config.project}-`)) {
        return stackId.replace(":", "-").replace("=", "-");
      }
      return `${this.config.project}-${stackId
        .replace(":", "-")
        .replace("=", "-")}`;
    });
  }

  private extractPodNames(stacks: string[]) {
    const podStackIdPrefix = `${this.config.project}-pod-`;
    return this.normalizeStackIds(stacks)
      .filter((stackId) => stackId.startsWith(podStackIdPrefix))
      .map((stackId) =>
        stackId.replace(new RegExp(`^${podStackIdPrefix}`), "")
      );
  }
}
