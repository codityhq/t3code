import { assert, describe, it } from "@effect/vitest";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as KerlovApi from "./KerlovApi.ts";
import * as KerlovPullRequestProvider from "./KerlovPullRequestProvider.ts";
import * as KerlovSourceControlProvider from "./KerlovSourceControlProvider.ts";

/** A row of `GET /repos/acme/web/pulls`, trimmed to what the list and the PR join write. */
const row = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: `Pull request ${number}`,
  kind: "pull_request",
  state: "open",
  author: { user_id: "u_1", username: "bob" },
  labels: [],
  created_at: "2026-11-20T10:00:00.000Z",
  updated_at: "2026-11-21T09:30:00.000Z",
  closed_at: null,
  base_ref: "main",
  head_ref: `branch-${number}`,
  base_oid: "b".repeat(40),
  head_oid: "c".repeat(40),
  merge_base_oid: "a".repeat(40),
  draft: false,
  merge_state: "unknown",
  changed_files: null,
  merged_at: null,
  merge_commit_oid: null,
  frozen_head_oid: null,
  frozen_merge_base_oid: null,
  ...fields,
});

const merged = (number: number) =>
  row(number, {
    state: "closed",
    closed_at: "2026-11-21T12:00:00.000Z",
    merged_at: "2026-11-21T12:00:00.000Z",
  });

/** Serves `pages` in order, keyed by the cursor each page hands out, and records every path. */
function fakeApi(pages: ReadonlyArray<ReadonlyArray<ReturnType<typeof row>>>) {
  const paths: Array<string> = [];
  const api = KerlovApi.KerlovApi.of({
    request: (input) =>
      Effect.sync(() => {
        paths.push(input.path);
        const cursor = new URL(input.path, "https://api.kerlov.com").searchParams.get("cursor");
        const index = cursor === null ? 0 : Number(cursor.slice(1));
        return JSON.stringify({
          pulls: pages[index] ?? [],
          next_cursor: index + 1 < pages.length ? `p${index + 1}` : null,
        });
      }),
  });
  return { api, paths };
}

const listInput = {
  cwd: "/repo",
  host: "kerlov.com",
  repository: "acme/web",
  involvement: "all" as const,
  viewer: "bob",
  limit: 30,
};

describe("KerlovPullRequestProvider.listQuery", () => {
  it.each([
    [{ state: "open", involvement: "all" }, "state:open"],
    [{ state: "merged", involvement: "authored" }, "state:closed author:@me"],
    [{ state: "all", involvement: "reviewing" }, "review-requested:@me"],
    [
      { state: "all", involvement: "all", author: "@me", labels: ['needs "review"', "bug"] },
      'author:bob label:"needs review" label:"bug"',
    ],
    [
      { state: "closed", involvement: "all", query: 'fix: "the" bug' },
      'state:closed "fix: the bug"',
    ],
  ] as const)("writes %j as %s", (input, query) => {
    assert.strictEqual(KerlovPullRequestProvider.listQuery({ viewer: "bob", ...input }), query);
  });
});

describe("KerlovPullRequestProvider.listChangeRequests", () => {
  it.effect("reads past pages the merged filter empties, and resumes from Kerlov's cursor", () => {
    const { api, paths } = fakeApi([[row(9)], [row(8), merged(7)], [merged(6)]]);
    return Effect.gen(function* () {
      const provider = yield* KerlovPullRequestProvider.make;
      const first = yield* provider.listChangeRequests({ ...listInput, state: "merged" });
      assert.deepStrictEqual(
        first.items.map((item) => [item.number, item.state, item.url]),
        [[7, "merged", "https://kerlov.com/acme/web/pull-requests/7"]],
      );
      assert.strictEqual(first.resumeAfter, "p2");
      assert.isTrue(first.continues);
      const query = new URL(paths[0]!, "https://api.kerlov.com").searchParams;
      assert.strictEqual(query.get("q"), "state:closed");
      assert.strictEqual(query.get("sort"), "recently-updated");

      const second = yield* provider.listChangeRequests({
        ...listInput,
        state: "merged",
        cursor: { updatedBefore: "2026-11-21T09:30:00.000Z", delivered: 1, resumeAfter: "p2" },
      });
      assert.deepStrictEqual(
        second.items.map((item) => item.number),
        [6],
      );
      assert.isFalse(second.continues);
    }).pipe(Effect.provideService(KerlovApi.KerlovApi, api));
  });

  it.effect("refuses a repository on a host that is not Kerlov's without asking it", () => {
    const { api, paths } = fakeApi([[row(1)]]);
    return Effect.gen(function* () {
      const provider = yield* KerlovPullRequestProvider.make;
      const error = yield* Effect.flip(
        provider.listChangeRequests({ ...listInput, host: "github.com", state: "open" }),
      );
      assert.strictEqual(error.reason, "failed");
      assert.deepStrictEqual(paths, []);
    }).pipe(Effect.provideService(KerlovApi.KerlovApi, api));
  });
});

