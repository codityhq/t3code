import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeability,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewThread,
  PullRequestState,
} from "@t3tools/contracts";
import { sortChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import type { ProviderChangeRequest } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { pullUrl } from "./kerlovHosts.ts";

/** Absent reads as null, so an older or newer server's row still decodes. */
const Nullable = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.withDecodingDefault(Effect.succeed(null)));

export const KerlovUser = Schema.Struct({ user_id: Schema.String, username: Schema.String });

/** lib/reactions.ts: counts per content, and whether the caller is among them. No names. */
export const KerlovReactions = Schema.Array(
  Schema.Struct({ content: Schema.String, count: Schema.Int, reacted: Schema.Boolean }),
);
const Reactions = KerlovReactions.pipe(Schema.withDecodingDefault(Effect.succeed([])));

export const KerlovLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
});

/** A pull request row of `GET /repos/:o/:r/pulls` (lib/issue-views.ts + lib/pr-sync.ts). */
export const KerlovPull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  author: Schema.NullOr(KerlovUser),
  labels: Schema.optional(Schema.Array(KerlovLabel)),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Nullable(Schema.String),
  base_ref: Schema.String,
  head_ref: Schema.String,
  base_oid: Nullable(Schema.String),
  head_oid: Nullable(Schema.String),
  merge_base_oid: Nullable(Schema.String),
  draft: Schema.Boolean,
  merge_state: Schema.optional(Schema.String),
  changed_files: Nullable(Schema.Int),
  merged_at: Nullable(Schema.String),
  merge_commit_oid: Nullable(Schema.String),
  locked: Schema.optional(Schema.Boolean),
  frozen_head_oid: Nullable(Schema.String),
  frozen_merge_base_oid: Nullable(Schema.String),
});
export type KerlovPull = typeof KerlovPull.Type;

export const KerlovPulls = Schema.Struct({
  pulls: Schema.Array(KerlovPull),
  next_cursor: Schema.NullOr(Schema.String),
});

/** `GET /repos/:o/:r/pulls/:n`: the row plus the issue's description and reactions. */
export const KerlovPullDetail = Schema.Struct({
  ...KerlovPull.fields,
  body: Nullable(Schema.String),
  reactions: Reactions,
});
export type KerlovPullDetail = typeof KerlovPullDetail.Type;

export const KerlovCheckRuns = Schema.Struct({
  head_oid: Schema.String,
  check_runs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: Schema.String,
      details_url: Nullable(Schema.String),
      summary: Nullable(Schema.String),
      started_at: Nullable(Schema.String),
      completed_at: Nullable(Schema.String),
    }),
  ),
});
export type KerlovCheckRuns = typeof KerlovCheckRuns.Type;

export const KerlovComments = Schema.Struct({
  comments: Schema.Array(
    Schema.Struct({
      comment_id: Schema.String,
      author: Schema.NullOr(KerlovUser),
      body: Schema.NullOr(Schema.String),
      deleted: Schema.optional(Schema.Boolean),
      created_at: Schema.String,
      edited_at: Nullable(Schema.String),
      reactions: Reactions,
    }),
  ),
  next_cursor: Schema.NullOr(Schema.String),
});
export type KerlovComments = typeof KerlovComments.Type;

/** `GET {gateway}/api/repos/:o/:r/refs`: `head` is the default branch's full ref. */
export const KerlovRefs = Schema.Struct({ head: Schema.NullOr(Schema.String) });

export const KerlovCurrentUser = Schema.Struct({ username: Schema.String });

export const KerlovRepository = Schema.Struct({
  repository_id: Schema.String,
  name: Schema.String,
  visibility: Schema.String,
});

/** The oid Kerlov records before it has read a branch's tip. */
const UNKNOWN_OID = /^0+$/u;
export const knownOid = (oid: string | null) =>
  oid === null || oid === "" || UNKNOWN_OID.test(oid) ? null : oid.toLowerCase();

export const isMerged = (pull: Pick<KerlovPull, "state" | "merged_at">) =>
  pull.state === "closed" && pull.merged_at !== null;

export const stateOf = (pull: Pick<KerlovPull, "state" | "merged_at">): PullRequestState =>
  isMerged(pull) ? "merged" : pull.state;

/** `clean` merges; `dirty` conflicts; `blocked` and `behind` are rules, not conflicts. */
export function mergeabilityOf(mergeState: string | undefined): PullRequestMergeability {
  return mergeState === "dirty"
    ? "conflicting"
    : mergeState === "clean" || mergeState === "blocked" || mergeState === "behind"
      ? "mergeable"
      : "unknown";
}

export function toActor(user: typeof KerlovUser.Type | null): PullRequestActor | null {
  const login = user?.username.trim();
  if (!login) return null;
  return {
    login,
    name: null,
    avatarUrl: null,
    ...(login.endsWith("[bot]") ? { isBot: true } : {}),
  };
}

