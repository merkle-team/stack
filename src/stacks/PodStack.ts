import { Fn, TerraformStack } from "cdktf";
import { Construct } from "constructs";
import { AwsProvider } from "@cdktf/provider-aws/lib/provider";
import { DataAwsVpc } from "@cdktf/provider-aws/lib/data-aws-vpc";
import { IamRole } from "@cdktf/provider-aws/lib/iam-role";
import { DataAwsIamPolicyDocument } from "@cdktf/provider-aws/lib/data-aws-iam-policy-document";
import { DataAwsCallerIdentity } from "@cdktf/provider-aws/lib/data-aws-caller-identity";
import { IamRolePolicyAttachment } from "@cdktf/provider-aws/lib/iam-role-policy-attachment";
import { IamPolicy } from "@cdktf/provider-aws/lib/iam-policy";
import { SmartSecurityGroup } from "../constructs/SmartSecurityGroup";
import { VpcSecurityGroupIngressRule } from "@cdktf/provider-aws/lib/vpc-security-group-ingress-rule";
import { VpcSecurityGroupEgressRule } from "@cdktf/provider-aws/lib/vpc-security-group-egress-rule";
import { LbTargetGroup } from "@cdktf/provider-aws/lib/lb-target-group";
import { DeployConfig } from "../config";
import { DataAwsAcmCertificate } from "@cdktf/provider-aws/lib/data-aws-acm-certificate";
import { LbListener } from "@cdktf/provider-aws/lib/lb-listener";
import { Lb } from "@cdktf/provider-aws/lib/lb";
import { readFileSync } from "fs";
import { IamInstanceProfile } from "@cdktf/provider-aws/lib/iam-instance-profile";
import { LaunchTemplate } from "@cdktf/provider-aws/lib/launch-template";
import { generateDeployScript } from "../util";
import { AutoscalingGroup } from "@cdktf/provider-aws/lib/autoscaling-group";
import { NetworkInterfaceSgAttachment } from "@cdktf/provider-aws/lib/network-interface-sg-attachment";
import { Instance } from "@cdktf/provider-aws/lib/instance";
import { stringToBase64 } from "uint8array-extras";
import { TerraformStateBackend } from "../constructs/TerraformStateBackend";
import * as zlib from "zlib";
import { Resource as NullResource } from "@cdktf/provider-null/lib/resource";
import { NullProvider } from "@cdktf/provider-null/lib/provider";

type PodStackOptions = {
  releaseId: string;
  project: string;
  shortName: string;
  region: string;
  vpcId: string;
  defaultSubnetIds?: string[];
  secretMappings: Record<string, string>;
  lbs: Record<string, Lb>;
  podOptions: DeployConfig["pods"][string];
};

export class PodStack extends TerraformStack {
  constructor(scope: Construct, id: string, options: PodStackOptions) {
    super(scope, id);

    new TerraformStateBackend(this, `${id}-state`, {
      region: options.region,
    });

    new NullProvider(this, "null");

    new AwsProvider(this, "aws", {
      region: options.region,
      defaultTags: [
        {
          tags: {
            project: options.project,
          },
        },
      ],
    });

    const vpc = new DataAwsVpc(this, "vpc", {
      id: options.vpcId,
    });

    const callerIdentity = new DataAwsCallerIdentity(this, "current", {});

    const fullPodName = `${options.project}-${options.shortName}`;
    const podOptions = options.podOptions;
    const lbs = options.lbs;
    const releaseId = options.releaseId;

    const podRole = new IamRole(this, `${fullPodName}-role`, {
      name: fullPodName,
      path: `/${options.project}/`,
      assumeRolePolicy: new DataAwsIamPolicyDocument(
        this,
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
        }
      ).json,
    });

    const anySecrets = Object.keys(options.secretMappings).length > 0;

