/**
 * Node transport for the YouTrack REST API, authenticated with a permanent token.
 *
 * Used by the probe and scan scripts, never by the app: inside a widget the Host
 * API provides the transport instead (host-client.ts). The REST mapping is shared
 * between both and lives in youtrack-api.ts.
 */

import { ApiError, YouTrackApiClient } from './youtrack-api.ts';
import type { ApiTransport, RequestOptions } from './youtrack-api.ts';
import type { YouTrackClient } from './types.ts';

const API_ROOT = '/api';

export interface RestClientOptions {
  baseUrl?: string;
  token?: string;
}

/**
 * Builds a client that talks to YouTrack over HTTP with a permanent token, read
 * from the arguments or from YT_BASE_URL / YT_TOKEN.
 */
export function createRestClient(options: RestClientOptions = {}): YouTrackClient {
  const baseUrl = options.baseUrl ?? process.env.YT_BASE_URL;
  const token = options.token ?? process.env.YT_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('YT_BASE_URL and YT_TOKEN must be set.');
  }
  const base = baseUrl.replace(/\/+$/, '');
  // Serialising and pacing is the client's job, the same for both transports.
  return new YouTrackApiClient(<T>(path: string, options: RequestOptions = {}) =>
    send<T>(base, token, path, options),
  );
}

async function send<T>(
  baseUrl: string,
  token: string,
  path: string,
  options: RequestOptions,
): Promise<T> {
  const query = options.query ? `?${new URLSearchParams(options.query)}` : '';
  const url = `${baseUrl}${API_ROOT}/${path}${query}`;
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ApiError(res.status, path, detail.slice(0, 200));
  }
  return (await res.json()) as T;
}
