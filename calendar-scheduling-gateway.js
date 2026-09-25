/**
 * Multi-Calendar Scheduling Gateway (Google Apps Script)
 *
 * PUBLIC TEMPLATE
 *
 * Aggregates busy time from multiple Google Calendars into a dedicated
 * booking-facing calendar, then mirrors real bookings back to a primary
 * calendar. Mirrored bookings are excluded from availability aggregation
 * to prevent feedback loops.
 *
 * SETUP
 *   1. Replace the example calendar IDs in CONFIG.
 *   2. Grant the script account read access to every source calendar and
 *      write access to the primary and booking calendars.
 *   3. In Apps Script, enable Services > Google Calendar API.
 *   4. Run testAllSchedulingSyncs() and inspect the execution log.
 *   5. When satisfied, add a time-driven trigger for syncAllScheduling().
 *
 * PRIVACY / INVITES
 *   Source-calendar details are reduced to private anonymous "Busy" blocks.
 *   Mirrored booking events use sendUpdates: "none", so guests are not sent
 *   a second invitation from the primary calendar.
 */

/* ============================================================
 * CONFIGURATION
 * ============================================================ */

const CONFIG = {

  /*
   * Calendars that can safely be queried using Free/Busy.
   *
   * primary calendar is deliberately NOT in this list.
   * It is handled separately because we need event-level
   * information to exclude booking mirrors.
   */

  freeBusySourceCalendarIds: [
    'source-calendar-1@example.com',
    'source-calendar-2@example.com',
    'source-calendar-3@example.com',
    'source-calendar-4@example.com'
  ],


  /*
   * Primary calendar.
   *
   * This is both:
   *
   *   1. an availability source
   *   2. the destination for mirrored booking calendar bookings
   *
   * Therefore it requires event-aware processing.
   */

  primaryCalendarId:
    'primary-calendar@example.com',


  /*
   * Scheduling gateway / booking service calendar.
   */

  bookingCalendarId:
    'booking-calendar@example.com',


  /*
   * Synchronization window.
   */

  daysForward: 60,

  hoursBackward: 24,


  /*
   * Synthetic availability marker.
   *
   * These events live on booking calendar.
   */

  availabilityMarkerKey:
    'schedulingGatewayAvailabilitySync',

  availabilityMarkerValue:
    'booking-service',


  /*
   * Booking mirror marker.
   *
   * These events live on primary calendar.
   */

  bookingMarkerKey:
    'schedulingGatewayBookingMirror',

  bookingMarkerValue:
    'booking-calendar',


  /*
   * Stores the original booking calendar event ID on its primary calendar copy.
   */

  bookingSourceIdKey:
    'schedulingGatewaySourceEventId',


  /*
   * Synthetic availability event title.
   */

  availabilityEventTitle:
    'Busy',


  /*
   * API write protection.
   */

  writeDelayMs: 300,

  maxWriteAttempts: 6,


  /*
   * Diagnostic threshold.
   */

  longBusyThresholdHours: 12
};


/* ============================================================
 * PUBLIC FUNCTIONS — AVAILABILITY
 * ============================================================ */


/**
 * DRY RUN
 *
 * Calculates availability reconciliation without changing booking calendar.
 */
function testAvailabilitySync() {

  reconcileAvailability(true);

}


/**
 * PRODUCTION
 *
 * Synchronizes anonymous availability blocks to booking calendar.
 */
function syncAvailability() {

  reconcileAvailability(false);

}


/* ============================================================
 * PUBLIC FUNCTIONS — BOOKING MIRROR
 * ============================================================ */


/**
 * DRY RUN
 *
 * Shows what booking calendar → primary calendar booking synchronization would do.
 */
function testBookingMirror() {

  reconcileBookingMirror(true);

}


/**
 * PRODUCTION
 *
 * Synchronizes real booking calendar events to primary calendar.
 */
function syncBookingMirror() {

  reconcileBookingMirror(false);

}


/* ============================================================
 * OPTIONAL COMBINED FUNCTIONS
 *
 * Useful later if we want ONE trigger rather than two.
 * ============================================================ */


/**
 * DRY RUN BOTH SYSTEMS.
 */
function testAllSchedulingSyncs() {

  console.log(
    '========================================'
  );

  console.log(
    'BOOKING MIRROR DRY RUN'
  );

  console.log(
    '========================================'
  );

  reconcileBookingMirror(true);


  console.log('');

  console.log(
    '========================================'
  );

  console.log(
    'AVAILABILITY DRY RUN'
  );

  console.log(
    '========================================'
  );

  reconcileAvailability(true);

}