describe("KerlovSourceControlProvider.listChangeRequests", () => {
  // The list has no head filter, so the branch is matched on each page as the CLI does.
  it.effect("finds a branch's pull request on a later page of the open list", () => {
    const { api, paths } = fakeApi([
      [row(9), row(8)],
      [row(7, { head_ref: "feature/x" }), row(6)],
    ]);
    const host = TestSourceControlHost.layer({
      git: {
        resolvePrimaryRemoteName: () => Effect.succeed("origin"),
        readConfigValue: (_cwd, key) =>
          Effect.succeed(
            key === "remote.origin.url" ? "https://git.kerlov.com/acme/web.git" : null,
          ),
      },
    });
    return Effect.gen(function* () {
      const provider = yield* KerlovSourceControlProvider.make;
      const found = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "feature/x",
        state: "open",
        limit: 1,
      });
      assert.deepStrictEqual(
        found.map((request) => [request.number, request.headRefName, request.url]),
        [[7, "feature/x", "https://kerlov.com/acme/web/pull-requests/7"]],
      );
      assert.isFalse(found[0]?.isCrossRepository);
      assert.strictEqual(paths.length, 2);
      assert.isTrue(paths.every((path) => path.startsWith("/repos/acme/web/pulls?")));
    }).pipe(
      Effect.provideService(KerlovApi.KerlovApi, api),
      Effect.provide(Layer.merge(host, FileSystem.layerNoop({}))),
    );
  });
});

/** Answers each request by method and path, and records them in order. */
function scriptedApi(answers: Record<string, unknown>, failing: ReadonlySet<string> = new Set()) {
  const sent: Array<{ method: string; path: string; origin: string; body: unknown }> = [];
  const api = KerlovApi.KerlovApi.of({
    request: (input) =>
      Effect.suspend(() => {
        const method = input.method ?? "GET";
        const key = `${method} ${input.path}`;
        sent.push({ method, path: input.path, origin: input.origin ?? "api", body: input.body });
        return failing.has(key)
          ? Effect.fail(
              new KerlovApi.KerlovApiError({
                host: input.host,
                operation: input.operation,
                status: 400,
                reason: "failed",
                detail: "invalid_line",
              }),
            )
          : Effect.succeed(JSON.stringify(answers[key] ?? {}));
      }),
  });
  return { api, sent };
}

const ref = { cwd: "/repo", host: "kerlov.com", repository: "acme/web", number: 7 };
const PULL = "/repos/acme/web/pulls/7";

