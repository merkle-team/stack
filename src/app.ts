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
} from "./util";
import {
  AutoScaling,
  AutoScalingGroup,
  LifecycleState,
} from "@aws-sdk/client-auto-scaling";
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { PodStack } from "./stacks/PodStack";
import { execa } from "execa";
import {
  ListSecretsCommand,
  SecretListEntry,
  SecretsManager,
} from "@aws-sdk/client-secrets-manager";

const MAX_RELEASES_TO_KEEP = 10;
const TF_ENVARS = { TF_IN_AUTOMATION: "1" };

type ExitStatus = number;

export class App {
  private config: DeployConfig;

  constructor(
    private readonly cliPath: string,
    private readonly options: Record<string, string | boolean>,
  ) {
    this.options = JSON.parse(JSON.stringify(options));
    this.config = parseConfig(this.options.config as string);
    this.createCdktfJson();
  }

  public async synth(
    stacks: string[] = this.getAllStackIds(),
  ): Promise<ExitStatus> {
    const child = await this.runCommand(
      ["bunx", "cdktf", "synth", ...this.normalizeStackIds(stacks)],
      { env: { ...process.env, ...TF_ENVARS } },
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
    // Need to run in serial since Terraform doesn't support multiple independent processes modifying
    // the plugin cache directory, and CDKTF doesn't support planning multiple stacks in parallel. See:
    // https://github.com/hashicorp/terraform-cdk/issues/2741
    // https://github.com/hashicorp/terraform/issues/31964
    // https://github.com/hashicorp/terraform-cdk/issues/3500#issuecomment-1951827605
    for (const stackId of stackIds) {
      console.info(
        "==========================================================================================",
      );
      console.info(`${stackId} plan output`);
      console.info(
        "↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓",
      );
      const result = await execa({
        stdout: "inherit",
        stderr: "inherit",
      })`bunx cdktf plan --skip-synth ${stackId}`;
      console.log("exit status", result.exitCode);
      if (result.exitCode !== 0) {
        failedStacks.push(stackId);
      }
    }

    if (failedStacks.length) {
      console.error("Stacks with plan failures:", failedStacks);
      return 1;
    }

    return 0;
  }

  public async deploy(stacks: string[]): Promise<ExitStatus> {
    if (this.options.applyOnly && this.options.skipApply) {
      throw new Error(
        "Cannot specify --apply-only and --skip-apply as they are mutually exclusive",
      );
    }

    const stackIds = stacks.length
      ? this.normalizeStackIds(stacks)
      : this.getAllStackIds();
    const podNames = this.extractPodNames(stackIds);

    console.info("Deploying stacks:", stackIds);

    const release = this.options.release as string;

    for (const [podName, podConfig] of objectEntries(this.config.pods)) {
      if (podNames.length > 0 && !podNames.includes(podName)) {
        continue;
      }

      if (Array.isArray(podConfig.environment)) {
        for (const envName of podConfig.environment) {
          if (process.env[envName] === undefined) {
            throw new Error(
              `Environment variable ${envName} is required by pod ${podName}, but was not provided in the environment`,
            );
          }
          if (envName.includes("=")) {
            throw new Error(
              `Environment variable ${envName} contains an equals sign, which is not allowed. Use a map if you want to provide explicit values`,
            );
          }
        }
      } else if (typeof podConfig.environment === "object") {
        for (const [envName, envValue] of Object.entries(
          podConfig.environment,
        )) {
          if (
            (envValue === null || envValue === undefined) &&
            (envValue === process.env[envName]) === undefined
          ) {
            throw new Error(
              `Environment variable ${envName} is required by pod ${podName}, but was not provided in the environment`,
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
      `Detected ${alreadyRunningInstances.length} already running instances`,
    );

    // Terraform apply to ASG will fail if there are currently active instance refreshes, so cancel them
    await this.rollbackActiveInstanceRefreshes(podNames);

    if (!this.options.skipApply) {
      const child = await this.runCommand(
        [
          "bunx",
          "cdktf",
          "apply",
          ...(this.options.yes ? ["--auto-approve"] : []),
          ...stackIds,
        ],
        { env: { ...process.env, ...TF_ENVARS } },
      );
      if (child.exitCode !== 0) return child.exited;
    }

    // Only perform a swap if there are already running instances.
    if (!this.options.applyOnly && alreadyRunningInstances.length) {
      // It's possible the above apply command removed instances, so need to check again
      const currentlyRunningInstances =
        await this.alreadyRunningInstances(podNames);
      if (currentlyRunningInstances.length) {
        const swapStatus = await this.swapContainers(
          release,
          currentlyRunningInstances,
          podNames,
        );
        if (swapStatus !== 0) {
          // No need to wait for instance refreshes since we know the deploy is a failure
          // TODO: Cancel existing instance refreshes?
          return swapStatus;
        }
      }
    }

    // Since we may have triggered an instance refresh, wait until all ASGs are healthy
    // and at desired count, or consider the deploy a failure
    const waitExitStatus = await this.waitForInstanceRefreshes(podNames);
    return waitExitStatus;
  }

  private async rollbackActiveInstanceRefreshes(
    podNames: string[],
  ): Promise<ExitStatus> {
    const asgs = await this.relevantAutoScalingGroups(podNames);
    if (!asgs.length) {
      console.log("No applicable ASGs to wait for instance refreshes");
      return 0; // Nothing to do
    }

    console.log(
      `Canceling instance refreshes for pods ${podNames.join(",")}...`,
    );

    const cancelPromises = asgs.map(({ AutoScalingGroupName, Tags }) => {
      const podName = Tags?.findLast((tag) => tag.Key === "pod")?.Value;
      if (!podName) {
        // Shouldn't happen, but check for type safety
        throw new Error(`ASG ${AutoScalingGroupName} does not have a pod tag`);
      }

      return this.rollbackActiveInstanceRefresh(
        AutoScalingGroupName as string,
        podName,
      );
    });

    const results = await Promise.allSettled(cancelPromises);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn(
          "Unable to cancel instance refresh due to error:",
          result.reason,
        );
      }
    }

    return 0;
  }

  private async rollbackActiveInstanceRefresh(
    asgName: string,
    podName: string,
  ) {
    const asg = new AutoScaling({ region: this.config.region });
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

  private async relevantAutoScalingGroups(podNames: string[]) {
    const asg = new AutoScaling({ region: this.config.region });

    // Fetch all ASGs for the pods we're deploying in chunks to avoid AWS limits
    const asgs: AutoScalingGroup[] = [];
    const maxPodsPerFetch = 5; // AWS limit
    for (let offset = 0; offset < podNames.length; offset += maxPodsPerFetch) {
      const podTagValues: string[] = podNames.slice(
        offset,
        Math.min(offset + maxPodsPerFetch, podNames.length),
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
            `ASG ${asg.AutoScalingGroupName} for ${this.config.project} project does not have a pod tag`,
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

  private async waitForInstanceRefreshes(
    podNames: string[],
  ): Promise<ExitStatus> {
    // Fetch all ASGs for the pods we're deploying in chunks to avoid AWS limits
    const asgs = await this.relevantAutoScalingGroups(podNames);
    if (!asgs.length) {
      console.log("No applicable ASGs to wait for instance refreshes");
      return 0; // Nothing to do
    }

    console.log(
      `Waiting for ASGs ${podNames.join(",")} to finish instance refresh...`,
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
        (this.config.pods[podName].deploy?.instanceRefreshTimeout || 600) *
          1000,
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

    console.log("Deploy completed successfully");
    return 0;
  }

  private async waitForInstanceRefresh(
    asgName: string,
    podName: string,
    timeoutMillis: number,
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
        const asg = new AutoScaling({ region: this.config.region });
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
            }`,
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
    podsToDeploy: string[],
  ): Promise<ExitStatus> {
    const ec2 = new EC2({ region: this.config.region });
    const asg = new AutoScaling({ region: this.config.region });
    const instancesForPod: Record<string, EC2Instance[]> = {};

    // HACK: Clear known hosts file to avoid issues with SSH client
    // when connecting via jump host
    await $`rm -f ~/.ssh/known_hosts`;

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
              `Desired capacity for ${group.AutoScalingGroupName} is 0. Skipping`,
            );
            return;
          }
        }

        const alreadyRunningPodInstances = alreadyRunningInstances.filter(
          (instance) => {
            const instancePod = instance.Tags?.findLast(
              (tag) => tag.Key === "pod",
            )?.Value;
            return instancePod === podName;
          },
        );

        if (!alreadyRunningPodInstances?.length) {
          if (podOptions.singleton) {
            console.error(
              `No existing instances found for pod ${podName}, but desired capacity is > 0. Canceling deploy.`,
            );
            throw new Error(
              `No existing instances found for pod ${podName}, but desired capacity is > 0`,
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
                    const { sshUser, bastionUser, bastionHost } = podOptions;

                    console.log(
                      `About to pull new containers for pod ${podName} on ${sshUser}@${ip}...`,
                    );

                    // Record the current host key (workaround for SSH client jump host bug)
                    if (bastionUser && bastionHost) {
                      await $`ssh -T -F /dev/null -o LogLevel=ERROR -o BatchMode=yes -o StrictHostKeyChecking=no ${bastionUser}@${bastionHost} true`;
                    }

                    const scriptInput = new Response(`
                      ${generateDeployScript(
                        this.config.project,
                        podName,
                        podOptions,
                        releaseId,
                        composeContents,
                        this.allowedPodSecrets(podName),
                      )}
                    `);
                    const connectResult =
                      bastionUser && bastionHost
                        ? await $`ssh -T -F /dev/null -J ${bastionUser}@${bastionHost} -o LogLevel=ERROR -o BatchMode=yes -o StrictHostKeyChecking=no ${sshUser}@${ip} bash -s < ${scriptInput}`
                        : await $`ssh -T -F /dev/null -o LogLevel=ERROR -o BatchMode=yes -o StrictHostKeyChecking=no ${sshUser}@${ip} bash -s < ${scriptInput}`;
                    if (connectResult.exitCode !== 0) {
                      console.error(
                        "STDOUT",
                        connectResult.stdout.toString(),
                        "STDERR",
                        connectResult.stderr.toString(),
                      );
                      throw new Error(
                        `Error connecting to ${ip} (exit code ${connectResult.exitCode})`,
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
                          `Unable to connect to ${ip} after 2 minutes.`,
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
                      e,
                    );
                    await sleep(5000);
                  }
                }
              }),
            );
            for (const result of pullResults) {
              if (result.status === "rejected") {
                updateFailed = true;
                console.error(result.reason);
              }
            }
          },
        );
      }),
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
        "One or more pods failed to download/start the latest images specified in their respective Docker Compose file(s). Aborting deploy.",
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
            (i) => i.InstanceId as string,
          );

          const asgInstances = await asg.describeAutoScalingInstances({
            InstanceIds: instanceIds,
          });

          const instancesInStandby =
            asgInstances.AutoScalingInstances?.filter(
              (instance) => instance.LifecycleState === LifecycleState.STANDBY,
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
                  (i) => i.LifecycleState === LifecycleState.IN_SERVICE,
                )
              ) {
                break;
              }
              if (Date.now() - exitStandbyStartTime > 180_000) {
                throw new Error(
                  `Standby Instances [${instancesInStandby.join(
                    ", ",
                  )}] did not exit Standby state within 180 seconds.`,
                );
              }
              console.info(
                `Waiting for instances [${instancesInStandby.join(
                  ", ",
                )}] to exit Standby state...`,
              );
              await sleep(5_000);
            }
          }
        }

        const { sshUser, bastionUser, bastionHost } = podOptions;
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
                          (i) => i.LifecycleState === LifecycleState.STANDBY,
                        )
                      ) {
                        break;
                      }
                      if (Date.now() - beginTime > 180_000) {
                        throw new Error(
                          `Pod ${podName} instance ${instanceId} (${ip}) did not enter Standby state within 180 seconds.`,
                        );
                      }
                      console.info(
                        `Waiting for pod ${podName} instance ${instanceId} (${ip}) to enter Standby state...`,
                      );
                      await sleep(10_000);
                    }
                  }

                  console.log(
                    `About to swap pod ${podName} containers on ${sshUser}@${ip}`,
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
    docker compose up --detach --quiet-pull

    # Delete old images + containers
    docker system prune --force

    # Clean up old releases
    echo "Deleting old release directories for pod ${podName} on ${instanceId} ${ip}"
    cd /home/${sshUser}
    ls -I current releases | sort | head -n -${MAX_RELEASES_TO_KEEP} | xargs --no-run-if-empty -I{} rm -rf releases/{}`,
                  );

                  // Swap the containers
                  const connectResult =
                    bastionUser && bastionHost
                      ? await $`ssh -T -F /dev/null -J ${bastionUser}@${bastionHost} -o LogLevel=ERROR -o BatchMode=yes -o StrictHostKeyChecking=no ${sshUser}@${ip} bash -s < ${scriptInput}`
                      : await $`ssh -T -F /dev/null -o LogLevel=ERROR -o BatchMode=yes -o StrictHostKeyChecking=no ${sshUser}@${ip} bash -s < ${scriptInput}`;
                  if (connectResult.exitCode !== 0) {
                    console.error(
                      "STDOUT",
                      connectResult.stdout.toString(),
                      "STDERR",
                      connectResult.stderr.toString(),
                    );
                    throw new Error(
                      `Error connecting to ${ip} (exit code ${connectResult.exitCode})`,
                    );
                  }

                  if (podOptions.deploy.detachBeforeContainerSwap) {
                    console.log(
                      `Moving pod ${podName} instance ${instanceId} ${ip} in ASG ${asgName} back to InService`,
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
                        `No launch template versions found for ASG ${asgName}`,
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
                },
              ),
            );
            for (const result of results) {
              if (result.status === "rejected") {
                deployFailed = true;
                console.error(result.reason);
              }
            }
          },
        );
      }),
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
        "One or more pods failed to start up the latest containers. Aborting deploy.",
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

    const child = await this.runCommand(
      [
        "bunx",
        "cdktf",
        "destroy",
        ...(this.options.yes ? ["--auto-approve"] : []),
        ...stackIds,
      ],
      { env: { ...process.env, ...TF_ENVARS } },
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
      const dynamo = new DynamoDB({ region: this.config.region });
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
    await this._synth();
    // By the time we reach here the configuration has already been validated
    console.info(`Stack configuration '${this.options.config}' is valid`);
    return 0;
  }

  public async console(pod: string): Promise<ExitStatus> {
    if (pod && !this.config.pods[pod]) {
      console.error(`Stack does not have a pod named ${pod}`);
      return 1;
    }

    const ec2 = new EC2({ region: this.config.region });
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
        (reservation) => reservation.Instances || [],
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
        (tag) => tag.Key === "pod",
      )?.Value;

      if (!instancePod) {
        throw new Error(
          `Unable to determine pod for instance ${instances[0].InstanceId}`,
        );
      }
      const { sshUser, bastionUser, bastionHost } =
        this.config.pods[instancePod];
      // Only one to chose from, so select automatically
      return this.sshInto(
        sshUser,
        instances[0].PrivateIpAddress as string,
        bastionUser,
        bastionHost,
      );
    }

    const candidates: string[] = [];
    for (const instance of instances) {
      const instancePod = instance.Tags?.findLast(
        (tag) => tag.Key === "pod",
      )?.Value;
      const release = instance.Tags?.findLast(
        (tag) => tag.Key === "release",
      )?.Value;
      if (!instancePod || !release) continue;
      candidates.push(
        [
          instance.InstanceId?.padEnd(20, " "),
          instance.PrivateIpAddress?.padEnd(16, " "),
          release.padEnd(25, " "),
          instancePod.padEnd(25, " ").slice(0, 25),
        ].join(" "),
      );
    }

    const fzf = await $`fzf --height=~10 < ${new Response(
      candidates.join("\n"),
    )}`;

    const choice = fzf.stdout.toString().trim();
    if (fzf.exitCode === 0) {
      const [instanceId, privateIp, , pod] = choice.split(/\s+/);
      console.info(
        `Connecting to pod ${pod} (${instanceId}) at ${privateIp}...`,
      );
      const { sshUser, bastionUser, bastionHost } = this.config.pods[pod];
      return this.sshInto(sshUser, privateIp, bastionUser, bastionHost);
    } else {
      console.error("No instance selected");
      return 1;
    }
  }

