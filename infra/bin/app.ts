#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { TilerStack } from "../lib/tiler-stack.js";
import { EdgeStack } from "../lib/edge-stack.js";
import { GithubOidcStack } from "../lib/github-oidc-stack.js";

const app = new App();

// Region is the deploy target, not a constant: us-west-2 is where the
// GeoParquet lake and the source COG buckets (naip-visualization, prd-tnm)
// live, so compute stays in-region with the bulk of the reads. Override with
// CDK_DEPLOY_REGION / the usual AWS_REGION if you really want it elsewhere and
// accept the cross-region read cost.
const region = process.env.CDK_DEPLOY_REGION ?? process.env.AWS_REGION ?? "us-west-2";
const account = process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT;
const env = { account, region };

// Shared bucket a fresh account seeds its own static bucket from. Public read
// with requester-pays, so any account can bootstrap from it.
const seedBucket = app.node.tryGetContext("seedBucket") ?? "mwkorver-foundation-us-west-2";

// This account's own static/DEM-index bucket. Derived, not a parameter: it
// used to be a CloudFormation parameter (StaticBucketName), and because
// `aws cloudformation deploy` carries forward the previous value of any
// parameter left out of --parameter-overrides, an already-deployed stack
// stayed pinned to whatever bucket it was first created with. Computing it
// here removes that failure mode entirely -- don't reintroduce the parameter.
const staticBucket = `threejs-cf-zxy-s1m-${account}-${region}`;

const tiler = new TilerStack(app, "flight-sim-tiler", {
  env,
  seedBucket,
  staticBucket,
  description: "flight-sim tiler: Lambda container behind an IAM-auth Function URL",
});

new EdgeStack(app, "flight-sim-edge", {
  env,
  staticBucket,
  // Wired straight from the tiler stack rather than being read back out with
  // `aws cloudformation describe-stacks` in a shell script and passed in as
  // parameters. CDK turns these into a CloudFormation export/import, so the
  // dependency is declared rather than reconstructed at deploy time.
  tilerFunctionUrlDomain: tiler.functionUrlDomain,
  tilerFunctionArn: tiler.functionArn,
  description: "flight-sim edge: CloudFront distribution over the tiler and the static app bucket",
});

// Deployed from a workstation, not by CI — it creates the role CI logs in
// with. Kept out of `--all` deploys (infra/deploy.sh) for the same reason:
// it's one-time setup, not part of shipping a change.
new GithubOidcStack(app, "flight-sim-github-oidc", {
  env,
  staticBucket,
  repo: app.node.tryGetContext("githubRepo") ?? "mwkorver/threejs-cf-zxy-s1m",
  environment: app.node.tryGetContext("githubEnvironment") ?? "production",
  description: "GitHub Actions OIDC provider and the deploy role it assumes",
});
