/**
 * DynamoDB Table Definitions for Kx Scheduling Engine
 * 
 * All tables use tenantId as the partition key for multi-tenant isolation.
 */

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Options for creating scheduler tables
 */
export interface SchedulerTablesOptions {
  /** Environment prefix for table names */
  environment: string;
  /** Removal policy for tables (default: RETAIN for prod, DESTROY for dev) */
  removalPolicy?: RemovalPolicy;
}

/**
 * All scheduler tables
 */
export interface SchedulerTables {
  programs: dynamodb.Table;
  locations: dynamodb.Table;
  schedules: dynamodb.Table;
  scheduleExceptions: dynamodb.Table;
  sessionSummaries: dynamodb.Table;
  bookings: dynamodb.Table;
  attendance: dynamodb.Table;
}

/**
 * Create all DynamoDB tables for the scheduling engine
 */
export function createSchedulerTables(
  scope: Construct,
  options: SchedulerTablesOptions
): SchedulerTables {
  const { environment, removalPolicy = environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY } = options;
  const prefix = `kx-scheduler-${environment}`;

  // =========================================================================
  // Programs Table
  // PK: tenantId, SK: programId
  // =========================================================================
  const programs = new dynamodb.Table(scope, 'ProgramsTable', {
    tableName: `${prefix}-programs`,
    partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'programId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy,
    pointInTimeRecovery: environment === 'prod',
  });

  // =========================================================================
  // Locations Table
  // PK: tenantId, SK: locationId
  // =========================================================================
  const locations = new dynamodb.Table(scope, 'LocationsTable', {
    tableName: `${prefix}-locations`,
    partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'locationId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy,
    pointInTimeRecovery: environment === 'prod',
  });

  // =========================================================================
  // Schedules Table
  // PK: tenantId, SK: scheduleId
  // GSI1: tenantId#programId -> for querying schedules by program
  // GSI2: tenantId#hostId -> for querying schedules by host
  // =========================================================================
  const schedules = new dynamodb.Table(scope, 'SchedulesTable', {
    tableName: `${prefix}-schedules`,
    partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'scheduleId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy,
    pointInTimeRecovery: environment === 'prod',
  });

  // GSI for querying by program
  schedules.addGlobalSecondaryIndex({
    indexName: 'byProgram',
    partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'programId', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  // GSI for querying by host (stored as gsi2pk = tenantId, gsi2sk = hostId)
  schedules.addGlobalSecondaryIndex({
    indexName: 'byHost',
    partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  // =========================================================================
  // Schedule Exceptions Table
  // PK: tenantId#scheduleId, SK: occurrenceDate (YYYY-MM-DD)
  // =========================================================================
  const scheduleExceptions = new dynamodb.Table(scope, 'ScheduleExceptionsTable', {
    tableName: `${prefix}-schedule-exceptions`,
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // tenantId#scheduleId
    sortKey: { name: 'occurrenceDate', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy,
    pointInTimeRecovery: environment === 'prod',
  });

  // =========================================================================
  // Session Summaries Table
  // PK: tenantId, SK: sessionId (scheduleId#date)
  // Used for capacity tracking
  // =========================================================================
  const sessionSummaries = new dynamodb.Table(scope, 'SessionSummariesTable', {
    tableName: `${prefix}-session-summaries`,
    partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy,
    pointInTimeRecovery: environment === 'prod',
  });

  // GSI for querying by date range (for cleanup, reporting)
  sessionSummaries.addGlobalSecondaryIndex({
    indexName: 'byDate',
    partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  // =========================================================================
  // Bookings Table
  // PK: tenantId#sessionId, SK: bookingId
  // GSI1: tenantId#subjectId -> for querying bookings by user
  // GSI2: tenantId, createdAt -> for querying recent bookings
  // =========================================================================
  const bookings = new dynamodb.Table(scope, 'BookingsTable', {
    tableName: `${prefix}-bookings`,
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // tenantId#sessionId
    sortKey: { name: 'bookingId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy,
    pointInTimeRecovery: environment === 'prod',
  });

  // GSI for querying by subject (user/member/lead)
  bookings.addGlobalSecondaryIndex({
    indexName: 'bySubject',
    partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING }, // tenantId#subjectId
    sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  // GSI for querying recent bookings
  bookings.addGlobalSecondaryIndex({
    indexName: 'byCreatedAt',
    partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  // =========================================================================
  // Attendance Table
  // PK: tenantId#sessionId, SK: bookingId
  // GSI: tenantId#subjectId -> for querying attendance by user
  // =========================================================================
  const attendance = new dynamodb.Table(scope, 'AttendanceTable', {
    tableName: `${prefix}-attendance`,
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // tenantId#sessionId
    sortKey: { name: 'bookingId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy,
    pointInTimeRecovery: environment === 'prod',
  });

  // GSI for querying by subject
  attendance.addGlobalSecondaryIndex({
    indexName: 'bySubject',
    partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING }, // tenantId#subjectId
    sortKey: { name: 'checkInTime', type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  return {
    programs,
    locations,
    schedules,
    scheduleExceptions,
    sessionSummaries,
    bookings,
    attendance,
  };
}

/**
 * Get table names for Lambda environment variables
 */
export function getTableEnvVars(tables: SchedulerTables): Record<string, string> {
  return {
    PROGRAMS_TABLE: tables.programs.tableName,
    LOCATIONS_TABLE: tables.locations.tableName,
    SCHEDULES_TABLE: tables.schedules.tableName,
    SCHEDULE_EXCEPTIONS_TABLE: tables.scheduleExceptions.tableName,
    SESSION_SUMMARIES_TABLE: tables.sessionSummaries.tableName,
    BOOKINGS_TABLE: tables.bookings.tableName,
    ATTENDANCE_TABLE: tables.attendance.tableName,
  };
}




