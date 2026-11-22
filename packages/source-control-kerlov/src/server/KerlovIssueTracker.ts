import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueComment,
  type IssueListSort,
  type IssueState,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueInvolvementFilter,
  type IssueScopeTarget,
  type IssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { definition } from "../shared/definition.ts";
import * as KerlovApi from "./KerlovApi.ts";
import * as Hosts from "./kerlovHosts.ts";
import * as Json from "./kerlovJson.ts";

const KIND = IssueTrackerKind.make(definition.kind);

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  // Kerlov lists no repository's assignable people to pick from.
  assignees: false,
  reactions: true,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

const OPEN: IssueState = { category: "open", name: "Open" };
const CLOSED: IssueState = { category: "closed", name: "Closed" };
const STATES: ReadonlyArray<IssueState> = [OPEN, CLOSED];
const PAGE_SIZE = 100;

/** An issue row of `GET /repos/:o/:r/issues` (lib/issue-views.ts `issueListJson`). */
const KerlovIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  kind: Schema.optional(Schema.String),
  state: Schema.Literals(["open", "closed"]),
  author: Schema.NullOr(Json.KerlovUser),
  assignees: Schema.optional(Schema.Array(Json.KerlovUser)),
  labels: Schema.optional(Schema.Array(Json.KerlovLabel)),
  comment_count: Schema.optional(Schema.Int),
  locked: Schema.optional(Schema.Boolean),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
});
type KerlovIssue = typeof KerlovIssue.Type;

export const KerlovIssues = Schema.Struct({
  issues: Schema.Array(KerlovIssue),
  next_cursor: Schema.NullOr(Schema.String),
});

/** `GET /repos/:o/:r/issues/:n` (`issueDetailJson`), which answers for pull requests too. */
const KerlovIssueDetail = Schema.Struct({
  ...KerlovIssue.fields,
  body: Schema.NullOr(Schema.String),
  close_reason: Schema.optional(Schema.NullOr(Schema.String)),
  reactions: Schema.optional(Json.KerlovReactions),
});

const Created = Schema.Struct({ number: Schema.Int });

const issueUrl = (scope: string, number: number | string) =>
  `${Hosts.webRepositoryUrl(scope)}/issues/${number}`;

/** Free text is quoted so a colon in it is never read as a qualifier. */
export function issueQuery(
  input: IssueInvolvementFilter & {
    readonly state: "all" | "open" | "closed";
    readonly query?: string | undefined;
    readonly labels?: ReadonlyArray<string> | undefined;
    readonly assignee?: string | undefined;
  },
): string {
  const terms: Array<string> = [];
  if (input.state !== "all") terms.push(`state:${input.state}`);
  if (input.involvement === "authored") terms.push("author:@me");
  if (input.involvement === "mentioned") terms.push("mentions:@me");
  if (input.assignee !== undefined) terms.push(`assignee:${input.assignee}`);
  else if (input.involvement === "assigned") terms.push("assignee:@me");
  for (const label of input.labels ?? []) terms.push(`label:"${label.replaceAll('"', "")}"`);
  const text = input.query?.replaceAll('"', "").trim();
  if (text) terms.push(`"${text}"`);
  return terms.join(" ");
}

const SORTS: Readonly<Record<IssueListSort, string>> = {
  updated: "recently-updated",
  created: "newest",
};

