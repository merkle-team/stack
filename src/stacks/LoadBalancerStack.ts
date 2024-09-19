import { TerraformStack } from "cdktf";
import { Construct } from "constructs";
import { AwsProvider } from "@cdktf/provider-aws/lib/provider";
import { DataAwsVpc } from "@cdktf/provider-aws/lib/data-aws-vpc";
import { SmartSecurityGroup } from "../constructs/SmartSecurityGroup";
import { VpcSecurityGroupIngressRule } from "@cdktf/provider-aws/lib/vpc-security-group-ingress-rule";
import { VpcSecurityGroupEgressRule } from "@cdktf/provider-aws/lib/vpc-security-group-egress-rule";
import { Lb } from "@cdktf/provider-aws/lib/lb";
import { TerraformStateBackend } from "../constructs/TerraformStateBackend";

type LoadBalancerStackOptions = {
  project: string;
  shortName: string;
  region: string;
  vpcId: string;
  type: "application" | "network";
  public?: boolean;
  subnets: string[];
  idleTimeout?: number;
};

export class LoadBalancerStack extends TerraformStack {
  public lb: Lb;

  constructor(scope: Construct, id: string, options: LoadBalancerStackOptions) {
    super(scope, id);

    new TerraformStateBackend(this, `${id}-state`, {
      region: options.region,
    });

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

    if (options.idleTimeout !== undefined && options.type !== "application") {
      throw new Error(
        `Load balancer ${options.shortName} has an idle-timeout specified, but is not an application load balancer`
      );
    }

    const uniqueLbName = `${options.project}-${options.shortName}`;

    const lbSg = new SmartSecurityGroup(this, `lb-ssg-${uniqueLbName}`, {
      project: options.project,
      shortName: options.shortName,
      vpcId: vpc.id,
    });

    // Allow ingress from anywhere
    new VpcSecurityGroupIngressRule(
      this,
      `lb-sgr-${uniqueLbName}-ingress-all-ipv4`,
      {
        securityGroupId: lbSg.securityGroupId,
        ipProtocol: "-1",
        cidrIpv4: "0.0.0.0/0",
      }
    );
    new VpcSecurityGroupIngressRule(
      this,
      `lb-sgr-${uniqueLbName}-ingress-all-ipv6`,
      {
        securityGroupId: lbSg.securityGroupId,
        ipProtocol: "-1",
        cidrIpv6: "::/0",
      }
    );

    // Allow egress to anywhere
    new VpcSecurityGroupEgressRule(
      this,
      `lb-sgr-${uniqueLbName}-egress-all-ipv4`,
      {
        securityGroupId: lbSg.securityGroupId,
        ipProtocol: "-1",
        cidrIpv4: "0.0.0.0/0",
      }
    );
    new VpcSecurityGroupEgressRule(
      this,
      `lb-sgr-${uniqueLbName}-egress-all-ipv6`,
      {
        securityGroupId: lbSg.securityGroupId,
        ipProtocol: "-1",
        cidrIpv6: "::/0",
      }
    );

    this.lb = new Lb(this, uniqueLbName, {
      name: uniqueLbName,
      loadBalancerType: options.type,
      internal: !options.public,
      subnets: options.subnets || undefined,
      idleTimeout: options.idleTimeout,
      preserveHostHeader: options.type === "application" ? true : undefined,
      enableCrossZoneLoadBalancing: true,
      ipAddressType: "dualstack",
      securityGroups: [lbSg.securityGroupId],
      tags: {
        Name: uniqueLbName,
        shortName: options.shortName,
      },
    });
  }
}
