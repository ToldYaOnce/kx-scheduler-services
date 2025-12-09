# Kx Scheduling Engine

A multi-tenant, product-agnostic scheduling backend built with AWS CDK, TypeScript, and DynamoDB.

**Perfect for:** Gyms, yoga studios, salons, clinics, co-working spaces, or any business that needs to schedule sessions, manage bookings, and track attendance.

---

## 🚀 Features

- **Multi-tenant by design** - All data isolated by `tenantId`
- **Recurring schedules** - RRULE (RFC5545) support for complex patterns
- **Transactional bookings** - Atomic capacity enforcement with DynamoDB transactions
- **GPS-based attendance** - Verify physical presence with Haversine distance calculation
- **Virtual sessions** - Sessions computed on-demand, not stored (saves storage, always accurate)
- **Schedule exceptions** - Cancel or modify individual occurrences without changing the series
- **Integrates with existing infrastructure** - Attaches to your API Gateway via cross-stack discovery

---

## 📦 Core Entities

| Entity | Description |
|--------|-------------|
| **Program** | What's being scheduled (e.g., "Yoga 101", "Haircut", "Consultation") |
| **Location** | Physical place with GPS coordinates for check-in validation |
| **Schedule** | Time pattern (one-off or recurring) with capacity and hosts |
| **ScheduleException** | Per-date override (cancellation or modification) |
| **Session** | Virtual/computed instance of a schedule (NOT stored) |
| **SessionSummary** | Capacity tracking for a session (bookedCount, waitlistCount) |
| **Booking** | Reservation linking a subject to a session |
| **AttendanceRecord** | Check-in record with GPS validation |

---

## 🌐 API Endpoints

All endpoints require `tenantId` (from JWT `custom:tenantId` claim or `X-Tenant-Id` header).

### Programs
```
GET    /scheduling/programs              # List all programs
GET    /scheduling/programs?programId=x  # Get single program
POST   /scheduling/programs              # Create program
PATCH  /scheduling/programs              # Update program
DELETE /scheduling/programs?programId=x  # Delete program
```

### Locations
```
GET    /scheduling/locations               # List all locations
GET    /scheduling/locations?locationId=x  # Get single location
POST   /scheduling/locations               # Create location (with GPS)
PATCH  /scheduling/locations               # Update location
DELETE /scheduling/locations?locationId=x  # Delete location
```

### Schedules
```
GET    /scheduling/schedules               # List schedules
GET    /scheduling/schedules?scheduleId=x  # Get single schedule
POST   /scheduling/schedules               # Create schedule (with RRULE)
PATCH  /scheduling/schedules               # Update schedule
DELETE /scheduling/schedules?scheduleId=x  # Delete schedule
```

### Schedule Exceptions
```
GET    /scheduling/exceptions?scheduleId=x                      # List exceptions
GET    /scheduling/exceptions?scheduleId=x&occurrenceDate=y     # Get single
POST   /scheduling/exceptions                                    # Create (cancel/override)
PATCH  /scheduling/exceptions                                    # Update
DELETE /scheduling/exceptions?scheduleId=x&occurrenceDate=y     # Delete (restore)
```

### Sessions (Read-Only, Computed)
```
GET    /scheduling/sessions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD  # List sessions
GET    /scheduling/sessions?sessionId=x                               # Get single session
```

### Bookings
```
GET    /scheduling/bookings                    # List user's bookings
GET    /scheduling/bookings?sessionId=x        # List session's bookings
POST   /scheduling/bookings                    # Create booking (transactional)
DELETE /scheduling/bookings?bookingId=x        # Cancel booking
```

### Attendance
```
GET    /scheduling/attendance                  # User's attendance history
GET    /scheduling/attendance?sessionId=x      # Session's attendance
POST   /scheduling/attendance                  # GPS check-in
PATCH  /scheduling/attendance                  # Manual override (admin)
```

---

## 📍 GPS-Based Attendance Check-In

One of the standout features of the Kx Scheduling Engine is **GPS-validated attendance**. Instead of trusting users to click "I'm here" from anywhere, we verify they're physically at the location.

### How It Works

#### 1. Set Up a Location with GPS Coordinates

```bash
POST /scheduling/locations
X-Tenant-Id: tenant_abc123
Content-Type: application/json

{
  "name": "Downtown Yoga Studio",
  "addressLine1": "123 Main St",
  "city": "Austin",
  "state": "TX",
  "lat": 30.2672,
  "lng": -97.7431,
  "checkInRadiusMeters": 100
}
```

The `checkInRadiusMeters` defines how close someone must be to check in (default: 100 meters).

