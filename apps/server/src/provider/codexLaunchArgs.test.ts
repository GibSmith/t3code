import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexLaunchArgSettingSqliteHome,
  codexMcpListLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it.each([
    {
      name: "preserves escaped TOML quotes in config values",
      launchArgs: String.raw`--config model=\"gpt-6.1-sol\" --strict-config`,
      expected: ["--config", 'model="gpt-6.1-sol"', "--strict-config"],
    },
    {
      name: "lets launch args override the unload delay",
      launchArgs: "-c thread_unload_delay_secs=1800",
      expected: ["-c", "thread_unload_delay_secs=1800"],
    },
    {
      name: "preserves an escaped trailing space in the environment override",
      launchArgs: "--strict-config",
      environment: { T3CODE_CODEX_LAUNCH_ARGS: "--cloud-skills-snapshot skills.json\\ " },
      expected: ["--cloud-skills-snapshot", "skills.json "],
    },
    {
      name: "uses configured arguments when the environment override is blank",
      launchArgs: "--strict-config",
      environment: { T3CODE_CODEX_LAUNCH_ARGS: " \t " },
      expected: ["--strict-config"],
    },
  ])("asks Codex to unload unsubscribed threads immediately and $name", (row) => {
    const launchArgs = resolveCodexLaunchArgs(row.launchArgs, row.environment ?? {});
    NodeAssert.deepStrictEqual(codexAppServerArgs(launchArgs, undefined), [
      "app-server",
      "-c",
      "thread_unload_delay_secs=0",
      ...row.expected,
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs(
        '--strict-config --enable foo --listen off --config model="gpt 5"',
        undefined,
      ),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("keeps user hooks, apps, and plugins off during text generation", () => {
    const launchArgs =
      "--enable hooks --enable=hooks --enable codex_hooks --enable=codex_hooks --enable apps --enable=apps --enable connectors --enable=connectors --enable plugins --enable=plugins --enable foo --disable hooks";
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs, undefined), [
      "--enable",
      "foo",
      "--disable",
      "hooks",
    ]);
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs(launchArgs, undefined), [
      "--enable",
      "hooks",
      "--enable=hooks",
      "--enable",
      "codex_hooks",
      "--enable=codex_hooks",
      "--enable",
      "foo",
      "--disable",
      "hooks",
    ]);
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs("--config --strict-config --enable --disable", undefined),
      ["--strict-config"],
    );
  });
});

describe.each(["", "="])("codex exec and mcp list launch args with -p%swork", (separator) => {
  const launchArgs = `--strict-config --oss --local-provider ollama --profile local -p${separator}work -c${separator}model_provider=ollama --listen off --enable foo`;

  it("keeps the local model provider flags for codex exec", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(launchArgs, undefined), [
      "--strict-config",
      "--oss",
      "--local-provider",
      "ollama",
      "--profile",
      "local",
      "-p=work",
      "-c=model_provider=ollama",
      "--enable",
      "foo",
    ]);
  });

  it("keeps the selected profile and drops exec-only flags for codex mcp list", () => {
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs(launchArgs, undefined), [
      "--profile",
      "local",
      "-p=work",
      "-c=model_provider=ollama",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexLaunchArgSettingSqliteHome", () => {
  it.each([
    ['-c sqlite_home="/my shadow"', "sqlite_home=/my shadow"],
    ["--config sqlite_home=/shadow", "sqlite_home=/shadow"],
    ["--config=sqlite_home='/shadow'", "--config=sqlite_home=/shadow"],
    ["-csqlite_home=/shadow", "-csqlite_home=/shadow"],
    ["-c=sqlite_home=/shadow", "-c=sqlite_home=/shadow"],
    ["--strict-config -c ' sqlite_home = \"/shadow\"'", ' sqlite_home = "/shadow"'],
    // Codex 0.170.0 ignores a quoted key, but a later release may not.
    [`-c '"sqlite_home"="/shadow"'`, '"sqlite_home"="/shadow"'],
  ])("finds the override in %s", (launchArgs, expected) => {
    NodeAssert.equal(codexLaunchArgSettingSqliteHome(launchArgs), expected);
  });

  // regression: #24486 any argument holding `sqlite_home=` counted, so Windows refused an MCP
  // server's own variable and text that only mentioned the setting.
  it.each([
    `-c 'mcp_servers.example.env.sqlite_home="MCP-only"'`,
    `--config=mcp_servers.example.env.sqlite_home=MCP-only`,
    `-c 'developer_instructions="Leave sqlite_home=unset"'`,
    "-c sqlite_home.nested=1",
    "-c model=sqlite_home",
    "--strict-config --enable sqlite_home",
    "",
  ])("leaves %s alone", (launchArgs) => {
    NodeAssert.equal(codexLaunchArgSettingSqliteHome(launchArgs), undefined);
  });
});

describe("pinned SQLite home", () => {
  // regression: #24486 a sqlite_home in any Codex config layer outranked CODEX_SQLITE_HOME.
  it("puts the SQLite home T3 validated after the launch args of every Codex command", () => {
    const environment = { T3CODE_CODEX_SQLITE_HOME: String.raw`C:\Users\me\.codex` };
    const pin = ["-c", String.raw`sqlite_home='C:\Users\me\.codex'`];

    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config", environment), [
      "app-server",
      "-c",
      "thread_unload_delay_secs=0",
      "--strict-config",
      ...pin,
    ]);
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--strict-config", environment), [
      "--strict-config",
      ...pin,
    ]);
    NodeAssert.deepStrictEqual(codexMcpListLaunchArgs("--enable foo", environment), [
      "--enable",
      "foo",
      ...pin,
    ]);
    // A TOML literal string cannot hold an apostrophe.
    NodeAssert.deepStrictEqual(
      codexMcpListLaunchArgs("", { T3CODE_CODEX_SQLITE_HOME: String.raw`C:\O'Neil\.codex` }),
      ["-c", String.raw`sqlite_home="C:\\O'Neil\\.codex"`],
    );
  });
});
