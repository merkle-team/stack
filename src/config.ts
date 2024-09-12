import { parseDocument } from "yaml";
import { readFileSync } from "fs";
import path from "path";
import { Type, type Static } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";

export const DeployConfigSchema = Type.Object({
  stack: Type.String(),
  region: Type.Optional(Type.String({ default: "us-east-1" })),

  secrets: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        podsIncluded: Type.Union([
          Type.Array(Type.String(), { uniqueItems: true }),
          Type.Record(Type.String(), Type.String()),
        ]),
      }),
    ),
  ),

  loadBalancers: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        type: Type.Union([
          Type.Literal("application"),
          Type.Literal("network"),
        ]),
        public: Type.Optional(Type.Boolean({ default: false })),
        idleTimeout: Type.Optional(Type.Integer({ minimum: 1, default: 60 })),
      }),
      { additionalProperties: false, default: {} },
    ),
  ),

  pods: Type.Record(
    Type.String(),
    Type.Object({
      environment: Type.Optional(
        Type.Union([
          Type.Record(
            Type.String(),
            Type.Union([Type.String(), Type.Undefined(), Type.Null()]),
          ),
          Type.Array(Type.String({ pattern: "^[A-Z0-9_]+$" }), {
            uniqueItems: true,
          }),
        ]),
      ),

      image: Type.String({ pattern: "^ami-[a-f0-9]+$" }),
      instanceType: Type.String(),
      publicIp: Type.Optional(Type.Boolean()),

      initScript: Type.Optional(Type.String()),

      compose: Type.String(),

      singleton: Type.Optional(
        Type.Object({
          networkInterfaceId: Type.Optional(
            Type.TemplateLiteral("eni-${string}"),
          ),
        }),
      ),

      autoscaling: Type.Optional(
        Type.Object({
          healthCheckGracePeriod: Type.Integer({ minimum: 0 }),
          minHealthyPercentage: Type.Integer({ minimum: 0 }),
          maxHealthyPercentage: Type.Integer({ minimum: 100, maximum: 200 }),
          minHealthyInstances: Type.Integer({ minimum: 0 }),
          onDemandBaseCapacity: Type.Integer({ minimum: 0 }),
          onDemandPercentageAboveBaseCapacity: Type.Integer({
            minimum: 0,
            maximum: 100,
          }),
        }),
      ),

      deploy: Type.Object({
        replaceWith: Type.Union([
          Type.Literal("new-instances"),
          Type.Literal("new-containers"),
        ]),
        detachBeforeContainerSwap: Type.Optional(
          Type.Boolean({ default: true }),
        ),
        shutdownTimeout: Type.Integer({ minimum: 0 }),
      }),

      endpoints: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
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
                cert: Type.String(),
              }),
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
              deregistration: Type.Object({
                delay: Type.Integer({ minimum: 0 }),
                action: Type.Optional(
                  Type.Union(
                    [
                      Type.Literal("do-nothing"),
                      Type.Literal("force-terminate-connection"),
                    ],
                    { default: "do-nothing" },
                  ),
                ),
              }),
              healthCheck: Type.Object({
                path: Type.Optional(Type.String()),
                successCodes: Type.Optional(
                  Type.Union([
                    Type.Integer({ minimum: 200, maximum: 599 }),
                    Type.String(),
                  ]),
                ),
                healthyThreshold: Type.Integer({ minimum: 1 }),
                unhealthyThreshold: Type.Integer({ minimum: 1 }),
                timeout: Type.Integer({ minimum: 1 }),
                interval: Type.Integer({ minimum: 5 }),
              }),
            }),
          }),
        ),
      ),
    }),
  ),

  network: Type.Object({
    id: Type.String({ pattern: "^vpc-[a-f0-9]+$" }),

    subnets: Type.Optional(
      Type.Object({
        public: Type.Array(Type.String({ pattern: "^subnet-[a-f0-9]+$" })),
        private: Type.Array(Type.String({ pattern: "^subnet-[a-f0-9]+$" })),
      }),
    ),
  }),
});

const DEPLOY_CONFIG_COMPILER = TypeCompiler.Compile(DeployConfigSchema);

export type DeployConfig = Static<typeof DeployConfigSchema>;

// Hack to work around weird issue with Bun + typing
function extractErrors(iterator) {
  return [...iterator];
}

export function parseConfig(configPath: string) {
  let config: DeployConfig = parseDocument(
    readFileSync(configPath).toString(),
    { merge: true },
  ).toJSON();
  const configErrors = extractErrors(DEPLOY_CONFIG_COMPILER.Errors(config));
  if (configErrors?.length) {
    for (const error of configErrors) {
      console.log(`${error.message} at ${error.path}`);
    }
    throw new Error("Invalid configuration file");
  }

  // Ensure all defaults are set if value not provided
  config = Value.Default(DeployConfigSchema, config) as DeployConfig;

  for (const [secretName, secretConfig] of Object.entries(
    config.secrets || {},
  )) {
    if (Array.isArray(secretConfig.podsIncluded)) {
      for (const podName of secretConfig.podsIncluded) {
        if (!config.pods[podName]) {
          throw new Error(
            `Secret ${secretName} exposed to pod ${podName}, which does not exist`,
          );
        }
      }
    } else if (typeof secretConfig.podsIncluded === "object") {
      // If an object is provided, treat each key as the pod name and each value as the environment variable name mapping
      for (const podName of Object.keys(secretConfig.podsIncluded)) {
        if (!config.pods[podName]) {
          throw new Error(
            `Secret ${secretName} exposed to pod ${podName}, which does not exist`,
          );
        }
      }
    }
  }

  for (const [podName, podConfig] of Object.entries(config.pods)) {
    podConfig.compose = path.resolve(
      path.dirname(configPath),
      podConfig.compose,
    );

    if (podConfig.singleton) {
      if (podConfig.autoscaling) {
        throw new Error(
          `Pod ${podName} cannot specify both singleton and autoscaling options -- they are mutually exclusive`,
        );
      }
    } else if (!podConfig.autoscaling) {
      throw new Error(
        `Pod ${podName} must specify autoscaling options -- specify singleton if you want a single instance`,
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
        `Invalid compose file ${podConfig.compose} for pod ${podName}\n${result.stdout.toString()}\n${result.stderr.toString()}`,
      );
    }
  }

  return config;
}