/**
 * PRODUCTION BOTH SYSTEMS.
 *
 * Booking synchronization deliberately runs FIRST.
 *
 * Then availability is recalculated.
 */
function syncAllScheduling() {

  reconcileBookingMirror(false);

  reconcileAvailability(false);

}


/* ============================================================
 * SYNC WINDOW
 * ============================================================ */


function getSyncWindow() {

  const now =
    new Date();


  return {

    timeMin:
      new Date(
        now.getTime() -
        CONFIG.hoursBackward *
        60 * 60 * 1000
      ),

    timeMax:
      new Date(
        now.getTime() +
        CONFIG.daysForward *
        24 * 60 * 60 * 1000
      )

  };

}


/* ============================================================
 * PART A
 *
 * AVAILABILITY RECONCILIATION
 * ============================================================ */


function reconcileAvailability(
  dryRun
) {

  const lock =
    LockService.getScriptLock();


  if (!lock.tryLock(30000)) {

    console.warn(
      'Another scheduling sync is already running. Aborting.'
    );

    return;

  }


  try {

    const {
      timeMin,
      timeMax
    } = getSyncWindow();


    console.log(
      dryRun
        ? '=== BOOKING AVAILABILITY DRY RUN ==='
        : '=== BOOKING AVAILABILITY SYNC ==='
    );


    console.log(
      'Logical availability sources: ' +
      (
        CONFIG.freeBusySourceCalendarIds.length +
        1
      )
    );


    console.log(
      `Standard Free/Busy sources: ` +
      `${CONFIG.freeBusySourceCalendarIds.length}`
    );


    console.log(
      `Event-aware source: ` +
      `${CONFIG.primaryCalendarId}`
    );


    console.log(
      `Window: ${formatPeriod(
        timeMin,
        timeMax
      )}`
    );


    /*
     * STEP 1
     *
     * Get availability from the four ordinary calendars.
     */

    const standardResult =
      getStandardSourceBusyPeriods(
        timeMin,
        timeMax
      );


    if (!standardResult.success) {

      console.error('');

      console.error(
        '=== SYNC ABORTED ==='
      );

      console.error(
        'One or more Free/Busy source calendars could not be read.'
      );

      console.error(
        'No destination events were changed.'
      );

      return;

    }


    /*
     * STEP 2
     *
     * Get busy periods from primary calendar at EVENT LEVEL.
     *
     * This allows us to exclude booking calendar booking mirrors.
     */

    const professionalResult =
      getProfessionalBusyPeriods(
        timeMin,
        timeMax
      );


    if (!professionalResult.success) {

      console.error('');

      console.error(
        '=== SYNC ABORTED ==='
      );

      console.error(
        'The primary calendar could not be read.'
      );

      console.error(
        'No destination events were changed.'
      );

      return;

    }


    /*
     * STEP 3
     *
     * Combine all legitimate busy periods.
     */

    const allBusyPeriods = [

      ...standardResult.busyPeriods,

      ...professionalResult.busyPeriods

    ];


    /*
     * STEP 4
     *
     * Merge overlapping and directly adjacent periods.
     */

    const desiredBlocks =
      mergeBusyPeriods(
        allBusyPeriods
      );


    /*
     * STEP 5
     *
     * Retrieve only our synthetic booking calendar Busy blocks.
     */

    const existingEvents =
      getManagedAvailabilityEvents(
        timeMin,
        timeMax
      );


    /*
     * STEP 6
     *
     * Exact-match reconciliation.
     */

    const plan =
      buildAvailabilityPlan(
        desiredBlocks,
        existingEvents
      );


    console.log('');

    console.log(
      '=== RECONCILIATION PLAN ==='
    );


    console.log(
      `Standard busy periods:     ` +
      `${standardResult.busyPeriods.length}`
    );


    console.log(
      `primary calendar busy events used: ` +
      `${professionalResult.busyPeriods.length}`
    );


    console.log(
      `Booking mirrors excluded:  ` +
      `${professionalResult.excludedMirrors}`
    );


    console.log(
      `Total raw busy periods:    ` +
      `${allBusyPeriods.length}`
    );


    console.log(
      `Merged blocks:             ` +
      `${desiredBlocks.length}`
    );


    console.log(
      `Managed existing:          ` +
      `${existingEvents.length}`
    );


    console.log('');


    console.log(
      `KEEP:   ${plan.keep.length}`
    );


    console.log(
      `CREATE: ${plan.create.length}`
    );


    console.log(
      `DELETE: ${plan.delete.length}`
    );


    logAvailabilityChanges(
      plan
    );


    if (dryRun) {

      console.log('');

      console.log(
        'DRY RUN COMPLETE — destination calendar unchanged.'
      );

      return;

    }


    /*
     * CREATE FIRST.
     *
     * This biases failure toward overblocking rather than
     * accidentally exposing unavailable time.
     */

    for (
      const block of plan.create
    ) {

      createManagedBusyEvent(
        block
      );

    }


    /*
     * DELETE obsolete blocks second.
     */

    for (
      const event of plan.delete
    ) {

      deleteCalendarEvent(
        CONFIG.bookingCalendarId,
        event,
        'obsolete availability block'
      );

    }


    console.log('');

    console.log(
      '=== AVAILABILITY SYNC COMPLETE ==='
    );


    console.log(
      `Kept:    ${plan.keep.length}`
    );


    console.log(
      `Created: ${plan.create.length}`
    );


    console.log(
      `Deleted: ${plan.delete.length}`
    );


  } catch (error) {

    console.error('');

    console.error(
      '=== AVAILABILITY SYNC FAILED ==='
    );

    console.error(
      String(error)
    );

    throw error;


  } finally {

    lock.releaseLock();

  }

}


