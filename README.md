# Google Calendar Scheduling Gateway

A Google Apps Script that combines availability from multiple Google Calendars into a scheduling gateway while keeping event details private.

It also mirrors appointments created through the booking service back to a primary calendar without creating duplicate invitations for attendees.

This is useful when a booking service can only connect to **one Google Calendar**, but your real availability lives across several calendars.

## The Problem

Many people have more than one calendar:

- Personal
- Work
- Client
- Volunteer or community
- Consulting
- Project-specific calendars

A scheduling service may only check one calendar for conflicts.

Sharing Free/Busy information between Google accounts can solve part of the problem, but it becomes awkward when calendars live across different accounts, organizations, or permission boundaries.

This script creates a small scheduling gateway between them.

## How It Works

```text
SOURCE CALENDARS
      │
      │ Free/Busy
      ▼
┌─────────────────────┐
│ Scheduling Gateway  │
└─────────────────────┘
      │
      │ Anonymous "Busy" events
      ▼
BOOKING SERVICE
```

The gateway exposes anonymous events named `Busy` to the booking service.

The booking service therefore sees when you are unavailable without receiving titles, descriptions, attendees, locations, or other details from your source calendars.

### Booking Mirror

Appointments created through the booking service travel in the opposite direction:

```text
BOOKING SERVICE
      │
      ▼
BOOKING CALENDAR
      │
      │ synchronized copy
      ▼
PRIMARY CALENDAR
```

The copy is created with:

```javascript
sendUpdates: 'none'
```

The attendee therefore receives the original booking invitation rather than another invitation from the primary calendar.

## Feedback-Loop Protection

There is one wrinkle.

The primary calendar may serve two purposes:

1. It contributes to availability.
2. It receives mirrored booking appointments.

Without special handling, this could happen:

```text
Booking created
      ↓
Booking calendar
      ↓
Mirrored to primary calendar
      ↓
Primary calendar reports it as busy
      ↓
Another Busy event gets created
      ↓
Booking calendar
```

The script prevents this loop with private Google Calendar extended properties.

Mirrored booking events receive a marker:

```text
schedulingGatewayBookingMirror
```

When the script calculates availability from the primary calendar, it reads events individually and excludes anything carrying that marker.

The original booking already blocks the booking calendar, so another synthetic Busy event isn't needed.

## Privacy Model

Regular source calendars are queried through Google's **Free/Busy API**.

The script receives only time ranges:

```text
2026-10-01 10:00 → 11:00
2026-10-01 14:30 → 15:30
```

It doesn't need event titles or descriptions.

The primary calendar is different because the script must inspect event metadata to distinguish real events from mirrored bookings.

Synthetic availability events contain only:

```text
Title: Busy
Visibility: Private
Start: <busy period start>
End: <busy period end>
```

No source event details are copied.

## Requirements

You'll need:

