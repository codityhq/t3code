import {
  resolvePullRequestAuthorFilter,
  type PullRequestCapabilities,
  type PullRequestListState,
  type PullRequestMergeCapabilities,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderChangeRequestDetail,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { definition } from "../shared/definition.ts";
import * as KerlovApi from "./KerlovApi.ts";
import * as Hosts from "./kerlovHosts.ts";
import * as Json from "./kerlovJson.ts";

const KIND = definition.kind;

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  search: true,
  reactions: true,
  labels: true,
  review: {
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["approve", "request-changes", "comment"],
  },
  reviewers: { request: true, listCandidates: false },
  edit: { changeRequest: true, comment: true },
};

/** Kerlov's list limit, and how many filtered-out pages one listing reads past. */
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const VIEWER_TTL = Duration.minutes(5);

type PullRef = ProviderRepositoryRef & { readonly number: number };

const MergeRequirements = Schema.Struct({
  viewer_merge_restricted: Schema.optional(Schema.Boolean),
  allowed_merge_methods: Schema.optional(Schema.Array(Schema.String)),
});

/** Free text is quoted so a colon in it is never read as a qualifier. */
export function listQuery(input: {
  readonly state: PullRequestListState;
  readonly involvement: "all" | "authored" | "reviewing";
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly author?: string | undefined;
  /** Each must be on a row; Kerlov ANDs repeated `label:` terms. */
  readonly labels?: ReadonlyArray<string> | undefined;
}): string {
  const terms: Array<string> = [];
  // Kerlov keeps merged pull requests closed; the merged are picked out after the read.
  if (input.state === "open") terms.push("state:open");
  if (input.state === "closed" || input.state === "merged") terms.push("state:closed");
  if (input.involvement === "authored") terms.push("author:@me");
  else if (input.author !== undefined)
    terms.push(`author:${resolvePullRequestAuthorFilter(input.author, input.viewer)}`);
  if (input.involvement === "reviewing") terms.push("review-requested:@me");
  for (const label of input.labels ?? []) terms.push(`label:"${label.replaceAll('"', "")}"`);
  const text = input.query?.replaceAll('"', "").trim();
  if (text) terms.push(`"${text}"`);
  return terms.join(" ");
}

