// Buffer's own addresses and what to say when it sends an artist back, shared by the Promote
// page's tabs. Here rather than beside the component that uses them so that file exports only
// components (react-refresh/only-export-components).

/** Buffer's app, where the artist sees what's scheduled and can change or delete it. */
export const BUFFER_URL = 'https://publish.buffer.com';

/** Where a Buffer user connects their social channels. */
export const BUFFER_CHANNELS_URL = 'https://publish.buffer.com/settings/channels';

/** What to say when Buffer sends the artist back to a Promote tab after a connection attempt. */
export const BUFFER_OUTCOMES: Record<string, string> = {
  // Nothing for 'connected': the channels appearing says it (Brandon, 2026-10-29).
  cancelled: 'Buffer wasn’t connected: the connection was stopped before it finished.',
  expired: 'That took too long and the connection expired. Try again.',
  failed: 'Buffer couldn’t be connected. Try again.',
  unavailable: 'Buffer isn’t available right now.',
};
