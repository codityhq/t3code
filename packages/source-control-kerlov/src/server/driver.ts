import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as KerlovApi from "./KerlovApi.ts";
import * as KerlovCredentials from "./KerlovCredentials.ts";
import * as KerlovIssueTracker from "./KerlovIssueTracker.ts";
import * as KerlovPullRequestProvider from "./KerlovPullRequestProvider.ts";
import * as KerlovSourceControlProvider from "./KerlovSourceControlProvider.ts";

const services = KerlovApi.layer.pipe(Layer.provideMerge(KerlovCredentials.layer));

const makeInstance = Effect.all({
  sourceControl: KerlovSourceControlProvider.make,
  discovery: KerlovSourceControlProvider.makeDiscovery,
  pullRequests: KerlovPullRequestProvider.make,
  issues: KerlovIssueTracker.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