- A Google account that owns or can access the target calendars. The **primary calendar on this account is used by the script** for receiving mirrored bookings and contributing availability.
- [Google Apps Script](https://script.google.com/)
- Access to each source calendar ([Google Calendar sharing instructions](https://support.google.com/calendar/answer/37082)). Standard source calendars only require **See only free/busy (hide details)** access.
- A Google Calendar that the booking service can access
- The **Google Calendar API Advanced Service**, enabled in Apps Script:

```text
Services
  → Add a service
  → Google Calendar API
```

## Configuration

All user-specific settings live in the `CONFIG` object near the top of the script.

### Standard Source Calendars

Add calendars that can safely be queried through Free/Busy:

```javascript
freeBusySourceCalendarIds: [
  'personal@example.com',
  'work@example.com',
  'client@example.com'
],
```

These calendars contribute availability without exposing event details.

### Primary Calendar

Set the calendar that should receive mirrored bookings:

```javascript
primaryCalendarId:
  'primary@example.com',
```

This calendar also contributes availability.

Because it receives mirrored bookings, the script reads it at the event level so those mirrors can be excluded from availability aggregation.

The account running the script therefore needs enough access to this calendar to read individual events and create, update, and delete booking mirrors.

### Booking Calendar

Set the calendar that the booking service can access:

```javascript
bookingCalendarId:
  'booking@example.com',
```

This calendar receives anonymous Busy events and appointments created through the booking service.

The script needs permission to read and modify events on this calendar.

## Sync Window

By default, the script processes:

```javascript
daysForward: 60,
hoursBackward: 24,
```

That means it maintains approximately 60 days of future availability while looking slightly backward to clean up or reconcile recent events.

Adjust these values for your scheduling workflow.

## First Run

Don't start by writing events.

Run the dry-run functions first.

### Test Availability

Run:

```javascript
testAvailabilitySync()
```

The execution log will show the availability reconciliation plan:

```text
KEEP
CREATE
DELETE
```

Nothing changes on the booking calendar.

### Test Booking Mirroring

Run:

```javascript
testBookingMirror()
```

The log shows which booking events would be:

```text
KEEP
CREATE
UPDATE
DELETE
```

Again, nothing changes.

### Test Everything

You can also run:

```javascript
testAllSchedulingSyncs()
```

This tests both directions without changing either calendar.

## Going Live

Once the dry-run output looks correct, run:

```javascript
syncAllScheduling()
```

The script first synchronizes bookings back to the primary calendar.

It then recalculates availability.

That order matters because the availability calculation can immediately recognize any newly created booking mirrors.

## Automated Triggers

After testing, [create a time-driven Apps Script trigger](https://developers.google.com/apps-script/guides/triggers/installable#time-driven_triggers) for:

```javascript
syncAllScheduling
```

A schedule such as every **5 to 15 minutes** works for many personal scheduling setups.

Choose the interval based on how quickly the booking service needs to reflect changes.

Apps Script quotas and Calendar API limits still apply.

## Reconciliation Instead of Blind Copying

The script doesn't delete and recreate every event during each run.

It calculates the desired state and compares that with events it already manages.

For availability blocks, it determines:

```text
KEEP
CREATE
DELETE
```

For booking mirrors:

```text
KEEP
CREATE
UPDATE
DELETE
```

Existing events that already match remain untouched.

This cuts unnecessary Calendar API writes and reduces the chance of hitting API limits.

## Rate-Limit Handling

Calendar writes use retry logic with exponential backoff.

If Google reports a temporary quota or rate-limit error, the script waits and retries instead of immediately failing.

The configuration includes:

```javascript
writeDelayMs: 300,
maxWriteAttempts: 6,
```

These values can be adjusted if needed.

## Failure Behavior

Availability synchronization follows a conservative rule:

**When a source calendar can't be read, don't modify the destination calendar.**

This matters because deleting existing Busy blocks after a failed source lookup could accidentally expose time that isn't actually available.

When creating and deleting availability blocks, the script also creates new Busy blocks **before** deleting obsolete ones.

A partial failure therefore tends to temporarily block too much time rather than expose unavailable time.

## Event Ownership

The script only manages events carrying its private extended-property markers.

It doesn't assume every event named `Busy` belongs to the script.

This distinction matters.

Someone can manually create an event named `Busy` without the synchronization system touching it.

## Calendar Discovery

If you don't know a calendar's ID, run:

```javascript
listAvailableCalendars()
```

The execution log will print calendars available to the Apps Script account:

```text
Calendar Name | calendar-id@example.com
```

Use those IDs in `CONFIG`.

## Recommended Architecture

A clean setup looks like this:

```text
Personal Calendar ───────┐
                         │
Work Calendar ───────────┤
                         │
Client Calendar ─────────┤
                         │
Primary Calendar ────────┤
                         │
                         ▼
                Scheduling Gateway
                         │
                         ▼
                  Booking Service
```

The calendar connected to the booking service should ideally be used specifically for scheduling.

That separation keeps the system easier to understand and limits what the external booking service can see.

## What This Script Doesn't Do

This isn't a full calendar synchronization system.

It doesn't attempt to merge Google accounts or reproduce every source event.

It has two narrow jobs:

**Availability:** Tell the booking service when you're unavailable.

**Booking mirroring:** Put appointments created through the booking service onto your primary calendar.

Keeping those jobs narrow makes the feedback-loop rules manageable.

## Before Publishing or Forking

Replace the example calendar IDs in `CONFIG`.

Never commit private email addresses, calendar IDs you don't want public, API credentials, tokens, or other account-specific information.

This script doesn't require hard-coded Google credentials. Apps Script handles authorization through the account running the script.

## License

Licensed under the [MIT License](LICENSE).

Copyright © 2026 tekNorah
