import { Construct } from "constructs";
import { SecurityGroup } from "@cdktf/provider-aws/lib/security-group";

type OriginalSecurityGroupOptions = ConstructorParameters<
  typeof SecurityGroup
>[2];

type SmartSecurityGroupOptions = {
  project: string;
  shortName: string;
} & OriginalSecurityGroupOptions;

export class SmartSecurityGroup extends Construct {
  public securityGroupId: string;

  constructor(
    scope: Construct,
    id: string,
    options: SmartSecurityGroupOptions,
  ) {
    super(scope, id);

    const uniqueLbName = `${options.project}-${options.shortName}`;

    const sg = new SecurityGroup(scope, `lb-${uniqueLbName}`, {
      ...options,
      namePrefix: `lb-sg-${uniqueLbName}-`, // Auto-generate suffix
      vpcId: options.vpcId,
      tags: {
        Name: uniqueLbName,
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