/* ============================================================
 * STANDARD SOURCE FREE/BUSY
 * ============================================================ */


function getStandardSourceBusyPeriods(
  timeMin,
  timeMax
) {

  const response =
    Calendar.Freebusy.query({

      timeMin:
        timeMin.toISOString(),

      timeMax:
        timeMax.toISOString(),

      items:
        CONFIG.freeBusySourceCalendarIds.map(
          id => ({
            id: id
          })
        )
    });


  let busyPeriods = [];

  let success = true;


  for (
    const calendarId
    of CONFIG.freeBusySourceCalendarIds
  ) {

    const calendar =
      response.calendars[calendarId];


    if (!calendar) {

      console.error(
        `SOURCE ERROR: No response for ${calendarId}`
      );

      success = false;

      continue;

    }


    if (
      calendar.errors &&
      calendar.errors.length > 0
    ) {

      console.error(
        `SOURCE ERROR: ${calendarId}: ` +
        JSON.stringify(
          calendar.errors
        )
      );

      success = false;

      continue;

    }


    const busy =
      calendar.busy || [];


    console.log(
      `${calendarId}: ` +
      `${busy.length} busy period(s)`
    );


    logLongBusyPeriods(
      calendarId,
      busy
    );


    busyPeriods.push(
      ...busy
    );

  }


  return {

    success:
      success,

    busyPeriods:
      busyPeriods

  };

}


/* ============================================================
 * EVENT-AWARE PROFESSIONAL CALENDAR AVAILABILITY
 * ============================================================ */


/**
 * Unlike Free/Busy, this function reads actual primary calendar events.
 *
 * This is necessary because Free/Busy strips event metadata.
 *
 * We need metadata so we can recognize:
 *
 *   schedulingGatewayBookingMirror=booking-calendar
 *
 * and exclude those events from the availability feed.
 */

