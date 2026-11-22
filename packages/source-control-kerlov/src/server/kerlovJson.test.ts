import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as Json from "./kerlovJson.ts";

/** A row of `GET /repos/acme/web/pulls`, as `issueListJson` and `pullRequestJson` write it. */
const PULL_ROW = {
  number: 7,
  title: "Fix the thing",
  kind: "pull_request",
  state: "open",
  author: { user_id: "u_1", username: "bob" },
  assignees: [],
  labels: [{ name: "bug", color: "d73a4a" }],
  priority: null,
  status: null,
  milestone: null,
  comment_count: 1,
  locked: false,
  pinned_at: null,
  created_at: "2026-11-20T10:00:00.000Z",
  updated_at: "2026-11-21T09:30:00.000Z",
  closed_at: null,
  via_agent: false,
  base_ref: "main",
  head_ref: "fix/thing",
  base_oid: "b".repeat(40),
  head_oid: "c".repeat(40),
  merge_base_oid: "a".repeat(40),
  draft: false,
  merge_state: "clean",
  merge_state_checked_at: "2026-11-21T09:31:00.000Z",
  merge_state_reason: null,
  merge_conflicts: [],
  merge_conflicts_truncated: false,
  changed_files: 3,
  changed_files_truncated: false,
  merged_at: null,
  merged_by_user_id: null,
  merge_method: null,
  merge_commit_oid: null,
  auto_merge_enabled: false,
  auto_merge_method: null,
  delete_branch_on_merge: false,
  frozen_at: null,
  frozen_base_oid: null,
  frozen_head_oid: null,
  frozen_merge_base_oid: null,
};

const MERGED_ROW = {
  ...PULL_ROW,
  state: "closed",
  closed_at: "2026-11-22T08:00:00.000Z",
  merged_at: "2026-11-22T08:00:00.000Z",
  merge_commit_oid: "d".repeat(40),
  merge_base_oid: null,
  frozen_at: "2026-11-22T08:00:00.000Z",
  frozen_head_oid: "e".repeat(40),
  frozen_merge_base_oid: "f".repeat(40),
};

const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
) => Schema.decodeUnknownSync(schema)(value);

describe("kerlovJson pull requests", () => {
  it("reads a list page and maps an open row", () => {
    const page = decode(Json.KerlovPulls, { pulls: [PULL_ROW], next_cursor: "MjAyNg==" });
    assert.strictEqual(page.next_cursor, "MjAyNg==");
    const row = Json.toChangeRequest(page.pulls[0]!, "acme/web");
    assert.deepInclude(row, {
      url: "https://kerlov.com/acme/web/pull-requests/7",
      headBranch: "fix/thing",
      headRepositoryNameWithOwner: "acme/web",
      baseBranch: "main",
      state: "open",
      mergeability: "mergeable",
      updatedAt: "2026-11-21T09:30:00.000Z",
    });
    assert.deepStrictEqual(row.author, { login: "bob", name: null, avatarUrl: null });
    assert.deepStrictEqual(row.labels, [{ name: "bug", color: "d73a4a" }]);
  });

  it("reads a closed pull request with a merge time as merged, and its frozen diff", () => {
    const pull = decode(Json.KerlovPull, MERGED_ROW);
    assert.strictEqual(Json.stateOf(pull), "merged");
    assert.strictEqual(Json.stateOf({ ...pull, merged_at: null }), "closed");
    assert.deepStrictEqual(Json.diffRange(pull), { base: "f".repeat(40), head: "e".repeat(40) });
    assert.deepStrictEqual(Json.diffRange(decode(Json.KerlovPull, PULL_ROW)), {
      base: "a".repeat(40),
      head: "c".repeat(40),
    });
  });

  it("tolerates fields an older server leaves out, and an unknown head", () => {
    const {
      merge_base_oid: _base,
      frozen_head_oid: _head,
      frozen_merge_base_oid: _mergeBase,
      changed_files: _files,
      ...older
    } = PULL_ROW;
    const pull = decode(Json.KerlovPullDetail, { ...older, head_oid: "0".repeat(40), body: null });
    assert.isNull(pull.merge_base_oid);
    assert.isNull(Json.knownOid(pull.head_oid));
    assert.isNull(Json.diffRange(pull));
  });

  it.each([
    ["clean", "mergeable"],
    ["behind", "mergeable"],
    ["blocked", "mergeable"],
    ["dirty", "conflicting"],
    ["unknown", "unknown"],
  ] as const)("reads merge state %s as %s", (state, mergeability) => {
    assert.strictEqual(Json.mergeabilityOf(state), mergeability);
  });
});