export function toChangeRequest(pull: KerlovPull, repository: string): ProviderChangeRequest {
  return {
    number: pull.number,
    title: pull.title,
    url: pullUrl(repository, pull.number),
    author: toActor(pull.author),
    headBranch: pull.head_ref,
    // Kerlov has no forks: the head is always a branch of the same repository.
    headRepositoryNameWithOwner: repository,
    baseBranch: pull.base_ref,
    state: stateOf(pull),
    isDraft: pull.draft,
    mergeability: mergeabilityOf(pull.merge_state),
    rebaseRequired: pull.merge_state === "behind",
    additions: 0,
    deletions: 0,
    createdAt: pull.created_at,
    closedAt: pull.closed_at,
    mergedAt: pull.merged_at,
    updatedAt: pull.updated_at,
    reviewRequestLogins: [],
    labels: (pull.labels ?? []).map((label) => ({ name: label.name, color: label.color })),
  };
}

const CHECK_STATUS: Readonly<Record<string, PullRequestCheck["status"]>> = {
  queued: "pending",
  running: "pending",
  passed: "success",
  failed: "failure",
  cancelled: "cancelled",
  skipped: "skipped",
};

/** A check reported twice under one name is one check; the later report is its state. */
export function toChecks(runs: KerlovCheckRuns): ReadonlyArray<PullRequestCheck> {
  const newest = new Map<string, KerlovCheckRuns["check_runs"][number]>();
  for (const run of runs.check_runs) {
    const held = newest.get(run.name);
    const at = run.started_at ?? run.completed_at ?? "";
    if (held === undefined || at >= (held.started_at ?? held.completed_at ?? "")) {
      newest.set(run.name, run);
    }
  }
  return sortChecks(
    [...newest.values()].map((run) => ({
      name: run.name,
      status: CHECK_STATUS[run.status] ?? "neutral",
      description: run.summary?.split("\n", 1)[0]?.replace(/^#+\s*/u, "") || null,
      url: run.details_url,
    })),
  );
}

export function checksStateOf(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState | null {
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending") || statuses.has("action-required")) return "pending";
  return statuses.has("success") ? "passing" : null;
}

/** Deleted comments stay in Kerlov's list as tombstones; T3 drops them. */
export function toComments(
  comments: KerlovComments,
  target: { readonly repository: string; readonly number: number },
): ReadonlyArray<PullRequestComment> {
  const page = pullUrl(target.repository, target.number);
  return comments.comments.flatMap((comment) =>
    comment.deleted === true || comment.body === null
      ? []
      : [
          {
            id: comment.comment_id,
            kind: "issue-comment" as const,
            author: toActor(comment.author),
            body: comment.body,
            createdAt: comment.created_at,
            ...(comment.edited_at === null ? {} : { editedAt: comment.edited_at }),
            // Kerlov anchors no conversation comment, so the link is the page.
            url: page,
            path: null,
            reviewState: null,
            reactions: toReactions(comment.reactions),
          },
        ],
  );
}

/** The diff a pull request shows: its head against the merge base, frozen once it ends. */
export function diffRange(
  pull: KerlovPull,
): { readonly base: string; readonly head: string } | null {
  const ended = pull.state === "closed";
  const head = knownOid(ended ? (pull.frozen_head_oid ?? pull.head_oid) : pull.head_oid);
  const base = knownOid(
    ended ? (pull.frozen_merge_base_oid ?? pull.merge_base_oid) : pull.merge_base_oid,
  );
  return head === null || base === null ? null : { base, head };
}

const REACTION_CONTENT: Readonly<Record<string, PullRequestReactionContent>> = {
  "+1": "thumbs-up",
  "-1": "thumbs-down",
  laugh: "laugh",
  tada: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

/** The content Kerlov's reaction routes take for T3's name of it. */
export const kerlovReactionContent = (content: PullRequestReactionContent): string =>
  Object.entries(REACTION_CONTENT).find(([, named]) => named === content)?.[0] ?? content;

/** Kerlov names no one who reacted, so `actors` stays empty. */
export function toReactions(
  reactions: typeof KerlovReactions.Type,
): ReadonlyArray<PullRequestReaction> {
  return reactions.flatMap((reaction) => {
    const content = REACTION_CONTENT[reaction.content];
    return content === undefined || reaction.count < 1
      ? []
      : [{ content, count: reaction.count, actors: [], viewerHasReacted: reaction.reacted }];
  });
}

/** `GET /repos/:o/:r/labels` (routes/repo-meta.ts). */
export const KerlovRepositoryLabels = Schema.Struct({
  labels: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Nullable(Schema.String),
      color: Schema.NullOr(Schema.String),
    }),
  ),
});

/** `GET /repos/:o/:r/pulls/:n/threads` (lib/reviews.ts `threadJson`). */
export const KerlovThreads = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      thread_id: Schema.String,
      path: Schema.String,
      diff_side: Schema.String,
      start_line: Nullable(Schema.Int),
      line: Schema.Int,
      outdated: Schema.Boolean,
      resolved: Schema.Boolean,
      comments: Schema.Array(
        Schema.Struct({
          comment_id: Schema.String,
          author: Schema.NullOr(KerlovUser),
          body: Schema.NullOr(Schema.String),
          deleted: Schema.optional(Schema.Boolean),
          draft: Schema.optional(Schema.Boolean),
          created_at: Schema.String,
          edited_at: Nullable(Schema.String),
          reactions: Reactions,
        }),
      ),
    }),
  ),
});
export type KerlovThreads = typeof KerlovThreads.Type;