export const make = Effect.gen(function* () {
  const api = yield* KerlovApi.KerlovApi;

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new IssueTrackerError({
      tracker: KIND,
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const base = (operation: string, input: IssueScopeTarget) => {
    const repository = Hosts.kerlovRepositoryPath(input.scope);
    return Hosts.isKerlovHost(input.host) && repository !== null
      ? Effect.succeed(`/repos/${repository}`)
      : Effect.fail(failure(operation, "Kerlov issues live in owner/name repositories."));
  };

  const issuePath = (operation: string, input: IssueScopeTarget & { readonly key: string }) =>
    /^[1-9]\d*$/u.test(input.key)
      ? Effect.map(base(operation, input), (path) => `${path}/issues/${input.key}`)
      : Effect.fail(failure(operation, "Kerlov issue keys are numbers."));

  const send = (
    operation: string,
    input: Pick<IssueScopeTarget, "host">,
    request: Omit<KerlovApi.KerlovApiRequest, "operation" | "host">,
  ) =>
    api.request({ ...request, host: input.host, operation }).pipe(
      Effect.mapError(
        (error) =>
          new IssueTrackerError({
            tracker: KIND,
            operation,
            // A refused write is the request's, not a reason to switch the tracker off.
            reason: error.reason === "forbidden" ? "failed" : error.reason,
            detail: error.detail,
            ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
            cause: error,
          }),
      ),
    );

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: Pick<IssueScopeTarget, "host">,
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

  const toSummary = (issue: KerlovIssue, scope: string): TrackerIssueSummary => ({
    key: String(issue.number),
    displayKey: `#${issue.number}`,
    title: issue.title.trim() || `#${issue.number}`,
    url: issueUrl(scope, issue.number),
    author: Json.toActor(issue.author),
    state: issue.state === "closed" ? CLOSED : OPEN,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    assignees: (issue.assignees ?? []).flatMap((user) => {
      const actor = Json.toActor(user);
      return actor === null ? [] : [actor];
    }),
    labels: (issue.labels ?? []).map((label) => ({ name: label.name, color: label.color })),
    commentCount: issue.comment_count ?? 0,
  });

  const toComments = (
    comments: Json.KerlovComments,
    scope: string,
    key: string,
  ): ReadonlyArray<IssueComment> =>
    comments.comments.flatMap((comment) =>
      comment.deleted === true || comment.body === null
        ? []
        : [
            {
              id: comment.comment_id,
              author: Json.toActor(comment.author),
              body: comment.body,
              createdAt: comment.created_at,
              url: issueUrl(scope, key),
              reactions: Json.toReactions(comment.reactions),
            },
          ],
    );

  const readComments = (
    operation: string,
    input: IssueScopeTarget & { readonly key: string },
    cursor: string | null,
  ) =>
    issuePath(operation, input).pipe(
      Effect.flatMap((path) => {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (cursor !== null) query.set("cursor", cursor);
        return read(operation, input, { path: `${path}/comments?${query}` }, Json.KerlovComments);
      }),
    );

  const getViewer = (input: Pick<IssueScopeTarget, "host">) =>
    read("getViewer", input, { path: "/v1/user" }, Json.KerlovCurrentUser).pipe(
      Effect.map((user) => user.username),
    );

  const tracker: IssueTrackerApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    getViewer,

    listIssues: Effect.fn("KerlovIssueTracker.listIssues")(function* (input) {
      const path = yield* base("listIssues", input);
      const query = new URLSearchParams({
        q: issueQuery(input),
        sort: SORTS[input.sort],
        limit: String(Math.min(PAGE_SIZE, Math.max(1, input.limit))),
      });
      if (input.cursor !== undefined) query.set("cursor", input.cursor);
      const page = yield* read(
        "listIssues",
        input,
        { path: `${path}/issues?${query}` },
        KerlovIssues,
      );
      return {
        items: page.issues.map((issue) => toSummary(issue, input.scope)),
        nextCursor: page.next_cursor,
      };
    }),

    getIssue: Effect.fn("KerlovIssueTracker.getIssue")(function* (input) {
      const path = yield* issuePath("getIssue", input);
      const detail = yield* read("getIssue", input, { path }, KerlovIssueDetail);
      if (detail.kind === "pull_request")
        return yield* failure("getIssue", `#${input.key} is a pull request, not an issue.`);
      const [comments, viewer] = yield* Effect.all(
        [
          readComments("getIssue", input, null),
          getViewer(input).pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: 2 },
      );
      const closed =
        detail.state === "closed" && detail.close_reason
          ? { ...CLOSED, closeReason: detail.close_reason }
          : CLOSED;
      const summary = toSummary(detail, input.scope);
      return {
        ...summary,
        state: detail.state === "closed" ? closed : OPEN,
        body: detail.body ?? "",
        viewer,
        viewerPermissions: {
          setState: viewer !== null,
          comment: viewer !== null && detail.locked !== true,
          edit: viewer !== null,
          labels: viewer !== null,
          assignees: false,
        },
        states: STATES,
        reactions: Json.toReactions(detail.reactions ?? []),
        comments: toComments(comments, input.scope, input.key),
        commentsCursor: comments.next_cursor,
        events: [],
        linkedPullRequests: [],
      };
    }),

    getComments: Effect.fn("KerlovIssueTracker.getComments")(function* (input) {
      const comments = yield* readComments("getComments", input, input.cursor);
      return {
        comments: toComments(comments, input.scope, input.key),
        nextCursor: comments.next_cursor,
      };
    }),

    create: Effect.fn("KerlovIssueTracker.create")(function* (input) {
      const path = yield* base("create", input);
      const created = yield* read(
        "create",
        input,
        {
          method: "POST",
          path: `${path}/issues`,
          body: {
            title: input.title,
            ...(input.body.trim() === "" ? {} : { body: input.body }),
            ...(input.labels.length === 0 ? {} : { labels: input.labels }),
            ...(input.assignees.length === 0 ? {} : { assignees: input.assignees }),
          },
        },
        Created,
      );
      const key = String(created.number);
      return { key, displayKey: `#${key}`, url: issueUrl(input.scope, key) };
    }),

    comment: Effect.fn("KerlovIssueTracker.comment")(function* (input) {
      const path = yield* issuePath("comment", input);
      yield* send("comment", input, {
        method: "POST",
        path: `${path}/comments`,
        body: { body: input.body },
      });
    }),

    update: Effect.fn("KerlovIssueTracker.update")(function* (input) {
      const path = yield* issuePath("update", input);
      if (input.title !== undefined || input.body !== undefined)
        yield* send("update", input, {
          method: "PATCH",
          path,
          body: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          },
        });
      // Labels and assignees are written whole, as the tracker interface hands them over.
      if (input.labels !== undefined)
        yield* send("update", input, {
          method: "PUT",
          path: `${path}/labels`,
          body: { labels: input.labels },
        });
      if (input.assignees !== undefined)
        yield* send("update", input, {
          method: "PUT",
          path: `${path}/assignees`,
          body: { assignees: input.assignees },
        });
    }),

    setState: Effect.fn("KerlovIssueTracker.setState")(function* (input) {
      const state = STATES.find((candidate) => candidate.name === input.state);
      if (state === undefined)
        return yield* failure("setState", `Kerlov issues have no "${input.state}" state.`);
      const path = yield* issuePath("setState", input);
      yield* send("setState", input, {
        method: "PATCH",
        path,
        body: { state: state.category },
      });
    }),

    setReaction: Effect.fn("KerlovIssueTracker.setReaction")(function* (input) {
      const path = yield* issuePath("setReaction", input);
      const subject =
        input.subjectId === undefined
          ? path
          : `${path}/comments/${encodeURIComponent(input.subjectId)}`;
      yield* send("setReaction", input, {
        method: input.reacted ? "POST" : "DELETE",
        path: `${subject}/reactions`,
        body: { content: Json.kerlovReactionContent(input.content) },
      });
    }),

    listCandidates: Effect.fn("KerlovIssueTracker.listCandidates")(function* (input) {
      const path = yield* base("listCandidates", input);
      const labels = yield* read(
        "listCandidates",
        input,
        { path: `${path}/labels` },
        Json.KerlovRepositoryLabels,
      );
      return {
        labels: labels.labels.map((label) => ({
          name: label.name,
          color: label.color,
          description: label.description,
        })),
        assignees: [],
        truncated: false,
      };
    }),
  };
  return tracker;
});
