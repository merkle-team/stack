import { parse as parseYaml } from "yaml";
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
        podsIncluded: Type.Optional(
          Type.Array(Type.String(), { uniqueItems: true }),
        ),
        podsExcluded: Type.Optional(
          Type.Array(Type.String(), { uniqueItems: true }),
        ),
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
        Type.Array(Type.String({ pattern: "^[A-Z0-9_]+$" }), {
          uniqueItems: true,
        }),
      ),

      image: Type.String({ pattern: "^ami-[a-f0-9]+$" }),
      instanceType: Type.String(),
      publicIp: Type.Optional(Type.Boolean()),

      initScript: Type.Optional(Type.String()),

      compose: Type.String(),

      specialPodType: Type.Optional(
        Type.Union([Type.Literal("long-lived-singleton")]),
      ),

      networkInterfaceId: Type.Optional(Type.TemplateLiteral("eni-${string}")),

      healthCheckGracePeriod: Type.Integer({ minimum: 0 }),
      minHealthyPercentage: Type.Integer({ minimum: 0 }),
      maxHealthyPercentage: Type.Integer({ minimum: 100, maximum: 200 }),
      minHealthyInstances: Type.Integer({ minimum: 0 }),
      onDemandBaseCapacity: Type.Integer({ minimum: 0 }),
      onDemandPercentageAboveBaseCapacity: Type.Integer({
        minimum: 0,
        maximum: 100,
      }),

      deploy: Type.Object({
        replaceWith: Type.Union([
          Type.Literal("new-instances"),
          Type.Literal("new-containers"),
        ]),
        detachBeforeContainerSwap: Type.Boolean({ default: true }),
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

    subnets: Type.Object({
      public: Type.Array(Type.String({ pattern: "^subnet-[a-f0-9]+$" })),
      private: Type.Array(Type.String({ pattern: "^subnet-[a-f0-9]+$" })),
    }),
  }),
});

const DEPLOY_CONFIG_COMPILER = TypeCompiler.Compile(DeployConfigSchema);

export type DeployConfig = Static<typeof DeployConfigSchema>;

// Hack to work around weird issue with Bun + typing
function extractErrors(iterator) {
  return [...iterator];
}

export function parseConfig(configPath: string) {
  let config: DeployConfig = parseYaml(readFileSync(configPath).toString());
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
    if (secretConfig.podsIncluded && secretConfig.podsExcluded) {
      throw new Error(
        `Secret ${secretName} cannot define both podsIncluded and podsExcluded--pick one or the other`,
      );
    }

    if (!secretConfig.podsIncluded && !secretConfig.podsExcluded) {
      throw new Error(
        `Secret ${secretName} must specify one of podsIncluded or podsExcluded`,
      );
    }

    if (secretConfig.podsIncluded?.length) {
      for (const podName of secretConfig.podsIncluded) {
        if (!config.pods[podName]) {
          throw new Error(
            `Secret ${secretName} allows access to pod ${podName} which does not exist`,
          );
        }
      }
    }

    if (secretConfig.podsExcluded?.length) {
      for (const podName of secretConfig.podsExcluded) {
        if (!config.pods[podName]) {
          throw new Error(
            `Secret ${secretName} prevents access to pod ${podName} which does not exist`,
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