    new IamRolePolicyAttachment(this, `${fullPodName}-policy-attachment`, {
      role: podRole.name,
      policyArn: new IamPolicy(this, `${fullPodName}-policy`, {
        name: `${fullPodName}-policy`,
        path: `/${options.project}/`,
        description: `Policy for pod ${fullPodName}`,
        policy: new DataAwsIamPolicyDocument(
          this,
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
                  `arn:aws:ecr:${options.region}:${callerIdentity.accountId}:repository/*`,
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
                resources: ["*"],
                // resources: anySecrets
                //   ? Object.keys(options.secretMappings).map(
                //       (secretName) =>
                //         `arn:aws:secretsmanager:${options.region}:${callerIdentity.accountId}:secret:${secretName}-*`
                //     )
                //   : ["*"],
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
          }
        ).json,
      }).arn,
    });

    for (const rolePolicyArn of podOptions.rolePolicies || []) {
      new IamRolePolicyAttachment(
        this,
        `${fullPodName}-policy-attachment-${rolePolicyArn
          .replace(":", "-")
          .replace("/", "-")}`,
        {
          role: podRole.name,
          policyArn: rolePolicyArn,
        }
      );
    }

    const podSg = new SmartSecurityGroup(this, fullPodName, {
      project: options.project,
      shortName: options.shortName,
      vpcId: vpc.id,
    });

    new VpcSecurityGroupIngressRule(this, `${fullPodName}-ingress-ssh`, {
      securityGroupId: podSg.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 22,
      toPort: 22,
      cidrIpv4: "0.0.0.0/0", // TODO: Lock down further
      tags: {
        Name: `${fullPodName}-ingress-ssh`,
        pod: options.shortName,
      },
    });
    new VpcSecurityGroupEgressRule(this, `${fullPodName}-egress-all-ipv4`, {
      securityGroupId: podSg.securityGroupId,
      ipProtocol: "-1",
      cidrIpv4: "0.0.0.0/0",
      tags: {
        Name: `${fullPodName}-egress-all-ipv4`,
        pod: options.shortName,
      },
    });
    new VpcSecurityGroupEgressRule(this, `${fullPodName}-egress-all-ipv6`, {
      securityGroupId: podSg.securityGroupId,
      ipProtocol: "-1",
      cidrIpv6: "::/0",
      tags: {
        Name: `${fullPodName}-egress-all-ipv6`,
        pod: options.shortName,
      },
    });

    const tgs: Record<string, LbTargetGroup> = {};
    for (const [endpointName, endpointOptions] of Object.entries(
      podOptions.endpoints || {}
    )) {
      for (const ipProtocol of ["tcp", "udp"]) {
        if (
          ipProtocol === "tcp" &&
          !["HTTP", "HTTPS", "TCP", "TCP_UDP", "TLS"].includes(
            endpointOptions.target.protocol
          )
        ) {
          continue;
        } else if (
          ipProtocol === "udp" &&
          !["UDP", "TCP_UDP"].includes(endpointOptions.target.protocol)
        ) {
          continue;
        }

        new VpcSecurityGroupIngressRule(
          this,
          `${fullPodName}-ingress-${endpointName}-ipv4-${ipProtocol}`,
          {
            securityGroupId: podSg.securityGroupId,
            ipProtocol,
            fromPort: endpointOptions.target.port,
            toPort: endpointOptions.target.port,
            cidrIpv4: endpointOptions.public ? "0.0.0.0/0" : "10.0.0.0/8",
            tags: {
              Name: `${fullPodName}-ingress-${endpointName}-ipv4-${ipProtocol}`,
              pod: options.shortName,
            },
          }
        );
        new VpcSecurityGroupIngressRule(
          this,
          `${fullPodName}-ingress-${endpointName}-ipv6-${ipProtocol}`,
          {
            securityGroupId: podSg.securityGroupId,
            ipProtocol,
            fromPort: endpointOptions.target.port,
            toPort: endpointOptions.target.port,
            cidrIpv6: endpointOptions.public ? "::/0" : vpc.ipv6CidrBlock,
            tags: {
              Name: `${fullPodName}-ingress-${endpointName}-ipv6-${ipProtocol}`,
              pod: options.shortName,
            },
          }
        );
      }

      // Don't need to create target group or listeners if there's no load balancer associated
      if (!endpointOptions.loadBalancer) continue;

      const tg = new LbTargetGroup(this, `${fullPodName}-${endpointName}`, {
        name: `${fullPodName}-${endpointName}`,
        port: endpointOptions.target.port,
        protocol: endpointOptions.target.protocol,
        vpcId: options.vpcId,
        deregistrationDelay:
          endpointOptions.target.deregistration?.delay?.toString(),
        connectionTermination:
          endpointOptions.target.deregistration?.action ===
          "force-terminate-connection",
        healthCheck: {
          healthyThreshold:
            endpointOptions.target.healthCheck?.healthyThreshold,
          unhealthyThreshold:
            endpointOptions.target.healthCheck?.unhealthyThreshold,
          port: endpointOptions.target.port.toString(),
          protocol: endpointOptions.target.protocol,
          timeout: endpointOptions.target.healthCheck?.timeout,
        },
      });
      tgs[endpointName] = tg;

      const certData = new DataAwsAcmCertificate(
        this,
        `${fullPodName}-${endpointName}-cert`,
        {
          domain: endpointOptions.loadBalancer.cert,
          statuses: ["ISSUED"],
          types: ["AMAZON_ISSUED"],
          mostRecent: true,
        }
      );

      new LbListener(this, `${fullPodName}-${endpointName}-listener`, {
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
          pod: options.shortName,
          endpoint: endpointName,
          loadBalancer: endpointOptions.loadBalancer.name,
        },
      });
    }

    const composeContents = readFileSync(podOptions.compose).toString();

    const instanceProfile = new IamInstanceProfile(
      this,
      `${fullPodName}-iprof`,
      {
        name: fullPodName,
        role: podRole.name,
        tags: {
          pod: options.shortName,
        },
      }
    );

    // Executed by cloud-init when the instance starts up
    // Use `sensitive` to hide massive base64 blob in diffs
    const userData = `#!/bin/bash
set -e -o pipefail

cd /home/${podOptions.sshUser}
echo "${zlib
      .gzipSync(
        podOptions.initScript
          ? readFileSync(podOptions.initScript).toString()
          : "#/bin/bash\n# No script specified in this deploy configuration's initScript\n"
      )
      .toString("base64")}" | base64 -d | gunzip > before-init.sh
chmod +x before-init.sh
./before-init.sh

echo "${zlib
      .gzipSync(
        generateDeployScript(
          options.project,
          options.shortName,
          options.podOptions,
          releaseId,
          composeContents,
          options.secretMappings
        )
      )
      .toString("base64")}" | base64 -d | gunzip > init.sh
chmod +x init.sh
su ${podOptions.sshUser} /home/${podOptions.sshUser}/init.sh
`;

    const lt = new LaunchTemplate(this, `${fullPodName}-lt`, {
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
          networkInterfaceId: podOptions.singleton?.networkInterfaceId,
          deleteOnTermination: (!podOptions.singleton
            ?.networkInterfaceId).toString(),
          associatePublicIpAddress: podOptions.singleton?.networkInterfaceId
            ? undefined
            : (!!podOptions.publicIp).toString(),
          // Don't add IPv6 addresses if we're using a reusable ENI
          ipv6AddressCount: podOptions.singleton?.networkInterfaceId
            ? undefined
            : 1,
          securityGroups: podOptions.singleton?.networkInterfaceId
            ? undefined
            : [podSg.securityGroupId],
        },
      ],

      // Disable DNS resolution for the instance hostname (e.g. ec2-192-0-2-0.compute-1.amazonaws.com)
      privateDnsNameOptions: {
        enableResourceNameDnsAaaaRecord: false,
        enableResourceNameDnsARecord: false,
        hostnameType: "resource-name",
      },

      tagSpecifications: [
        {
          resourceType: "instance",
          tags: {
            Name: `${fullPodName}-${releaseId}`, // Purely for visual in AWS console, no functional purpose
            project: options.project,
            pod: options.shortName,
            release: releaseId,
          },
        },
      ],

      userData: Fn.sensitive(stringToBase64(userData)), // Hide in diffs since it's a large blob
    });

    if (podOptions.singleton) {
      // Can't use ASG with a pre-specified ENI since ASGs assign ENIs directly
      // so we create the instance directly
      const instance = new Instance(this, `${fullPodName}-singleton`, {
        launchTemplate: {
          name: lt.name,
        },
        maintenanceOptions: {
          autoRecovery: "default",
        },
        lifecycle: {
          ignoreChanges: ["tags", "user_data"],
        },
      });
      if (podOptions.singleton.networkInterfaceId) {
        new NetworkInterfaceSgAttachment(
          this,
          `${fullPodName}-eni-sg-attachment`,
          {
            networkInterfaceId: podOptions.singleton.networkInterfaceId,
            securityGroupId: podSg.securityGroupId,
          }
        );
      } else {
        instance.securityGroups = [podSg.securityGroupId];
      }
    } else {
      if (!podOptions.autoscaling) {
        throw new Error(`Pod ${fullPodName} must specify autoscaling options`);
      }

      const asg = new AutoscalingGroup(this, `${fullPodName}-asg`, {
        namePrefix: `${fullPodName}-`,
        minSize: 1,
        maxSize: 2, // Allow deploy of a new instance without downtime
        desiredCapacity: 1,
        defaultInstanceWarmup: 60, // Give 1 minute for the instance to start up, download containers, and start before including in CloudWatch metrics
        defaultCooldown: 0, // Don't wait between scaling actions
        healthCheckGracePeriod: podOptions.autoscaling.healthCheckGracePeriod,
        healthCheckType: Object.keys(podOptions.endpoints || {}).length
          ? "ELB"
          : "EC2",
        waitForCapacityTimeout: `${podOptions.autoscaling?.healthCheckGracePeriod}s`,

        trafficSource: Object.values(tgs).map((tg) => ({
          identifier: tg.arn,
          type: "elbv2",
        })),

        vpcZoneIdentifier: options.defaultSubnetIds,
        protectFromScaleIn: false,

        terminationPolicies: ["OldestLaunchTemplate"],

        instanceMaintenancePolicy: {
          minHealthyPercentage: podOptions.autoscaling.minHealthyPercentage,
          maxHealthyPercentage: podOptions.autoscaling.maxHealthyPercentage,
        },
        waitForElbCapacity: podOptions.autoscaling.minHealthyInstances,

        instanceRefresh: {
          strategy: "Rolling",
          preferences: {
            minHealthyPercentage: podOptions.autoscaling.minHealthyPercentage,
            maxHealthyPercentage: podOptions.autoscaling.maxHealthyPercentage,
            autoRollback: true,
            scaleInProtectedInstances: "Wait",
            skipMatching: true,
            standbyInstances: "Wait",
          },
        },

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
            key: "project",
            value: options.project,
            propagateAtLaunch: true,
          },
          {
            key: "pod",
            value: options.shortName,
            propagateAtLaunch: true,
          },
        ],

        lifecycle: {
          createBeforeDestroy: true, // Create new ASG before destroying old one so there's no downtime

          // After we've created the ASG for the first time, this is managed separately
          ignoreChanges: [
            "min_size",
            "max_size",
            "desired_capacity",
            "wait_for_elb_capacity",
          ],
        },
      });

      // HACK: Wait for ASG to refresh itself before continuing
      const waitForRefresh = new NullResource(
        this,
        `${fullPodName}-wait-for-asg`
      );
      waitForRefresh.addOverride("depends_on", [asg]);
      waitForRefresh.addOverride("provisioner.local-exec", {
        command: "sleep 30 && echo 'Done!'",
      });
    }
  }
}