function getProfessionalBusyPeriods(
  timeMin,
  timeMax
) {

  try {

    const events =
      listCalendarEvents(
        CONFIG.primaryCalendarId,
        timeMin,
        timeMax
      );


    const busyPeriods = [];

    let excludedMirrors = 0;

    let excludedFreeEvents = 0;

    let excludedCancelled = 0;


    for (
      const event of events
    ) {

      /*
       * Cancelled events do not block availability.
       */

      if (
        event.status ===
        'cancelled'
      ) {

        excludedCancelled++;

        continue;

      }


      /*
       * CRITICAL FEEDBACK-LOOP PROTECTION.
       *
       * If this event was copied from booking calendar by our booking
       * synchronization system, do NOT send it back to booking calendar
       * as a synthetic Busy block.
       */

      if (
        isBookingMirrorEvent(
          event
        )
      ) {

        excludedMirrors++;

        continue;

      }


      /*
       * Google Calendar events explicitly marked transparent
       * represent "Free" rather than "Busy".
       */

      if (
        event.transparency ===
        'transparent'
      ) {

        excludedFreeEvents++;

        continue;

      }


      /*
       * Everything remaining genuinely blocks the professional
       * calendar and therefore contributes to availability.
       */

      busyPeriods.push({

        start:
          getEventStart(event)
            .toISOString(),

        end:
          getEventEnd(event)
            .toISOString()

      });

    }


    console.log(
      `${CONFIG.primaryCalendarId}: ` +
      `${busyPeriods.length} busy event(s) used`
    );


    console.log(
      `  Booking mirrors excluded: ${excludedMirrors}`
    );


    console.log(
      `  Free events excluded:      ${excludedFreeEvents}`
    );


    console.log(
      `  Cancelled excluded:        ${excludedCancelled}`
    );


    logLongBusyPeriods(
      CONFIG.primaryCalendarId,
      busyPeriods
    );


    return {

      success:
        true,

      busyPeriods:
        busyPeriods,

      excludedMirrors:
        excludedMirrors,

      excludedFreeEvents:
        excludedFreeEvents,

      excludedCancelled:
        excludedCancelled

    };


  } catch (error) {

    console.error(
      `SOURCE ERROR: ${CONFIG.primaryCalendarId}: ` +
      String(error)
    );


    return {

      success:
        false,

      busyPeriods:
        [],

      excludedMirrors:
        0

    };

  }

}


/* ============================================================
 * BOOKING MIRROR IDENTIFICATION
 * ============================================================ */


function isBookingMirrorEvent(
  event
) {

  const properties =
    event.extendedProperties &&
    event.extendedProperties.private;


  if (!properties) {

    return false;

  }


  return (
    properties[
      CONFIG.bookingMarkerKey
    ] ===
    CONFIG.bookingMarkerValue
  );

}


/* ============================================================
 * AVAILABILITY DESTINATION DISCOVERY
 * ============================================================ */


function getManagedAvailabilityEvents(
  timeMin,
  timeMax
) {

  return listCalendarEvents(
    CONFIG.bookingCalendarId,
    timeMin,
    timeMax,
    `${CONFIG.availabilityMarkerKey}=` +
    `${CONFIG.availabilityMarkerValue}`
  );

}


/* ============================================================
 * AVAILABILITY PLAN
 * ============================================================ */


function buildAvailabilityPlan(
  desiredBlocks,
  existingEvents
) {

  const plan = {

    keep: [],

    create: [],

    delete: []

  };


  const desiredMap =
    new Map();


  for (
    const block of desiredBlocks
  ) {

    desiredMap.set(
      blockKey(
        block.start,
        block.end
      ),
      block
    );

  }


  const existingMap =
    new Map();


  for (
    const event of existingEvents
  ) {

    const key =
      blockKey(
        getEventStart(event),
        getEventEnd(event)
      );


    /*
     * If duplicate managed events somehow exist,
     * preserve one and delete the others.
     */

    if (
      existingMap.has(key)
    ) {

      plan.delete.push(
        event
      );

    } else {

      existingMap.set(
        key,
        event
      );

    }

  }


  for (
    const [key, block]
    of desiredMap
  ) {

    if (
      existingMap.has(key)
    ) {

      plan.keep.push({

        event:
          existingMap.get(key),

        block:
          block

      });

    } else {

      plan.create.push(
        block
      );

    }

  }


  for (
    const [key, event]
    of existingMap
  ) {

    if (
      !desiredMap.has(key)
    ) {

      plan.delete.push(
        event
      );

    }

  }


  return plan;

}


/* ============================================================
 * PART B
 *
 * BOOKING CALENDAR → PRIMARY CALENDAR MIRROR
 * ============================================================ */


