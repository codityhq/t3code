import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as KerlovApi from "./KerlovApi.ts";
import * as KerlovIssueTracker from "./KerlovIssueTracker.ts";

/** An issue as `issueListJson` writes it; the detail adds what `issueDetailJson` does. */
const ISSUE = {
  number: 12,
  title: "Crash on start",
  kind: "issue",
  state: "closed",
  author: { user_id: "u_1", username: "bob" },
  assignees: [{ user_id: "u_2", username: "alice" }],
  labels: [{ name: "bug", color: "d73a4a" }],
  priority: null,
  status: null,
  milestone: null,
  comment_count: 2,
  locked: false,
  pinned_at: null,
  created_at: "2026-11-20T10:00:00.000Z",
  updated_at: "2026-11-21T10:00:00.000Z",
  closed_at: "2026-11-21T10:00:00.000Z",
  via_agent: false,
};

const DETAIL = {
  ...ISSUE,
  issue_id: "iss_1",
  body: "Steps to reproduce",
  close_reason: "not_planned",
  links: [],
  reactions: [{ content: "+1", count: 3, reacted: false }],
  sub_issues: null,
  subscription: null,
};

const COMMENTS = {
  comments: [
    {
      comment_id: "cmt_1",
      author: { user_id: "u_2", username: "alice" },
      body: "Same here",
      deleted: false,
      created_at: "2026-11-20T11:00:00.000Z",
      updated_at: "2026-11-20T11:00:00.000Z",
      edited_at: null,
      reactions: [],
      via_agent: false,
    },
  ],
  next_cursor: "MjAyNi0xMS0yMA==",
};

function scriptedApi(answers: Record<string, unknown>) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const api = KerlovApi.KerlovApi.of({
    request: (input) =>
      Effect.suspend(() => {
        const method = input.method ?? "GET";
        sent.push({ method, path: input.path, body: input.body });
        return Effect.succeed(JSON.stringify(answers[`${method} ${input.path}`] ?? {}));
      }),
  });
  return { api, sent };
}

const scope = { cwd: "/repo", host: "kerlov.com", scope: "acme/web" };

describe("KerlovIssueTracker.issueQuery", () => {
  it.each([
    [{ state: "open", involvement: "all" }, "state:open"],
    [{ state: "all", involvement: "mentioned", viewer: "bob" }, "mentions:@me"],
    [{ state: "closed", involvement: "assigned", viewer: "bob" }, "state:closed assignee:@me"],
    [
      { state: "all", involvement: "authored", viewer: "bob", labels: ["bug", "p1"], query: "x:y" },
      'author:@me label:"bug" label:"p1" "x:y"',
    ],
  ] as const)("writes %j as %s", (input, query) => {
    assert.strictEqual(KerlovIssueTracker.issueQuery(input), query);
  });
});

describe("KerlovIssueTracker", () => {
  it.effect("lists issues newest-updated first and carries Kerlov's cursor", () => {
    const query = new URLSearchParams({
      q: "state:open",
      sort: "recently-updated",
      limit: "25",
      cursor: "abc=",
    });
    const { api } = scriptedApi({
      [`GET /repos/acme/web/issues?${query}`]: { issues: [ISSUE], next_cursor: "def=" },
    });
    return Effect.gen(function* () {
      const tracker = yield* KerlovIssueTracker.make;
      const page = yield* tracker.listIssues({
        ...scope,
        involvement: "all",
        state: "open",
        limit: 25,
        sort: "updated",
        cursor: "abc=",
      });
      assert.strictEqual(page.nextCursor, "def=");
      assert.deepInclude(page.items[0], {
        key: "12",
        displayKey: "#12",
        state: { category: "closed", name: "Closed" },
        commentCount: 2,
        closedAt: "2026-11-21T10:00:00.000Z",
      });
    }).pipe(Effect.provideService(KerlovApi.KerlovApi, api));
  });

  it.effect("reads an issue with its close reason, reactions and first comments", () => {
    const { api } = scriptedApi({
      "GET /repos/acme/web/issues/12": DETAIL,
      "GET /repos/acme/web/issues/12/comments?limit=100": COMMENTS,
      "GET /v1/user": { username: "bob" },
    });
    return Effect.gen(function* () {
      const tracker = yield* KerlovIssueTracker.make;
      const issue = yield* tracker.getIssue({ ...scope, key: "12" });
      assert.deepStrictEqual(issue.state, {
        category: "closed",
        name: "Closed",
        closeReason: "not_planned",
      });
      assert.strictEqual(issue.url, "https://kerlov.com/acme/web/issues/12");
      assert.deepStrictEqual(
        issue.assignees.map((actor) => actor.login),
        ["alice"],
      );
      assert.deepStrictEqual(issue.labels, [{ name: "bug", color: "d73a4a" }]);
      assert.deepStrictEqual(issue.reactions, [
        { content: "thumbs-up", count: 3, actors: [], viewerHasReacted: false },
      ]);
      assert.deepStrictEqual(
        issue.comments.map((comment) => comment.body),
        ["Same here"],
      );
      assert.strictEqual(issue.commentsCursor, "MjAyNi0xMS0yMA==");
      assert.strictEqual(issue.viewer, "bob");
    }).pipe(Effect.provideService(KerlovApi.KerlovApi, api));
  });

  it.effect("refuses a pull request read through the issue route", () => {
    const { api } = scriptedApi({
      "GET /repos/acme/web/issues/12": { ...DETAIL, kind: "pull_request" },
    });
    return Effect.gen(function* () {
      const tracker = yield* KerlovIssueTracker.make;
      const error = yield* Effect.flip(tracker.getIssue({ ...scope, key: "12" }));
      assert.include(error.detail, "is a pull request");
    }).pipe(Effect.provideService(KerlovApi.KerlovApi, api));
  });

  it.effect("files, edits, closes and reacts through Kerlov's routes", () => {
    const { api, sent } = scriptedApi({
      "POST /repos/acme/web/issues": { ...DETAIL, number: 13, state: "open" },
    });
    return Effect.gen(function* () {
      const tracker = yield* KerlovIssueTracker.make;
      const created = yield* tracker.create!({
        ...scope,
        title: "New",
        body: "",
        labels: ["bug"],
        assignees: [],
      });
      assert.deepStrictEqual(created, {
        key: "13",
        displayKey: "#13",
        url: "https://kerlov.com/acme/web/issues/13",
      });
      yield* tracker.update!({ ...scope, key: "13", title: "Renamed", labels: ["bug", "p1"] });
      yield* tracker.setState!({ ...scope, key: "13", state: "Closed" });
      yield* tracker.setReaction!({
        ...scope,
        key: "13",
        subjectId: "cmt_1",
        content: "rocket",
        reacted: true,
      });
      assert.deepStrictEqual(
        sent.map(({ method, path, body }) => [method, path, body]),
        [
          ["POST", "/repos/acme/web/issues", { title: "New", labels: ["bug"] }],
          ["PATCH", "/repos/acme/web/issues/13", { title: "Renamed" }],
          ["PUT", "/repos/acme/web/issues/13/labels", { labels: ["bug", "p1"] }],
          ["PATCH", "/repos/acme/web/issues/13", { state: "closed" }],
          ["POST", "/repos/acme/web/issues/13/comments/cmt_1/reactions", { content: "rocket" }],
        ],
      );
    }).pipe(Effect.provideService(KerlovApi.KerlovApi, api));
  });
});
