import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface AgentCoreStackProps extends cdk.StackProps {
  /** Digest-pinned image URI already mirrored into ECR. No tag fallback. */
  readonly imageUri?: string;
  /** Existing owner-provisioned AgentCore Identity secret ARN; never its value. */
  readonly identitySecretArn?: string;
}

const DEFAULT_IMAGE_URI =
  '111122223333.dkr.ecr.us-east-1.amazonaws.com/vector-sigma-agent@sha256:' + 'a'.repeat(64);
const DEFAULT_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:111122223333:secret:agentcore/provider-placeholder';

/**
 * Synth-only, isolated AgentCore runtime definition. The example values are
 * deliberately non-deployable placeholders; account-specific values must be
 * supplied after separate owner authorization.
 */
export class AgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentCoreStackProps = {}) {
    super(scope, id, props);

    const imageUri = props.imageUri ?? DEFAULT_IMAGE_URI;
    const secretArn = props.identitySecretArn ?? DEFAULT_SECRET_ARN;
    if (!/@sha256:[a-f0-9]{64}$/.test(imageUri)) {
      throw new Error('imageUri must be an immutable ECR image digest URI');
    }
    if (!/^arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:[^:]+$/.test(secretArn)) {
      throw new Error('identitySecretArn must be a Secrets Manager ARN, not secret material');
    }

    // AgentCore Identity owns retrieval of the referenced provider secret.
    // The runtime role receives no direct Secrets Manager read permission.
    const executionRole = new iam.Role(this, 'RuntimeExecutionRole', {
      roleName: 'vector-sigma-agentcore-runtime',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account },
          ArnLike: {
            'aws:SourceArn': cdk.Stack.of(this).formatArn({
              service: 'bedrock-agentcore',
              resource: 'runtime',
              resourceName: 'vector-sigma-agent-*',
            }),
          },
        },
      }),
    });

    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadOnlyPromotedAgentImage',
      actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
      resources: [cdk.Stack.of(this).formatArn({
        service: 'ecr',
        resource: 'repository',
        resourceName: 'vector-sigma-agent',
      })],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'EcrAuthorizationToken',
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // Secrets Manager ARN is a parameterized reference for a future
    // AgentCore Identity provider. It is intentionally not attached to the
    // runtime role; no secret value enters the template or CI.
    const identitySecret = new cdk.CfnParameter(this, 'IdentitySecretArn', {
      type: 'String',
      default: secretArn,
      description: 'Owner-provisioned AgentCore Identity provider secret ARN (reference only).',
      allowedPattern: '^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:[^:]+$',
    });
    // This parameter holds a secret ARN reference (never secret material) and
    // is therefore intentionally NOT NoEcho; acknowledge the ARN-shaped heuristic.
    cdk.Annotations.of(this).acknowledgeWarning(
      'CloudFormation-Validate::W2509',
      'IdentitySecretArn is a secret ARN reference, not secret material; NoEcho would block referencing.',
    );
    new cdk.CfnOutput(this, 'IdentitySecretReference', {
      value: identitySecret.valueAsString,
      description: 'Secret ARN reference only; secret value is not embedded.',
    });

    new cdk.CfnResource(this, 'AgentRuntime', {
      type: 'AWS::BedrockAgentCore::Runtime',
      properties: {
        AgentRuntimeName: 'vector_sigma_agent',
        AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: imageUri } },
        RoleArn: executionRole.roleArn,
        ProtocolConfiguration: 'HTTP',
        NetworkConfiguration: { NetworkMode: 'PUBLIC' },
        Description: 'Vector Sigma agent runtime; isolated dev stack only.',
      },
    });
  }
}