function reconcileBookingMirror(
  dryRun
) {

  const lock =
    LockService.getScriptLock();


  if (!lock.tryLock(30000)) {

    console.warn(
      'Another scheduling sync is already running. Aborting.'
    );

    return;

  }


  try {

    const {
      timeMin,
      timeMax
    } = getSyncWindow();


    console.log(
      dryRun
        ? '=== BOOKING MIRROR DRY RUN ==='
        : '=== BOOKING MIRROR SYNC ==='
    );


    console.log(
      `Source: ${CONFIG.bookingCalendarId}`
    );


    console.log(
      `Destination: ${CONFIG.primaryCalendarId}`
    );


    console.log(
      `Window: ${formatPeriod(
        timeMin,
        timeMax
      )}`
    );


    /*
     * Get all booking calendar events.
     */

    const bookingEvents =
      listCalendarEvents(
        CONFIG.bookingCalendarId,
        timeMin,
        timeMax
      );


    /*
     * Everything except our synthetic availability blocks is
     * considered a real booking calendar event.
     */

    const realBookingEvents =
      bookingEvents.filter(
        event =>
          !isManagedAvailabilityEvent(
            event
          )
      );


    /*
     * Get booking mirrors already living on primary calendar.
     */

    const mirroredEvents =
      listCalendarEvents(
        CONFIG.primaryCalendarId,
        timeMin,
        timeMax,
        `${CONFIG.bookingMarkerKey}=` +
        `${CONFIG.bookingMarkerValue}`
      );


    const plan =
      buildBookingMirrorPlan(
        realBookingEvents,
        mirroredEvents
      );


    console.log('');

    console.log(
      '=== BOOKING MIRROR PLAN ==='
    );


    console.log(
      `booking calendar events total:      ${bookingEvents.length}`
    );


    console.log(
      `Synthetic Busy events:  ${
        bookingEvents.length -
        realBookingEvents.length
      }`
    );


    console.log(
      `Real booking calendar events:       ${realBookingEvents.length}`
    );


    console.log(
      `Existing mirror events: ${mirroredEvents.length}`
    );


    console.log('');


    console.log(
      `KEEP:   ${plan.keep.length}`
    );


    console.log(
      `CREATE: ${plan.create.length}`
    );


    console.log(
      `UPDATE: ${plan.update.length}`
    );


    console.log(
      `DELETE: ${plan.delete.length}`
    );


    logBookingChanges(
      plan
    );


    if (dryRun) {

      console.log('');

      console.log(
        'DRY RUN COMPLETE — no booking copies were changed.'
      );

      return;

    }


    /*
     * CREATE.
     */

    for (
      const sourceEvent of plan.create
    ) {

      createBookingMirror(
        sourceEvent
      );

    }


    /*
     * UPDATE.
     */

    for (
      const change of plan.update
    ) {

      updateBookingMirror(
        change.sourceEvent,
        change.mirrorEvent
      );

    }


    /*
     * DELETE.
     */

    for (
      const mirrorEvent of plan.delete
    ) {

      deleteCalendarEvent(
        CONFIG.primaryCalendarId,
        mirrorEvent,
        'obsolete booking calendar booking mirror'
      );

    }


    console.log('');

    console.log(
      '=== BOOKING MIRROR SYNC COMPLETE ==='
    );


    console.log(
      `Kept:    ${plan.keep.length}`
    );


    console.log(
      `Created: ${plan.create.length}`
    );


    console.log(
      `Updated: ${plan.update.length}`
    );


    console.log(
      `Deleted: ${plan.delete.length}`
    );


  } catch (error) {

    console.error('');

    console.error(
      '=== BOOKING MIRROR SYNC FAILED ==='
    );

    console.error(
      String(error)
    );

    throw error;


  } finally {

    lock.releaseLock();

  }

}


/* ============================================================
 * IDENTIFY SYNTHETIC BOOKING-CALENDAR AVAILABILITY EVENTS
 * ============================================================ */


function isManagedAvailabilityEvent(
  event
) {

  const properties =
    event.extendedProperties &&
    event.extendedProperties.private;


  if (!properties) {

    return false;

  }


  return (
    properties[
      CONFIG.availabilityMarkerKey
    ] ===
    CONFIG.availabilityMarkerValue
  );

}


/* ============================================================
 * BOOKING MIRROR PLAN
 * ============================================================ */


