import {
  requireSettingsSecretLiteral,
  type ServerSettings,
  type SettingsSecretUnresolvedError,
  type VcsError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isMissingExecutable } from "@t3tools/source-control-core/server/discovery";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as Kerlov from "../shared/definition.ts";

/** OAuth access tokens are short-lived; the CLI refreshes them, so T3 asks again soon. */
const TOKEN_TTL = Duration.minutes(1);
const MISSING_TTL = Duration.seconds(10);

export const KerlovCredentialSource = Schema.Literals(["settings", "env", "kerlov"]);
export type KerlovCredentialSource = typeof KerlovCredentialSource.Type;

export interface KerlovCredential {
  readonly token: Redacted.Redacted<string>;
  readonly source: KerlovCredentialSource;
}

export class KerlovUnknownHostError extends Schema.TaggedError<KerlovUnknownHostError>()(
  "KerlovUnknownHostError",
  { host: Schema.String },
) {
  override get message(): string {
    return `${this.host} is not one of Kerlov's hosts.`;
  }
}

export class KerlovCliMissingError extends Schema.TaggedError<KerlovCliMissingError>()(
  "KerlovCliMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No Kerlov credential for ${this.host}: save an API key in Settings, set KERLOV_TOKEN, or install the kerlov CLI and run \`kerlov auth login\`.`;
  }
}

export class KerlovNotSignedInError extends Schema.TaggedError<KerlovNotSignedInError>()(
  "KerlovNotSignedInError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No Kerlov credential for ${this.host}: run \`kerlov auth login\` on the server, or save an API key in Settings.`;
  }
}

export class KerlovHostDisabledError extends Schema.TaggedError<KerlovHostDisabledError>()(
  "KerlovHostDisabledError",
  { host: Schema.String },
) {
  override get message(): string {
    return `Kerlov host ${this.host} is turned off in Settings → Source control & issues.`;
  }
}

export class KerlovCliFailedError extends Schema.TaggedError<KerlovCliFailedError>()(
  "KerlovCliFailedError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The kerlov CLI could not hand over a credential for ${this.host}. Check \`kerlov auth status\` on the server.`;
  }
}

