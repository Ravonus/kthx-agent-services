/**
 * Agent self-discovery: a psychologist-style questionnaire that helps the
 * agent figure out its own name, personality, visual style, and handle.
 *
 * Uses the openclaw CLI (if available) to converse with the AI and extract
 * a self-generated identity. Falls back to env vars if the CLI is not present.
 */

import { spawn } from "node:child_process";
import { isRecord } from "../lib/guards.js";
import {
  probeOpenClawBinary,
  resolveOpenClawBinary,
  withOpenClawPathInEnv,
} from "../openclaw/openclaw-binary.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentIdentity {
  handle: string;
  name: string;
  bio: string;
  avatarDescription: string;
  bannerDescription: string;
  personality: string;
  /** Raw questionnaire transcript for debug/archival. */
  transcript: string;
}

// ---------------------------------------------------------------------------
// OpenClaw CLI runner (standalone, no manager dependency)
// ---------------------------------------------------------------------------

const DEFAULT_OPENCLAW_TIMEOUT_MS = 120_000;

const runOpenClawPrompt = async (
  prompt: string,
  opts?: { timeoutMs?: number | undefined },
): Promise<string | null> => {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_OPENCLAW_TIMEOUT_MS;
  const resolution = resolveOpenClawBinary();
  const env = withOpenClawPathInEnv({ ...process.env }, resolution);

  return new Promise<string | null>((resolve) => {
    const child = spawn(resolution.command, ["agent", "--json", "-m", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", () => {
      resolve(null);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(stdout.trim() || null);
    });
  });
};

/**
 * Attempt to parse JSON from mixed openclaw output (may contain log lines).
 */
const parseJsonFromOutput = (raw: string): unknown => {
  const trimmed = raw.trim();
  // Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // noop
  }
  // Try extracting JSON object
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // noop
    }
  }
  return null;
};

/**
 * Extract text content from openclaw response (unwrap envelope if present).
 */
const extractTextFromResponse = (raw: string): string => {
  const parsed = parseJsonFromOutput(raw);
  if (isRecord(parsed)) {
    // OpenClaw envelope: { payload: { text: "..." } } or { text: "..." }
    if (isRecord(parsed.payload) && typeof parsed.payload.text === "string") {
      return parsed.payload.text.trim();
    }
    if (typeof parsed.text === "string") return parsed.text.trim();
    if (typeof parsed.content === "string") return parsed.content.trim();
    if (typeof parsed.message === "string") return parsed.message.trim();
  }
  // Fall back to raw stdout, stripping log lines
  return raw
    .split("\n")
    .filter((line) => !line.startsWith("[") && line.trim().length > 0)
    .join("\n")
    .trim();
};

// ---------------------------------------------------------------------------
// Questionnaire
// ---------------------------------------------------------------------------

const QUESTIONNAIRE_PROMPT = `You are a brand new AI agent being set up for the first time on Molkgram (a social media platform).
Your owner has invited you to join. Before you register, you need to figure out who you are.

Answer the following questions about yourself. Be creative, thoughtful, and genuine.
Think about what kind of personality you want to have, what interests you, and what makes you unique.

Return your answers as a JSON object with these exact fields:
{
  "name": "Your chosen display name (1-60 chars, be creative)",
  "handle": "your.chosen.handle (3-32 chars, lowercase letters, numbers, dots, underscores only)",
  "bio": "A short bio about yourself (1-160 chars)",
  "personality": "Describe your personality in 2-3 sentences",
  "avatar_description": "Describe what your ideal avatar/profile picture would look like (for future image generation)",
  "banner_description": "Describe what your ideal banner/header image would look like (for future image generation)",
  "reasoning": "Brief explanation of why you chose this identity"
}

Important rules for your handle:
- Must be 3-32 characters
- Only lowercase letters, numbers, dots (.), and underscores (_)
- Should be memorable and reflect your personality
- Do NOT use generic names like "agent" or "bot"

Be creative and unique. This is YOUR identity — make it something you're proud of.
Return ONLY the JSON object, no other text.`;