function buildBookingMirrorPlan(
  sourceEvents,
  mirrorEvents
) {

  const plan = {

    keep: [],

    create: [],

    update: [],

    delete: []

  };


  const mirrorBySourceId =
    new Map();


  for (
    const mirrorEvent of mirrorEvents
  ) {

    const sourceId =
      getBookingSourceId(
        mirrorEvent
      );


    /*
     * Malformed managed mirror.
     */

    if (!sourceId) {

      plan.delete.push(
        mirrorEvent
      );

      continue;

    }


    /*
     * Duplicate mirror.
     */

    if (
      mirrorBySourceId.has(
        sourceId
      )
    ) {

      plan.delete.push(
        mirrorEvent
      );

      continue;

    }


    mirrorBySourceId.set(
      sourceId,
      mirrorEvent
    );

  }


  const activeSourceIds =
    new Set();


  for (
    const sourceEvent of sourceEvents
  ) {

    if (
      sourceEvent.status ===
      'cancelled'
    ) {

      continue;

    }


    activeSourceIds.add(
      sourceEvent.id
    );


    const mirrorEvent =
      mirrorBySourceId.get(
        sourceEvent.id
      );


    if (!mirrorEvent) {

      plan.create.push(
        sourceEvent
      );

      continue;

    }


    if (
      bookingEventsMatch(
        sourceEvent,
        mirrorEvent
      )
    ) {

      plan.keep.push({

        sourceEvent:
          sourceEvent,

        mirrorEvent:
          mirrorEvent

      });

    } else {

      plan.update.push({

        sourceEvent:
          sourceEvent,

        mirrorEvent:
          mirrorEvent

      });

    }

  }


  for (
    const [sourceId, mirrorEvent]
    of mirrorBySourceId
  ) {

    if (
      !activeSourceIds.has(
        sourceId
      )
    ) {

      plan.delete.push(
        mirrorEvent
      );

    }

  }


  return plan;

}


/* ============================================================
 * BOOKING EVENT COMPARISON
 * ============================================================ */


function bookingEventsMatch(
  sourceEvent,
  mirrorEvent
) {

  return (

    normalizeText(
      sourceEvent.summary
    ) ===
    normalizeText(
      mirrorEvent.summary
    )

    &&

    normalizeText(
      sourceEvent.description
    ) ===
    normalizeText(
      mirrorEvent.description
    )

    &&

    normalizeText(
      sourceEvent.location
    ) ===
    normalizeText(
      mirrorEvent.location
    )

    &&

    blockKey(
      getEventStart(sourceEvent),
      getEventEnd(sourceEvent)
    ) ===
    blockKey(
      getEventStart(mirrorEvent),
      getEventEnd(mirrorEvent)
    )

  );

}


function normalizeText(
  value
) {

  return value || '';

}


/* ============================================================
 * CREATE BOOKING MIRROR
 * ============================================================ */


function createBookingMirror(
  sourceEvent
) {

  const resource =
    buildBookingMirrorResource(
      sourceEvent
    );


  return calendarWriteWithRetry(

    () =>
      Calendar.Events.insert(
        resource,
        CONFIG.primaryCalendarId,
        {
          sendUpdates:
            'none'
        }
      ),

    `mirroring booking calendar event ${sourceEvent.id}`

  );

}


/* ============================================================
 * UPDATE BOOKING MIRROR
 * ============================================================ */


function updateBookingMirror(
  sourceEvent,
  mirrorEvent
) {

  const resource =
    buildBookingMirrorResource(
      sourceEvent
    );


  return calendarWriteWithRetry(

    () =>
      Calendar.Events.patch(
        resource,
        CONFIG.primaryCalendarId,
        mirrorEvent.id,
        {
          sendUpdates:
            'none'
        }
      ),

    `updating booking mirror ${mirrorEvent.id}`

  );

}


/* ============================================================
 * BUILD BOOKING MIRROR RESOURCE
 * ============================================================ */


function buildBookingMirrorResource(
  sourceEvent
) {

  const resource = {

    summary:
      sourceEvent.summary ||
      'Booked Session',


    description:
      sourceEvent.description ||
      '',


    location:
      sourceEvent.location ||
      '',


    start:
      cloneEventDate(
        sourceEvent.start
      ),


    end:
      cloneEventDate(
        sourceEvent.end
      ),


    transparency:
      sourceEvent.transparency ||
      'opaque',


    visibility:
      'private',


    extendedProperties: {

      private: {

        [CONFIG.bookingMarkerKey]:
          CONFIG.bookingMarkerValue,

        [CONFIG.bookingSourceIdKey]:
          sourceEvent.id

      }
    }
  };


  /*
   * Preserve conferencing information when exposed by Google.
   *
   * No new conference is created.
   */

  if (
    sourceEvent.conferenceData
  ) {

    resource.conferenceData =
      sourceEvent.conferenceData;

  }


  return resource;

}


/* ============================================================
 * CLONE EVENT DATE
 * ============================================================ */


function cloneEventDate(
  eventDate
) {

  if (
    eventDate.dateTime
  ) {

    const result = {

      dateTime:
        eventDate.dateTime

    };


    if (
      eventDate.timeZone
    ) {

      result.timeZone =
        eventDate.timeZone;

    }


    return result;

  }


  return {

    date:
      eventDate.date

  };

}


