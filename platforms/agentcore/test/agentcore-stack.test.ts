import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentCoreStack } from '../lib/agentcore-stack.js';

function synthesizedTemplate(): Template {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestAgentCore');
  return Template.fromStack(stack);
}

test('synthesizes an HTTP AgentCore runtime with immutable image reference', () => {
  const template = synthesizedTemplate();
  template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    AgentRuntimeName: 'vector_sigma_agent',
    ProtocolConfiguration: 'HTTP',
    NetworkConfiguration: { NetworkMode: 'PUBLIC' },
    AgentRuntimeArtifact: {
      ContainerConfiguration: {
        ContainerUri: Match.stringLikeRegexp('@sha256:[a-f0-9]{64}$'),
      },
    },
  });
});

test('scopes ECR image reads and excludes direct secret or broad AWS access', () => {
  const template = synthesizedTemplate();
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [{
        Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
        Condition: {
          StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
          ArnLike: { 'aws:SourceArn': /bedrock-agentcore/ },
        },
      }],
    },
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: 'ReadOnlyPromotedAgentImage',
          Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
          Effect: 'Allow',
          Resource: {
            'Fn::Join': Match.arrayWith([
              ['arn:', { Ref: 'AWS::Partition' }, ':ecr:', { Ref: 'AWS::Region' }, ':', { Ref: 'AWS::AccountId' }, ':repository/vector-sigma/agent'],
            ]),
          },
        }),
        Match.objectLike({ Sid: 'EcrAuthorizationToken', Action: 'ecr:GetAuthorizationToken', Effect: 'Allow', Resource: '*' }),
      ]),
    },
  });

  const serialized = JSON.stringify(template.toJSON());
  assert.doesNotMatch(serialized, /secretsmanager:GetSecretValue|bedrock:InvokeModel|AdministratorAccess/);
});

test('keeps only an ARN reference in CloudFormation and rejects mutable image tags', () => {
  const template = synthesizedTemplate();
  template.hasParameter('IdentitySecretArn', {
    Type: 'String',
    AllowedPattern: '^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:[^:]+$',
  });
  const serialized = JSON.stringify(template.toJSON());
  assert.match(serialized, /IdentitySecretArn/);
  assert.doesNotMatch(serialized, /GetSecretValue|secret-value|secretValue/);

  assert.throws(
    () => new AgentCoreStack(new cdk.App(), 'MutableImage', {
      imageUri: '111122223333.dkr.ecr.us-east-1.amazonaws.com/vector-sigma/agent:latest',
    }),
    /immutable ECR image digest URI/,
  );
});