describe("KerlovPullRequestProvider reviews", () => {
  const draft = {
    path: "src/a.ts",
    position: { kind: "added" as const, newLine: 3 },
    body: "Nit",
  };

  it.effect("sends line comments as threads of a pending review, then submits it", () => {
    const { api, sent } = scriptedApi({
      [`GET ${PULL}`]: { ...row(7), body: "", reactions: [] },
      [`POST ${PULL}/reviews`]: { review_id: "rev_9" },
    });
    return Effect.gen(function* () {
      const provider = yield* KerlovPullRequestProvider.make;
      yield* provider.submitReview({
        ...ref,
        verdict: "request-changes",
        body: "",
        comments: [draft],
      });
      assert.deepStrictEqual(
        sent.map(({ method, path, body }) => [method, path, body]),
        [
          ["GET", PULL, undefined],
          ["POST", `${PULL}/reviews`, { event: "pending", head_oid: "c".repeat(40) }],
          [
            "POST",
            `${PULL}/threads`,
            {
              path: "src/a.ts",
              line: 3,
              diff_side: "additions",
              body: "Nit",
              anchor_oid: "c".repeat(40),
              review_id: "rev_9",
            },
          ],
          ["POST", `${PULL}/reviews/rev_9/submit`, { event: "request_changes" }],
        ],
      );
    }).pipe(Effect.provideService(KerlovApi.KerlovApi, api));
  });

  it.effect("discards the pending review when a line comment is refused", () => {
    const { api, sent } = scriptedApi(
      {
        [`GET ${PULL}`]: { ...row(7), body: "", reactions: [] },
        [`POST ${PULL}/reviews`]: { review_id: "rev_9" },
      },
      new Set([`POST ${PULL}/threads`]),
    );
    return Effect.gen(function* () {
      const provider = yield* KerlovPullRequestProvider.make;
      const error = yield* Effect.flip(
        provider.submitReview({ ...ref, verdict: "comment", body: "", comments: [draft] }),
      );
      assert.strictEqual(error.detail, "invalid_line");
      assert.deepStrictEqual(sent.at(-1), {
        method: "DELETE",
        path: `${PULL}/reviews/rev_9`,
        origin: "api",
        body: undefined,
      });
      assert.isFalse(sent.some(({ path }) => path.endsWith("/submit")));
    }).pipe(Effect.provideService(KerlovApi.KerlovApi, api));
  });

  it.effect("replies to and resolves threads, and reacts to comments and the pull request", () => {
    const { api, sent } = scriptedApi({});
    return Effect.gen(function* () {
      const provider = yield* KerlovPullRequestProvider.make;
      yield* provider.replyToThread({ ...ref, threadId: "thr_1", body: "Done" });
      yield* provider.setThreadResolution({ ...ref, threadId: "thr_1", resolved: false });
      yield* provider.setReaction({ ...ref, subjectId: "cmt_1", content: "hooray", reacted: true });
      yield* provider.setReaction({ ...ref, content: "thumbs-down", reacted: false });
      yield* provider.setLabels!({ ...ref, labels: ["bug"], applied: false });
      assert.deepStrictEqual(
        sent.map(({ method, path, body }) => [method, path, body]),
        [
          ["POST", `${PULL}/threads/thr_1/comments`, { body: "Done" }],
          ["POST", `${PULL}/threads/thr_1/unresolve`, undefined],
          ["POST", "/repos/acme/web/issues/7/comments/cmt_1/reactions", { content: "tada" }],
          ["DELETE", "/repos/acme/web/issues/7/reactions", { content: "-1" }],
          ["DELETE", "/repos/acme/web/issues/7/labels", { labels: ["bug"] }],
        ],
      );
    }).pipe(Effect.provideService(KerlovApi.KerlovApi, api));
  });
});

describe("KerlovPullRequestProvider.getChangeRequestActivity", () => {
  it.effect("reads commits from the gateway between the merge base and the head", () => {
    const range = new URLSearchParams({ base: "a".repeat(40), head: "c".repeat(40) });
    const { api, sent } = scriptedApi({
      [`GET ${PULL}`]: {
        ...row(7),
        body: "",
        reactions: [{ content: "heart", count: 1, reacted: true }],
      },
      "GET /repos/acme/web/issues/7/comments?limit=100": { comments: [], next_cursor: null },
      [`GET ${PULL}/reviews`]: { reviews: [] },
      [`GET ${PULL}/threads`]: { threads: [] },
      [`GET /api/repos/acme/web/compare?${range}`]: {
        commits: [
          {
            oid: "1".repeat(40),
            message: "Fix",
            committer: { name: "Bob", email: "b@example.test", date: "2026-11-21T10:00:00Z" },
          },
        ],
        commits_truncated: false,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* KerlovPullRequestProvider.make;
      const activity = yield* provider.getChangeRequestActivity(ref);
      assert.deepStrictEqual(
        activity.commits.map((commit) => commit.oid),
        ["1".repeat(40)],
      );
      assert.deepStrictEqual(activity.reactions, [
        { content: "heart", count: 1, actors: [], viewerHasReacted: true },
      ]);
      assert.strictEqual(sent.find(({ path }) => path.includes("/compare"))?.origin, "gateway");
    }).pipe(Effect.provideService(KerlovApi.KerlovApi, api));
  });
});
