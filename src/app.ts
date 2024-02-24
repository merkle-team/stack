import { AutoScaling } from '@aws-sdk/client-auto-scaling';
import { EC2 } from '@aws-sdk/client-ec2';

export class App {
  private options: Record<string, any>;

  constructor(options: Record<string, any>) {
    this.options = JSON.parse(JSON.stringify(options));
  }

  public async deploy() {
    const ec2 = new EC2({
      region: 'us-east-1',
    });
    const autoScaling = new AutoScaling({
      region: 'us-east-1',
    });

    const result = await autoScaling.describeAutoScalingGroups({ AutoScalingGroupNames: ['test-asg'] });
    if (!result.AutoScalingGroups?.length) {
      console.log('No AutoScalingGroups found');
    }
  }
}
