#!/usr/bin/env node
import 'dotenv/config';
import * as cdk from 'aws-cdk-lib';
import { SchedulerStack } from '../lib/scheduler-stack';

const app = new cdk.App();

// Get environment from .env or defaults
const environment = process.env.ENVIRONMENT || 'dev';
const sourceStackName = process.env.SOURCE_STACK_NAME || 'KxGenStack';

console.log('🚀 KX Scheduler Services');
console.log(`   Environment: ${environment}`);
console.log(`   Source Stack: ${sourceStackName}`);
console.log(`   API Gateway Service: ${process.env.API_GATEWAY_SERVICE_NAME || 'kxgen'}`);
console.log(`   EventBridge Service: ${process.env.EVENTBRIDGE_SERVICE_NAME || 'kx-event-tracking'}`);

new SchedulerStack(app, 'KxSchedulerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Kx Scheduling Engine - Multi-tenant scheduling, booking, and attendance backend',
  
  // Custom props
  environment,
  sourceStackName,
  apiGatewayServiceName: process.env.API_GATEWAY_SERVICE_NAME || 'kxgen',
  eventBridgeServiceName: process.env.EVENTBRIDGE_SERVICE_NAME || 'kx-event-tracking',
});