#### 2. Create a Schedule at That Location

```bash
POST /scheduling/schedules
X-Tenant-Id: tenant_abc123
Content-Type: application/json

{
  "type": "SESSION",
  "programId": "prog_yoga101",
  "locationId": "loc_downtown",
  "start": "2025-01-15T09:00:00-06:00",
  "end": "2025-01-15T10:00:00-06:00",
  "timezone": "America/Chicago",
  "isRecurring": true,
  "rrule": "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
  "baseCapacity": 20
}
```

#### 3. User Books a Session

```bash
POST /scheduling/bookings
X-Tenant-Id: tenant_abc123
Content-Type: application/json

{
  "sessionId": "sched_xyz#2025-01-15",
  "subjectId": "user_12345",
  "subjectType": "MEMBER"
}
```

#### 4. User Checks In with GPS

When the user arrives at the studio, their app sends their GPS coordinates:

```bash
POST /scheduling/attendance
X-Tenant-Id: tenant_abc123
Content-Type: application/json

{
  "bookingId": "book_abc123",
  "lat": 30.2675,
  "lng": -97.7428
}
```

#### 5. System Validates Location & Time

The system performs two validations:

**Time Window Validation:**
- Default: 15 minutes before to 15 minutes after session start
- Too early? `"Too early to check in (45 minutes before session)"`
- Too late? `"Too late to check in (30 minutes after session start)"`

