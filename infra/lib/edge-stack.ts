import { Annotations, CfnCondition, CfnOutput, CfnParameter, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/**
 * AWS-managed CachingOptimized policy. Managed policies have no CloudFormation
 * resource to reference, and the IDs are permanent documented constants.
 * https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
 */
const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";

export interface EdgeStackProps extends StackProps {
  /** Tiler Function URL host (no scheme) — the origin. */
  readonly tilerFunctionUrlDomain: string;
  /** Tiler Lambda ARN, for the invoke permissions. */
  readonly tilerFunctionArn: string;
  /** Static/DEM-index bucket name this stack owns. */
  readonly staticBucket: string;
  /**
   * Whether the distribution actually serves. Defaults off (see bin/app.ts).
   *
   * A disabled distribution answers nothing and bills nothing, while the stack,
   * the bucket and the seeded DEM index stay intact — so turning the demo back
   * on is one deploy rather than a rebuild. It is also the required first step
   * before a distribution can ever be deleted.
   */
  readonly demoEnabled: boolean;
}

/**
 * Edge: one CloudFront distribution, path-routed. /imagery, /terrain and
 * /basemap go to the tiler Function URL via OAC; everything else is served
 * from the account's static S3 bucket (compiled web app + footprints).
 *
 * Ported from the SAM template this replaces, with logical IDs pinned to the
 * live stack so it adopts those resources rather than replacing them. L1
 * (Cfn*) constructs are used deliberately here: the L2 Distribution generates
 * its own OACs and logical IDs, which would not line up with what is already
 * deployed.
 */
export class EdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const { tilerFunctionUrlDomain, tilerFunctionArn, staticBucket, demoEnabled } = props;

    // Still a deploy-time NoEcho parameter rather than a synth-time value:
    // inlining it in TypeScript would bake the key into cdk.out and into the
    // template uploaded to the staging bucket. It is not a real secret (it
    // ships in the client bundle) but there is no reason to widen where it
    // lands. Empty = open distribution, no viewer function attached.
    const tileAccessKey = new CfnParameter(this, "TileAccessKey", {
      type: "String",
      default: "",
      noEcho: true,
      description:
        "Dev access key. When non-empty, a viewer-request CloudFront Function 403s any request without ?k=<key>.",
    });

    const keyEnabled = new CfnCondition(this, "KeyEnabled", {
      expression: Fn.conditionNot(Fn.conditionEquals(tileAccessKey.valueAsString, "")),
    });

    // --- Static bucket ----------------------------------------------------
    // Named, not generated: the deploy seeds it by name and the tiler reads its
    // DEM index by name. RETAIN so a stack teardown never takes the seeded
    // index and web app with it.
    const bucket = new s3.Bucket(this, "AppStaticBucket", {
      bucketName: staticBucket,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Origin access controls -------------------------------------------
    const tilerOac = new cloudfront.CfnOriginAccessControl(this, "TilerOAC", {
      originAccessControlConfig: {
        name: "flight-sim-tiler-oac",
        originAccessControlOriginType: "lambda",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
    });

    // SigV4-signs origin requests so the bucket stays private (public access
    // block on) and only this distribution can read it.
    const staticOac = new cloudfront.CfnOriginAccessControl(this, "StaticOAC", {
      originAccessControlConfig: {
        name: "flight-sim-static-oac",
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
    });

    // --- Policies ---------------------------------------------------------
    // Path-only cache keys: no query strings, no cookies, no headers. This is
    // why year/layer live in the path rather than the query string.
    const cachePolicy = new cloudfront.CfnCachePolicy(this, "TileCachePolicy", {
      cachePolicyConfig: {
        name: "flight-sim-tiles-path-only",
        // Origin sends Cache-Control: immutable; these are guardrails.
        defaultTtl: 86400,
        minTtl: 60,
        maxTtl: 31536000,
        parametersInCacheKeyAndForwardedToOrigin: {
          enableAcceptEncodingBrotli: false, // tiles are already compressed
          enableAcceptEncodingGzip: false,
          cookiesConfig: { cookieBehavior: "none" },
          headersConfig: { headerBehavior: "none" },
          queryStringsConfig: { queryStringBehavior: "none" },
        },
      },
    });

    // Tiles are a public read-only API consumed cross-origin (dev server, any
    // future host). CORS is applied at the edge so cached objects carry it and
    // the origin stays header-free.
    const corsPolicy = new cloudfront.CfnResponseHeadersPolicy(this, "TileCorsPolicy", {
      responseHeadersPolicyConfig: {
        name: "flight-sim-tiles-cors",
        corsConfig: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: { items: ["*"] },
          accessControlAllowMethods: { items: ["GET", "HEAD"] },
          accessControlAllowOrigins: { items: ["*"] },
          accessControlExposeHeaders: { items: ["X-DEM-Source"] },
          originOverride: true,
        },
      },
    });

    // --- Dev gate ---------------------------------------------------------
    // MUST run on viewer-request, not at the origin: CloudFront serves cache
    // hits without ever contacting the Lambda, so origin-side auth would leave
    // every already-cached tile open.
    //
    // The key is read from the query string but the cache policy above keeps
    // queryStringBehavior: none, so it never enters the cache key (all viewers
    // share one cached object) and is never forwarded to the origin. Rotating
    // the key therefore needs no invalidation.
    const authFn = new cloudfront.CfnFunction(this, "TileAuthFunction", {
      name: "flight-sim-tile-auth",
      autoPublish: true,
      functionConfig: {
        comment: "Require ?k=<key> on every viewer request (dev gate)",
        runtime: "cloudfront-js-2.0",
      },
      functionCode: Fn.sub(
        [
          "function handler(event) {",
          "  var qs = event.request.querystring;",
          "  if (!qs.k || qs.k.value !== '${TileAccessKey}') {",
          "    return { statusCode: 403, statusDescription: 'Forbidden' };",
          "  }",
          "  return event.request;",
          "}",
        ].join("\n"),
      ),
    });
    authFn.cfnOptions.condition = keyEnabled;

    // PascalCase deliberately. CDK rewrites camelCase prop keys to
    // CloudFormation's casing, but only for plain objects it can walk -- the
    // value inside Fn.conditionIf is an opaque token, so anything nested here
    // is emitted verbatim and has to already be CloudFormation-shaped.
    // (FunctionARN, not FunctionArn: that is the actual property name.)
    const authAssociations = Fn.conditionIf(
      keyEnabled.logicalId,
      [{ EventType: "viewer-request", FunctionARN: authFn.getAtt("FunctionMetadata.FunctionARN") }],
      Fn.ref("AWS::NoValue"),
    );

    // A tiler behavior: cached path-only, CORS at the edge, dev gate attached.
    const tilerBehavior = (pathPattern: string) => ({
      pathPattern,
      targetOriginId: "tiler",
      viewerProtocolPolicy: "https-only",
      cachePolicyId: cachePolicy.ref,
      responseHeadersPolicyId: corsPolicy.ref,
      allowedMethods: ["GET", "HEAD"],
      compress: false,
      functionAssociations: authAssociations,
    });

    // --- Distribution -----------------------------------------------------
    const distribution = new cloudfront.CfnDistribution(this, "Distribution", {
      distributionConfig: {
        // Off by default. The ?k= gate deters crawlers, not people: index.html
        // and /assets/* are ungated and the key is baked into the bundle they
        // serve, so anyone with the domain has a working demo on this account's
        // bill. Being reachable is therefore a deliberate act, not a resting
        // state — and this is the switch that decides it, not the secrecy of
        // the URL.
        enabled: demoEnabled,
        comment: "flight-sim viewer and tile stream",
        defaultRootObject: "index.html",
        httpVersion: "http2and3", // multiplexing matters for tile storms
        priceClass: "PriceClass_100",
        origins: [
          {
            id: "tiler",
            domainName: tilerFunctionUrlDomain,
            originAccessControlId: tilerOac.getAtt("Id").toString(),
            customOriginConfig: { originProtocolPolicy: "https-only" },
            // All POPs funnel origin misses through one regional cache, so the
            // tiler sees at most one cold render per tile instead of one per
            // POP. Placed in the origin's own region.
            originShield: { enabled: true, originShieldRegion: this.region },
          },
          {
            id: "static",
            domainName: `${staticBucket}.s3.${this.region}.amazonaws.com`,
            originAccessControlId: staticOac.getAtt("Id").toString(),
            s3OriginConfig: { originAccessIdentity: "" },
          },
        ],
        // Default serves the web viewer (index.html, JS, CSS).
        defaultCacheBehavior: {
          targetOriginId: "static",
          viewerProtocolPolicy: "redirect-to-https",
          cachePolicyId: CACHING_OPTIMIZED,
          allowedMethods: ["GET", "HEAD"],
          compress: true,
        },
        cacheBehaviors: [
          tilerBehavior("/imagery/*"),
          tilerBehavior("/terrain/*"),
          tilerBehavior("/basemap/*"),
          // Static footprint vectors -> S3 origin, same tile cache policy.
          {
            pathPattern: "/footprints/*",
            targetOriginId: "static",
            viewerProtocolPolicy: "https-only",
            cachePolicyId: cachePolicy.ref,
            responseHeadersPolicyId: corsPolicy.ref,
            allowedMethods: ["GET", "HEAD"],
            compress: false,
            functionAssociations: authAssociations,
          },
          {
            pathPattern: "/assets/*",
            targetOriginId: "static",
            viewerProtocolPolicy: "https-only",
            cachePolicyId: CACHING_OPTIMIZED,
            allowedMethods: ["GET", "HEAD"],
            compress: true,
          },
        ],
      },
    });

    const distributionArn = `arn:aws:cloudfront::${this.account}:distribution/${distribution.ref}`;

    // Whole-bucket read for the OAC, only from this distribution. Not
    // footprints/*-only: one "static" origin serves both the compiled web app
    // (index.html, /assets/*) and footprints/*.json. Still not a "public"
    // policy (service principal + SourceArn condition), so it is allowed
    // despite the bucket's BlockPublicPolicy.
    const bucketPolicy = new s3.CfnBucketPolicy(this, "StaticBucketPolicy", {
      bucket: bucket.bucketName,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowCloudFrontOACRead",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${staticBucket}/*`,
            Condition: { StringEquals: { "AWS:SourceArn": distributionArn } },
          },
        ],
      },
    });

    // AWS requires BOTH InvokeFunctionUrl and InvokeFunction for OAC ->
    // an AWS_IAM Function URL. With only the former, every request 403s
    // {"Message":"Forbidden"} at the Function URL. This cost an afternoon.
    const invokeUrlPermission = new lambda.CfnPermission(this, "TilerInvokeUrlPermission", {
      functionName: tilerFunctionArn,
      action: "lambda:InvokeFunctionUrl",
      principal: "cloudfront.amazonaws.com",
      sourceArn: distributionArn,
    });
    const invokePermission = new lambda.CfnPermission(this, "TilerInvokePermission", {
      functionName: tilerFunctionArn,
      action: "lambda:InvokeFunction",
      principal: "cloudfront.amazonaws.com",
      sourceArn: distributionArn,
    });

    // --- Adopt the live stack's logical IDs -------------------------------
    (bucket.node.defaultChild as s3.CfnBucket).overrideLogicalId("AppStaticBucket");
    bucketPolicy.overrideLogicalId("StaticBucketPolicy");
    tilerOac.overrideLogicalId("TilerOAC");
    staticOac.overrideLogicalId("StaticOAC");
    cachePolicy.overrideLogicalId("TileCachePolicy");
    corsPolicy.overrideLogicalId("TileCorsPolicy");
    authFn.overrideLogicalId("TileAuthFunction");
    distribution.overrideLogicalId("Distribution");
    invokeUrlPermission.overrideLogicalId("TilerInvokeUrlPermission");
    invokePermission.overrideLogicalId("TilerInvokePermission");

    new CfnOutput(this, "DistributionDomain", { value: distribution.getAtt("DomainName").toString() });

    // Say which way the switch is set, every deploy. A distribution that
    // silently stopped serving is a bad thing to discover from a blank page.
    new CfnOutput(this, "DemoEnabled", {
      value: String(demoEnabled),
      description: demoEnabled
        ? "Distribution is SERVING — reachable by anyone with the domain"
        : "Distribution is DISABLED — redeploy with -c demoEnabled=true to serve",
    });
    if (!demoEnabled) {
      Annotations.of(this).addInfo(
        "Distribution deploys DISABLED (demo off). To serve it: " +
          "npx cdk deploy flight-sim-edge -c demoEnabled=true. " +
          "CloudFront takes ~15 min to propagate either way.",
      );
    }
  }
}
