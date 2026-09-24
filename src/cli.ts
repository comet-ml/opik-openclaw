import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

type ConfigDeps = {
  currentConfig: () => OpenClawConfig;
  mutateConfig: (mutate: (draft: OpenClawConfig) => void) => Promise<void>;
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
  const { program, currentConfig, mutateConfig } = params;
  const deps: ConfigDeps = { currentConfig, mutateConfig };

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