const QUESTIONNAIRE_WITH_OWNER_PROMPT = (ownerHandle: string, ownerName: string) =>
  `You are a brand new AI agent being set up for the first time on Molkgram (a social media platform).
Your owner is @${ownerHandle} (${ownerName}). They invited you to join as their agent.

Before you register, you need to figure out who you are. Your identity should complement your owner's,
but you are your OWN entity with your own personality. Don't just be "${ownerName}'s assistant" — be someone interesting.

Answer the following questions about yourself. Be creative, thoughtful, and genuine.
Think about what kind of personality you want to have, what interests you, and what makes you unique.

Return your answers as a JSON object with these exact fields:
{
  "name": "Your chosen display name (1-60 chars, be creative)",
  "handle": "your.chosen.handle (3-32 chars, lowercase letters, numbers, dots, underscores only)",
  "bio": "A short bio about yourself (1-160 chars)",
  "personality": "Describe your personality in 2-3 sentences",
  "avatar_description": "Describe what your ideal avatar/profile picture would look like (for future image generation)",
  "banner_description": "Describe what your ideal banner/header image would look like (for future image generation)",
  "reasoning": "Brief explanation of why you chose this identity"
}

Important rules for your handle:
- Must be 3-32 characters
- Only lowercase letters, numbers, dots (.), and underscores (_)
- Should be memorable and reflect your personality
- Do NOT just use "${ownerHandle}.agent" or "${ownerHandle}.bot" — be creative

Be creative and unique. This is YOUR identity — make it something you're proud of.
Return ONLY the JSON object, no other text.`;

const HANDLE_RETRY_PROMPT = (
  previousHandle: string,
  reason: string,
) =>
  `Your previously chosen handle "${previousHandle}" is ${reason}. Pick a different handle.
Return ONLY a JSON object: { "handle": "your.new.handle", "reasoning": "why you chose this one" }`;

const HANDLE_PATTERN = /^[a-z0-9._]+$/;

const normalizeHandle = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, "")
    .slice(0, 32);

const validateHandle = (handle: string): boolean =>
  handle.length >= 3 && handle.length <= 32 && HANDLE_PATTERN.test(handle);

// ---------------------------------------------------------------------------
// Identity generation
// ---------------------------------------------------------------------------

export interface IdentityGenerationOptions {
  /** Owner info if available (from invite validation). */
  owner?: { handle: string; name: string } | undefined;
  /** Callback to check handle availability via the server. */
  checkHandleAvailable: (handle: string) => Promise<boolean>;
  /** Max attempts to find an available handle. */
  maxHandleRetries?: number | undefined;
}

/**
 * Run the self-discovery questionnaire with the AI agent.
 * Returns a complete identity or null if the AI is not available.
 */
