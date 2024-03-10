import { Command } from "@commander-js/extra-typings";
import { App } from "./app";

const program = new Command();

program.option("-d, --debug", "Display debug logs");
program.option("-y, --yes", "Accept all prompts (POTENTIALLY DANGEROUS!)");

program.option(
  "-c, --config <path>",
  "Path to the configuration file",
  "deploy.yml",
);

program
  .command("init")
  .description("Initialize/upgrade local Terraform providers/modules")
  .action(async () => {
    const app = new App(program.opts());
    await app.init({ upgrade: true });
    process.exit(0);
  });

program
  .command("deploy")
  .description("Deploy this stack")
  .action(async () => {
    const app = new App(program.opts());
    await app.deploy();
  });

program
  .command("plan")
  .description("Generate a deployment plan for this stack")
  .action(async () => {
    const app = new App(program.opts());
    await app.plan();
  });

program
  .command("destroy")
  .description("Destroy all resources for this stack")
  .action(async () => {
    const app = new App(program.opts());
    await app.destroy();
  });

program
  .command("lint")
  .description("Validate configuration and report any issues/errors")
  .action(async () => {
    const app = new App(program.opts());
    await app.lint();
  });

program
  .command("console")
  .description("Open a console to a pod in this stack")
  .argument("[pod]", "Pod to connect to")
  .action(async (pod) => {
    const app = new App(program.opts());
    await app.console(pod);
  });

program.parse(process.argv);
