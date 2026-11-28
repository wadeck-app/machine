// The shape of a mock route of a scenario (dsl-scenarios), BROWSER-SAFE: no import. It is structurally the `ScenarioHandler` of `@wadeck-app/app-core-sdk/scenarios`
// (the SDK is not imported here so that this folder stays free of any package), so the routes built here are given to `defineScenarios` as they are.

/** The part of the request the mock routes read. */
export interface MockRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** What a mock route answers: a status of 400 or more makes the page fail as with the real backend. */
export interface MockResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly delayMs?: number;
}

export type MockHandler = (request: MockRequest) => MockResponse;

/** `"METHOD /full/path/:param"` -> handler. */
export type MockRoutes = Record<string, MockHandler>;

/** The path every route of the module lives under. */
export const MODULE_PREFIX = '/api/modules/machine';
