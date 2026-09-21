/**
 * Browser transport for the YouTrack REST API, backed by the app Host API.
 *
 * This is the production path: it runs inside the sandboxed widget iframe and
 * calls `/api` with the permissions of the user viewing the widget - no token, no
 * base URL. The REST mapping is shared with the Node transport (client.ts) and
 * lives in youtrack-api.ts.
 *
 * What pins the app's minimum YouTrack version is not this call - the Host API
 * reference carries no version note for `fetchYouTrack` - but the storage the
 * backend handler writes: `AppGlobalStorage` exists since 2024.2 and its
 * extension properties since 2024.3, which is what the manifest asks for.
 */

import { YouTrackApiClient } from './youtrack-api.ts';
import type { ClientOptions } from './youtrack-api.ts';
import type { YouTrackClient } from './types.ts';

type Host = Awaited<ReturnType<typeof YTApp.register>>;

/**
 * Builds a client that routes every request through the Host API.
 *
 * The options are per scan, not per widget: a scan that can be stopped and can say
 * how many requests it has sent needs its own signal and its own counter.
 */
export function createHostClient(host: Host, options: ClientOptions = {}): YouTrackClient {
  return new YouTrackApiClient(
    (path, requestOptions = {}) =>
      host.fetchYouTrack(path, {
        method: requestOptions.method ?? 'GET',
        query: requestOptions.query,
        body: requestOptions.body,
      }),
    options,
  );
}
