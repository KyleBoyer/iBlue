import type {
  BlueBubblesResponse,
  BlueBubblesStatus,
} from "./contracts.js";

export function success<T>(
  data: T,
  message = "Success",
  metadata?: Record<string, unknown>,
): BlueBubblesResponse<T> {
  return {
    status: 200,
    message,
    data,
    ...(metadata ? { metadata } : {}),
  };
}

export function failure(
  status: Exclude<BlueBubblesStatus, 200 | 201>,
  message: string,
  type: string,
  errorMessage: string,
  data?: unknown,
): BlueBubblesResponse {
  return {
    status,
    message,
    error: { type, message: errorMessage },
    ...(data === undefined ? {} : { data }),
  };
}

export function unsupported(feature: string): BlueBubblesResponse {
  return failure(
    501,
    `${feature} is not available in iBlue's direct IDS mode`,
    "Not Implemented",
    "UNSUPPORTED_BY_DIRECT_IDS",
  );
}