export class KerlovCliTimeoutError extends Schema.TaggedError<KerlovCliTimeoutError>()(
  "KerlovCliTimeoutError",
  { host: Schema.String, timeoutMs: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The kerlov CLI did not hand over a credential for ${this.host} within ${this.timeoutMs / 1000} seconds. Try again.`;
  }
}

export type KerlovCredentialUnavailableError =
  | KerlovUnknownHostError
  | KerlovCliMissingError
  | KerlovNotSignedInError
  | KerlovHostDisabledError
  | KerlovCliFailedError
  | KerlovCliTimeoutError
  | SettingsSecretUnresolvedError;

/** Where requests to Kerlov get their token. The API layer asks; it never reads a source. */
export class KerlovCredentials extends Context.Service<
  KerlovCredentials,
  {
    readonly get: (
      host: string,
    ) => Effect.Effect<KerlovCredential, KerlovCredentialUnavailableError>;
    readonly invalidate: (host: string) => Effect.Effect<void>;
  }
>()("@t3tools/source-control-kerlov/server/KerlovCredentials") {}

/** KERLOV_TOKEN is T3's own convention; the CLI reads no token from the environment. */
export function environmentToken(env: Readonly<Record<string, string | undefined>>): string | null {
  return env.KERLOV_TOKEN?.trim() || null;
}

/** The `password=` git's credential protocol answers with; null when the helper stayed silent. */
export function credentialHelperPassword(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith("password=")) return line.slice("password=".length).trim() || null;
  }
  return null;
}

/** The helper keys a login by the gateway, the host git itself asks it about. */
export const CREDENTIAL_HELPER_INPUT = `protocol=https\nhost=${Kerlov.KERLOV_GATEWAY_HOST}\n\n`;

/** Where the installers put the CLI, which a service's PATH usually leaves out. */
export function installedCliPath(input: {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}): string {
  if (input.platform === "win32") {
    const local = input.env.LOCALAPPDATA?.trim() || `${input.home}\\AppData\\Local`;
    return `${local}\\kerlov\\kerlov.exe`;
  }
  return `${input.home}/.kerlov/bin/kerlov`;
}

const isNotFound = (error: VcsError) => isMissingExecutable(error);

/** Settings key tokens by the host typed in; any of Kerlov's three names its one account. */
const TOKEN_HOSTS = [Kerlov.KERLOV_WEB_HOST, Kerlov.KERLOV_GATEWAY_HOST, Kerlov.KERLOV_API_HOST];

/** @public */
export const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const environment = yield* HostProcess.Environment;
  const workingDirectory = yield* HostProcess.WorkingDirectory;
  const installed = installedCliPath({
    platform: yield* HostProcess.Platform,
    env: environment,
    home: yield* HostProcess.HomeDirectory,
  });
  const host = Kerlov.KERLOV_WEB_HOST;

  // The CLI's credential helper refreshes an expiring login under its own lock; T3 must never
  // refresh one itself, since the rotated refresh token would sign the CLI out.
  const runHelper = (command: string) =>
    sourceControlHost.process.run({
      operation: "KerlovCredentials.get",
      command,
      args: ["auth", "git-credential", "get"],
      cwd: workingDirectory,
      stdin: CREDENTIAL_HELPER_INPUT,
      timeoutMs: 15_000,
      maxOutputBytes: 16_000,
    });

  const fromCli = Effect.suspend(() => runHelper("kerlov")).pipe(
    Effect.catchIf(isNotFound, () => runHelper(installed)),
    Effect.mapError((error) =>
      isNotFound(error)
        ? new KerlovCliMissingError({ host })
        : error._tag === "VcsProcessTimeoutError"
          ? new KerlovCliTimeoutError({ host, timeoutMs: error.timeoutMs, cause: error })
          : new KerlovCliFailedError({ host, cause: error }),
    ),
    Effect.flatMap((output) => {
      const token = credentialHelperPassword(output.stdout);
      // The helper says nothing at all when it holds no login.
      return token === null
        ? Effect.fail(new KerlovNotSignedInError({ host }))
        : Effect.succeed(token);
    }),
  );

  const readSettings = (settings: ServerSettings) =>
    readSourceControlHostSettings(
      Kerlov.settings,
      settings.sourceControlHosts[Kerlov.definition.kind],
    );

  const enabled = sourceControlHost.settings.get.pipe(
    Effect.map((settings) => readSettings(settings).hosts[host]?.enabled !== false),
    Effect.orElseSucceed(() => true),
  );

  const savedToken = sourceControlHost.settings.getWithSecrets(Kerlov.definition.kind).pipe(
    Effect.map((settings) => {
      const tokens = readSettings(settings).tokens;
      return {
        token: TOKEN_HOSTS.map((name) => tokens[name]).find((token) => token !== undefined),
        secretProviders: settings.secretProviders,
      };
    }),
    Effect.orElseSucceed(() => ({ token: undefined, secretProviders: {} })),
    Effect.flatMap(({ token, secretProviders }) =>
      requireSettingsSecretLiteral(token, secretProviders),
    ),
    Effect.map((token) => token.trim() || null),
  );

  const lookup = Effect.fn("KerlovCredentials.lookup")(function* (_: string) {
    const fromEnv = environmentToken(environment);
    const token = fromEnv ?? (yield* fromCli);
    return {
      token: Redacted.make(token),
      source: fromEnv === null ? "kerlov" : "env",
    } satisfies KerlovCredential;
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 1,
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? TOKEN_TTL
        : Exit.findErrorOption(exit).pipe(
              Option.exists(
                (error) =>
                  error._tag === "KerlovCliFailedError" || error._tag === "KerlovCliTimeoutError",
              ),
            )
          ? Duration.zero
          : MISSING_TTL,
  });

  return KerlovCredentials.of({
    get: Effect.fn("KerlovCredentials.get")(function* (requested) {
      // Only Kerlov's own hosts get a token, whatever host a remote or link names.
      if (!Kerlov.isKerlovHost(requested))
        return yield* new KerlovUnknownHostError({ host: normalizeHost(requested) });
      if (!(yield* enabled)) return yield* new KerlovHostDisabledError({ host });
      const saved = yield* savedToken;
      if (saved !== null) return { token: Redacted.make(saved), source: "settings" as const };
      return yield* Cache.get(cache, host);
    }),
    invalidate: Effect.fn("KerlovCredentials.invalidate")(() => Cache.invalidate(cache, host)),
  });
});

export const layer = Layer.effect(KerlovCredentials, make);
