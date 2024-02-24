import { AutoScaling } from "@aws-sdk/client-auto-scaling";
import { EC2 } from "@aws-sdk/client-ec2";

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

    const result = await asg.describeAutoScalingGroups({
      AutoScalingGroupNames: ["test-asg"],
    });
    if (!result.AutoScalingGroups?.length) {
      console.log("No AutoScalingGroups found");

      const result = await asg.createAutoScalingGroup({
        AutoScalingGroupName: "test-asg",

        MinSize: 1,
        MaxSize: 1,
        DesiredCapacity: 1,

        DefaultInstanceWarmup: 0,
        HealthCheckGracePeriod: 60,

        // InstanceMaintenancePolicy:
        // MaxInstanceLifetime:
        // NewInstancesProtectedFromScaleIn:
        // TerminationPolicies:

        // Subnet IDs (required)
        // VPCZoneIdentifier//
      });
    }
  }
}