  private async alreadyRunningInstances(pods: string[]) {
    const ec2 = new EC2({ region: this.config.region });
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
      (reservation) => reservation.Instances || [],
    );

    return instances || [];
  }

  private async sshInto(
    sshUser: string,
    host: string,
    bastionUser?: string,
    bastionHost?: string,
  ): Promise<ExitStatus> {
    if (bastionUser && bastionHost) {
      // Accept the SSH host key for the bastion automatically (we don't store host keys)
      await execa({
        all: true,
      })`ssh -o LogLevel=ERROR -o BatchMode=yes -o StrictHostKeyChecking=no ${bastionUser}@${bastionHost} true`;
    }

    const sshResult = Bun.spawnSync(
      [
        "ssh",
        ...(bastionUser ? ["-J", `${bastionUser}@${bastionHost}`] : []),
        ...(this.options.yes ? ["-o", "BatchMode=yes"] : []),
        "-o",
        "LogLevel=ERROR",
        // Gets really annoying to have to clear your known hosts file
        // all the time, so don't bother with host key checking
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        `${sshUser}@${host}`,
      ],
      {
        stdio: ["inherit", "inherit", "inherit"],
      },
    );
    return sshResult.exitCode;
  }

  // Internal use only. Exposed for CDKTF interoperability
  public async _synth() {
    const app = new CdkApp();

    const secretsClient = new SecretsManager({ region: this.config.region });
    let secrets: SecretListEntry[] = [];
    let nextToken;
    for (;;) {
      const {
        SecretList,
        NextToken,
      }: { SecretList?: SecretListEntry[]; NextToken?: string } =
        await secretsClient.send(
          new ListSecretsCommand({ MaxResults: 100, NextToken: nextToken }),
        );
      secrets = [...secrets, ...(SecretList || [])];
      nextToken = NextToken;
      if (!nextToken) break;
    }
    const secretNames = new Set(secrets.map((s) => s.Name as string));

    let secretsMissing = 0;
    for (const [secretName, _secretConfig] of Object.entries(
      this.config.secrets || {},
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
        } missing from Secrets Manager`,
      );
    }

    // TODO: Ensure secrets are referenced in each pod

    // Create separate state file for each pod so we can deploy/update them independently if desired
    // (this would otherwise be very difficult to do with Terraform's -target flag)
    //
    // This has the added benefit of speeding up the deploy for large applications when only a single
    // pod was modified.
    for (const [podName, podOptions] of Object.entries(this.config.pods)) {
      new PodStack(app, `${this.config.project}-pod-${podName}`, {
        releaseId: this.options.release.toString(),
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
      });
    }
    app.synth();

    return 0;
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
    const allowedSecrets: Record<string, string> = {};
    for (const [secretName, secretOptions] of Object.entries(
      this.config.secrets || {},
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
        app: `bun ${this.cliPath} _cdktf-synth`,
        language: "typescript",
      }),
    );
  }

  private getAllStackIds() {
    const stackIds = Object.keys(this.config.pods || {}).map(
      (podName) => `${this.config.project}-pod-${podName}`,
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
        stackId.replace(new RegExp(`^${podStackIdPrefix}`), ""),
      );
  }
}
