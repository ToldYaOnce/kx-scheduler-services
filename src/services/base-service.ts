/**
 * Base Service Helper
 * 
 * Provides common patterns for our scheduling services.
 * Works alongside the kx-cdk-lambda-utils decorators.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { 
  DynamoDBDocumentClient, 
  GetCommand, 
  PutCommand, 
  DeleteCommand, 
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
  BatchGetCommand
} from '@aws-sdk/lib-dynamodb';

// Singleton document client
const dynamoClient = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Standard API response format
 */
export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * CORS headers for all responses
 */
const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Tenant-Id,X-Subject-Id',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PATCH,DELETE',
};

/**
 * Create a success response
 */
export function success(data: any, statusCode: number = 200): ApiResponse {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(data),
  };
}

/**
 * Create an error response
 */
export function error(statusCode: number, message: string, details?: any): ApiResponse {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify({ 
      error: message,
      ...(details && { details }),
    }),
  };
}

/**
 * Extract tenantId from API Gateway event
 */
export function getTenantId(event: any): string | null {
  // From Cognito JWT claims (support both naming conventions)
  const claims = event.requestContext?.authorizer?.claims;
  if (claims?.['custom:tenantId']) {
    return claims['custom:tenantId'];
  }
  if (claims?.['custom:tenant_id']) {
    return claims['custom:tenant_id'];
  }
  
  // From header (for testing)
  const headerTenant = event.headers?.['x-tenant-id'] || event.headers?.['X-Tenant-Id'];
  if (headerTenant) {
    return headerTenant;
  }
  
  // From query params (for testing)
  if (event.queryStringParameters?.tenantId) {
    return event.queryStringParameters.tenantId;
  }
  
  return null;
}

/**
 * Extract subjectId (user ID) from API Gateway event
 */
export function getSubjectId(event: any): string | null {
  // From Cognito JWT claims (sub is the user ID)
  const claims = event.requestContext?.authorizer?.claims;
  if (claims?.sub) {
    return claims.sub;
  }
  
  // From header (for testing)
  const headerSubject = event.headers?.['x-subject-id'] || event.headers?.['X-Subject-Id'];
  if (headerSubject) {
    return headerSubject;
  }
  
  return null;
}

/**
 * Parse JSON body safely
 */
export function parseBody(event: any): any {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return {};
  }
}

/**
 * Generate a unique ID with prefix
 */
export function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get current ISO timestamp
 */
export function now(): string {
  return new Date().toISOString();
}

// Re-export DynamoDB commands for convenience
export {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
  BatchGetCommand,
};

