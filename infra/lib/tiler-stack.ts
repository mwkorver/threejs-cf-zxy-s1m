import * as path from "node:path";
import { CfnOutput, Duration, Fn, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import type { Construct } from "constructs";

export interface TilerStackProps extends StackProps {
  /**
   * Shared bucket new deployments seed their own static bucket from. Public
   * read with requester-pays, so an account that has none of this data can
   * still bootstrap. A prop rather than a hardcoded literal so a fork can
   * point at its own copy.
   */
  readonly seedBucket: string;
  /** Static/DEM-index bucket this account's edge stack owns. */
  readonly staticBucket: string;
}

/**
 * Tiler: Lambda container behind an IAM-auth Function URL. CloudFront
 * (EdgeStack) is the only intended caller and signs origin requests via OAC.
 *
 * Ported from the SAM template this stack replaces. Every logical ID is pinned
 * to what CloudFormation already has deployed (see overrideLogicalId calls) so
 * this adopts the live stack in place instead of creating parallel resources
 * and deleting the originals.
 */
export class TilerStack extends Stack {
  readonly functionArn: string;
  readonly functionUrlDomain: string;

  constructor(scope: Construct, id: string, props: TilerStackProps) {
    super(scope, id, props);

    const { seedBucket, staticBucket } = props;

    // Built explicitly rather than letting Function synthesize one, so its
    // inline policy lands on the role itself -- matching the shape SAM
    // deployed, where the whole policy lives in the Role's Policies property
    // rather than in a separate AWS::IAM::Policy resource.
    const role = new iam.Role(this, "TilerFunctionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
      inlinePolicies: {
        TilerFunctionRolePolicy0: new iam.PolicyDocument({
          statements: [
            // Signed source reads. Requester-pays is scoped per-asset in
            // imagery.py/terrain.py to the buckets that need it, not set
            // process-wide, so the per-asset check stays meaningful.
            new iam.PolicyStatement({
              actions: ["s3:GetObject"],
              resources: [
                "arn:aws:s3:::naip-visualization/*", // NAIP RGB COGs (requester-pays)
                "arn:aws:s3:::prd-tnm/*", // S1M terrain COGs
                "arn:aws:s3:::elevation-tiles-prod/*", // far-field terrain
                `arn:aws:s3:::${seedBucket}/*`,
                // Exact bucket, not a "threejs-cf-zxy-s1m-*" prefix wildcard:
                // S3 names are globally unique across ALL AWS accounts, so a
                // prefix wildcard would also match buckets belonging to anyone
                // else who picks the same prefix.
                `arn:aws:s3:::${staticBucket}/*`,
                "arn:aws:s3:::naip-geoparquet-index/*", // canonical NAIP lake index
              ],
            }),
            new iam.PolicyStatement({
              actions: ["s3:ListBucket"],
              resources: [
                `arn:aws:s3:::${seedBucket}`,
                `arn:aws:s3:::${staticBucket}`,
                "arn:aws:s3:::naip-geoparquet-index",
              ],
            }),
          ],
        }),
      },
    });

    const fn = new lambda.DockerImageFunction(this, "TilerFunction", {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, "..", "..", "tiler"), {
        platform: Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      // warp + WebP encode are CPU-bound and Lambda scales vCPU with memory
      // (1 vCPU at 1769 MB), so 3008 MB buys ~1.7 vCPU. Only pays off with
      // GDAL_NUM_THREADS below; 2 full vCPU would need ~3538 MB.
      memorySize: 3008,
      timeout: Duration.seconds(60), // headroom for cold start + basemap child retries
      // Guarantees a floor of 100 concurrent slots (blunts fast-low-pass
      // spikes) and caps it at 100 as a cost ceiling. Free -- reserved, not
      // provisioned -- but needs account concurrency above 100 + 10.
      reservedConcurrentExecutions: 100,
      role,
      environment: {
        TILER_LAKE_PATH: "s3://naip-geoparquet-index/manifest-index",
        TILER_S1M_INDEX_PATH: `s3://${staticBucket}/manifest-index/s1m/S1M_Products.parquet`,
        TILER_SEED_BUCKET_PATH: `s3://${seedBucket}/threejs-cf-zxy-s1m/`,
        // GDAL tuning for COG-over-S3 reads. Names verified against the GDAL in
        // the image -- an unrecognised key is silently ignored, so a typo reads
        // as a working knob while doing nothing.
        GDAL_DISABLE_READDIR_ON_OPEN: "EMPTY_DIR", // no LIST per open, just the object
        GDAL_NUM_THREADS: "ALL_CPUS", // warp across the vCPU the memory size buys
        CPL_VSIL_CURL_CHUNK_SIZE: "65536", // min read unit, up from GDAL's 16 KB
        VSI_CACHE: "TRUE", // cache read blocks in memory (25 MB/handle default)
        // Frequently-tweaked knobs -- pydantic reads TILER_* (settings.py).
        // These are function config, so they change without an image rebuild.
        // Already-cached CloudFront tiles are immutable, so seeing a change on
        // previously-served tiles still needs an invalidation.
        TILER_USGS_MIN_ZOOM: "11",
        TILER_S1M_MIN_ZOOM: "15",
        TILER_TILE_SIZE: "512",
      },
    });

    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM, // CloudFront OAC signs origin requests
    });

    // --- Adopt the live stack's logical IDs -------------------------------
    // A mismatch here makes CloudFormation create a replacement and delete the
    // original rather than update in place.
    (role.node.defaultChild as iam.CfnRole).overrideLogicalId("TilerFunctionRole");
    (fn.node.defaultChild as lambda.CfnFunction).overrideLogicalId("TilerFunction");
    const cfnUrl = fnUrl.node.defaultChild as lambda.CfnUrl;
    cfnUrl.overrideLogicalId("TilerFunctionUrl");
    // TargetFunctionArn requires recreation whenever it changes, and recreating
    // a Function URL issues a NEW hostname -- which is the distribution's
    // origin. SAM emitted `Ref` here (a Lambda Ref resolves to the function
    // name, which TargetFunctionArn accepts); CDK's L2 emits GetAtt .Arn.
    // Both point at the same function, but the resolved strings differ, so
    // CloudFormation would treat it as a real change and reissue the URL.
    // Match what is deployed so adopting this stack stays a no-op.
    cfnUrl.addPropertyOverride("TargetFunctionArn", { Ref: "TilerFunction" });

    this.functionArn = fn.functionArn;
    // FunctionUrl is https://<host>/ -- take the host, which is what the
    // distribution's origin DomainName needs.
    this.functionUrlDomain = Fn.select(2, Fn.split("/", fnUrl.url));

    new CfnOutput(this, "FunctionUrl", { value: fnUrl.url });
    new CfnOutput(this, "FunctionUrlDomain", { value: this.functionUrlDomain });
    new CfnOutput(this, "FunctionArn", { value: fn.functionArn });
  }
}
