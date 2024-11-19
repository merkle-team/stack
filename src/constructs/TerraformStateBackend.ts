import { S3Backend } from "cdktf";
import { Construct } from "constructs";

export type TerraformStateBackendOptions = {
  region: string;
};

/**
 * Configures Terraform to store state in an S3 bucket.
 */
export class TerraformStateBackend extends Construct {
  constructor(
    scope: Construct,
    name: string,
    options: TerraformStateBackendOptions
  ) {
    super(scope, name);

    new S3Backend(scope, {
      region: options.region,
      bucket: "warpcast-terraform-state",
      key: `${name}.tfstate`,
      encrypt: true,
      dynamodbTable: "warpcast-terraform-locks",
    });
  }
}
