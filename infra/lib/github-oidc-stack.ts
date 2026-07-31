import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface GithubOidcStackProps extends StackProps {
  /** "owner/repo", for human-readable descriptions only — not the trust match. */
  readonly repo: string;
  /**
   * The repo's OIDC subject prefix, verbatim. Read it from GitHub rather than
   * assuming the familiar `repo:<owner>/<repo>` shape:
   *
   *   gh api repos/<owner>/<repo>/actions/oidc/customization/sub \
   *     -q .sub_claim_prefix
   *
   * GitHub now issues ID-qualified subjects for repos like this one —
   * `repo:owner@<user id>/<repo>@<repo id>`. Guessing the plain form produces
   * a trust policy that looks correct, deploys clean, and then fails every run
   * with "Not authorized to perform sts:AssumeRoleWithWebIdentity" and no clue
   * as to why. The embedded IDs are worth having: they survive a rename, so
   * nobody can claim the old name and inherit this trust.
   */
  readonly subjectPrefix: string;
  /**
   * GitHub environment the workflow job declares. The subject claim is
   * `<subjectPrefix>:environment:<name>` for a job with an `environment:`, so
   * this scopes trust to that job rather than to any workflow in the repo.
   */
  readonly environment: string;
  /** Static bucket the workflow syncs the built client into. */
  readonly staticBucket: string;
}

/**
 * GitHub Actions OIDC: an identity provider plus one role the deploy workflow
 * assumes. No stored AWS access keys — GitHub mints a short-lived token per
 * run and STS exchanges it.
 *
 * Deployed from a workstation, not from CI: this stack creates the very role
 * CI authenticates with, so it can't be the thing CI deploys.
 */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const { repo, subjectPrefix, environment, staticBucket } = props;

    // L1 with explicit thumbprints rather than the L2, which provisions a
    // custom-resource Lambda purely to fetch them. AWS stopped validating the
    // thumbprint for this specific host in 2023 (it verifies against its own
    // trusted CA store), but the field is still required by the API. These are
    // GitHub's published values.
    const provider = new iam.CfnOIDCProvider(this, "GithubOidcProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIdList: ["sts.amazonaws.com"],
      thumbprintList: [
        "6938fd4d98bab03faadb97b34396831e3780aea1",
        "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
      ],
    });

    // The scoping that matters. `sub` is pinned with StringEquals to one repo
    // AND one environment -- not StringLike with a wildcard, which is the
    // classic mistake here: `repo:owner/*` would let any repo under the owner
    // assume this role, and a bare `*` would open it to all of GitHub.
    // `aud` is pinned too, so a token minted for another audience is useless.
    const role = new iam.Role(this, "GithubDeployRole", {
      roleName: "flight-sim-github-deploy",
      description: `Assumed by GitHub Actions in ${repo} (environment: ${environment}) to deploy the flight-sim stacks`,
      assumedBy: new iam.FederatedPrincipal(
        provider.attrArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": `${subjectPrefix}:environment:${environment}`,
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
    });

    // `cdk deploy` does its real work through the bootstrap roles, so the
    // workflow only needs to assume them. This is deliberately not
    // AdministratorAccess -- though note the ceiling is still whatever
    // cdk-hnb659fds-cfn-exec-role can do, which is how CDK's bootstrap model
    // works.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
      }),
    );

    // The workflow's own steps, which run with these base credentials rather
    // than through CDK: `aws s3 sync` of the built client...
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
        resources: [`arn:aws:s3:::${staticBucket}`, `arn:aws:s3:::${staticBucket}/*`],
      }),
    );

    // ...reading the distribution id back out of the stack...
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks", "cloudformation:DescribeStackResources"],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/flight-sim-*/*`],
      }),
    );

    // ...and invalidating the app entry points. Scoped to this account's
    // distributions rather than one id, so this stack doesn't have to depend
    // on the edge stack's physical resource id; invalidation can cost money on
    // the wrong distribution but cannot expose anything.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: role.roleArn,
      description: "Set as the AWS_DEPLOY_ROLE_ARN secret in the GitHub repo",
    });
  }
}
