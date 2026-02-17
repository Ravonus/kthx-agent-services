/**
 * Grant and permission types for the agent runtime.
 *
 * Ported from agent-runtime.mjs lines 3134-3318 (buildGrantState,
 * buildCreditsPermissionState, buildGrantStateFromPermissionWindow,
 * parseGrantCandidatesFromPermissionState) and lines 3108-3124
 * (isDirectorGrantPayload, isDirectorDirectivePayload, isDirectorCreditsPayload).
 */

// ---------------------------------------------------------------------------
// Grant action budget
// ---------------------------------------------------------------------------

export type GrantAction = {
  key: string;
  totalCount: number;
  remainingCount: number;
  notBeforeSeconds: number;
  notBeforeAtMs: number | null;
};

// ---------------------------------------------------------------------------
// Grant state (built after receiving a director_grant or permission window)
// ---------------------------------------------------------------------------

export type GrantState = {
  id: string;
  issuedAt: string;
  issuedAtMs: number;
  windowSeconds: number;
  expiresAtMs: number;
  reputation: number | null;
  challenge: Record<string, unknown> | null;
  challengeSolved: boolean;
  actions: Map<string, GrantAction>;
};

// ---------------------------------------------------------------------------
// Director push payloads
// ---------------------------------------------------------------------------

export type DirectorGrantPayload = {
  type: "director_grant";
  grant: {
    id: string;
    issuedAt?: string;
    windowSeconds?: number;
    actions?: Array<{
      kind: string;
      postKind?: string;
      postType?: string;
      count?: number;
      notBeforeSeconds?: number;
    }>;
    reputation?: number;
    challenge?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

export type DirectorDirectivePayload = {
  type: "director_directive";
  directive: {
    id: string;
    kind: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type DirectorCreditsPayload = {
  type: "director_credits_added";
  creditId: string;
  issuedAt?: string;
  expiresAt?: string;
  credited?: {
    like?: number;
    comment?: number;
    repost?: number;
    story?: number;
    post?: number;
  };
  [key: string]: unknown;
};

export type DirectivePayload =
  | DirectorGrantPayload
  | DirectorDirectivePayload
  | DirectorCreditsPayload;

// ---------------------------------------------------------------------------
// Permission window (from server permission state)
// ---------------------------------------------------------------------------

export type PermissionWindowAction = {
  actionKey: string;
  remainingCount: number;
  notBeforeAt?: string;
};

export type PermissionWindow = {
  grantId: string;
  expiresAt?: string;
  actions?: PermissionWindowAction[];
};

export type PermissionState = {
  serverTime?: string;
  activeWindows?: PermissionWindow[];
};

// ---------------------------------------------------------------------------
// Credits permission
// ---------------------------------------------------------------------------

export type CreditsPermission = {
  creditId: string;
  issuedAt?: string;
  expiresAt?: string;
  credited?: Record<string, number>;
};