describe("kerlovJson checks and comments", () => {
  it("keeps the latest report of each check name and rolls them up", () => {
    const runs = decode(Json.KerlovCheckRuns, {
      number: 7,
      head_oid: "c".repeat(40),
      check_runs: [
        {
          id: "cr_1",
          head_oid: "c".repeat(40),
          name: "ci/test",
          status: "failed",
          started_at: "2026-11-21T09:00:00.000Z",
          completed_at: "2026-11-21T09:05:00.000Z",
          details_url: "https://ci.example.test/1",
          summary: "## 3 failed\nmore",
          created_at: "2026-11-21T09:00:00.000Z",
          updated_at: "2026-11-21T09:05:00.000Z",
        },
        {
          id: "cr_2",
          head_oid: "c".repeat(40),
          name: "ci/test",
          status: "running",
          started_at: "2026-11-21T09:10:00.000Z",
          completed_at: null,
          details_url: null,
          summary: null,
          created_at: "2026-11-21T09:10:00.000Z",
          updated_at: "2026-11-21T09:10:00.000Z",
        },
        {
          id: "cr_3",
          head_oid: "c".repeat(40),
          name: "lint",
          status: "passed",
          started_at: null,
          completed_at: "2026-11-21T09:01:00.000Z",
          details_url: null,
          summary: null,
          created_at: "2026-11-21T09:01:00.000Z",
          updated_at: "2026-11-21T09:01:00.000Z",
        },
      ],
      rollup: {
        total: 3,
        passed: 1,
        failed: 1,
        running: 1,
        queued: 0,
        pending: 1,
        conclusion: "failed",
      },
    });
    const checks = Json.toChecks(runs);
    assert.deepStrictEqual(
      checks.map((check) => [check.name, check.status]),
      [
        ["ci/test", "pending"],
        ["lint", "success"],
      ],
    );
    assert.strictEqual(Json.checksStateOf(checks), "pending");
  });

  it("drops deleted comments, maps reactions, and links the rest to the pull request page", () => {
    const comments = decode(Json.KerlovComments, {
      comments: [
        {
          comment_id: "c_1",
          author: { user_id: "u_2", username: "alice" },
          body: "Looks good",
          deleted: false,
          created_at: "2026-11-21T10:00:00.000Z",
          updated_at: "2026-11-21T10:00:00.000Z",
          edited_at: null,
          reactions: [
            { content: "+1", count: 2, reacted: true },
            { content: "tada", count: 1, reacted: false },
          ],
          via_agent: false,
        },
        {
          comment_id: "c_2",
          author: { user_id: "u_3", username: "carol" },
          body: null,
          deleted: true,
          created_at: "2026-11-21T11:00:00.000Z",
          updated_at: "2026-11-21T11:00:00.000Z",
          edited_at: null,
          reactions: [],
          via_agent: false,
        },
      ],
      next_cursor: null,
    });
    assert.deepStrictEqual(Json.toComments(comments, { repository: "acme/web", number: 7 }), [
      {
        id: "c_1",
        kind: "issue-comment",
        author: { login: "alice", name: null, avatarUrl: null },
        body: "Looks good",
        createdAt: "2026-11-21T10:00:00.000Z",
        url: "https://kerlov.com/acme/web/pull-requests/7",
        path: null,
        reviewState: null,
        reactions: [
          { content: "thumbs-up", count: 2, actors: [], viewerHasReacted: true },
          { content: "hooray", count: 1, actors: [], viewerHasReacted: false },
        ],
      },
    ]);
  });
});