**GPS Distance Validation (Haversine Formula):**
- Calculates the actual distance between check-in coordinates and location coordinates
- Uses the [Haversine formula](https://en.wikipedia.org/wiki/Haversine_formula) for spherical Earth distance

```typescript
// The math behind it
const a = Math.sin(Δlat/2)² + cos(lat1) × cos(lat2) × Math.sin(Δlng/2)²
const c = 2 × atan2(√a, √(1-a))
const distance = EARTH_RADIUS × c  // 6,371,000 meters
```

#### 6. Response

**✅ Successful Check-In (within radius):**
```json
{
  "tenantId": "tenant_abc123",
  "sessionId": "sched_xyz#2025-01-15",
  "bookingId": "book_abc123",
  "subjectId": "user_12345",
  "status": "PRESENT",
  "checkInTime": "2025-01-15T08:52:00.000Z",
  "checkInMethod": "GPS",
  "checkInLat": 30.2675,
  "checkInLng": -97.7428,
  "timeValidation": {
    "minutesFromStart": -8,
    "message": "Check-in time valid"
  },
  "gpsValidation": {
    "distanceMeters": 42,
    "message": "Check-in successful (42m from location)"
  }
}
```

**✅ Late Check-In:**
```json
{
  "status": "LATE",
  "timeValidation": {
    "minutesFromStart": 7,
    "message": "Check-in time valid"
  },
  "gpsValidation": {
    "distanceMeters": 35,
    "message": "Check-in successful (35m from location)"
  }
}
```

**❌ Too Far Away:**
```json
{
  "error": "Too far from location (250m, max 100m)"
}
```

**❌ Too Early:**
```json
{
  "error": "Too early to check in (45 minutes before session, window opens 15 minutes before)"
}
```

### Configuration Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `checkInRadiusMeters` | 100 | Maximum distance from location center (per-location) |
| Time window before | 15 min | How early users can check in |
| Time window after | 15 min | How late users can check in |

### Manual Override (Admin)

For cases where GPS fails or special circumstances:

```bash
PATCH /scheduling/attendance
X-Tenant-Id: tenant_abc123
Content-Type: application/json

{
  "sessionId": "sched_xyz#2025-01-15",
  "bookingId": "book_abc123",
  "status": "PRESENT"
}
```

This records the attendance with `checkInMethod: "OVERRIDE"`.

### Attendance Statuses

| Status | Description |
|--------|-------------|
| `PRESENT` | Checked in on time |
| `LATE` | Checked in after session start (but within window) |
| `NO_SHOW` | Did not check in (set via admin override) |

### Check-In Methods

| Method | Description |
|--------|-------------|
| `GPS` | Automatic GPS validation |
| `MANUAL` | User checked in without GPS coords |
| `OVERRIDE` | Admin manually recorded attendance |

---

## 🔄 RRULE Support (Recurring Schedules)

We support RFC5545 RRULE with some MVP constraints:

### Supported Frequencies
- `DAILY` - Every day or every N days
- `WEEKLY` - Specific days of the week (requires `BYDAY`)
- `MONTHLY` - Specific day of the month (simple `BYMONTHDAY` only)

### Examples

**Every weekday at 9 AM:**
```
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
```

**Every Monday, Wednesday, Friday:**
```
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR
```

**Every other week on Tuesday:**
```
RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU
```

**First of every month:**
```
RRULE:FREQ=MONTHLY;BYMONTHDAY=1
```

**Daily for 30 occurrences:**
```
RRULE:FREQ=DAILY;COUNT=30
```

### Not Supported (MVP)
- `YEARLY` frequency
- Complex `BYSETPOS` (e.g., "last Friday of the month")
- `BYHOUR`, `BYMINUTE` (time comes from schedule's `start`)

---

## 💳 Transactional Booking Capacity

Bookings use DynamoDB transactions to ensure atomic capacity enforcement:

```typescript
// What happens when you book:
TransactWrite([
  // 1. Create the booking
  Put({ TableName: 'bookings', Item: booking }),
  
  // 2. Increment counter with capacity check
  Update({
    TableName: 'session-summaries',
    Key: { tenantId, sessionId },
    UpdateExpression: 'SET bookedCount = bookedCount + 1',
    ConditionExpression: 'bookedCount < capacity'  // ← Atomic check!
  })
])
```

If the session is full, the entire transaction fails and returns `409 Conflict: Session is at capacity`.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         API Gateway                              │
│                         (KxGenApi)                               │
└─────────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────┴───────────┐
                    │  /scheduling/*        │
                    └───────────┬───────────┘
                                │
    ┌──────────┬──────────┬─────┴─────┬──────────┬──────────┐
    ▼          ▼          ▼           ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│Programs│ │Locations│ │Schedules│ │Sessions│ │Bookings│ │Attend. │
│ Lambda │ │ Lambda │ │ Lambda │ │ Lambda │ │ Lambda │ │ Lambda │
└────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘
     │          │          │          │          │          │
     └──────────┴──────────┴────┬─────┴──────────┴──────────┘
                                │
                    ┌───────────┴───────────┐
                    │      DynamoDB         │
                    │  (7 tables + GSIs)    │
                    └───────────────────────┘
```

### DynamoDB Tables

| Table | PK | SK | GSIs |
|-------|----|----|------|
| `programs` | tenantId | programId | - |
| `locations` | tenantId | locationId | - |
| `schedules` | tenantId | scheduleId | byProgram, byHost |
| `schedule-exceptions` | tenantId#scheduleId | occurrenceDate | - |
| `session-summaries` | tenantId | sessionId | byDate |
| `bookings` | tenantId#sessionId | bookingId | bySubject, byCreatedAt |
| `attendance` | tenantId#sessionId | bookingId | bySubject |

---

## 🔌 Integration

### Cross-Stack Discovery

This stack attaches to an existing API Gateway using CloudFormation exports:

```typescript
// In your main stack (kx-aws), export the API Gateway:
new CfnOutput(this, 'ApiGatewayId', {
  value: api.restApiId,
  exportName: 'KxGenStack-ApiGatewayId'
});

new CfnOutput(this, 'ApiGatewayRootResourceId', {
  value: api.restApiRootResourceId,
  exportName: 'KxGenStack-ApiGatewayRootResourceId'
});

// In scheduler stack, import it:
const api = RestApi.fromRestApiAttributes(this, 'KxGenApi', {
  restApiId: Fn.importValue('KxGenStack-ApiGatewayId'),
  rootResourceId: Fn.importValue('KxGenStack-ApiGatewayRootResourceId'),
});
```

Or use the discovery helpers from `@toldyaonce/kx-cdk-constructs`:

```typescript
import { ApiGatewayDiscovery } from '@toldyaonce/kx-cdk-constructs';

const api = ApiGatewayDiscovery.importApiGateway(this, 'KxGenApi', 'kxgen');
```

### Authentication

The service expects `tenantId` from one of:
1. JWT claim: `custom:tenantId` (Cognito)
2. Header: `X-Tenant-Id`
3. Query param: `tenantId` (testing only)

User identity (`subjectId`) comes from:
1. JWT claim: `sub` (Cognito user ID)
2. Header: `X-Subject-Id`
3. Request body: `subjectId`

---

## 🛠️ Development

### Prerequisites
- Node.js 20+
- AWS CDK CLI
- AWS credentials configured

### Setup
```bash
npm install
```

### Build
```bash
npm run build
```

### Deploy
```bash
npm run deploy
```

### Update KX packages
```bash
npm run add:utils       # Update lambda-utils + constructs
npm run add:constructs  # Update constructs only
npm run add:events      # Update events packages
```

---

## 📄 License

MIT

---

Built with 🔥 by KX Tech


