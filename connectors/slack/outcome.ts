// Whether a write hydra asked Slack for (a post, a file upload) may have happened. The clients that write never retry, so a failed write either
// did not happen, and Slack's answer says so, or its outcome is unknown and a resend could make it twice.

/** Errors that say a write did not happen: a platform refusal (`An API error occurred: …`), a rate limit, no connection. */
const CLEANLY_REFUSED = /An API error occurred|rate.?limit|not connected/i

/** Anything but a clean refusal (fatal_error, a 5xx, a timeout, a dropped socket) may have half succeeded. */
export const outcomeUnknown = (why: string): boolean => !CLEANLY_REFUSED.test(why) || /fatal_error/.test(why)
