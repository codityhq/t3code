import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as Credentials from "./KerlovCredentials.ts";
import * as Hosts from "./kerlovHosts.ts";

const NO_REDIRECT: RequestInit = { redirect: "manual" };
const TIMEOUT = Duration.seconds(30);
const MAX_PROBLEM_TEXT = 300;

export const KerlovApiFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "forbidden",
  "rate-limited",
  "not-found",
  "failed",
]);

export class KerlovApiError extends Schema.TaggedError<KerlovApiError>()("KerlovApiError", {
  host: Schema.String,
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  reason: KerlovApiFailure,
  detail: Schema.String,
  retryAt: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Kerlov ${this.operation} failed on ${this.host}: ${this.detail}`;
  }
}

export interface KerlovApiRequest {
  /** The host the repository or link named; only Kerlov's own get a token. */
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * Below the API origin, starting with `/`, or below the git gateway's for `gateway`. The pull
   * request routes are the API's pre-v1 surface at its root, so they carry no `/v1`.
   */
  readonly path: string;
  /** The gateway serves refs and diffs, and takes the same token over HTTP Basic. */
  readonly origin?: "api" | "gateway";
  readonly body?: unknown;
  readonly accept?: string;
}

export class KerlovApi extends Context.Service<
  KerlovApi,
  {
    readonly request: (input: KerlovApiRequest) => Effect.Effect<string, KerlovApiError>;
  }
>()("@t3tools/source-control-kerlov/server/KerlovApi") {}

const decodeProblem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.optional(Schema.Unknown),
      detail: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
);

const reasonForStatus = (status: number): typeof KerlovApiFailure.Type =>
  status === 401
    ? "unauthenticated"
    : status === 403
      ? "forbidden"
      : status === 429
        ? "rate-limited"
        : status === 404
          ? "not-found"
          : "failed";

const boundedProblemText = (text: string | undefined) => {
  const line = text?.replace(/\s+/gu, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_PROBLEM_TEXT ? `${line.slice(0, MAX_PROBLEM_TEXT)}…` : line;
};

/** Kerlov answers `{error: "<code>", detail?}`; the gateway's errors nest a message. */
export function problemText(text: string): string | undefined {
  const problem = Option.getOrUndefined(decodeProblem(text));
  if (problem === undefined) return undefined;
  const error = problem.error;
  const nested =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { readonly message: unknown }).message)
      : undefined;
  return boundedProblemText(
    problem.detail ?? problem.message ?? nested ?? (typeof error === "string" ? error : undefined),
  );
}

const credentialFailure = (
  error: Credentials.KerlovCredentialUnavailableError,
): typeof KerlovApiFailure.Type =>
  error._tag === "KerlovCliMissingError"
    ? "missing-tool"
    : error._tag === "KerlovCliFailedError" ||
        error._tag === "KerlovCliTimeoutError" ||
        error._tag === "KerlovUnknownHostError"
      ? "failed"
      : "unauthenticated";

const retryAtFrom = (headers: Readonly<Record<string, string>>, now: number) => {
  const seconds = Number(headers["retry-after"]);
  return Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1_000 : undefined;
};

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* Credentials.KerlovCredentials;

  const request = Effect.fn("KerlovApi.request")(function* (input: KerlovApiRequest) {
    const fail = (
      fields: Pick<KerlovApiError, "status" | "reason" | "detail"> & {
        readonly cause?: unknown;
        readonly retryAt?: number | undefined;
      },
    ) =>
      new KerlovApiError({
        host: input.host,
        operation: input.operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.retryAt === undefined ? {} : { retryAt: fields.retryAt }),
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });
    const method = input.method ?? "GET";
    const credential = yield* credentials
      .get(input.host)
      .pipe(
        Effect.mapError((cause) =>
          fail({ status: null, reason: credentialFailure(cause), detail: cause.message, cause }),
        ),
      );
    const gateway = input.origin === "gateway";
    const origin = gateway ? Hosts.GATEWAY_ORIGIN : Hosts.API_ORIGIN;
    yield* Effect.annotateCurrentSpan({
      "kerlov.operation": input.operation,
      "http.request.method": method,
    });
    const token = Redacted.value(credential.token);
    const base = HttpClientRequest.make(method)(`${origin}${input.path}`).pipe(
      gateway
        ? // The gateway reads the token as the Basic password and ignores the username.
          HttpClientRequest.basicAuth("kerlov", token)
        : HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({
        accept: input.accept ?? "application/json",
        "user-agent": "t3code",
      }),
    );
    const reply = yield* Effect.gen(function* () {
      const response = yield* httpClient
        .execute(
          input.body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
        )
        .pipe(
          // Client spans expose query strings carrying branch names.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          // fetch would carry the token to any redirect target.
          Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
        );
      return { status: response.status, headers: response.headers, text: yield* response.text };
    }).pipe(
      Effect.timeout(TIMEOUT),
      Effect.mapError((cause) =>
        fail({ status: null, reason: "failed", detail: "Could not reach Kerlov.", cause }),
      ),
    );
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": reply.status });
    if (reply.status >= 200 && reply.status < 300) return reply.text;
    // The CLI may hold a fresher token than the one that was refused.
    if (reply.status === 401) yield* credentials.invalidate(input.host);
    return yield* fail({
      status: reply.status,
      reason: reasonForStatus(reply.status),
      detail: problemText(reply.text) ?? `Kerlov answered HTTP ${reply.status}.`,
      retryAt:
        reply.status === 429
          ? retryAtFrom(reply.headers, yield* Clock.currentTimeMillis)
          : undefined,
    });
  });

  return KerlovApi.of({ request });
});

export const layer = Layer.effect(KerlovApi, make);