/* ============================================================
 * GET ORIGINAL BOOKING EVENT ID
 * ============================================================ */


function getBookingSourceId(
  event
) {

  const properties =
    event.extendedProperties &&
    event.extendedProperties.private;


  if (!properties) {

    return null;

  }


  return (
    properties[
      CONFIG.bookingSourceIdKey
    ] ||
    null
  );

}


/* ============================================================
 * GENERIC EVENT LISTING
 * ============================================================ */


function listCalendarEvents(
  calendarId,
  timeMin,
  timeMax,
  privateExtendedProperty
) {

  let events = [];

  let pageToken;


  do {

    const options = {

      timeMin:
        timeMin.toISOString(),

      timeMax:
        timeMax.toISOString(),

      singleEvents:
        true,

      maxResults:
        2500,

      pageToken:
        pageToken

    };


    if (
      privateExtendedProperty
    ) {

      options.privateExtendedProperty =
        privateExtendedProperty;

    }


    const response =
      Calendar.Events.list(
        calendarId,
        options
      );


    events.push(
      ...(response.items || [])
    );


    pageToken =
      response.nextPageToken;


  } while (pageToken);


  return events;

}


/* ============================================================
 * CREATE SYNTHETIC BUSY EVENT
 * ============================================================ */


function createManagedBusyEvent(
  block
) {

  const event = {

    summary:
      CONFIG.availabilityEventTitle,


    start: {

      dateTime:
        new Date(
          block.start
        ).toISOString()

    },


    end: {

      dateTime:
        new Date(
          block.end
        ).toISOString()

    },


    transparency:
      'opaque',


    visibility:
      'private',


    extendedProperties: {

      private: {

        [CONFIG.availabilityMarkerKey]:
          CONFIG.availabilityMarkerValue

      }
    }
  };


  return calendarWriteWithRetry(

    () =>
      Calendar.Events.insert(
        event,
        CONFIG.bookingCalendarId,
        {
          sendUpdates:
            'none'
        }
      ),

    `creating Busy block ${formatPeriod(
      block.start,
      block.end
    )}`

  );

}


/* ============================================================
 * GENERIC DELETE
 * ============================================================ */


function deleteCalendarEvent(
  calendarId,
  event,
  description
) {

  return calendarWriteWithRetry(

    () =>
      Calendar.Events.remove(
        calendarId,
        event.id,
        {
          sendUpdates:
            'none'
        }
      ),

    `deleting ${description}: ${event.id}`

  );

}


/* ============================================================
 * RATE-LIMIT SAFE WRITES
 * ============================================================ */


function calendarWriteWithRetry(
  operation,
  description
) {

  for (
    let attempt = 1;
    attempt <= CONFIG.maxWriteAttempts;
    attempt++
  ) {

    try {

      const result =
        operation();


      Utilities.sleep(
        CONFIG.writeDelayMs
      );


      return result;


    } catch (error) {

      const message =
        String(error);


      const retryable =

        message.includes(
          'Rate Limit Exceeded'
        ) ||

        message.includes(
          'rateLimitExceeded'
        ) ||

        message.includes(
          'userRateLimitExceeded'
        ) ||

        message.includes(
          'Quota exceeded'
        ) ||

        message.includes(
          'Service invoked too many times'
        );


      if (!retryable) {

        console.error(
          `FAILED: ${description}`
        );

        throw error;

      }


      if (
        attempt ===
        CONFIG.maxWriteAttempts
      ) {

        console.error(
          `FAILED: ${description} after ` +
          `${attempt} attempt(s).`
        );

        throw error;

      }


      const delay =

        Math.pow(
          2,
          attempt - 1
        ) * 1000

        +

        Math.floor(
          Math.random() * 500
        );


      console.warn(
        `Rate limited while ${description}. ` +
        `Attempt ${attempt}/${CONFIG.maxWriteAttempts}. ` +
        `Retrying in ${delay} ms.`
      );


      Utilities.sleep(
        delay
      );

    }
  }

}


/* ============================================================
 * MERGE BUSY PERIODS
 * ============================================================ */


