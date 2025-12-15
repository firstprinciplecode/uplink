export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function makeError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): ApiErrorBody {
  return { error: { code, message, details } };
}



