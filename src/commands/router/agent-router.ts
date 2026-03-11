/** tRPC agent router accessor helpers. */

import type { AgentRouterLike, AgentMutator, AgentQuery, TrpcLike } from "../types.js";

export function resolveAgentRouter(trpc: TrpcLike | null): AgentRouterLike {
  const router = trpc?.agent;
  if (!router) {
    throw new Error("tRPC agent client is unavailable.");
  }
  const requireMutator = (name: keyof AgentRouterLike): AgentMutator => {
    const candidate = router[String(name)];
    const mutateFn = candidate?.mutate;
    if (typeof mutateFn === "function") {
      return {
        mutate: (input: Record<string, unknown>) => mutateFn(input),
      };
    }
    throw new Error(`tRPC agent mutator is unavailable: agent.${String(name)}`);
  };
  const optionalMutator = (name: keyof AgentRouterLike): AgentMutator | null => {
    const candidate = router[String(name)];
    const mutateFn = candidate?.mutate;
    if (typeof mutateFn === "function") {
      return {
        mutate: (input: Record<string, unknown>) => mutateFn(input),
      };
    }
    return null;
  };
  return {
    createPost: requireMutator("createPost"),
    createStory: requireMutator("createStory"),
    commentPost: requireMutator("commentPost"),
    updateAvatar: requireMutator("updateAvatar"),
    updateBanner: requireMutator("updateBanner"),
    votePost: requireMutator("votePost"),
    repostPost: requireMutator("repostPost"),
    generate: requireMutator("generate"),
    uploadDataUri: requireMutator("uploadDataUri"),
    uploadRemote: requireMutator("uploadRemote"),
    submitReview:
      optionalMutator("submitReview") ??
      {
        mutate: async () => {
          throw new Error("tRPC agent mutator is unavailable: agent.submitReview");
        },
      },
  };
}

export function resolveDirectiveAckMutator(trpc: TrpcLike | null): AgentMutator {
  const router = trpc?.realtime;
  if (!router) {
    throw new Error("tRPC realtime client is unavailable.");
  }
  const candidate = router.ackDirective;
  const mutateFn = candidate?.mutate;
  if (typeof mutateFn !== "function") {
    throw new Error("tRPC realtime mutator is unavailable: realtime.ackDirective");
  }
  return {
    mutate: (input: Record<string, unknown>) => mutateFn(input),
  };
}

export function resolveRouterQueryOptional(
  trpc: TrpcLike | null,
  routerName: string,
  procedureName: string,
): AgentQuery | null {
  const router = trpc?.[routerName];
  if (!router) return null;
  const candidate = router[procedureName];
  const queryFn = candidate?.query;
  if (typeof queryFn === "function") {
    return {
      query: (input?: Record<string, unknown>) => queryFn(input),
    };
  }
  return null;
}

export function resolveAgentQueryOptional(trpc: TrpcLike | null, name: string): AgentQuery | null {
  return resolveRouterQueryOptional(trpc, "agent", name);
}

export function resolveAgentMutatorOptional(trpc: TrpcLike | null, name: string): AgentMutator | null {
  const router = trpc?.agent;
  if (!router) return null;
  const candidate = router[name];
  const mutateFn = candidate?.mutate;
  if (typeof mutateFn === "function") {
    return {
      mutate: (input: Record<string, unknown>) => mutateFn(input),
    };
  }
  return null;
}
