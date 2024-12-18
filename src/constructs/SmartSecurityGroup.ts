import { Construct } from "constructs";
import { SecurityGroup } from "@cdktf/provider-aws/lib/security-group";

type OriginalSecurityGroupOptions = ConstructorParameters<
  typeof SecurityGroup
>[2];

type SmartSecurityGroupOptions = {
  project: string;
  shortName: string;
  vpcId: string;
} & OriginalSecurityGroupOptions;

export class SmartSecurityGroup extends Construct {
  public securityGroupId: string;

  constructor(
    scope: Construct,
    id: string,
    options: SmartSecurityGroupOptions
  ) {
    super(scope, id);

    const uniqueSgName = `${options.project}-${options.shortName}`;

    const sg = new SecurityGroup(scope, `sgrp-${uniqueSgName}`, {
      ...options,
      namePrefix: `sgrp-${uniqueSgName}-`, // Auto-generate suffix
      vpcId: options.vpcId,
      tags: {
        Name: uniqueSgName,
        shortName: options.shortName,
      },
      timeouts: {
        delete: "5m",
      },
      lifecycle: {
        createBeforeDestroy: true, // Rename SG without breaking anything (see namePrefix above)
      },
    });

    this.securityGroupId = sg.id;
  }
}
