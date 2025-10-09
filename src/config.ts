import { parseDocument } from "yaml";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { Type, type Static } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";

export const DeployConfigSchema = Type.Object({
  project: Type.String(),
  region: Type.String({ default: "us-east-1" }),

  network: Type.Object({
    id: Type.String({ pattern: "^vpc-[a-f0-9]+$" }),

    subnets: Type.Optional(
      Type.Object({
        public: Type.Array(Type.String({ pattern: "^subnet-[a-f0-9]+$" })),
        private: Type.Array(Type.String({ pattern: "^subnet-[a-f0-9]+$" })),
      })
    ),
  }),

  secrets: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([
        Type.Object({
          as: Type.Optional(Type.String()),
          pods: Type.Optional(
            Type.Union([
              Type.Array(Type.String(), { uniqueItems: true }),
              Type.Record(Type.String(), Type.String()),
            ])
          ),
        }),
        Type.Null(),
      ])
    )
  ),

  pods: Type.Record(
    Type.String(),
    Type.Object({
      environment: Type.Optional(
        Type.Union([
          Type.Record(
            Type.String(),
            Type.Union([Type.String(), Type.Undefined(), Type.Null()])
          ),
          Type.Array(Type.String({ pattern: "^[A-Z0-9_]+$" }), {
            uniqueItems: true,
          }),
        ])
      ),

      image: Type.String({ pattern: "^ami-[a-f0-9]+$" }),
      sshUser: Type.String({ default: "ec2-user" }),
      instanceType: Type.String(),
      instanceTags: Type.Optional(Type.Record(Type.String(), Type.String())),
      rootVolumeSize: Type.Optional(
        Type.Integer({
          minimum: 10,
          default: 100,
          maximum: 16 * 1024 /* 16 TiB */,
        })
      ),
      publicIp: Type.Optional(Type.Boolean()),

      rolePolicies: Type.Optional(Type.Array(Type.String())),

      initScript: Type.Optional(Type.String()),
      preContainerShutdownScript: Type.Optional(Type.String()),

      compose: Type.String(),

      singleton: Type.Optional(
        Type.Object({
          terminatingTask: Type.Optional(Type.Boolean({ default: false })),
          subnetId: Type.Optional(
            Type.String({ pattern: "^subnet-[a-f0-9]+$" })
          ),
          networkInterfaceId: Type.Optional(
            Type.TemplateLiteral("eni-${string}")
          ),
        })
      ),

      autoscaling: Type.Optional(
        Type.Object({
          subnetIds: Type.Optional(Type.Array(Type.String())),
          healthCheckGracePeriod: Type.Integer({ minimum: 0 }),
          minHealthyPercentage: Type.Integer({ minimum: 0 }),
          maxHealthyPercentage: Type.Integer({ minimum: 100, maximum: 200 }),
          minHealthyInstances: Type.Integer({ minimum: 0 }),
          onDemandBaseCapacity: Type.Integer({ minimum: 0 }),
          onDemandPercentageAboveBaseCapacity: Type.Integer({
            minimum: 0,
            maximum: 100,
          }),
          disableReplacingUnhealthyInstances: Type.Optional(
            Type.Boolean({ default: false })
          ),
          disableInstanceRefresh: Type.Optional(
            Type.Boolean({ default: false })
          ),
          disableAZRebalance: Type.Optional(Type.Boolean({ default: false })),
        })
      ),

      deploy: Type.Object({
        replaceWith: Type.Union([
          Type.Literal("new-instances"),
          Type.Literal("new-containers"),
        ]),
        detachBeforeContainerSwap: Type.Optional(
          Type.Boolean({ default: true })
        ),
        shutdownTimeout: Type.Integer({ minimum: 0 }),
        instanceRefreshTimeout: Type.Optional(Type.Integer({ minimum: 300 })),
        timeout: Type.Optional(Type.Integer({ minimum: 10 })),
        orchestrator: Type.Optional(
          Type.Union([
            Type.Literal("asg"), // Default: use ASG's built-in logic to determine when deploy is finished
            Type.Literal("consul"),
          ])
        ),
        healthCheckService: Type.Optional(Type.String()), // If using Consul-based deploy, the service whose health to check
        _preserveAsg: Type.Optional(Type.Boolean()),
      }),

      loadBalancers: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            awsName: Type.Optional(Type.String()),
            type: Type.Union([
              Type.Literal("application"),
              Type.Literal("network"),
            ]),
            public: Type.Optional(Type.Boolean({ default: false })),
            idleTimeout: Type.Optional(
              Type.Integer({ minimum: 1, default: 60 })
            ),
            clientKeepAlive: Type.Optional(
              Type.Integer({ minimum: 60, maximum: 3600 })
            ),
          }),
          { additionalProperties: false, default: {} }
        )
      ),

      endpoints: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            awsName: Type.Optional(Type.String()),
            loadBalancer: Type.Optional(
              Type.Object({
                name: Type.String(),
                protocol: Type.Union([
                  Type.Literal("HTTP"),
                  Type.Literal("HTTPS"),
                  Type.Literal("TCP"),
                  Type.Literal("UDP"),
                  Type.Literal("TCP_UDP"),
                  Type.Literal("TLS"),
                ]),
                port: Type.Integer({ minimum: 1, maximum: 65535 }),
                cert: Type.Optional(Type.String()),
              })
            ),
            public: Type.Optional(Type.Boolean({ default: false })),
            target: Type.Object({
              port: Type.Integer({ minimum: 1, maximum: 65535 }),
              protocol: Type.Union([
                Type.Literal("HTTP"),
                Type.Literal("HTTPS"),
                Type.Literal("TCP"),
                Type.Literal("UDP"),
                Type.Literal("TCP_UDP"),
                Type.Literal("TLS"),
              ]),
              deregistration: Type.Optional(
                Type.Object({
                  delay: Type.Integer({ minimum: 0 }),
                  action: Type.Optional(
                    Type.Union(
                      [
                        Type.Literal("do-nothing"),
                        Type.Literal("force-terminate-connection"),
                      ],
                      { default: "do-nothing" }
                    )
                  ),
                })
              ),
              healthCheck: Type.Optional(
                Type.Object({
                  path: Type.Optional(Type.String()),
                  healthyThreshold: Type.Integer({ minimum: 2, maximum: 10 }),
                  unhealthyThreshold: Type.Integer({ minimum: 2, maximum: 10 }),
                  timeout: Type.Integer({ minimum: 2, maximum: 120 }),
                  interval: Type.Integer({ minimum: 5, maximum: 300 }),
                })
              ),
            }),
          })
        )
      ),
    })
  ),
});

