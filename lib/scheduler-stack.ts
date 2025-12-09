import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { createSchedulerTables, getTableEnvVars, SchedulerTables } from './tables';
import { attachServiceToApiGateway, LambdaOptions } from '@toldyaonce/kx-cdk-lambda-utils';
// Discovery - uncomment after publishing kx-cdk-constructs@1.43.0
// import { ApiGatewayDiscovery } from '@toldyaonce/kx-cdk-constructs';

import { ProgramsService } from '../src/services/programs-service';
import { LocationsService } from '../src/services/locations-service';
import { SchedulesService } from '../src/services/schedules-service';
import { ScheduleExceptionsService } from '../src/services/schedule-exceptions-service';
import { SessionsService } from '../src/services/sessions-service';
import { BookingsService } from '../src/services/bookings-service';
import { AttendanceService } from '../src/services/attendance-service';

/**
 * Props for the SchedulerStack
 */
export interface SchedulerStackProps extends cdk.StackProps {
  environment: string;
  sourceStackName: string;
  apiGatewayServiceName: string;
  eventBridgeServiceName: string;
}

/**
 * Kx Scheduling Engine Stack
 */
export class SchedulerStack extends cdk.Stack {
  public readonly tables: SchedulerTables;
  public readonly api: apigateway.IRestApi;

  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    const { environment, apiGatewayServiceName } = props;

    console.log(`\n📅 Initializing SchedulerStack (${environment})`);

    // =========================================================================
    // DynamoDB Tables
    // =========================================================================
    
    console.log('📊 Creating DynamoDB tables...');
    this.tables = createSchedulerTables(this, { environment });

    // =========================================================================
    // API Gateway - Choose ONE option:
    // =========================================================================
    
    // OPTION 1: Create standalone API (current - for independent deployment)
    // console.log('🌐 Creating standalone API Gateway...');
    // this.api = new apigateway.RestApi(this, 'SchedulerApi', {
    //   restApiName: `kx-scheduler-${environment}`,
    //   description: 'Kx Scheduling Engine API',
    //   deployOptions: { stageName: 'prod' },
    // });

    // OPTION 2: Attach to existing KxGenApi via SSM discovery
    // Requires: kx-cdk-constructs@1.43.0 + kx-aws deployed with SSM params
    console.log(`🔍 Discovering API Gateway: ${apiGatewayServiceName}...`);
    this.api = apigateway.RestApi.fromRestApiAttributes(this, 'KxGenApi', {
      restApiId: cdk.Fn.importValue('KxGenStack-ApiGatewayId'),
      rootResourceId: cdk.Fn.importValue('KxGenStack-ApiGatewayRootResourceId'),
    });
    
    // When kx-cdk-constructs@1.43.0 is published, use this cleaner syntax:
    // this.api = ApiGatewayDiscovery.importApiGateway(this, 'KxGenApi', apiGatewayServiceName);

    // =========================================================================
    // Cognito Authorizer - Point to same user pool as KxGenStack
    // =========================================================================
    
    // Import the user pool from KxGenStack (hardcoded ID - same as in kx-aws)
    const userPoolId = process.env.COGNITO_USER_POOL_ID || 'us-east-1_eDKc7BAeq';
    console.log(`🔐 Setting up Cognito authorizer for user pool: ${userPoolId}`);
    
    const userPool = cognito.UserPool.fromUserPoolId(this, 'KxGenUserPool', userPoolId);
    
    // Create a Cognito authorizer pointing to the same user pool
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'SchedulerCognitoAuth', {
      cognitoUserPools: [userPool],
      authorizerName: 'kx-scheduler-authorizer',
      identitySource: 'method.request.header.Authorization',
    });

    // =========================================================================
    // Lambda Configuration
    // =========================================================================

    const tableEnvVars = getTableEnvVars(this.tables);
    
    const lambdaOptions: LambdaOptions = {
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        ...tableEnvVars,
        NODE_OPTIONS: '--enable-source-maps',
        ENVIRONMENT: environment,
      },
      // 🔐 Apply Cognito authorizer to all scheduler routes
      authorizer: cognitoAuthorizer,
    };

    // =========================================================================
    // HTTP Services
    // =========================================================================

    console.log('⚡ Creating Lambda functions and API routes...');

    // Cast to RestApi for attachServiceToApiGateway compatibility
    // TODO: Update kx-cdk-lambda-utils to accept IRestApi
    const api = this.api as apigateway.RestApi;

    // Programs Service: /scheduling/programs
    const programsLambdas = attachServiceToApiGateway(
      this, api, ProgramsService,
      './src/services/programs-service.ts', lambdaOptions
    );
    this.grantTableAccess(programsLambdas, ['programs']);

    // Locations Service: /scheduling/locations
    const locationsLambdas = attachServiceToApiGateway(
      this, api, LocationsService,
      './src/services/locations-service.ts', lambdaOptions
    );
    this.grantTableAccess(locationsLambdas, ['locations']);

    // Schedules Service: /scheduling/schedules
    const schedulesLambdas = attachServiceToApiGateway(
      this, api, SchedulesService,
      './src/services/schedules-service.ts', lambdaOptions
    );
    this.grantTableAccess(schedulesLambdas, ['schedules']);

    // Schedule Exceptions Service: /scheduling/exceptions
    const exceptionsLambdas = attachServiceToApiGateway(
      this, api, ScheduleExceptionsService,
      './src/services/schedule-exceptions-service.ts', lambdaOptions
    );
    this.grantTableAccess(exceptionsLambdas, ['schedules', 'scheduleExceptions']);

    // Sessions Service: /scheduling/sessions (read-only, extended timeout for RRULE expansion)
    const sessionsLambdas = attachServiceToApiGateway(
      this, api, SessionsService,
      './src/services/sessions-service.ts',
      { ...lambdaOptions, timeout: cdk.Duration.seconds(60), authorizer: cognitoAuthorizer }
    );
    this.grantTableAccess(sessionsLambdas, ['schedules', 'scheduleExceptions', 'sessionSummaries']);

    // Bookings Service: /scheduling/bookings
    const bookingsLambdas = attachServiceToApiGateway(
      this, api, BookingsService,
      './src/services/bookings-service.ts', lambdaOptions
    );
    this.grantTableAccess(bookingsLambdas, ['schedules', 'scheduleExceptions', 'sessionSummaries', 'bookings']);

    // Attendance Service: /scheduling/attendance
    const attendanceLambdas = attachServiceToApiGateway(
      this, api, AttendanceService,
      './src/services/attendance-service.ts', lambdaOptions
    );
    this.grantTableAccess(attendanceLambdas, ['schedules', 'scheduleExceptions', 'bookings', 'attendance', 'locations']);

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    
    new cdk.CfnOutput(this, 'StackEnvironment', {
      value: environment,
      description: 'Scheduler stack environment',
    });

    new cdk.CfnOutput(this, 'AttachedToApi', {
      value: 'KxGenApi',
      description: 'Scheduler endpoints attached to existing API Gateway',
    });

    console.log(`\n✅ SchedulerStack initialized!`);
    console.log(`   Tables: 7 DynamoDB tables`);
    console.log(`   Services: 7 Lambda-backed APIs`);
  }

  /**
   * Grant Lambda access to specified tables
   */
  private grantTableAccess(
    lambdas: { lambda: lambda.Function }[],
    tableKeys: (keyof SchedulerTables)[]
  ) {
    for (const { lambda: fn } of lambdas) {
      for (const key of tableKeys) {
        this.tables[key].grantReadWriteData(fn);
      }
    }
  }
}
