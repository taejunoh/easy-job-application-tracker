import "server-only";

import { unstable_rethrow } from "next/navigation";

import {
  authenticateApiRequestAsync,
  type ApiAuthenticationResult,
} from "./auth";
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

const FORBIDDEN = Object.freeze({
  error: "Forbidden" as const,
  code: "forbidden" as const,
});

type ProtectedHandler<TRequest extends Request, TArgs extends unknown[]> = (
  request: TRequest,
  ...args: TArgs
) => Response | Promise<Response>;

export type ApiPrincipal =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "session" }>
  | Readonly<{
      kind: "installation";
      installationId: string;
      origin: string;
    }>;

type ProtectedPrincipalHandler<
  TRequest extends Request,
  TArgs extends unknown[],
> = (
  request: TRequest,
  principal: ApiPrincipal,
  ...args: TArgs
) => Response | Promise<Response>;

type ProtectedRouteOptions = Readonly<{
  installationMethods?: readonly string[];
}>;

export function createProtectedRoute(
  methods: readonly string[],
  options: ProtectedRouteOptions = {},
) {
  const methodPolicy = Object.freeze([...methods]);
  const installationMethods = new Set(
    (options.installationMethods ?? []).map((method) => method.toUpperCase()),
  );

  const execute = async <TRequest extends Request, TArgs extends unknown[]>(
    routeHandler: ProtectedHandler<TRequest, TArgs> | undefined,
    principalHandler: ProtectedPrincipalHandler<TRequest, TArgs> | undefined,
    request: TRequest,
    args: TArgs,
  ): Promise<Response> => {
    let cors: CorsAllowed | undefined;

    try {
      const corsResult = corsHeaders(request, methodPolicy);
      if (!corsResult.allowed) return privateNoStore(corsResult.response);
      cors = corsResult;

      const authentication = await authenticateApiRequestAsync(request);
      if (!authentication.authenticated) {
        return protectedResponse(
          Response.json(authentication.error, {
            status: authentication.status,
          }),
          cors,
        );
      }
      if (
        authentication.via === "installation" &&
        !installationMethods.has(request.method.toUpperCase())
      ) {
        return protectedResponse(
          Response.json(FORBIDDEN, { status: 403 }),
          cors,
        );
      }

      const principal = authenticationPrincipal(authentication);
      const response = principalHandler
        ? await principalHandler(request, principal, ...args)
        : await (routeHandler as ProtectedHandler<TRequest, TArgs>)(
            request,
            ...args,
          );
      return protectedResponse(response, cors);
    } catch (error) {
      unstable_rethrow(error);
      if (error instanceof InvalidRequestError) {
        const response = Response.json(INVALID_REQUEST, { status: 400 });
        return cors ? protectedResponse(response, cors) : privateNoStore(response);
      }

      console.error("Protected route error:", error);
      const response = Response.json(INTERNAL_ERROR, { status: 500 });
      return cors ? protectedResponse(response, cors) : privateNoStore(response);
    }
  };

  return Object.freeze({
    handler<TRequest extends Request, TArgs extends unknown[]>(
      routeHandler: ProtectedHandler<TRequest, TArgs>,
    ): (request: TRequest, ...args: TArgs) => Promise<Response> {
      return async (request: TRequest, ...args: TArgs): Promise<Response> => {
        return execute(routeHandler, undefined, request, args);
      };
    },

    handlerWithPrincipal<TRequest extends Request, TArgs extends unknown[]>(
      routeHandler: ProtectedPrincipalHandler<TRequest, TArgs>,
    ): (request: TRequest, ...args: TArgs) => Promise<Response> {
      return async (request: TRequest, ...args: TArgs): Promise<Response> => {
        return execute(undefined, routeHandler, request, args);
      };
    },

    OPTIONS(request: Request): Response {
      return privateNoStore(corsPreflight(request, methodPolicy));
    },
  });
}

function authenticationPrincipal(
  authentication: Extract<ApiAuthenticationResult, { authenticated: true }>,
): ApiPrincipal {
  if (authentication.via === "installation") return authentication.principal;
  return Object.freeze({
    kind: authentication.via === "session" ? "session" : "root",
  });
}

function protectedResponse(response: Response, cors: CorsAllowed): Response {
  return privateNoStore(decorateCorsResponse(response, cors));
}
