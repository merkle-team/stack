import { Command } from "@commander-js/extra-typings";
import { App } from "./app";
const program = new Command();

program.option("-d, --debug", "Display debug logs");

program.option(
  "-c, --config <path>",
  "Path to the configuration file",
  "deploy.yml",
);

program
  .command("it")
  .description("Deploy the application")
  .action(async () => {
    const options = program.opts();
    const app = new App(options);
    try {
      await app.deploy();
    } catch (e: unknown) {
      console.error(e);
      process.exit(1);
    }
  });

program.parse(process.argv);