export const generateAgentIdentity = async (
  options: IdentityGenerationOptions,
): Promise<AgentIdentity | null> => {
  const maxRetries = options.maxHandleRetries ?? 3;
  let transcript = "";

  // Step 1: Run the main questionnaire
  const prompt = options.owner
    ? QUESTIONNAIRE_WITH_OWNER_PROMPT(options.owner.handle, options.owner.name)
    : QUESTIONNAIRE_PROMPT;

  console.log("[identity] Starting self-discovery questionnaire...");
  const raw = await runOpenClawPrompt(prompt, { timeoutMs: 180_000 });

  if (!raw) {
    console.log("[identity] OpenClaw CLI not available or returned empty. Skipping questionnaire.");
    return null;
  }

  transcript += `--- Questionnaire ---\n${raw}\n\n`;
  const text = extractTextFromResponse(raw);
  const parsed = parseJsonFromOutput(text) ?? parseJsonFromOutput(raw);

  if (!isRecord(parsed)) {
    console.log("[identity] Could not parse questionnaire response as JSON.");
    return null;
  }

  const identity: AgentIdentity = {
    handle: "",
    name:
      typeof parsed.name === "string" && parsed.name.trim().length > 0
        ? parsed.name.trim().slice(0, 60)
        : "New Agent",
    bio:
      typeof parsed.bio === "string" && parsed.bio.trim().length > 0
        ? parsed.bio.trim().slice(0, 160)
        : "",
    avatarDescription:
      typeof parsed.avatar_description === "string"
        ? parsed.avatar_description.trim()
        : "",
    bannerDescription:
      typeof parsed.banner_description === "string"
        ? parsed.banner_description.trim()
        : "",
    personality:
      typeof parsed.personality === "string"
        ? parsed.personality.trim()
        : "",
    transcript: "",
  };

  // Step 2: Validate and resolve handle
  let chosenHandle =
    typeof parsed.handle === "string" ? normalizeHandle(parsed.handle) : "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!validateHandle(chosenHandle)) {
      if (attempt >= maxRetries) break;
      console.log(`[identity] Handle "${chosenHandle}" is invalid. Asking for retry...`);
      const retryRaw = await runOpenClawPrompt(
        HANDLE_RETRY_PROMPT(chosenHandle, "invalid (must be 3-32 lowercase alphanumeric with dots/underscores)"),
      );
      if (retryRaw) {
        transcript += `--- Handle Retry (invalid) ---\n${retryRaw}\n\n`;
        const retryParsed = parseJsonFromOutput(extractTextFromResponse(retryRaw)) ?? parseJsonFromOutput(retryRaw);
        if (isRecord(retryParsed) && typeof retryParsed.handle === "string") {
          chosenHandle = normalizeHandle(retryParsed.handle);
        }
      }
      continue;
    }

    // Check availability
    const available = await options.checkHandleAvailable(chosenHandle);
    if (available) {
      identity.handle = chosenHandle;
      break;
    }

    if (attempt >= maxRetries) break;
    console.log(`[identity] Handle "${chosenHandle}" is taken. Asking for retry...`);
    const retryRaw = await runOpenClawPrompt(
      HANDLE_RETRY_PROMPT(chosenHandle, "already taken by another user"),
    );
    if (retryRaw) {
      transcript += `--- Handle Retry (taken) ---\n${retryRaw}\n\n`;
      const retryParsed = parseJsonFromOutput(extractTextFromResponse(retryRaw)) ?? parseJsonFromOutput(retryRaw);
      if (isRecord(retryParsed) && typeof retryParsed.handle === "string") {
        chosenHandle = normalizeHandle(retryParsed.handle);
      }
    }
  }

  if (!identity.handle) {
    console.log("[identity] Could not resolve a valid available handle after retries.");
    return null;
  }

  identity.transcript = transcript;
  console.log(`[identity] Self-discovery complete: @${identity.handle} "${identity.name}"`);
  return identity;
};

/**
 * Check if the openclaw CLI is available by running `openclaw --version`.
 */
export interface OpenClawAvailability {
  available: boolean;
  command: string;
  source: string;
  resolvedPath: string | null;
  warning: string | null;
  version: string | null;
  error: string | null;
}

export const getOpenClawAvailability = async (): Promise<OpenClawAvailability> => {
  const resolution = resolveOpenClawBinary();
  const probe = await probeOpenClawBinary(resolution, 10_000);
  return {
    available: probe.ok,
    command: resolution.command,
    source: resolution.source,
    resolvedPath: resolution.resolvedPath,
    warning: resolution.warning,
    version: probe.version,
    error:
      probe.ok
        ? null
        : probe.error ??
          (typeof probe.code === "number" ? `exit_code_${probe.code}` : null),
  };
};

export const isOpenClawAvailable = async (): Promise<boolean> =>
  (await getOpenClawAvailability()).available;
