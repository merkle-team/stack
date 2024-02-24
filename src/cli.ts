import { Command } from "@commander-js/extra-typings";
import { App } from "./app";
const program = new Command();

program.option("-d, --debug", "Display debug logs");

program
  .command("it")
  .description("Deploy the application")
  .action(() => {
    const options = program.opts();
    const app = new App(options);
    app.deploy();
  });

program.parse(process.argv);
