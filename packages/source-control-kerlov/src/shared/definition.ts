import { makeProviderSettingsSchema, SourceControlProviderKind } from "@t3tools/contracts";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  type ChangeRequestHostIdentity,
  defineSourceControl,
  hostCredentialSettingsFields,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  parseIssuePath,
  projectChangeRequestHost,
} from "@t3tools/source-control-core/shared/definition";
import { parseUrl } from "@t3tools/shared/url";

import { icon } from "./icon.ts";

/**
 * Kerlov is hosted only: its web app, API and git gateway each have one fixed origin. T3 keys
 * every Kerlov repository and pull request by the web host, since that is the one links name.
 */
export const KERLOV_WEB_HOST = "kerlov.com";
export const KERLOV_API_HOST = "api.kerlov.com";
export const KERLOV_GATEWAY_HOST = "git.kerlov.com";
const HOSTS: ReadonlySet<string> = new Set([KERLOV_WEB_HOST, KERLOV_API_HOST, KERLOV_GATEWAY_HOST]);

const KIND = SourceControlProviderKind.make("kerlov");

/** `/pull/N` redirects to `/pull-requests/N`, so both name the same pull request. */
const CHANGE_REQUEST_PATH = /^\/([^/]+\/[^/]+)\/(?:pull-requests|pull)\/(\d+)(?:\/|$)/u;
const ISSUE_PATH = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/([^/]+\/[^/]+)\/commits?\/([0-9a-f]+)\/?$/iu;
const REPOSITORY_PAGE_PATH = /^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/u;
const CHECKOUT_COMMAND = /^kerlov\s+pr\s+checkout\s+(.+)$/iu;

export const isKerlovHost = (host: string) => HOSTS.has(host.trim().toLowerCase());

/** The web host for any of Kerlov's three hosts, else `host` itself. */
const kerlovWebHost = (host: string) =>
  isKerlovHost(host) ? KERLOV_WEB_HOST : host.trim().toLowerCase();

const isWebHost = (url: URL) => url.host.toLowerCase() === KERLOV_WEB_HOST;

function parseChangeRequestUrl(url: URL) {
  return isWebHost(url) ? parseChangeRequestPath(url, CHANGE_REQUEST_PATH) : null;
}

/** Remotes name the git gateway, links the web app; both are the same repository. */
const changeRequestHost = (identity: ChangeRequestHostIdentity) =>
  kerlovWebHost(projectChangeRequestHost(identity, KIND));

const webRepositoryUrl = (input: { readonly host: string; readonly repository: string }) =>
  `https://${kerlovWebHost(input.host)}/${input.repository}`;

export const settings = makeProviderSettingsSchema(hostCredentialSettingsFields);
export type KerlovSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "Kerlov",
  pickerLabel: "Kerlov",
  icon,
  credentials: {
    cliName: "kerlov",
    cliLabel: "Kerlov CLI",
    loginCommand: "kerlov auth login",
    tokenEnvVar: "KERLOV_TOKEN",
    tokenAccess:
      "read and write access to contents, write access to pull requests and issues, and read access to checks",
    newTokenUrl: () => `https://${KERLOV_WEB_HOST}/account/settings?section=api-keys`,
  },
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "owner/repo",
  publicHost: KERLOV_WEB_HOST,
  publishDescription: KERLOV_WEB_HOST,
  publishHost: () => KERLOV_WEB_HOST,
  newRepositoryOwner: (account) => ({ owner: account }),
  defaultCloneTransport: "https",
  changeRequestUrl: (input) =>
    !Number.isSafeInteger(input.number) || input.number < 1
      ? null
      : changeRequestUrlBelow(webRepositoryUrl(input), `pull-requests/${input.number}`),
  parseChangeRequestUrl,
  commitUrl: (input) => buildCommitUrl({ ...input, webUrl: webRepositoryUrl(input) }, "commits"),
  parseIssueUrl: (url) => (isWebHost(url) ? parseIssuePath(url, ISSUE_PATH) : null),
  parseCommitUrl: (url) => (isWebHost(url) ? parseCommitPath(url, COMMIT_PATH) : null),
  // Pages are on the web host and clones on the gateway, so a page names its clone URL.
  repositoryUrlFromPage: (url) => {
    if (!isWebHost(url)) return null;
    const match = REPOSITORY_PAGE_PATH.exec(url.pathname);
    return match === null ? null : `https://${KERLOV_GATEWAY_HOST}/${match[1]}/${match[2]}.git`;
  },
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(["merge", "close", "reopen", "ready", "draft"] as const),
  checkoutCommand: ({ number }) => `kerlov pr checkout ${number}`,
  changeRequestCloseCommand: /\bkerlov\s+pr\s+(?:merge|close)\b/u,
  changeRequestCreateCommand: /\bkerlov\s+pr\s+create\b/u,
  authorProfileUrl: (login) =>
    login.endsWith("[bot]") ? null : `https://${KERLOV_WEB_HOST}/${encodeURIComponent(login)}`,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (reference) => {
    const url = parseUrl(reference);
    return url !== null && parseChangeRequestUrl(url) !== null;
  },
  checkoutChangeRequestHost: () => null,
  // Kerlov serves git from its gateway alone.
  recognizeRemote: ({ host }) =>
    host === KERLOV_GATEWAY_HOST
      ? { kind: KIND, name: "Kerlov", baseUrl: `https://${KERLOV_WEB_HOST}` }
      : null,
  changeRequestHost,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(changeRequestHost(identity), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(changeRequestHost(identity), identity, link),
  settings,
});

export function parsePullRequestUrl(value: string) {
  const url = parseUrl(value);
  return url === null ? null : parseChangeRequestUrl(url);
}