export const make = Effect.gen(function* () {
  const api = yield* KerlovApi.KerlovApi;

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: KIND,
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const toProviderError = (operation: string) => (error: KerlovApi.KerlovApiError) =>
    new PullRequestProviderError({
      provider: KIND,
      operation,
      reason: error.reason,
      detail: error.detail,
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      cause: error,
    });

  const target = (operation: string, input: ProviderRepositoryRef) => {
    const repository = Hosts.kerlovRepositoryPath(input.repository);
    return Hosts.isKerlovHost(input.host) && repository !== null
      ? Effect.succeed({ repository, base: `/repos/${repository}` })
      : Effect.fail(
          failure(operation, "Kerlov serves owner/name repositories on kerlov.com alone."),
        );
  };

  const send = (
    operation: string,
    input: Pick<ProviderRepositoryRef, "host">,
    request: Omit<KerlovApi.KerlovApiRequest, "operation" | "host">,
  ) =>
    api
      .request({ ...request, host: input.host, operation })
      .pipe(Effect.mapError(toProviderError(operation)));

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: Pick<ProviderRepositoryRef, "host">,
    request: Omit<KerlovApi.KerlovApiRequest, "operation" | "host">,
    schema: S,
  ) =>
    send(operation, input, request).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            failure(operation, "Kerlov returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  const readPull = Effect.fn("KerlovPullRequestProvider.readPull")(function* (
    operation: string,
    input: PullRef,
  ) {
    const { base } = yield* target(operation, input);
    return yield* read(
      operation,
      input,
      { path: `${base}/pulls/${input.number}` },
      Json.KerlovPullDetail,
    );
  });

  const readChecks = Effect.fn("KerlovPullRequestProvider.readChecks")(function* (
    operation: string,
    input: PullRef,
  ) {
    const { base } = yield* target(operation, input);
    const runs = yield* read(
      operation,
      input,
      { path: `${base}/pulls/${input.number}/check-runs` },
      Json.KerlovCheckRuns,
    );
    return Json.toChecks(runs);
  });

  const viewers = yield* Cache.makeWith(
    (host: string) =>
      read("getViewer", { host }, { path: "/v1/user" }, Json.KerlovCurrentUser).pipe(
        Effect.map((user) => user.username),
      ),
    {
      capacity: 4,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? VIEWER_TTL : Duration.zero),
    },
  );
  const viewerOf = (host: string) => Cache.get(viewers, host.toLowerCase());

  const permissionsOf = (
    pull: Json.KerlovPull,
    viewer: string | null,
  ): PullRequestViewerPermissions => {
    const state = Json.stateOf(pull);
    const open = state === "open";
    const authored =
      viewer !== null && pull.author?.username.toLowerCase() === viewer.toLowerCase();
    return {
      actions: open
        ? [pull.draft ? "ready" : "draft", "close", ...(pull.draft ? [] : (["merge"] as const))]
        : state === "closed"
          ? ["reopen"]
          : [],
      comment: pull.locked !== true,
      resolve: true,
      verdicts: authored ? ["comment"] : ["approve", "request-changes", "comment"],
      requestReviewers: open,
      labels: true,
      editChangeRequest: true,
    };
  };

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    unavailableRequirement: {
      missing:
        "Install the kerlov CLI and run `kerlov auth login`, save a Kerlov API key in Settings, or set KERLOV_TOKEN on the server.",
      unauthenticated:
        "Kerlov refused the server's credential. Run `kerlov auth login` again, or replace the API key saved in Settings.",
    },
    readsPublicHostWithoutCheckout: true,
    servesHost: Hosts.isKerlovHost,
    getViewer: (input) => viewerOf(input.host ?? definition.publicHost ?? ""),

    listChangeRequests: Effect.fn("KerlovPullRequestProvider.listChangeRequests")(
      function* (input) {
        const { base, repository } = yield* target("listChangeRequests", input);
        // A group naming one label is a plain requirement; the caller applies the rest.
        const labels = (input.filters?.labels ?? []).flatMap((group) =>
          group.length === 1 ? group : [],
        );
        const q = listQuery({
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          query: input.query,
          author: input.filters?.author,
          labels,
        });
        const limit = Math.min(PAGE_SIZE, Math.max(1, input.limit));
        const keep = (pull: Json.KerlovPull) => input.state !== "merged" || Json.isMerged(pull);
        let cursor = input.cursor?.resumeAfter ?? null;
        const items: Array<Json.KerlovPull> = [];
        // A page the merged filter empties reads on, so a listing does not end early.
        for (let page = 0; page < MAX_PAGES; page++) {
          const query = new URLSearchParams({ q, sort: "recently-updated", limit: String(limit) });
          if (cursor !== null) query.set("cursor", cursor);
          const listed: typeof Json.KerlovPulls.Type = yield* read(
            "listChangeRequests",
            input,
            { path: `${base}/pulls?${query}` },
            Json.KerlovPulls,
          );
          items.push(...listed.pulls.filter(keep));
          cursor = listed.next_cursor;
          if (cursor === null || items.length > 0) break;
        }
        return {
          ...(cursor === null ? {} : { resumeAfter: cursor }),
          items: items.map((pull) => Json.toChangeRequest(pull, repository)),
          truncated: cursor !== null,
          continues: cursor !== null,
        };
      },
    ),

    getChangeRequest: Effect.fn("KerlovPullRequestProvider.getChangeRequest")(function* (input) {
      const operation = "getChangeRequest";
      const { base, repository } = yield* target(operation, input);
      const [pull, checks, viewer, requirements] = yield* Effect.all(
        [
          readPull(operation, input),
          readChecks(operation, input).pipe(Effect.orElseSucceed(() => [])),
          viewerOf(input.host).pipe(Effect.orElseSucceed(() => null)),
          read(
            operation,
            input,
            { path: `${base}/pulls/${input.number}/merge-requirements` },
            MergeRequirements,
          ).pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: 4 },
      );
      const allowed = new Set(requirements?.allowed_merge_methods ?? ["merge", "squash", "rebase"]);
      const mergeCapabilities: PullRequestMergeCapabilities = {
        merge: allowed.has("merge"),
        squash: allowed.has("squash"),
        rebase: allowed.has("rebase"),
      };
      const permissions = permissionsOf(pull, viewer);
      const checksState = Json.checksStateOf(checks);
      const detail: ProviderChangeRequestDetail = {
        ...Json.toChangeRequest(pull, repository),
        headSha: Json.knownOid(pull.head_oid),
        body: pull.body ?? "",
        changedFiles: pull.changed_files ?? 0,
        mergedAt: pull.merged_at,
        mergeCommitSha: pull.merge_commit_oid,
        closedAt: pull.closed_at,
        reviewers: [],
        checks,
        ...(checksState === null ? {} : { checksState }),
        mergeCapabilities,
        baseComparison: pull.merge_state === "behind" ? "behind" : "unknown",
        viewerPermissions:
          requirements?.viewer_merge_restricted === true
            ? {
                ...permissions,
                actions: permissions.actions.filter((action) => action !== "merge"),
              }
            : permissions,
      };
      return detail;
    }),

    getChangeRequestChecks: Effect.fn("KerlovPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const [pull, checks] = yield* Effect.all(
          [readPull("getChangeRequestChecks", input), readChecks("getChangeRequestChecks", input)],
          { concurrency: 2 },
        );
        return { checks, state: Json.stateOf(pull) };
      },
    ),

    getChangeRequestActivity: Effect.fn("KerlovPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const operation = "getChangeRequestActivity";
        const { base, repository } = yield* target(operation, input);
        const path = `${base}/pulls/${input.number}`;
        const [pull, listed, reviews, threads] = yield* Effect.all(
          [
            readPull(operation, input),
            read(
              operation,
              input,
              { path: `${base}/issues/${input.number}/comments?limit=${PAGE_SIZE}` },
              Json.KerlovComments,
            ),
            read(operation, input, { path: `${path}/reviews` }, Json.KerlovReviews),
            read(operation, input, { path: `${path}/threads` }, Json.KerlovThreads),
          ],
          { concurrency: 4 },
        );
        const range = Json.diffRange(pull);
        // Without the gateway's answer the conversation still shows; only the commits are missing.
        const compare =
          range === null
            ? null
            : yield* read(
                operation,
                input,
                {
                  origin: "gateway",
                  path: `/api/repos/${repository}/compare?${new URLSearchParams(range)}`,
                },
                Json.KerlovCompare,
              ).pipe(Effect.orElseSucceed(() => null));
        const subject = { repository, number: input.number };
        const conversation = Json.toComments(listed, subject);
        const comments = [...conversation, ...Json.toReviewComments(reviews, subject)].toSorted(
          (a, b) => a.createdAt.localeCompare(b.createdAt),
        );
        return {
          author: Json.toActor(pull.author),
          comments,
          commentCount: comments.length,
          commentsTruncated: listed.next_cursor !== null,
          reviewThreads: Json.toReviewThreads(threads, subject),
          commits: compare === null ? [] : Json.toCommits(compare),
          reactions: Json.toReactions(pull.reactions),
        };
      },
    ),

    getViewerPermissions: Effect.fn("KerlovPullRequestProvider.getViewerPermissions")(
      function* (input) {
        const [pull, viewer] = yield* Effect.all(
          [readPull("getViewerPermissions", input), viewerOf(input.host)],
          { concurrency: 2 },
        );
        return permissionsOf(pull, viewer);
      },
    ),

    getDiff: Effect.fn("KerlovPullRequestProvider.getDiff")(function* (input) {
      if (input.commit !== undefined)
        return yield* failure("getDiff", "Kerlov cannot show one commit's diff here yet.");
      const pull = yield* readPull("getDiff", input);
      const range = Json.diffRange(pull);
      if (range === null)
        return yield* failure(
          "getDiff",
          "Kerlov has not compared this pull request's branches yet.",
        );
      const { repository } = yield* target("getDiff", input);
      const query = new URLSearchParams({ base: range.base, head: range.head });
      if (input.path !== undefined) query.append("path", input.path);
      const patch = yield* send("getDiff", input, {
        origin: "gateway",
        path: `/api/repos/${repository}/patch?${query}`,
        accept: "text/plain",
      });
      return { patch, truncated: false, nextCursor: null };
    }),

    runAction: Effect.fn("KerlovPullRequestProvider.runAction")(function* (input) {
      const { base } = yield* target(input.action, input);
      const path = `${base}/pulls/${input.number}`;
      switch (input.action) {
        case "merge": {
          const method = input.mergeMethod ?? "merge";
          if (method === "fast-forward")
            return yield* failure("merge", "Kerlov merges by merge, squash or rebase.");
          yield* send("merge", input, {
            method: "POST",
            path: `${path}/merge`,
            body: {
              method,
              ...(input.expectedHeadSha === undefined
                ? {}
                : { expected_head_oid: input.expectedHeadSha }),
            },
          });
          return;
        }
        case "close":
        case "reopen":
          yield* send(input.action, input, {
            method: "PATCH",
            path,
            body: { state: input.action === "close" ? "closed" : "open" },
          });
          return;
        case "ready":
        case "draft":
          yield* send(input.action, input, {
            method: "PATCH",
            path,
            body: { draft: input.action === "draft" },
          });
          return;
        default:
          return yield* failure(input.action, `Kerlov cannot ${input.action} from T3 Code.`);
      }
    }),

    updateChangeRequest: Effect.fn("KerlovPullRequestProvider.updateChangeRequest")(
      function* (input) {
        const { base } = yield* target("updateChangeRequest", input);
        yield* send("updateChangeRequest", input, {
          method: "PATCH",
          path: `${base}/pulls/${input.number}`,
          body: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          },
        });
      },
    ),

    comment: Effect.fn("KerlovPullRequestProvider.comment")(function* (input) {
      const { base } = yield* target("comment", input);
      yield* send("comment", input, {
        method: "POST",
        path: `${base}/issues/${input.number}/comments`,
        body: { body: input.body },
      });
    }),

    updateComment: Effect.fn("KerlovPullRequestProvider.updateComment")(function* (input) {
      if (input.kind !== "issue-comment")
        return yield* failure(
          "updateComment",
          "Kerlov edits a line comment only through its thread, which T3 does not pass.",
        );
      const { base } = yield* target("updateComment", input);
      yield* send("updateComment", input, {
        method: "PATCH",
        path: `${base}/issues/${input.number}/comments/${encodeURIComponent(input.commentId)}`,
        body: { body: input.body },
      });
    }),

    submitReview: Effect.fn("KerlovPullRequestProvider.submitReview")(function* (input) {
      const pull = yield* readPull("submitReview", input);
      const headOid = Json.knownOid(pull.head_oid);
      if (headOid === null)
        return yield* failure("submitReview", "Kerlov has not reported the pull request's head.");
      const { base } = yield* target("submitReview", input);
      const path = `${base}/pulls/${input.number}`;
      const event =
        input.verdict === "approve"
          ? "approve"
          : input.verdict === "request-changes"
            ? "request_changes"
            : "comment";
      const summary = input.body.length === 0 ? {} : { body: input.body };
      if (input.comments.length === 0) {
        yield* send("submitReview", input, {
          method: "POST",
          path: `${path}/reviews`,
          body: { event, head_oid: headOid, ...summary },
        });
        return;
      }
      // Line comments go out as drafts of a pending review, then land together when it is submitted.
      const pending = yield* read(
        "submitReview",
        input,
        { method: "POST", path: `${path}/reviews`, body: { event: "pending", head_oid: headOid } },
        Json.KerlovReviewCreated,
      );
      const review = `${path}/reviews/${encodeURIComponent(pending.review_id)}`;
      yield* Effect.forEach(
        input.comments,
        (comment) =>
          send("submitReview", input, {
            method: "POST",
            path: `${path}/threads`,
            body: Json.toThreadBody(comment, headOid, pending.review_id),
          }),
        { discard: true },
      ).pipe(
        Effect.andThen(
          send("submitReview", input, {
            method: "POST",
            path: `${review}/submit`,
            body: { event, ...summary },
          }),
        ),
        // A pending review left behind would refuse the next one, so a failed submit discards it.
        Effect.tapError(() =>
          send("submitReview", input, { method: "DELETE", path: review }).pipe(Effect.ignore),
        ),
      );
    }),

    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),

    setReviewerRequest: Effect.fn("KerlovPullRequestProvider.setReviewerRequest")(
      function* (input) {
        const { base } = yield* target("setReviewerRequest", input);
        const reviewers = input.reviewers.filter((reviewer) => reviewer.kind !== "team");
        const teams = input.reviewers.filter((reviewer) => reviewer.kind === "team");
        yield* send("setReviewerRequest", input, {
          method: input.requested ? "POST" : "DELETE",
          path: `${base}/pulls/${input.number}/reviewers`,
          body: {
            ...(reviewers.length === 0 ? {} : { reviewers: reviewers.map(({ id }) => id) }),
            ...(teams.length === 0 ? {} : { teams: teams.map(({ id }) => id) }),
          },
        });
      },
    ),

    listLabelCandidates: Effect.fn("KerlovPullRequestProvider.listLabelCandidates")(
      function* (input) {
        const { base } = yield* target("listLabelCandidates", input);
        const [labels, pull] = yield* Effect.all(
          [
            read(
              "listLabelCandidates",
              input,
              { path: `${base}/labels` },
              Json.KerlovRepositoryLabels,
            ),
            readPull("listLabelCandidates", input),
          ],
          { concurrency: 2 },
        );
        const applied = new Set((pull.labels ?? []).map((label) => label.name));
        return {
          candidates: labels.labels.map((label) => ({
            name: label.name,
            color: label.color,
            description: label.description,
            isApplied: applied.has(label.name),
          })),
          truncated: false,
        };
      },
    ),

    listRepositoryLabels: Effect.fn("KerlovPullRequestProvider.listRepositoryLabels")(
      function* (input) {
        const { base } = yield* target("listRepositoryLabels", input);
        const labels = yield* read(
          "listRepositoryLabels",
          input,
          { path: `${base}/labels` },
          Json.KerlovRepositoryLabels,
        );
        return {
          items: labels.labels.map((label) => ({ name: label.name, color: label.color })),
          truncated: false,
        };
      },
    ),

    setLabels: Effect.fn("KerlovPullRequestProvider.setLabels")(function* (input) {
      const { base } = yield* target("setLabels", input);
      yield* send("setLabels", input, {
        method: input.applied ? "POST" : "DELETE",
        path: `${base}/issues/${input.number}/labels`,
        body: { labels: input.labels },
      });
    }),

    replyToThread: Effect.fn("KerlovPullRequestProvider.replyToThread")(function* (input) {
      const { base } = yield* target("replyToThread", input);
      yield* send("replyToThread", input, {
        method: "POST",
        path: `${base}/pulls/${input.number}/threads/${encodeURIComponent(input.threadId)}/comments`,
        body: { body: input.body },
      });
    }),

    // A thread comment is a comment of the pull request's issue, so one route reacts to both.
    setReaction: Effect.fn("KerlovPullRequestProvider.setReaction")(function* (input) {
      const { base } = yield* target("setReaction", input);
      const subject =
        input.subjectId === undefined
          ? `${base}/issues/${input.number}`
          : `${base}/issues/${input.number}/comments/${encodeURIComponent(input.subjectId)}`;
      yield* send("setReaction", input, {
        method: input.reacted ? "POST" : "DELETE",
        path: `${subject}/reactions`,
        body: { content: Json.kerlovReactionContent(input.content) },
      });
    }),

    setThreadResolution: Effect.fn("KerlovPullRequestProvider.setThreadResolution")(
      function* (input) {
        const { base } = yield* target("setThreadResolution", input);
        yield* send("setThreadResolution", input, {
          method: "POST",
          path: `${base}/pulls/${input.number}/threads/${encodeURIComponent(input.threadId)}/${input.resolved ? "resolve" : "unresolve"}`,
        });
      },
    ),
  };
  return provider;
});
