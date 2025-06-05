import { Command } from "@commander-js/extra-typings";
import { App } from "./app";
import { version } from "../package.json" assert { type: "json" };

const CLI_PATH = import.meta.path;

function generateReleaseId() {
  // Store the release ID in an environment variable so that we can pass to subprocesses,
  // reusing any previously defined one if provided.
  return (
    process.env["RELEASE_ID"] ||
    `${new Date()
      .toISOString()
      .replace(/\:/g, "-")
      .replace(/\./g, "-")
      .replace("Z", "z")}`
  );
}
const DEFAULT_RELEASE_ID = generateReleaseId();

const program = new Command();

program.version(version);
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
  ".stack/deploy.yml"
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
    DEFAULT_RELEASE_ID
  )
  .action(async (stacks, options) => {
    const app = new App(CLI_PATH, { ...program.opts(), ...options });
    process.exit(await app.synth(stacks));
  });

program
  .command("_cdktf-synth")
  .description("Internal use only")
  .option(
    "-r, --release <releaseId>",
    "Name to use for the release (defaults to a timestamp)",
    DEFAULT_RELEASE_ID
  )
  .action(async (options) => {
    const app = new App(CLI_PATH, { ...program.opts(), ...options });
    process.exit(await app._synth());
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
    "-r, --release <releaseId>",
    "Name to use for the release (defaults to a timestamp)",
    DEFAULT_RELEASE_ID
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
  .option(
    "-r, --release <releaseId>",
    "Name to use for the release (defaults to a timestamp)",
    DEFAULT_RELEASE_ID
  )
  .action(async (stacks, options) => {
    const app = new App(CLI_PATH, { ...program.opts(), ...options });
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
  .option(
    "-r, --release <releaseId>",
    "Name to use for the release (defaults to a timestamp)",
    DEFAULT_RELEASE_ID
  )
  .action(async (options) => {
    const app = new App(CLI_PATH, { ...program.opts(), ...options });
    process.exit(await app.lint());
  });

program
  .command("unlock")
  .description("Remove any active locks on the specified stack(s)")
  .argument(
    "[stacks...]",
    "Stack to unlock. If unspecified, all stacks are unlocked.",
    []
  )
  .action(async (stacks) => {
    const app = new App(CLI_PATH, program.opts());
    process.exit(await app.unlock(stacks));
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
