import "server-only";

import { unstable_rethrow } from "next/navigation";

import { authenticateApiRequest } from "./auth";
import { privateNoStore } from "./auth-response";
import {
  corsHeaders,
  corsPreflight,
  decorateCorsResponse,
  type CorsAllowed,
} from "./cors";
import { InvalidRequestError } from "./request-body";

const INTERNAL_ERROR = Object.freeze({
  error: "Internal server error" as const,
  code: "internal_error" as const,
});

const INVALID_REQUEST = Object.freeze({
  error: "Invalid request" as const,
  code: "invalid_request" as const,
});

type ProtectedHandler<TRequest extends Request, TArgs extends unknown[]> = (
  request: TRequest,
  ...args: TArgs
) => Response | Promise<Response>;

export function createProtectedRoute(methods: readonly string[]) {
  const methodPolicy = Object.freeze([...methods]);

  return Object.freeze({
    handler<TRequest extends Request, TArgs extends unknown[]>(
      routeHandler: ProtectedHandler<TRequest, TArgs>,
    ): (request: TRequest, ...args: TArgs) => Promise<Response> {
      return async (request: TRequest, ...args: TArgs): Promise<Response> => {
        let cors: CorsAllowed | undefined;

        try {
          const corsResult = corsHeaders(request, methodPolicy);
          if (!corsResult.allowed) {
            return privateNoStore(corsResult.response);
          }
          cors = corsResult;

          const authentication = authenticateApiRequest(request);
          if (!authentication.authenticated) {
            return protectedResponse(
              Response.json(authentication.error, {
                status: authentication.status,
              }),
              cors,
            );
          }

          return protectedResponse(await routeHandler(request, ...args), cors);
        } catch (error) {
          unstable_rethrow(error);
          if (error instanceof InvalidRequestError) {
            const response = Response.json(INVALID_REQUEST, { status: 400 });
            return cors
              ? protectedResponse(response, cors)
              : privateNoStore(response);
          }

          console.error("Protected route error:", error);
          const response = Response.json(INTERNAL_ERROR, { status: 500 });
          return cors
            ? protectedResponse(response, cors)
            : privateNoStore(response);
        }
      };
    },

    OPTIONS(request: Request): Response {
      return privateNoStore(corsPreflight(request, methodPolicy));
    },
  });
}

function protectedResponse(response: Response, cors: CorsAllowed): Response {
  return privateNoStore(decorateCorsResponse(response, cors));
}
