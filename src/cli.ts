import type { OpenClawConfig } from "openclaw/plugin-sdk";

type ConfigDeps = {
  loadConfig: () => OpenClawConfig;
  writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
};

type RegisterOpikCliParams = {
  program: any;
} & ConfigDeps;

async function runConfigureLazy(deps: ConfigDeps): Promise<void> {
  const { runOpikConfigure } = await import("./configure.js");
  await runOpikConfigure(deps);
}

async function showStatusLazy(deps: ConfigDeps): Promise<void> {
  const { showOpikStatus } = await import("./configure.js");
  showOpikStatus(deps);
}

export function registerOpikCli(params: RegisterOpikCliParams): void {
  const { program, loadConfig, writeConfigFile } = params;
  const deps: ConfigDeps = { loadConfig, writeConfigFile };

  const root = program.command("opik").description("Opik trace export integration");

  root
    .command("configure")
    .description("Interactive setup for Opik trace export")
    .action(async () => {
      await runConfigureLazy(deps);
    });

  root
    .command("status")
    .description("Show current Opik configuration")
    .action(async () => {
      await showStatusLazy(deps);
    });
}
