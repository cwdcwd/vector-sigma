#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AgentCoreStack } from '../lib/agentcore-stack.js';

const app = new cdk.App();
new AgentCoreStack(app, 'VectorSigmaAgentCore');