/** `GET /repos/:o/:r/pulls/:n/reviews` (lib/reviews.ts `reviewJson`). */
export const KerlovReviews = Schema.Struct({
  reviews: Schema.Array(
    Schema.Struct({
      review_id: Schema.String,
      reviewer: Schema.Struct({ user_id: Schema.String, username: Schema.NullOr(Schema.String) }),
      state: Schema.String,
      body: Nullable(Schema.String),
      submitted_at: Nullable(Schema.String),
      created_at: Schema.String,
    }),
  ),
});
export type KerlovReviews = typeof KerlovReviews.Type;

export const KerlovReviewCreated = Schema.Struct({ review_id: Schema.String });

/** `GET {gateway}/api/repos/:o/:r/compare` (gateway browse.rs `CompareBody`). */
export const KerlovCompare = Schema.Struct({
  commits: Schema.Array(
    Schema.Struct({
      oid: Schema.String,
      message: Schema.String,
      committer: Schema.Struct({ name: Schema.String, date: Schema.String }),
    }),
  ),
  commits_truncated: Schema.Boolean,
});
export type KerlovCompare = typeof KerlovCompare.Type;

/** Kerlov sides name the diff's halves; T3's name the columns they are drawn in. */
const sideOf = (diffSide: string) => (diffSide === "deletions" ? "left" : "right");

/** Drafts of a pending review are the caller's alone, and deleted comments keep no words. */
export function toReviewThreads(
  threads: KerlovThreads,
  target: { readonly repository: string; readonly number: number },
): ReadonlyArray<PullRequestReviewThread> {
  const page = pullUrl(target.repository, target.number);
  return threads.threads.flatMap((thread) => {
    const comments = thread.comments.flatMap((comment) =>
      comment.deleted === true || comment.draft === true || comment.body === null
        ? []
        : [
            {
              id: comment.comment_id,
              author: toActor(comment.author),
              body: comment.body,
              createdAt: comment.created_at,
              ...(comment.edited_at === null ? {} : { editedAt: comment.edited_at }),
              url: page,
              reactions: toReactions(comment.reactions),
              // Kerlov's edit route needs the thread, which T3's edit does not carry.
              canEdit: false,
            },
          ],
    );
    return comments.length === 0 || thread.path.trim() === ""
      ? []
      : [
          {
            id: thread.thread_id,
            path: thread.path,
            line: thread.line > 0 ? thread.line : null,
            side: sideOf(thread.diff_side),
            isResolved: thread.resolved,
            isOutdated: thread.outdated,
            comments,
          },
        ];
  });
}

const REVIEW_STATES = new Set(["approved", "changes_requested", "commented"]);

/** Submitted reviews read as conversation entries carrying their verdict. */
export function toReviewComments(
  reviews: KerlovReviews,
  target: { readonly repository: string; readonly number: number },
): ReadonlyArray<PullRequestComment> {
  const page = pullUrl(target.repository, target.number);
  return reviews.reviews.flatMap((review) =>
    review.submitted_at === null || !REVIEW_STATES.has(review.state)
      ? []
      : [
          {
            id: review.review_id,
            kind: "review" as const,
            author: toActor(
              review.reviewer.username === null
                ? null
                : { user_id: review.reviewer.user_id, username: review.reviewer.username },
            ),
            body: review.body ?? "",
            createdAt: review.submitted_at,
            url: page,
            path: null,
            reviewState: review.state,
          },
        ],
  );
}

/** The gateway names commit authors by their git signature, which is no Kerlov login. */
export function toCommits(compare: KerlovCompare): ReadonlyArray<PullRequestCommit> {
  return compare.commits.map((commit) => ({
    oid: commit.oid,
    messageHeadline: commit.message.split("\n", 1)[0]?.trim() ?? "",
    committedDate: commit.committer.date,
  }));
}

/** A line comment as `POST /pulls/:n/threads` takes it, anchored to the head it was written on. */
export function toThreadBody(
  draft: PullRequestReviewCommentDraft,
  anchorOid: string,
  reviewId: string,
) {
  const at = (position: PullRequestReviewCommentDraft["position"]) =>
    position.kind === "added"
      ? { side: "additions" as const, line: position.newLine }
      : position.kind === "deleted"
        ? { side: "deletions" as const, line: position.oldLine }
        : position.side === "left"
          ? { side: "deletions" as const, line: position.oldLine }
          : { side: "additions" as const, line: position.newLine };
  const end = at(draft.position);
  const start = draft.startPosition === undefined ? undefined : at(draft.startPosition);
  return {
    path: draft.path,
    line: end.line,
    diff_side: end.side,
    // Kerlov refuses a start past the end, whichever side each is on.
    ...(start !== undefined && start.side === end.side && start.line < end.line
      ? { start_line: start.line, start_side: start.side }
      : {}),
    body: draft.body,
    anchor_oid: anchorOid,
    review_id: reviewId,
  };
}
