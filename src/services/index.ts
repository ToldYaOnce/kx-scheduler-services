/**
 * Services Module Exports
 * 
 * Export service classes (not handlers) for CDK integration
 */

export { ProgramsService } from './programs-service';
export { LocationsService } from './locations-service';
export { SchedulesService } from './schedules-service';
export { ScheduleExceptionsService } from './schedule-exceptions-service';
export { SessionsService } from './sessions-service';
export { BookingsService } from './bookings-service';
export { AttendanceService } from './attendance-service';

// Re-export base service utilities
export * from './base-service';
