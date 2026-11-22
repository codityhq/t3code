import { assert, describe, it } from "@effect/vitest";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";

import * as KerlovCredentials from "./KerlovCredentials.ts";

const processOutput = TestSourceControlHost.processOutput;
const HELPER_ANSWER =
  "protocol=https\nhost=git.kerlov.com\nusername=bob\npassword=oauth_cli\npassword_expiry_utc=1800000000\n";

function harness(
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
  env: NodeJS.ProcessEnv = {},
) {
  const calls: Array<SourceControlHost.SourceControlProcessInput> = [];
  const layer = KerlovCredentials.layer.pipe(
    Layer.provideMerge(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            calls.push(input);
            return run(input);
          },
        },
      }),
    ),
    Layer.provide(Layer.succeed(HostProcess.Environment, env)),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/home/t3")),
    Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
  );
  return { layer, calls };
}

const notOnPath = (input: SourceControlHost.SourceControlProcessInput) =>
  Effect.fail(
    new VcsProcessSpawnError({
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      argumentCount: input.args.length,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
      }),
    }),
  );

describe("KerlovCredentials", () => {
  it("reads the password git's credential protocol answers with, and silence as none", () => {
    assert.strictEqual(KerlovCredentials.credentialHelperPassword(HELPER_ANSWER), "oauth_cli");
    assert.isNull(KerlovCredentials.credentialHelperPassword(""));
    assert.strictEqual(
      KerlovCredentials.CREDENTIAL_HELPER_INPUT,
      "protocol=https\nhost=git.kerlov.com\n\n",
    );
  });

  it("finds the CLI where its installers put it", () => {
    assert.strictEqual(
      KerlovCredentials.installedCliPath({ platform: "linux", env: {}, home: "/home/t3" }),
      "/home/t3/.kerlov/bin/kerlov",
    );
    assert.strictEqual(
      KerlovCredentials.installedCliPath({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\t3\\AppData\\Local" },
        home: "C:\\Users\\t3",
      }),
      "C:\\Users\\t3\\AppData\\Local\\kerlov\\kerlov.exe",
    );
  });

  it.effect("puts a saved API key before KERLOV_TOKEN, and KERLOV_TOKEN before the CLI", () => {
    const { layer, calls } = harness(() => Effect.succeed(processOutput(HELPER_ANSWER)), {
      KERLOV_TOKEN: "krl_env",
    });
    return Effect.gen(function* () {
      const credentials = yield* KerlovCredentials.KerlovCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      yield* settings.update({
        sourceControlHosts: { kerlov: { tokens: { "kerlov.com": "krl_saved" } } },
      });
      const saved = yield* credentials.get("git.kerlov.com");
      assert.strictEqual(Redacted.value(saved.token), "krl_saved");
      assert.strictEqual(saved.source, "settings");

      yield* settings.update({ sourceControlHosts: { kerlov: { tokens: {} } } });
      const fromEnv = yield* credentials.get("kerlov.com");
      assert.strictEqual(Redacted.value(fromEnv.token), "krl_env");
      assert.strictEqual(fromEnv.source, "env");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks the CLI's credential helper, from its install path when not on PATH", () => {
    const { layer, calls } = harness((input) =>
      input.command === "kerlov" ? notOnPath(input) : Effect.succeed(processOutput(HELPER_ANSWER)),
    );
    return Effect.gen(function* () {
      const credentials = yield* KerlovCredentials.KerlovCredentials;
      const credential = yield* credentials.get("kerlov.com");
      assert.strictEqual(Redacted.value(credential.token), "oauth_cli");
      assert.strictEqual(credential.source, "kerlov");
      assert.deepStrictEqual(
        calls.map((call) => [call.command, ...call.args]),
        [
          ["kerlov", "auth", "git-credential", "get"],
          ["/home/t3/.kerlov/bin/kerlov", "auth", "git-credential", "get"],
        ],
      );
      assert.strictEqual(calls[1]?.stdin, "protocol=https\nhost=git.kerlov.com\n\n");
      // Cached: the helper is not asked again for the next request.
      yield* credentials.get("api.kerlov.com");
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a CLI that is installed nowhere, and one with no login", () => {
    const missing = harness(notOnPath);
    const silent = harness(() => Effect.succeed(processOutput("")));
    return Effect.gen(function* () {
      const notInstalled = yield* Effect.flip(
        KerlovCredentials.KerlovCredentials.use((credentials) =>
          credentials.get("kerlov.com"),
        ).pipe(Effect.provide(missing.layer)),
      );
      assert.strictEqual(notInstalled._tag, "KerlovCliMissingError");
      const signedOut = yield* Effect.flip(
        KerlovCredentials.KerlovCredentials.use((credentials) =>
          credentials.get("kerlov.com"),
        ).pipe(Effect.provide(silent.layer)),
      );
      assert.strictEqual(signedOut._tag, "KerlovNotSignedInError");
    });
  });

  it.effect("refuses a host turned off in Settings and any host that is not Kerlov's", () => {
    const { layer, calls } = harness(() => Effect.succeed(processOutput(HELPER_ANSWER)), {
      KERLOV_TOKEN: "krl_env",
    });
    return Effect.gen(function* () {
      const credentials = yield* KerlovCredentials.KerlovCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      const foreign = yield* Effect.flip(credentials.get("git.kerlov.com.evil.test"));
      assert.strictEqual(foreign._tag, "KerlovUnknownHostError");
      yield* settings.update({
        sourceControlHosts: {
          kerlov: { hosts: { "kerlov.com": { enabled: false } }, tokens: { "kerlov.com": "krl" } },
        },
      });
      const disabled = yield* Effect.flip(credentials.get("kerlov.com"));
      assert.strictEqual(disabled._tag, "KerlovHostDisabledError");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(layer));
  });
});
