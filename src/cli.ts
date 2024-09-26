import { Command } from "@commander-js/extra-typings";
import { App } from "./app";

const CLI_PATH = import.meta.path;

function generateReleaseId() {
  if (process.env.RELEASE !== undefined) return process.env.RELEASE;
  return `${new Date()
    .toISOString()
    .replace(/\:/g, "-")
    .replace(/\./g, "-")
    .replace("Z", "z")}`;
}

const program = new Command();

program.option("-d, --debug", "Display debug logs");
program.option("-y, --yes", "Accept all prompts (POTENTIALLY DANGEROUS!)");
program.option(
  "-w, --workdir <path>",
  "Working directory to use",
  (workdir) => {
    if (workdir) {
      process.chdir(workdir);
    }
  }
);
program.option(
  "-c, --config <path>",
  "Path to the configuration file",
  "deploy.yml"
);

program
  .command("synth")
  .description("Synthesize Terraform configuration for the specified stacks(s)")
  .argument(
    "[stacks...]",
    "Stack(s) to synthesize. If unspecified, all stacks are synthesized.",
    ["*"]
  )
  .option(
    "-r, --release <releaseId>",
    "Name to use for the release (defaults to a timestamp)",
    generateReleaseId()
  )
  .action(async (stacks, options) => {
    const app = new App(CLI_PATH, program.opts());
    process.exit(await app.synth(stacks));
  });

program
  .command("_cdktf-synth")
  .description("Internal use only")
  .option(
    "-r, --release <releaseId>",
    "Name to use for the release (defaults to a timestamp)",
    generateReleaseId()
  )
  .action(async (options) => {
    const app = new App(CLI_PATH, program.opts());
    process.exit(await app._synth({ ...options }));
  });

program
  .command("deploy")
  .description("Deploy this stack")
  .argument(
    "[pods...]",
    "Pod(s) to deploy. If unspecified, all pods are deployed.",
    []
  )
  .option(
    "--skip-apply",
    "Skip the apply step (faster for container swap deploys)",
    false
  )
  .option("--apply-only", "Skip the deploy step after the apply", false)
  .action(async (pods, options) => {
    const app = new App(CLI_PATH, { ...program.opts(), ...options });
    process.exit(await app.deploy(pods));
  });

program
  .command("plan")
  .description("Generate a deployment plan the specified stacks")
  .argument(
    "[stacks...]",
    "Stack to plan. If unspecified, all stacks are planned.",
    []
  )
  .action(async (stacks) => {
    const app = new App(CLI_PATH, program.opts());
    process.exit(await app.plan(stacks));
  });

program
  .command("destroy")
  .description("Destroy all resources for the specified stacks")
  .argument(
    "[stacks...]",
    "Stack to plan. If unspecified, all stacks are planned.",
    []
  )
  .action(async (stacks) => {
    const app = new App(CLI_PATH, program.opts());
    process.exit(await app.destroy(stacks));
  });

program
  .command("lint")
  .description("Validate configuration and report any issues/errors")
  .action(async () => {
    const app = new App(CLI_PATH, program.opts());
    process.exit(await app.lint());
  });

program
  .command("console")
  .description("Open a console to a pod in this stack")
  .argument("[pod]", "Pod to connect to")
  .action(async (pod) => {
    const app = new App(CLI_PATH, program.opts());
    process.exit(await app.console((pod || "").replace(/^pod:/, "")));
  });

program.parse(process.argv);
