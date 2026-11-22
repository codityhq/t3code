import {
  SourceControlProviderError,
  type ChangeRequest,
  type ChangeRequestState,
  type SourceControlProviderAuth,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import {
  providerAuth,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as Kerlov from "../shared/definition.ts";
import * as KerlovApi from "./KerlovApi.ts";
import * as KerlovCredentials from "./KerlovCredentials.ts";
import * as Hosts from "./kerlovHosts.ts";
import * as Json from "./kerlovJson.ts";

const KIND = Kerlov.definition.kind;
const LABEL = "Kerlov";
const HOST = Kerlov.KERLOV_WEB_HOST;
/** Open pull requests read while looking for one branch's, newest first, as the CLI does. */
const BRANCH_PAGES = 5;

const INSTALL_HINT =
  "Install the Kerlov CLI with `curl -fsSL https://kerlov.com/install.sh | sh`, then run `kerlov auth login`, save an API key in Settings, or set KERLOV_TOKEN on the server.";

const SOURCE_DETAIL: Readonly<
  Record<KerlovCredentials.KerlovCredentialSource, string | undefined>
> = {
  settings: "Using the API key saved in Settings; it overrides KERLOV_TOKEN and the kerlov login.",
  env: "Using KERLOV_TOKEN from the server environment; it overrides the kerlov login.",
  kerlov: undefined,
};

/** Checks the credential a request would use against the API, which every source answers to. */
export const makeDiscovery = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const api = yield* KerlovApi.KerlovApi;
  const credentials = yield* KerlovCredentials.KerlovCredentials;
  const decodeUser = Schema.decodeEffect(Schema.fromJsonString(Json.KerlovCurrentUser));

  const probe = Effect.fn("KerlovSourceControlProvider.discovery")(function* (_cwd: string) {
    const item = (fields: {
      readonly auth: SourceControlProviderAuth;
      readonly available: boolean;
    }): SourceControlProviderDiscoveryItem => ({
      kind: KIND,
      label: LABEL,
      executable: "kerlov",
      status: fields.available ? "available" : "missing",
      version: Option.none(),
      installHint: INSTALL_HINT,
      detail: Option.none(),
      auth: fields.auth,
    });
    const settings = yield* sourceControlHost.settings.get.pipe(
      Effect.map((current) =>
        readSourceControlHostSettings(Kerlov.settings, current.sourceControlHosts[KIND]),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (settings?.hosts[HOST]?.enabled === false)
      return item({
        available: true,
        auth: providerAuth({
          status: "unauthenticated",
          host: HOST,
          detail: `${HOST} is turned off in Settings → Source control & issues.`,
        }),
      });
    const credential = yield* Effect.result(credentials.get(HOST));
    if (Result.isFailure(credential)) {
      const error = credential.failure;
      return item({
        available: error._tag !== "KerlovCliMissingError",
        auth:
          error._tag === "KerlovCliMissingError"
            ? providerAuth({ status: "unknown", detail: INSTALL_HINT })
            : providerAuth({
                status:
                  error._tag === "KerlovCliFailedError" || error._tag === "KerlovCliTimeoutError"
                    ? "unknown"
                    : "unauthenticated",
                host: HOST,
                detail: error.message,
              }),
      });
    }
    const user = yield* api.request({ host: HOST, operation: "discovery", path: "/v1/user" }).pipe(
      Effect.flatMap((raw) =>
        decodeUser(raw).pipe(
          Effect.mapError(
            (cause) =>
              new KerlovApi.KerlovApiError({
                host: HOST,
                operation: "discovery",
                status: null,
                reason: "failed",
                detail: "Kerlov returned an unreadable account.",
                cause,
              }),
          ),
        ),
      ),
      Effect.result,
    );
    const source = credential.success.source;
    return item({
      available: true,
      auth: Result.isSuccess(user)
        ? providerAuth({
            status: "authenticated",
            host: HOST,
            account: user.success.username,
            detail: SOURCE_DETAIL[source],
          })
        : providerAuth({
            status: user.failure.reason === "unauthenticated" ? "unauthenticated" : "unknown",
            host: HOST,
            detail:
              user.failure.reason === "unauthenticated"
                ? source === "kerlov"
                  ? "Kerlov refused the kerlov CLI's login. Run `kerlov auth login` again."
                  : `Kerlov refused ${source === "settings" ? "the API key saved in Settings" : "KERLOV_TOKEN"}.`
                : `Could not check the Kerlov credential: ${user.failure.detail}`,
          }),
    });
  });

  return {
    type: "managed-cli",
    kind: KIND,
    label: LABEL,
    installHint: INSTALL_HINT,
    probe,
    // Kerlov's remotes are recognized by host alone, so an unknown remote is never one.
    refineUnknownRemote: () => Effect.succeed(null),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

const cloneUrls = (repository: string) => {
  // The gateway serves git over HTTPS only.
  const url = Hosts.cloneUrl(repository);
  return { nameWithOwner: repository, url, sshUrl: url };
};

const listedState = (state: ChangeRequestState | "all") =>
  state === "open" ? "state:open" : state === "all" ? "" : "state:closed";

export const make = Effect.gen(function* () {
  const api = yield* KerlovApi.KerlovApi;
  const host = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;

  const error = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new SourceControlProviderError({
      provider: KIND,
      operation,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const send = (
    operation: string,
    cwd: string,
    request: Omit<KerlovApi.KerlovApiRequest, "operation">,
  ) =>
    api
      .request({ ...request, operation })
      .pipe(Effect.mapError((cause) => error(operation, cwd, cause.detail, cause)));
  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    cwd: string,
    request: Omit<KerlovApi.KerlovApiRequest, "operation">,
    schema: S,
  ) =>
    send(operation, cwd, request).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            error(operation, cwd, "Kerlov returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  const resolveTarget = Effect.fn("KerlovSourceControlProvider.resolveTarget")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository?: string;
    },
  ) {
    if (input.repository !== undefined) {
      const named =
        Hosts.parseKerlovRemote(input.repository) ?? Hosts.kerlovRepositoryPath(input.repository);
      if (named) return named;
      return yield* error(
        operation,
        input.cwd,
        "A Kerlov repository is named owner/name or by its URL.",
      );
    }
    const remoteUrl =
      input.context?.remoteUrl ??
      (yield* host.git.resolvePrimaryRemoteName(input.cwd).pipe(
        Effect.flatMap((remote) => host.git.readConfigValue(input.cwd, `remote.${remote}.url`)),
        Effect.mapError((cause) =>
          error(operation, input.cwd, "Could not read the Kerlov remote.", cause),
        ),
      ));
    const remote = remoteUrl ? Hosts.parseKerlovRemote(remoteUrl) : null;
    if (remote) return remote;
    return yield* error(operation, input.cwd, "No Kerlov repository remote was found.");
  });

  const toChangeRequest = (repository: string, pull: Json.KerlovPull): ChangeRequest => {
    const headSha = Json.knownOid(pull.head_oid);
    return {
      provider: KIND,
      number: pull.number,
      title: pull.title,
      url: Hosts.pullUrl(repository, pull.number),
      baseRefName: pull.base_ref,
      headRefName: pull.head_ref,
      ...(headSha === null ? {} : { headSha }),
      state: Json.stateOf(pull),
      ...(pull.draft ? { isDraft: true } : {}),
      closedAt: pull.closed_at,
      mergedAt: pull.merged_at,
      updatedAt: DateTime.make(pull.updated_at),
      // Kerlov has no forks.
      isCrossRepository: false,
      headRepositoryNameWithOwner: repository,
      headRepositoryOwnerLogin: repository.split("/")[0] ?? null,
    };
  };

  const getPull = Effect.fn("KerlovSourceControlProvider.getPull")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const reference = input.reference.trim();
    const link = Kerlov.parsePullRequestUrl(reference);
    const repository = link ? link.repository : yield* resolveTarget("getChangeRequest", input);
    const number = link ? link.number : Number(/^#?([1-9]\d*)$/u.exec(reference)?.[1]);
    if (!Number.isSafeInteger(number) || number < 1)
      return yield* error(
        "getChangeRequest",
        input.cwd,
        "A Kerlov pull request is a number or a pull request URL.",
      );
    const pull = yield* read(
      "getChangeRequest",
      input.cwd,
      { host: HOST, path: `/repos/${repository}/pulls/${number}` },
      Json.KerlovPullDetail,
    );
    return toChangeRequest(repository, pull);
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    repositoryNameFromRemoteUrl: Hosts.parseKerlovRemote,
    getChangeRequest: getPull,
    listChangeRequests: Effect.fn("KerlovSourceControlProvider.listChangeRequests")(
      function* (input) {
        const repository = yield* resolveTarget("listChangeRequests", input);
        const branch = SourceControlProvider.sourceBranch(input);
        const limit = input.limit ?? 20;
        const matches: Array<ChangeRequest> = [];
        let cursor: string | null = null;
        // The list has no head filter, so pages are read until the branch's pull requests turn up.
        for (let page = 0; page < BRANCH_PAGES && matches.length < limit; page++) {
          const query = new URLSearchParams({
            q: listedState(input.state),
            sort: "recently-updated",
            limit: "100",
          });
          if (cursor !== null) query.set("cursor", cursor);
          const listed: typeof Json.KerlovPulls.Type = yield* read(
            "listChangeRequests",
            input.cwd,
            { host: HOST, path: `/repos/${repository}/pulls?${query}` },
            Json.KerlovPulls,
          );
          for (const pull of listed.pulls) {
            const request = toChangeRequest(repository, pull);
            if (
              pull.head_ref === branch &&
              (input.state === "all" || request.state === input.state)
            )
              matches.push(request);
          }
          cursor = listed.next_cursor;
          if (cursor === null) break;
        }
        return matches.slice(0, limit);
      },
    ),
    createsDraftChangeRequests: true,
    createChangeRequest: Effect.fn("KerlovSourceControlProvider.createChangeRequest")(
      function* (input) {
        const repository = yield* resolveTarget("createChangeRequest", {
          ...input,
          ...(input.target?.repository ? { repository: input.target.repository } : {}),
        });
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        if (
          (source?.repository && source.repository.toLowerCase() !== repository.toLowerCase()) ||
          (source?.owner && source.owner.toLowerCase() !== repository.split("/")[0]?.toLowerCase())
        )
          return yield* error(
            "createChangeRequest",
            input.cwd,
            "Kerlov opens pull requests from a branch of the same repository. Push the branch there first.",
          );
        const body = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(
            Effect.mapError((cause) =>
              error(
                "createChangeRequest",
                input.cwd,
                "Could not read the pull request description.",
                cause,
              ),
            ),
          );
        yield* api
          .request({
            host: HOST,
            operation: "createChangeRequest",
            method: "POST",
            path: `/repos/${repository}/pulls`,
            body: {
              title: input.title,
              head_ref: SourceControlProvider.sourceBranch(input),
              base_ref: input.target?.refName ?? input.baseRefName,
              ...(body.trim().length === 0 ? {} : { body }),
              ...(input.draft === true ? { draft: true } : {}),
            },
          })
          .pipe(
            // 409: the branch pair already has an open pull request, which is what was asked for.
            Effect.catchIf(
              (cause) => cause.status === 409,
              () => Effect.succeed(""),
            ),
            Effect.mapError((cause) =>
              error("createChangeRequest", input.cwd, cause.detail, cause),
            ),
          );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("KerlovSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const repository = yield* resolveTarget("getRepositoryCloneUrls", input);
        // Confirms the repository exists and the credential can read it.
        yield* read(
          "getRepositoryCloneUrls",
          input.cwd,
          { host: HOST, path: `/repos/${repository}` },
          Json.KerlovRepository,
        );
        return cloneUrls(repository);
      },
    ),
    createRepository: Effect.fn("KerlovSourceControlProvider.createRepository")(function* (input) {
      const repository = yield* resolveTarget("createRepository", input);
      const [owner, name] = repository.split("/");
      yield* send("createRepository", input.cwd, {
        host: HOST,
        method: "POST",
        path: "/repos",
        body: { name, owner, visibility: input.visibility },
      });
      return cloneUrls(repository);
    }),
    getDefaultBranch: Effect.fn("KerlovSourceControlProvider.getDefaultBranch")(function* (input) {
      const repository = yield* resolveTarget("getDefaultBranch", input);
      const refs = yield* read(
        "getDefaultBranch",
        input.cwd,
        {
          host: HOST,
          origin: "gateway",
          path: `/api/repos/${repository}/refs`,
        },
        Json.KerlovRefs,
      );
      return refs.head?.replace(/^refs\/heads\//u, "") || null;
    }),
    // No forks: a pull request's head is always a branch of the repository itself.
    checkoutChangeRequest: Effect.fn("KerlovSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const pull = yield* getPull(input);
        const repository = yield* resolveTarget("checkoutChangeRequest", input).pipe(
          Effect.orElseSucceed(() => null),
        );
        const git = host.git;
        yield* Effect.gen(function* () {
          const remoteName =
            input.context && repository !== null && pull.headRepositoryNameWithOwner === repository
              ? input.context.remoteName
              : yield* git.ensureRemote({
                  cwd: input.cwd,
                  preferredName: "kerlov",
                  url: Hosts.cloneUrl(pull.headRepositoryNameWithOwner ?? ""),
                });
          const localBranch = pull.headRefName;
          const remoteBranch = { cwd: input.cwd, remoteName, remoteBranch: localBranch };
          const branches = yield* git.listLocalBranchNames(input.cwd);
          if (input.force !== true && !branches.includes(localBranch))
            yield* git.fetchRemoteBranch({ ...remoteBranch, localBranch });
          else yield* git.fetchRemoteTrackingBranch(remoteBranch);
          if (input.force === true)
            yield* git.execute({
              operation: "KerlovSourceControlProvider.checkoutChangeRequest",
              cwd: input.cwd,
              // The upstream is recorded next, through the host's serialized config write.
              args: [
                "checkout",
                "--no-track",
                "-B",
                localBranch,
                `refs/remotes/${remoteName}/${localBranch}`,
                "--",
              ],
            });
          yield* git.setBranchUpstream({ ...remoteBranch, branch: localBranch });
          yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
        }).pipe(
          Effect.mapError((cause) =>
            error(
              "checkoutChangeRequest",
              input.cwd,
              "Could not check out the Kerlov pull request.",
              cause,
            ),
          ),
        );
      },
    ),
  });
});