const DEPLOY_CONFIG_COMPILER = TypeCompiler.Compile(DeployConfigSchema);

export type DeployConfig = Static<typeof DeployConfigSchema>;

export function parseConfig(configPath: string) {
  let config: DeployConfig = parseDocument(
    readFileSync(configPath).toString(),
    { merge: true }
  ).toJSON();
  const configErrors = [...DEPLOY_CONFIG_COMPILER.Errors(config)];
  if (configErrors?.length) {
    for (const error of configErrors) {
      console.log(`${error.message} at ${error.path}`);
    }
    throw new Error("Invalid configuration file");
  }

  // Ensure all defaults are set if value not provided
  config = Value.Default(DeployConfigSchema, config) as DeployConfig;

  for (const [secretName, secretConfig] of Object.entries(
    config.secrets || {}
  )) {
    // If undefined, assume all pods are included
    const podsToInclude =
      secretConfig?.pods === null || secretConfig?.pods === undefined
        ? Object.keys(config.pods)
        : secretConfig.pods;
    if (Array.isArray(podsToInclude)) {
      for (const podName of podsToInclude) {
        if (!config.pods[podName]) {
          throw new Error(
            `Secret ${secretName} exposed to pod ${podName}, which does not exist`
          );
        }
      }
    } else if (typeof podsToInclude === "object") {
      if (secretConfig?.as) {
        throw new Error(
          `Secret ${secretName} cannot specify both 'as' and 'podsIncluded' with individual secret name mappings for each pod`
        );
      }
      // If an object is provided, treat each key as the pod name and each value as the environment variable name mapping
      for (const podName of Object.keys(podsToInclude)) {
        if (!config.pods[podName]) {
          throw new Error(
            `Secret ${secretName} exposed to pod ${podName}, which does not exist`
          );
        }
      }
    }
  }

  for (const [podName, podConfig] of Object.entries(config.pods)) {
    podConfig.compose = resolve(dirname(configPath), podConfig.compose);

    if (podConfig.initScript) {
      podConfig.initScript = resolve(dirname(configPath), podConfig.initScript);
    }

    if (podConfig.singleton) {
      if (podConfig.autoscaling) {
        throw new Error(
          `Pod ${podName} cannot specify both singleton and autoscaling options -- they are mutually exclusive`
        );
      }
    } else if (!podConfig.autoscaling) {
      throw new Error(
        `Pod ${podName} must specify autoscaling options -- specify singleton if you want a single instance`
      );
    }

    if (
      podConfig.deploy.orchestrator === "consul" &&
      !podConfig.deploy.healthCheckService
    ) {
      throw new Error(
        `Pod ${podName} has no health check service name configured when using Consul-based deploy`
      );
    }

    const result = Bun.spawnSync([
      "docker",
      "compose",
      "-f",
      podConfig.compose,
      "config",
    ]);
    if (!result.success) {
      throw new Error(
        `Invalid compose file ${
          podConfig.compose
        } for pod ${podName}\n${result.stdout.toString()}\n${result.stderr.toString()}`
      );
    }
  }

  return config;
}