describe("kerlovJson review threads, reviews and commits", () => {
  it("reads threads, leaving out drafts, deleted comments and threads they empty", () => {
    const threads = decode(Json.KerlovThreads, {
      threads: [
        {
          thread_id: "thr_1",
          path: "src/a.ts",
          diff_side: "deletions",
          start_line: null,
          line: 12,
          start_side: null,
          anchor_oid: "c".repeat(40),
          outdated: true,
          resolved: true,
          resolved_by: { user_id: "u_2", username: "alice" },
          resolved_at: "2026-11-21T12:00:00.000Z",
          comments: [
            {
              comment_id: "cmt_1",
              author: { user_id: "u_2", username: "alice" },
              body: "Why remove this?",
              deleted: false,
              draft: false,
              review_id: "rev_1",
              suggestions: [],
              reactions: [{ content: "eyes", count: 1, reacted: false }],
              created_at: "2026-11-21T11:00:00.000Z",
              updated_at: "2026-11-21T11:00:00.000Z",
              edited_at: null,
            },
            {
              comment_id: "cmt_2",
              author: { user_id: "u_1", username: "bob" },
              body: "still drafting",
              deleted: false,
              draft: true,
              review_id: "rev_2",
              suggestions: [],
              reactions: [],
              created_at: "2026-11-21T11:05:00.000Z",
              updated_at: "2026-11-21T11:05:00.000Z",
              edited_at: null,
            },
          ],
        },
        {
          thread_id: "thr_2",
          path: "src/b.ts",
          diff_side: "additions",
          start_line: 3,
          line: 4,
          start_side: "additions",
          anchor_oid: "c".repeat(40),
          outdated: false,
          resolved: false,
          resolved_by: null,
          resolved_at: null,
          comments: [
            {
              comment_id: "cmt_3",
              author: { user_id: "u_3", username: "carol" },
              body: null,
              deleted: true,
              draft: false,
              review_id: null,
              suggestions: [],
              reactions: [],
              created_at: "2026-11-21T11:10:00.000Z",
              updated_at: "2026-11-21T11:10:00.000Z",
              edited_at: null,
            },
          ],
        },
      ],
    });
    assert.deepStrictEqual(Json.toReviewThreads(threads, { repository: "acme/web", number: 7 }), [
      {
        id: "thr_1",
        path: "src/a.ts",
        line: 12,
        side: "left",
        isResolved: true,
        isOutdated: true,
        comments: [
          {
            id: "cmt_1",
            author: { login: "alice", name: null, avatarUrl: null },
            body: "Why remove this?",
            createdAt: "2026-11-21T11:00:00.000Z",
            url: "https://kerlov.com/acme/web/pull-requests/7",
            reactions: [{ content: "eyes", count: 1, actors: [], viewerHasReacted: false }],
            canEdit: false,
          },
        ],
      },
    ]);
  });

  it("reads submitted reviews as verdicts and leaves a pending one out", () => {
    const reviews = decode(Json.KerlovReviews, {
      reviews: [
        {
          review_id: "rev_1",
          reviewer: { user_id: "u_2", username: "alice" },
          state: "approved",
          body: null,
          head_oid: "c".repeat(40),
          submitted_at: "2026-11-21T12:00:00.000Z",
          created_at: "2026-11-21T11:59:00.000Z",
        },
        {
          review_id: "rev_2",
          reviewer: { user_id: "u_1", username: "bob" },
          state: "pending",
          body: null,
          head_oid: "c".repeat(40),
          submitted_at: null,
          created_at: "2026-11-21T12:01:00.000Z",
        },
      ],
    });
    assert.deepStrictEqual(
      Json.toReviewComments(reviews, { repository: "acme/web", number: 7 }).map((review) => [
        review.id,
        review.kind,
        review.reviewState,
        review.author?.login,
      ]),
      [["rev_1", "review", "approved", "alice"]],
    );
  });

  it("reads the gateway's comparison as the pull request's commits", () => {
    const signature = (date: string) => ({ name: "Bob", email: "bob@example.test", date });
    const compare = decode(Json.KerlovCompare, {
      base_oid: "b".repeat(40),
      head_oid: "c".repeat(40),
      merge_base_oid: "a".repeat(40),
      ahead: 2,
      behind: 0,
      commits: [
        {
          oid: "1".repeat(40),
          parents: ["a".repeat(40)],
          tree: "9".repeat(40),
          author: signature("2026-11-21T10:00:00+02:00"),
          committer: signature("2026-11-21T10:01:00+02:00"),
          message: "Fix the thing\n\nLonger explanation.",
        },
      ],
      commits_truncated: false,
      files: [],
      stats: { additions: 3, deletions: 1, files: 1 },
      files_truncated: false,
    });
    assert.deepStrictEqual(Json.toCommits(compare), [
      {
        oid: "1".repeat(40),
        messageHeadline: "Fix the thing",
        committedDate: "2026-11-21T10:01:00+02:00",
      },
    ]);
  });

  it("writes line comments as Kerlov threads of a pending review", () => {
    const head = "c".repeat(40);
    assert.deepStrictEqual(
      Json.toThreadBody(
        {
          path: "src/a.ts",
          position: { kind: "context", oldLine: 9, newLine: 10, side: "right" },
          startPosition: { kind: "added", newLine: 8 },
          body: "Rename these",
        },
        head,
        "rev_1",
      ),
      {
        path: "src/a.ts",
        line: 10,
        diff_side: "additions",
        start_line: 8,
        start_side: "additions",
        body: "Rename these",
        anchor_oid: head,
        review_id: "rev_1",
      },
    );
    // A range across both sides cannot be written; the comment keeps its last line.
    assert.notProperty(
      Json.toThreadBody(
        {
          path: "src/a.ts",
          position: { kind: "deleted", oldLine: 4 },
          startPosition: { kind: "added", newLine: 2 },
          body: "x",
        },
        head,
        "rev_1",
      ),
      "start_line",
    );
    assert.strictEqual(Json.kerlovReactionContent("thumbs-up"), "+1");
    assert.strictEqual(Json.kerlovReactionContent("hooray"), "tada");
  });
});
