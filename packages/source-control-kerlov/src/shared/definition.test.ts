import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

/** A project cloned from the gateway, as the server's identity resolver writes it. */
const PROJECT = {
  canonicalKey: "git.kerlov.com/acme/web",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://git.kerlov.com/acme/web.git",
  },
  displayName: "acme/web",
  owner: "acme",
  name: "web",
};

describe("Kerlov change request URLs", () => {
  it.each([
    "https://kerlov.com/acme/web/pull-requests/7",
    "https://kerlov.com/acme/web/pull-requests/7/files",
    "https://kerlov.com/acme/web/pull/7",
  ])("reads %s on the web host", (url) => {
    expect(parse(url)).toEqual({
      host: "kerlov.com",
      repository: "acme/web",
      number: 7,
      repositoryUrl: "https://kerlov.com/acme/web",
    });
    expect(definition.isChangeRequestReference(url)).toBe(true);
  });

  it.each([
    "https://git.kerlov.com/acme/web/pull-requests/7",
    "https://bitbucket.org/acme/web/pull-requests/7",
    "https://kerlov.com/acme/web/issues/7",
    "https://kerlov.com/acme/web/pull-requests/0",
  ])("leaves %s alone", (url) => {
    expect(parse(url)).toBeNull();
  });

  it("builds web links on kerlov.com from a project keyed by the gateway", () => {
    const input = { host: "git.kerlov.com", repository: "acme/web", number: 7 };
    expect(definition.changeRequestUrl(input)).toBe("https://kerlov.com/acme/web/pull-requests/7");
    expect(
      definition.commitUrl?.({
        host: "git.kerlov.com",
        repository: "acme/web",
        sha: "A".repeat(40),
        remoteUrl: "https://git.kerlov.com/acme/web.git",
      }),
    ).toBe(`https://kerlov.com/acme/web/commits/${"a".repeat(40)}`);
    expect(definition.authorProfileUrl("bob")).toBe("https://kerlov.com/bob");
  });

  it("puts a gateway project's pull requests on kerlov.com", () => {
    const link = parse("https://kerlov.com/Acme/Web/pull-requests/7")!;
    expect(definition.changeRequestHost?.(PROJECT)).toBe("kerlov.com");
    expect(definition.isChangeRequestInRepository(PROJECT, link)).toBe(true);
    expect(definition.canReadChangeRequestOnHost(PROJECT, link)).toBe(true);
    expect(
      definition.isChangeRequestInRepository(
        PROJECT,
        parse("https://kerlov.com/acme/other/pull-requests/7")!,
      ),
    ).toBe(false);
  });
});

describe("Kerlov issue URLs", () => {
  it("reads an issue on the web host only", () => {
    const issue = (url: string) => definition.parseIssueUrl(new URL(url));
    expect(issue("https://kerlov.com/Acme/Web/issues/12")).toEqual({
      host: "kerlov.com",
      scope: "acme/web",
      key: "12",
    });
    expect(issue("https://git.kerlov.com/acme/web/issues/12")).toBeNull();
    expect(issue("https://kerlov.com/acme/web/pull-requests/12")).toBeNull();
  });
});

describe("Kerlov remotes and pages", () => {
  it("recognizes remotes on the git gateway alone", () => {
    expect(recognizeRemoteWith(definition, "https://git.kerlov.com/acme/web.git")).toEqual({
      kind: "kerlov",
      name: "Kerlov",
      baseUrl: "https://kerlov.com",
    });
    expect(recognizeRemoteWith(definition, "https://kerlov.com/acme/web")).toBeNull();
    expect(recognizeRemoteWith(definition, "https://git.kerlov.com.evil.test/a/b.git")).toBeNull();
    expect(recognizeRemoteWith(definition, "git@github.com:acme/web.git")).toBeNull();
  });

  it("clones a repository from any of its web pages", () => {
    const repositoryUrl = (url: string) => definition.repositoryUrlFromPage(new URL(url));
    expect(repositoryUrl("https://kerlov.com/acme/web")).toBe(
      "https://git.kerlov.com/acme/web.git",
    );
    expect(repositoryUrl("https://kerlov.com/acme/web/code?ref=main&path=src")).toBe(
      "https://git.kerlov.com/acme/web.git",
    );
    expect(repositoryUrl("https://git.kerlov.com/acme/web.git")).toBeNull();
  });

  it("reads the checkout command it suggests", () => {
    expect(definition.checkoutCommand({ number: 7, headBranch: "fix" })).toBe(
      "kerlov pr checkout 7",
    );
    expect(definition.checkoutCommandArgument("kerlov pr checkout 7")).toBe("7");
    expect(definition.changeRequestCloseCommand?.test("kerlov pr merge 7 --squash")).toBe(true);
  });
});
