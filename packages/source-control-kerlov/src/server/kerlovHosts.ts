import {
  KERLOV_API_HOST,
  KERLOV_GATEWAY_HOST,
  KERLOV_WEB_HOST,
  isKerlovHost,
} from "../shared/definition.ts";

/** Kerlov is hosted only, on three fixed origins. */
export const WEB_ORIGIN = `https://${KERLOV_WEB_HOST}`;
export const API_ORIGIN = `https://${KERLOV_API_HOST}`;
export const GATEWAY_ORIGIN = `https://${KERLOV_GATEWAY_HOST}`;

export { isKerlovHost };

const SEGMENT = /^[A-Za-z0-9_.-]+$/u;

/** `owner/name` from a path, `.git` dropped. Kerlov repositories nest no deeper. */
export function kerlovRepositoryPath(path: string): string | null {
  const [owner, name, ...rest] = path
    .trim()
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "")
    .split("/");
  return rest.length === 0 &&
    owner !== undefined &&
    name !== undefined &&
    [owner, name].every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
    ? `${owner}/${name}`
    : null;
}

/** The repository of an HTTPS remote on the git gateway, the only place Kerlov serves git. */
export function parseKerlovRemote(remoteUrl: string): string | null {
  const url = URL.parse(remoteUrl.trim());
  return url !== null &&
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.host.toLowerCase() === KERLOV_GATEWAY_HOST
    ? kerlovRepositoryPath(url.pathname)
    : null;
}

export const webRepositoryUrl = (repository: string) => `${WEB_ORIGIN}/${repository}`;

export const cloneUrl = (repository: string) => `${GATEWAY_ORIGIN}/${repository}.git`;

export const pullUrl = (repository: string, number: number) =>
  `${webRepositoryUrl(repository)}/pull-requests/${number}`;