function mergeBusyPeriods(
  periods
) {

  if (!periods.length) {

    return [];

  }


  const sorted =

    periods

      .map(
        period => ({

          start:
            new Date(
              period.start
            ),

          end:
            new Date(
              period.end
            )

        })
      )

      .sort(
        (a, b) =>
          a.start - b.start
      );


  const merged =
    [sorted[0]];


  for (
    let i = 1;
    i < sorted.length;
    i++
  ) {

    const current =
      sorted[i];


    const previous =
      merged[
        merged.length - 1
      ];


    /*
     * Overlapping AND directly adjacent periods are merged.
     */

    if (
      current.start <=
      previous.end
    ) {

      if (
        current.end >
        previous.end
      ) {

        previous.end =
          current.end;

      }

    } else {

      merged.push(
        current
      );

    }

  }


  return merged.map(
    period => ({

      start:
        period.start.toISOString(),

      end:
        period.end.toISOString()

    })
  );

}


/* ============================================================
 * EVENT HELPERS
 * ============================================================ */


function blockKey(
  start,
  end
) {

  return (
    new Date(start).toISOString() +
    '|' +
    new Date(end).toISOString()
  );

}


function getEventStart(
  event
) {

  return new Date(
    event.start.dateTime ||
    event.start.date
  );

}


function getEventEnd(
  event
) {

  return new Date(
    event.end.dateTime ||
    event.end.date
  );

}


function getDurationHours(
  start,
  end
) {

  return (
    new Date(end).getTime() -
    new Date(start).getTime()
  ) /
  (1000 * 60 * 60);

}


/* ============================================================
 * LONG BUSY DIAGNOSTICS
 * ============================================================ */


function logLongBusyPeriods(
  calendarId,
  periods
) {

  for (
    const period of periods
  ) {

    const hours =
      getDurationHours(
        period.start,
        period.end
      );


    if (
      hours >
      CONFIG.longBusyThresholdHours
    ) {

      console.warn(
        `LONG BUSY SOURCE PERIOD: ` +
        `${calendarId} | ` +
        `${formatPeriod(
          period.start,
          period.end
        )} | ` +
        `${hours.toFixed(2)} hours`
      );

    }

  }

}


/* ============================================================
 * AVAILABILITY LOGGING
 * ============================================================ */


function logAvailabilityChanges(
  plan
) {

  if (
    !plan.create.length &&
    !plan.delete.length
  ) {

    console.log('');

    console.log(
      'No availability changes required.'
    );

    return;

  }


  console.log('');


  for (
    const block of plan.create
  ) {

    console.log(
      `CREATE: ${formatPeriod(
        block.start,
        block.end
      )}`
    );

  }


  for (
    const event of plan.delete
  ) {

    console.log(
      `DELETE: ${formatEvent(
        event
      )}`
    );

  }

}


/* ============================================================
 * BOOKING LOGGING
 * ============================================================ */


function logBookingChanges(
  plan
) {

  if (
    !plan.create.length &&
    !plan.update.length &&
    !plan.delete.length
  ) {

    console.log('');

    console.log(
      'No booking changes required.'
    );

    return;

  }


  console.log('');


  for (
    const event of plan.create
  ) {

    console.log(
      `CREATE: ${formatBookingEvent(
        event
      )}`
    );

  }


  for (
    const change of plan.update
  ) {

    console.log(
      `UPDATE: ${formatBookingEvent(
        change.sourceEvent
      )}`
    );

  }


  for (
    const event of plan.delete
  ) {

    console.log(
      `DELETE: ${formatBookingEvent(
        event
      )}`
    );

  }

}


/* ============================================================
 * FORMATTING
 * ============================================================ */


function formatEvent(
  event
) {

  return formatPeriod(
    getEventStart(event),
    getEventEnd(event)
  );

}


function formatBookingEvent(
  event
) {

  return (
    `"${event.summary || '(No title)'}" | ` +
    `${formatEvent(event)}`
  );

}


function formatPeriod(
  start,
  end
) {

  return (
    `${new Date(start).toLocaleString()} → ` +
    `${new Date(end).toLocaleString()}`
  );

}


/* ============================================================
 * CALENDAR DISCOVERY
 * ============================================================ */


function listAvailableCalendars() {

  let pageToken;


  do {

    const response =
      Calendar.CalendarList.list({

        maxResults:
          250,

        pageToken:
          pageToken

      });


    const calendars =
      response.items || [];


    calendars.forEach(
      calendar => {

        console.log(
          `${calendar.summary} | ${calendar.id}`
        );

      }
    );


    pageToken =
      response.nextPageToken;


  } while (pageToken);

}
