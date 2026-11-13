#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AgentCoreStack } from '../lib/agentcore-stack.js';

const app = new cdk.App();
// Optional context from the manual deploy workflow; the stack's own validation
// rejects anything that is not a digest-pinned image URI or a secret ARN.
const imageUri = app.node.tryGetContext('imageUri') as string | undefined;
const identitySecretArn = app.node.tryGetContext('identitySecretArn') as string | undefined;
new AgentCoreStack(app, 'VectorSigmaAgentCore', { imageUri, identitySecretArn });
