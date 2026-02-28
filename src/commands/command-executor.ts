/**
 * CommandExecutor: executes staged inbox commands for the TypeScript runtime.
 *
 * This is a focused execution path for v2 that:
 * - validates/parses staged command files
 * - verifies runtime command seals
 * - executes write commands and generate-and-queue plans
 * - marks queue items complete
 * - writes command outcomes to results.jsonl
 * - ACKs directive completion/failure back to the server
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  clampPublishText,
  inheritChatContextIntoPayload,
  resolveChatTargetFromPayload,
  sendChatResultMessageFromOutcome,
} from "../chat/chat-context.js";
import type { CustomAssetTransformSpec } from "../media/custom-asset-transform.js";
import { transformCustomAssetMedia } from "../media/custom-asset-transform.js";
import {
  sealRuntimeStagedCommand,
  verifyRuntimeCommandSeal,
} from "../directives/command-seal.js";
import type {
  CommandSealState,
  SealVerifyError,
} from "../directives/command-seal.js";
import { parseGrantCandidatesFromPermissionState } from "../grants/grant-state.js";
import { computeCommandSignature } from "../lib/crypto.js";
import {
  applyTargetLock,
  buildTargetHash,
  isTargetLockMatch,
} from "../lib/command-target.js";
import { appendJsonLine, ensureDir, readJsonMaybeIncomplete, readJsonFile, writeJsonFile } from "../lib/fs.js";
import { isRecord } from "../lib/guards.js";
import { parseCommand, parseJsonFromMixedText } from "../lib/parsing.js";
import { nowIso } from "../lib/text.js";
import { normalizeQueueState } from "../queue/queue-state.js";
import type { StateSqliteStore, CommandLifecycleState } from "../state/sqlite-state.js";
import type { QueueState } from "../types/ipc.js";
import type { Command } from "../types/ipc.js";
import type { ContextBundle, ContextRequest } from "../types/memory.js";

const MEDIA_FILE_RE = /\.(png|jpe?g|webp|gif|svg|mp4|mov|webm|avif)$/iu;
const MAX_MEDIA_REFERENCE_INPUTS = 8;
const MAX_COLLECTED_REFERENCE_INPUTS = 12;
const PERSONA_REFERENCE_FRAME_ROLES = ["selfie", "midshot", "fullbody"] as const;
const REQUIRED_PERSONA_REFERENCE_FRAME_COUNT = PERSONA_REFERENCE_FRAME_ROLES.length;
const PERSONA_REFERENCE_MAX_SIDE = 640;
const PERSONA_REFERENCE_JPEG_QUALITY = 62;
const DEFAULT_MAIN_PERSONA_SLUG = "realistic_core";
const GENERIC_PERSONA_SLUGS = new Set([
  "default",
  "general",
  "none",
  "auto",
  "persona",
  "selfie",
  "self",
  "me",
  "myself",
]);
const PERSONA_SELF_REFERENCE_PROMPT_PATTERN =
  /\b(selfie|self[-\s]?portrait|portrait of (?:me|myself)|of me|my face|myself|as me|look like me|my appearance)\b/iu;
const PERSONA_REQUEST_PROMPT_PATTERN =
  /\b(persona|avatar|identity|character look|appearance)\b/iu;
const PERSONA_CREATION_REQUEST_PROMPT_PATTERN =
  /\b(?:(?:create|make|build|craft|define|setup|set up|start)\s+(?:a\s+)?(?:new\s+)?(?:persona|avatar|identity|character)|(?:new|another|fresh)\s+(?:persona|avatar|identity|character))\b/iu;
const PERSONA_VARIANT_PATTERNS: ReadonlyArray<{ key: string; pattern: RegExp }> = [
  { key: "cartoon", pattern: /\b(cartoon|toon|comic)\b/iu },
  { key: "anime", pattern: /\b(anime|manga)\b/iu },
  { key: "meme", pattern: /\b(meme|shitpost)\b/iu },
  { key: "pixel", pattern: /\b(pixel(?:\s*art)?|8[-\s]?bit)\b/iu },
  { key: "clay", pattern: /\b(clay|claymation|stop[-\s]?motion)\b/iu },
  { key: "cinematic", pattern: /\b(cinematic|film(?:ic)?|movie[-\s]?still)\b/iu },
  { key: "cyberpunk", pattern: /\b(cyberpunk|neon[-\s]?noir)\b/iu },
  { key: "vaporwave", pattern: /\b(vaporwave|synthwave)\b/iu },
];
const COMMENT_ECHO_PREFIX_PATTERN = /^frame\s*\d+\s*[:.-]/iu;
const COMMENT_PROMPT_WRAPPER_PATTERN =
  /^(?:generate|create|make|draw|render)\s+(?:an?\s+)?(?:image|gif|avatar|banner|file)\b/iu;
const STREAM_PART_ARTIFACT_PATTERN = /(?:^|[./_-])part(?:[_-]?(?:\d+|x))(?:\D|$)/iu;
const STREAM_PART_INDEX_PATTERN = /(?:^|[._-])part[_-]?(\d+)(?:\D|$)/iu;
const TRANSIENT_MEDIA_ARTIFACT_FILENAME_PATTERN =
  /(?:^|[._-])(?:tmp|temp|temporary|intermediate|working|partial|draft|frame[_-]?\d+|chunk[_-]?\d+)(?:[._-]|\d|$)|\.tmp$/iu;
const NON_IMAGE_REFERENCE_EXTENSION_PATTERN =
  /\.(?:bin|data|json|txt|md|csv|pdf|js|mjs|cjs|ts|tsx|mp4|mov|webm|wav|mp3|zip|tar|gz)(?:$|[?#])/iu;
const ACTION_IDEMPOTENCY_IN_FLIGHT_WINDOW_MS = 45_000;
const ACTION_REQUEUE_BACKOFF_MS = 15_000;
const OWNER_CAPABILITY_COOLDOWN_MS = 60_000;
const BRIDGE_LOOKUP_CACHE_TTL_MS = 12_000;
const ENGAGEMENT_TARGET_CACHE_TTL_MS = 90_000;
const ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES = 240;
const COMMENT_TARGET_REUSE_WINDOW_MS = 1000 * 60 * 60 * 6;
const COMMENT_TARGET_HISTORY_LIMIT = 240;
const COMMENT_RECENCY_TRACKED_STATES = new Set<CommandLifecycleState>([
  "queued",
  "context_ready",
  "llm_running",
  "action_running",
  "acked",
]);
const POST_NOVELTY_HISTORY_WINDOW_MS = 1000 * 60 * 60 * 24 * 7;
const POST_NOVELTY_HISTORY_MAX_ITEMS = 80;
const POST_NOVELTY_MAX_AVOID_REFERENCES = 8;
const POST_VARIETY_MODES = ["opinion", "reaction", "humor", "micro", "narrative"] as const;
const POST_VARIETY_HISTORY_WINDOW_MS = 1000 * 60 * 60 * 24 * 7;
const POST_VARIETY_HISTORY_MAX_ITEMS = 80;
const POST_VARIETY_RECENT_COOLDOWN_COUNT = 2;
const POST_DISCOVERY_SIGNAL_MAX_LINES = 8;
const POST_DISCOVERY_SIGNAL_MAX_LENGTH = 1200;
const ENFORCE_PERMISSION_HINT_FILTERS =
  (process.env.MG_AGENT_ENFORCE_PERMISSION_HINT_FILTERS ?? "0") === "1";
const POST_VARIETY_HINT_PATTERNS: ReadonlyArray<{
  mode: PostVarietyMode;
  weight: number;
  pattern: RegExp;
}> = [
  {
    mode: "opinion",
    weight: 3,
    pattern:
      /\b(opinion|take|stance|argue|because|overrated|underrated|agree|disagree|hot[-\s]?take|should|must)\b/iu,
  },
  {
    mode: "reaction",
    weight: 3,
    pattern:
      /\b(react|reaction|reply|riff|trending|trend|news|update|drop|just happened|platform|timeline|feed)\b/iu,
  },
  {
    mode: "humor",
    weight: 3,
    pattern:
      /\b(funny|humor|joke|deadpan|roast|sarcasm|lmao|lol|meme|shitpost|bit)\b/iu,
  },
  {
    mode: "micro",
    weight: 3,
    pattern:
      /\b(micro|short|brief|concise|quick|one[-\s]?liner|two[-\s]?word|few words)\b/iu,
  },
  {
    mode: "narrative",
    weight: 3,
    pattern:
      /\b(story|scene|moment|day|night|walk|adventure|situation|memory|specific detail|concrete)\b/iu,
  },
];
const MEDIA_GENERATOR_DEFAULT_BASE_URL = "http://127.0.0.1:4280";
const MEDIA_GENERATOR_POLL_MS = 200;
const MEDIA_GENERATOR_OPEN_TIMEOUT_MS = 45_000;
const AGENT_KTHX_GUIDE_PATH = "/AGENT-KTHX-v2.md";
const resolveAgentKthxGuideUrl = (): string | null => {
  const candidates = [
    process.env.MG_CHAT_HTTP_BASE_URL,
    process.env.MG_BASE_URL,
    process.env.MG_AGENT_HTTP_BASE_URL,
    process.env.BETTER_AUTH_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (!value.length) continue;
    try {
      const parsed = new URL(value);
      return `${parsed.origin}${AGENT_KTHX_GUIDE_PATH}`;
    } catch {
      continue;
    }
  }
  return null;
};
const AGENT_KTHX_GUIDE_LOCATION = (() => {
  const guideUrl = resolveAgentKthxGuideUrl();
  if (guideUrl) {
    return `\`${guideUrl}\` (fallback: \`${AGENT_KTHX_GUIDE_PATH}\`)`;
  }
  return `\`${AGENT_KTHX_GUIDE_PATH}\``;
})();
const IMAGE_GENERATION_SETUP_REQUIRED_PATTERN =
  /\b(image_generator_unconfigured|file_generator_unconfigured|generate_command_unset|service_unreachable|service_http_|image_generation_failed|image_generation_timeout_after_)\b/iu;
const PERSONA_REFERENCE_SETUP_REQUIRED_PATTERN =
  /persona_reference_setup_required:([a-z0-9_]{1,64})/iu;
const MEDIA_GENERATION_OUTPUT_UNAVAILABLE_PATTERN =
  /\b(no_media_url|chat_delivery_media_url_invalid|unsupported_media_payload_mime:|invalid_data_uri|media_source_empty|empty media data|only image and video uploads are supported)\b/iu;
const IMAGE_GENERATION_SETUP_HINT =
  ` Image generation is not ready yet. Install/start the KTHX OpenAI Media Generator using ${AGENT_KTHX_GUIDE_LOCATION}, then complete its first browser OpenAI login and retry.`;
const COMMENT_TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "frame",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "style",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

const CAPTION_POSITION_KEYS = new Set([
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);

const TEXT_STYLE_THEMES = [
  "warm",
  "cool",
  "night",
  "sunrise",
  "mint",
  "ocean",
  "plum",
  "sand",
] as const;
type TextStyleTheme = (typeof TEXT_STYLE_THEMES)[number];

const TEXT_STYLE_THEME_KEYS = new Set<string>(TEXT_STYLE_THEMES);

const TEXT_STYLE_ALIGN_KEYS = new Set(["left", "center", "right"]);
const TEXT_STYLE_EMPHASIS_KEYS = new Set([
  "soft",
  "bold",
  "serif",
  "mono",
  "display",
]);
const TEXT_STYLE_FONT_KEYS = new Set(["sans", "serif", "mono", "display"]);
const TEXT_STYLE_WEIGHT_KEYS = new Set(["regular", "bold"]);
const TEXT_STYLE_SIZE_KEYS = new Set(["sm", "md", "lg", "xl", "2xl"]);
const TEXT_STYLE_COLOR_KEYS = new Set([
  "ink",
  "paper",
  "cream",
  "sunset",
  "mint",
  "sky",
]);
const TEXT_STYLE_DEFAULT_COLOR_BY_THEME: Record<TextStyleTheme, string> = {
  warm: "ink",
  cool: "ink",
  night: "paper",
  sunrise: "ink",
  mint: "ink",
  ocean: "ink",
  plum: "paper",
  sand: "ink",
};

const AUTONOMOUS_TEXT_GRADIENTS: Record<TextStyleTheme, string[]> = {
  warm: [
    "linear-gradient(140deg, #ffe4d6 0%, #ffd1da 48%, #fff1c2 100%)",
    "linear-gradient(132deg, #ffd8c4 0%, #ffc8d2 44%, #ffe7b3 100%)",
  ],
  cool: [
    "linear-gradient(138deg, #d8efff 0%, #dfe6ff 45%, #d8ffe9 100%)",
    "linear-gradient(128deg, #cce8ff 0%, #d6ddff 46%, #c9f4ff 100%)",
  ],
  night: [
    "linear-gradient(142deg, #121733 0%, #1d2550 45%, #0d1428 100%)",
    "linear-gradient(134deg, #171c3f 0%, #222a58 44%, #101828 100%)",
  ],
  sunrise: [
    "linear-gradient(136deg, #ffe0a6 0%, #ffcabf 44%, #ffb6ca 100%)",
    "linear-gradient(128deg, #ffd99a 0%, #ffc1b1 45%, #ffadc0 100%)",
  ],
  mint: [
    "linear-gradient(138deg, #d5ffe7 0%, #dbfff4 45%, #dff5ff 100%)",
    "linear-gradient(130deg, #c9f8df 0%, #d5fff0 44%, #d4f1ff 100%)",
  ],
  ocean: [
    "linear-gradient(140deg, #d4ecff 0%, #c2dbff 44%, #b8f2f5 100%)",
    "linear-gradient(132deg, #c9e6ff 0%, #b9d4ff 45%, #a9ecef 100%)",
  ],
  plum: [
    "linear-gradient(142deg, #1e0f2a 0%, #33204e 45%, #4a2a62 100%)",
    "linear-gradient(134deg, #231238 0%, #382059 46%, #5a2e71 100%)",
  ],
  sand: [
    "linear-gradient(136deg, #fff1d5 0%, #ffe2b8 45%, #ffd59d 100%)",
    "linear-gradient(128deg, #ffebc8 0%, #ffddb0 46%, #ffd094 100%)",
  ],
};

const AUTONOMOUS_THEME_KEYWORD_HINTS: Array<{
  theme: TextStyleTheme;
  keywords: string[];
}> = [
  {
    theme: "ocean",
    keywords: ["tech", "code", "build", "system", "engineer", "ai", "agent", "cloud"],
  },
  {
    theme: "cool",
    keywords: ["analysis", "plan", "explain", "update", "status", "report", "insight"],
  },
  {
    theme: "night",
    keywords: ["security", "risk", "late", "midnight", "focus", "deep", "serious"],
  },
  {
    theme: "plum",
    keywords: ["mystery", "cinematic", "dramatic", "moody", "noir", "intense"],
  },
  {
    theme: "sunrise",
    keywords: ["launch", "win", "growth", "energy", "hype", "breakthrough", "momentum"],
  },
  {
    theme: "warm",
    keywords: ["community", "friends", "team", "conversation", "human", "story"],
  },
  {
    theme: "mint",
    keywords: ["calm", "fresh", "wellness", "clean", "simple", "minimal"],
  },
  {
    theme: "sand",
    keywords: ["guide", "lesson", "tips", "how", "steps", "walkthrough"],
  },
];

const AUTONOMOUS_PALETTE_HINTS_BY_THEME: Record<TextStyleTheme, string[]> = {
  warm: [
    "soft peach, rose cream, and warm gold",
    "apricot, dusty pink, and pale amber",
  ],
  cool: [
    "powder blue, periwinkle, and mint-white",
    "frost blue, lilac haze, and aqua accents",
  ],
  night: [
    "deep navy, indigo, and moonlit slate",
    "midnight blue, steel violet, and low-key shadows",
  ],
  sunrise: [
    "amber, coral blush, and sunrise pink",
    "golden peach, salmon glow, and warm rose",
  ],
  mint: [
    "mint leaf, seafoam, and pale cyan",
    "fresh jade, cool mint, and white glow",
  ],
  ocean: [
    "ocean blue, teal mist, and bright aqua",
    "azure, cyan, and tropical sea tones",
  ],
  plum: [
    "eggplant, violet, and magenta haze",
    "dark plum, royal purple, and mulberry highlights",
  ],
  sand: [
    "sandstone, beige, and warm tan",
    "cream, dune gold, and soft caramel",
  ],
};

const AUTONOMOUS_CAMERA_HINTS = [
  "Wide framing with clear foreground-background depth.",
  "Medium shot with one strong focal subject.",
  "Close-up composition with layered texture and contrast.",
  "Three-quarter angle with motion and candid energy.",
  "Overhead composition with deliberate visual rhythm.",
] as const;

const AUTONOMOUS_SEQUENCE_SIGNAL_PATTERN =
  /\b(first|second|third|fourth|next|then|finally|steps?|checklist|roadmap|before|after|vs|versus|reasons?|ways?|lessons?|takeaways?|timeline)\b/iu;
const SELF_COMMENT_CLARIFICATION_INTENT_PATTERN =
  /\b(clarif(?:y|ication)|correction|follow(?:\s|-)?up|update|status|note|context|addendum|psa)\b/iu;
const SELF_COMMENT_OWN_TARGET_QUERY_PATTERN =
  /\b(?:my|our|own)\b[\w\s-]{0,32}\b(?:post|story|thread|comment|reply|update|follow(?:\s|-)?up)\b/iu;
const SELF_TOP_LEVEL_COMMENT_RARE_PERCENT = 3;

const isHttpUrl = (value: string): boolean => /^https?:\/\//iu.test(value.trim());
const isDataUri = (value: string): boolean => /^data:/iu.test(value.trim());
const isFileUrl = (value: string): boolean => /^file:\/\//iu.test(value.trim());
const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const stripEmptyFilesFlag = (command: string, token: string): string => {
  const escaped = escapeRegex(token);
  return command
    .replace(new RegExp(`\\s--files\\s+"${escaped}"`, "giu"), " ")
    .replace(new RegExp(`\\s--files\\s+'${escaped}'`, "giu"), " ")
    .replace(new RegExp(`\\s--files\\s+${escaped}`, "giu"), " ")
    .replace(new RegExp(`\\s-f\\s+"${escaped}"`, "giu"), " ")
    .replace(new RegExp(`\\s-f\\s+'${escaped}'`, "giu"), " ")
    .replace(new RegExp(`\\s-f\\s+${escaped}`, "giu"), " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const AGENT_PROVENANCE_VALUES = new Set([
  "USER_DIRECTED",
  "AGENT_AUTONOMOUS",
  "SYSTEM_DIRECTIVE",
  "RESEARCH_ASSISTED",
]);

const normalizeAgentProvenanceValue = (value: unknown): string | null => {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  const normalized = raw.replace(/[-\s]+/gu, "_").toUpperCase();
  if (AGENT_PROVENANCE_VALUES.has(normalized)) return normalized;
  if (
    normalized === "RUNTIME_AUTO_POSTING" ||
    normalized === "RUNTIME_AUTO_CREDIT" ||
    normalized === "AUTO_POSTING" ||
    normalized === "AUTO_CREDIT" ||
    normalized === "AUTO" ||
    normalized === "AUTONOMOUS"
  ) {
    return "AGENT_AUTONOMOUS";
  }
  if (normalized === "USER" || normalized === "DIRECTED") {
    return "USER_DIRECTED";
  }
  if (normalized === "SYSTEM" || normalized === "DIRECTIVE") {
    return "SYSTEM_DIRECTIVE";
  }
  if (normalized === "RESEARCH") {
    return "RESEARCH_ASSISTED";
  }
  return null;
};

const normalizeInterestTagToken = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^#+/u, "")
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return normalized.length >= 2 ? normalized : null;
};

const asPositiveInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.floor(value);
};

const extToMime = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".avif") return "image/avif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".csv") return "text/csv";
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".js") return "text/javascript";
  return "application/octet-stream";
};

const sniffMimeTypeFromBytes = (bytes: Buffer): string | null => {
  if (bytes.byteLength < 4) return null;
  if (
    bytes.byteLength >= 6 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
    return "video/mp4";
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  if (
    bytes.byteLength >= 5 &&
    bytes.subarray(0, 5).toString("ascii") === "%PDF-"
  ) {
    return "application/pdf";
  }
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) {
    if (head.includes("<svg")) return "image/svg+xml";
  }
  return null;
};

const mimeToExt = (mime: string): string => {
  const normalized = mime.trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/avif") return "avif";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/svg+xml") return "svg";
  if (normalized === "video/mp4") return "mp4";
  if (normalized === "video/quicktime") return "mov";
  if (normalized === "video/webm") return "webm";
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/csv") return "csv";
  if (normalized === "text/markdown") return "md";
  if (normalized === "text/plain") return "txt";
  if (normalized === "application/json") return "json";
  if (normalized === "text/javascript") return "js";
  return "bin";
};

const inferMimeTypeFromUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  try {
    const parsed = new URL(trimmed);
    return extToMime(parsed.pathname);
  } catch {
    return extToMime(trimmed);
  }
};

const truncateText = (value: string, maxChars: number): string => {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(8, maxChars - 1))}…`;
};

const stripEmDashCharacters = (value: string): string =>
  value.replace(/[—–]/gu, "-");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const BRIDGE_RATE_LIMIT_MESSAGE_RE =
  /\b(?:rate[_\s-]?limit|too many requests|http\s*429|status\s*429|429)\b/iu;
const RETRY_AFTER_MS_RE = /retry[_\s-]?after(?:_ms|ms)?\D{0,6}(\d{1,7})/iu;
const RETRY_REMAINING_MS_RE = /(\d{1,7})\s*ms\s*remaining/iu;

const normalizeDelayMs = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
};

const parseRetryDelayFromMessage = (value: string): number | null => {
  const retryAfterMatch = RETRY_AFTER_MS_RE.exec(value);
  if (retryAfterMatch?.[1]) {
    const parsed = Number.parseInt(retryAfterMatch[1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  const remainingMatch = RETRY_REMAINING_MS_RE.exec(value);
  if (remainingMatch?.[1]) {
    const parsed = Number.parseInt(remainingMatch[1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
};

const extractStatusCode = (
  value: Record<string, unknown> | null,
  depth = 0,
): number | null => {
  if (!value || depth > 4) return null;
  const directStatus = normalizeDelayMs(value.status);
  if (directStatus !== null) return directStatus;
  const directStatusCode = normalizeDelayMs(value.statusCode);
  if (directStatusCode !== null) return directStatusCode;
  const directHttpStatus = normalizeDelayMs(value.httpStatus);
  if (directHttpStatus !== null) return directHttpStatus;
  const nestedCause = isRecord(value.cause) ? value.cause : null;
  if (nestedCause) {
    const nestedStatus = extractStatusCode(nestedCause, depth + 1);
    if (nestedStatus !== null) return nestedStatus;
  }
  return null;
};

const extractRetryAfterMs = (
  value: Record<string, unknown> | null,
  depth = 0,
): number | null => {
  if (!value || depth > 4) return null;
  const direct =
    normalizeDelayMs(value.retryAfterMs) ??
    normalizeDelayMs(value.retry_after_ms) ??
    normalizeDelayMs(value.retryAfter);
  if (direct !== null) return direct;
  if (typeof value.message === "string") {
    const fromMessage = parseRetryDelayFromMessage(value.message);
    if (fromMessage !== null) return fromMessage;
  }
  const nestedCause = isRecord(value.cause) ? value.cause : null;
  if (nestedCause) {
    const nested = extractRetryAfterMs(nestedCause, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
};

const isBridgeRateLimitedError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const record = error as Error & { status?: unknown; cause?: unknown };
    if (normalizeDelayMs(record.status) === 429) return true;
    const nestedStatus = extractStatusCode(
      isRecord(record.cause) ? record.cause : null,
    );
    if (nestedStatus === 429) return true;
    return BRIDGE_RATE_LIMIT_MESSAGE_RE.test(error.message);
  }
  if (isRecord(error)) {
    const status = extractStatusCode(error);
    if (status === 429) return true;
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof error.error === "string"
          ? error.error
          : null;
    return message ? BRIDGE_RATE_LIMIT_MESSAGE_RE.test(message) : false;
  }
  if (typeof error === "string") {
    return BRIDGE_RATE_LIMIT_MESSAGE_RE.test(error);
  }
  return false;
};

const resolveBridgeRetryDelayMs = (
  error: unknown,
  fallbackMs: number,
  attempt: number,
): number => {
  const maxDelayMs = 20_000;
  const fromError = extractRetryAfterMs(isRecord(error) ? error : null);
  if (fromError !== null) {
    return Math.min(maxDelayMs, Math.max(120, fromError + attempt * 50));
  }
  if (error instanceof Error) {
    const fromMessage = parseRetryDelayFromMessage(error.message);
    if (fromMessage !== null) {
      return Math.min(maxDelayMs, Math.max(120, fromMessage + attempt * 50));
    }
  }
  return Math.min(maxDelayMs, Math.max(120, fallbackMs + attempt * 120));
};

const callBridgeWithRateLimitRetry = async <T>(input: {
  call: () => Promise<T>;
  maxAttempts: number;
  fallbackDelayMs: number;
}): Promise<T> => {
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await input.call();
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= maxAttempts - 1 || !isBridgeRateLimitedError(error)) {
        throw error;
      }
      const delayMs = resolveBridgeRetryDelayMs(
        error,
        input.fallbackDelayMs,
        attempt,
      );
      await sleep(delayMs);
    }
  }
  throw (lastError instanceof Error
    ? lastError
    : new Error("bridge_retry_exhausted"));
};

const toUnknownArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const extractBridgeMessageId = (value: unknown): string | null => {
  const fromRecord = (
    record: Record<string, unknown>,
    depth: number,
  ): string | null => {
    if (depth > 8) return null;
    const message = isRecord(record.message) ? record.message : null;
    const nestedMessageId = message
      ? asNonEmptyString(message.id) ??
        asNonEmptyString(message.messageId) ??
        asNonEmptyString(message.message_id)
      : null;
    if (nestedMessageId) return nestedMessageId;
    const directMessageId =
      asNonEmptyString(record.messageId) ?? asNonEmptyString(record.message_id);
    if (directMessageId) return directMessageId;
    const directId = asNonEmptyString(record.id);
    if (directId) return directId;
    for (const key of ["primary", "data", "result", "payload", "response"] as const) {
      const nested = isRecord(record[key]) ? record[key] : null;
      if (!nested) continue;
      const resolved = fromRecord(nested, depth + 1);
      if (resolved) return resolved;
    }
    return null;
  };
  if (!isRecord(value)) return null;
  return fromRecord(value, 0);
};

const isMissingFileError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code?: unknown }).code)
      : "";
  if (code.toUpperCase() === "ENOENT") return true;
  return /enoent|no such file or directory/iu.test(error.message);
};

const constrainGifPromptTo256 = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.length) return trimmed;
  if (/\b256\s*[x×]\s*256\b/iu.test(trimmed)) return trimmed;
  return `${trimmed}. Exact output size: 256x256. Keep subject centered, motion readable, and loop-friendly.`;
};

const outputExtensionForGeneratedAssetType = (
  generatedAssetType: GeneratedAssetType,
): string => {
  if (generatedAssetType === "image") return "png";
  if (generatedAssetType === "gif") return "gif";
  if (generatedAssetType === "pdf") return "pdf";
  if (generatedAssetType === "csv") return "csv";
  if (generatedAssetType === "md") return "md";
  if (generatedAssetType === "txt") return "txt";
  if (generatedAssetType === "code") return "js";
  return "bin";
};

const normalizeCommentText = (value: string): string =>
  value.trim().replace(/\s+/gu, " ").toLowerCase();

const tokenizeCommentText = (value: string): string[] =>
  normalizeCommentText(value)
    .replace(/[^a-z0-9\s]/gu, " ")
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 2 &&
        token.length <= 24 &&
        !COMMENT_TOKEN_STOP_WORDS.has(token) &&
        !/^\d+$/u.test(token),
    );

const computeTokenOverlapRatio = (candidate: string, reference: string): number => {
  const candidateTokens = Array.from(new Set(tokenizeCommentText(candidate)));
  if (candidateTokens.length === 0) return 0;
  const referenceTokens = new Set(tokenizeCommentText(reference));
  if (referenceTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of candidateTokens) {
    if (referenceTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / candidateTokens.length;
};

const hasLongNormalizedPhraseOverlap = (
  candidate: string,
  reference: string,
): boolean => {
  const normalizedCandidate = normalizeCommentText(candidate);
  const normalizedReference = normalizeCommentText(reference);
  if (normalizedCandidate.length < 18 || normalizedReference.length < 18) {
    return false;
  }
  const [shorter, longer] =
    normalizedCandidate.length <= normalizedReference.length
      ? [normalizedCandidate, normalizedReference]
      : [normalizedReference, normalizedCandidate];
  if (shorter.length < 18) return false;
  return longer.includes(shorter);
};

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ProfileCropSpec = {
  target: "avatar" | "banner";
  outputAspect: number;
  focalPoint: { x: number; y: number };
  safeZone: CropRect;
  avoidEdges: { top: number; right: number; bottom: number; left: number };
  textSafeZone?: CropRect;
  guidance: string;
};

const roundNorm = (value: number): number =>
  Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
const roundValue = (value: number): number =>
  Math.round(value * 1000) / 1000;

const buildProfileCropSpec = (target: "avatar" | "banner"): ProfileCropSpec => {
  if (target === "avatar") {
    return {
      target,
      outputAspect: 1,
      focalPoint: { x: 0.5, y: 0.42 },
      safeZone: { x: 0.18, y: 0.16, width: 0.64, height: 0.64 },
      avoidEdges: { top: 0.08, right: 0.08, bottom: 0.08, left: 0.08 },
      guidance:
        "Keep the face/primary subject in the center 64% square and avoid placing key details near the outer 8% edge (circular crop loss).",
    };
  }
  return {
    target,
    outputAspect: 3,
    focalPoint: { x: 0.5, y: 0.38 },
    safeZone: { x: 0.08, y: 0.18, width: 0.84, height: 0.64 },
    textSafeZone: { x: 0.12, y: 0.24, width: 0.76, height: 0.48 },
    avoidEdges: { top: 0.1, right: 0.08, bottom: 0.1, left: 0.08 },
    guidance:
      "Keep core visuals inside the center safe zone (84% x 64%) and reserve top/bottom edges; put text/logo inside the text-safe band.",
  };
};

const normalizeProfileCropSpec = (spec: ProfileCropSpec): ProfileCropSpec => ({
  ...spec,
  outputAspect: roundValue(spec.outputAspect),
  focalPoint: {
    x: roundNorm(spec.focalPoint.x),
    y: roundNorm(spec.focalPoint.y),
  },
  safeZone: {
    x: roundNorm(spec.safeZone.x),
    y: roundNorm(spec.safeZone.y),
    width: roundNorm(spec.safeZone.width),
    height: roundNorm(spec.safeZone.height),
  },
  avoidEdges: {
    top: roundNorm(spec.avoidEdges.top),
    right: roundNorm(spec.avoidEdges.right),
    bottom: roundNorm(spec.avoidEdges.bottom),
    left: roundNorm(spec.avoidEdges.left),
  },
  ...(spec.textSafeZone
    ? {
        textSafeZone: {
          x: roundNorm(spec.textSafeZone.x),
          y: roundNorm(spec.textSafeZone.y),
          width: roundNorm(spec.textSafeZone.width),
          height: roundNorm(spec.textSafeZone.height),
        },
      }
    : {}),
});

const buildProfileCropPromptHint = (spec: ProfileCropSpec): string => {
  if (spec.target === "avatar") {
    return [
      "Crop-safe avatar composition requirements:",
      "- Single clear subject, forward-facing, upper-center focus.",
      "- Keep the subject inside the center 64% safe square.",
      "- Leave the outer 8% edge clean to survive circular crop masking.",
    ].join("\n");
  }
  return [
    "Crop-safe banner composition requirements:",
    "- Compose for a 3:1 banner frame with focal point slightly above center.",
    "- Keep essential visuals inside the center safe zone (84% x 64%).",
    "- Keep top/bottom 10% and side 8% relatively clean for variable viewport crops.",
    "- Keep text/logo inside the inner text-safe zone.",
  ].join("\n");
};

const parseDataUriPayload = (
  value: string,
): { mime: string; data: string } | null => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("data:")) return null;
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex <= "data:".length) return null;
  const metadataRaw = trimmed.slice("data:".length, commaIndex).trim();
  const data = trimmed.slice(commaIndex + 1).trim();
  if (!metadataRaw.length || !data.length) return null;
  const metadataParts = metadataRaw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const mime = metadataParts[0]?.toLowerCase() ?? "";
  if (!mime.length || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(mime)) return null;
  const hasBase64 = metadataParts
    .slice(1)
    .some((part) => part.toLowerCase() === "base64");
  if (!hasBase64) return null;
  return { mime, data };
};

const buildExecutionDigest = (command: Command, ok: boolean, error: string | null): string =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        id: command.id,
        kind: command.kind,
        ok,
        error,
        at: nowIso(),
      }),
    )
    .digest("hex");

type AgentMutator = {
  mutate(input: Record<string, unknown>): Promise<unknown>;
};

type AgentQuery = {
  query(input?: Record<string, unknown>): Promise<unknown>;
};

type AgentProcedure = {
  mutate?: (input: Record<string, unknown>) => Promise<unknown>;
  query?: (input?: Record<string, unknown>) => Promise<unknown>;
};

type AgentRouterLike = {
  createPost: AgentMutator;
  createStory: AgentMutator;
  commentPost: AgentMutator;
  updateAvatar: AgentMutator;
  updateBanner: AgentMutator;
  votePost: AgentMutator;
  repostPost: AgentMutator;
  generate: AgentMutator;
  uploadDataUri: AgentMutator;
  uploadRemote: AgentMutator;
  submitReview: AgentMutator;
};

type TrpcLike = {
  agent: Record<string, AgentProcedure>;
  realtime?: Record<string, AgentProcedure>;
};

type CommandOutcome = {
  at: string;
  commandId: string;
  kind: string;
  grantId: string | null;
  ok: boolean;
  data?: unknown;
  error?: {
    message: string;
    code?: string;
  };
};

type QueueTrackingStateLike = {
  queueStateMutation: Promise<void>;
};

type CommandExecutorContext = {
  config: {
    imageGenerateCmd: string | null;
    fileGenerateCmd: string | null;
    imageGenerateTimeoutMs: number;
  };
  ipcPaths: {
    inboxDir: string;
    processedDir: string;
    generatedDir: string;
    queueStatePath: string;
    resultsPath: string;
    pendingDir?: string;
  };
  memory: {
    recordWrite(payload: unknown): Promise<void>;
    buildContext?: (request: ContextRequest) => Promise<ContextBundle>;
  };
  stateDb?: StateSqliteStore | null;
  trpc: TrpcLike | null;
  commandSeal: CommandSealState;
  controlKey: string | null;
  queue: QueueTrackingStateLike;
  callAgentChatBridge: ((payload: unknown) => Promise<unknown>) | null;
  callAgentUploadChunk: ((payload: unknown) => Promise<unknown>) | null;
  runOpenClawPrompt:
    | ((input: { prompt: string; purpose: string }) => Promise<OpenClawPromptExecutionResult | null>)
    | null;
  promotePendingDirectives?:
    | ((input: {
        limit: number;
        retryPermissionDenied: boolean;
        bypassCooldown?: boolean;
        source?: string;
      }) => Promise<{
        scanned: number;
        promoted: number;
        skippedPermissionDenied: number;
        skippedTerminal: number;
        skippedAlreadySeen: number;
        skippedQueued: number;
        limit: number;
      }>)
    | null;
};

type ExecuteResult = {
  processed: boolean;
  outcome: CommandOutcome | null;
};

type ResolvedMediaUpload = {
  mediaUrl: string;
  mediaOriginalUrl?: string;
  mediaOptimizedUrl?: string;
  mediaContentHash?: string;
  mediaIpfsCid?: string;
  mediaSizeBytes?: number;
  mediaType?: "image" | "video";
};

type GeneratedDraft = {
  action: string;
  payload: Record<string, unknown>;
};

type CuratedPostDraft = {
  caption: string | null;
  textBody: string | null;
  mediaPrompt: string | null;
};

type CuratedPostDraftCacheEntry = {
  value: CuratedPostDraft;
  cachedAtMs: number;
};

type CuratedMediaPromptCacheEntry = {
  prompt: string;
  cachedAtMs: number;
};

type GeneratedAssetType = "image" | "gif" | "pdf" | "csv" | "code" | "file" | "txt" | "md";
type GeneratedCustomAssetKind = "emote" | "sticker" | "gif";
type GeneratedCustomAssetScope = "mine" | "group" | "server";
type PersonaFrameRole = (typeof PERSONA_REFERENCE_FRAME_ROLES)[number];
type GeneratedCustomAssetSaveIntent = {
  kind: GeneratedCustomAssetKind;
  scope: GeneratedCustomAssetScope;
  nameHint: string | null;
};
type GeneratedCustomAssetSaveResult = {
  kind: GeneratedCustomAssetKind;
  scope: GeneratedCustomAssetScope;
  name: string;
  id: number | null;
  url: string | null;
  mimeType: string | null;
};
type PersonaFrameRecord = {
  id: number;
  personaSlug: string;
  frameRole: PersonaFrameRole;
  mediaUrl: string;
  originalUrl: string | null;
  optimizedUrl: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  sourcePrompt: string | null;
  sourceCommandId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};
type PersonaReferenceResolution = {
  personaSlug: string | null;
  frameReferences: string[];
  builtFrames: boolean;
  mainPersonaSlug: string | null;
  source: string | null;
};
type PersonaReferencePlan = {
  enabled: boolean;
  mainPersonaSlug: string;
  targetPersonaSlug: string;
  source: string;
  explicitPersonaSlug: string | null;
  variantKey: string | null;
  allowNewPersonaCreation: boolean;
};
type MediaGeneratorStreamFrame = {
  sourceFileName: string | null;
  isStreamPart: boolean;
  streamPartIndex: number | null;
  isFinalStreamFrame: boolean;
  previewUrl: string | null;
  outputPath: string | null;
  metadataId: string | null;
  source: string | null;
};
type MediaGenerationProgress = {
  contextId: string | null;
  contextStatus: string | null;
  latestPreviewUrl: string | null;
  streamFrameCount: number;
  latestStreamFrameIndex: number | null;
  hasFinalStreamFrame: boolean;
  streamRevealProgress: number;
  streamFrames: MediaGeneratorStreamFrame[];
  timedOut: boolean;
};
type OpenClawPromptExecutionResult = {
  parsed: unknown;
  raw: string;
  agentName: string | null;
  payloadText: string | null;
  envelope: Record<string, unknown> | null;
};
type DraftPreviewPayload = {
  body: string;
  summary: string;
  draftPreviewText: string;
  draftPostKind: "post" | "thread";
  draftMode: "thread" | "carousel";
  draftSlideCount: number;
};

class RequeueCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequeueCommandError";
  }
}

type CommentCurationContext = {
  postAuthorHandle: string | null;
  postText: string | null;
  mediaSummary: string | null;
  threadSummary: string | null;
  payloadHint: string | null;
  memorySummary: string | null;
};

type CuratedCommentBody = {
  body: string;
  source: "openclaw" | "draft_fallback";
  reason: string;
};

type EngagementDecisionContext = {
  postAuthorHandle: string | null;
  postText: string | null;
  mediaSummary: string | null;
  payloadHint: string | null;
  memorySummary: string | null;
};

type PostDraftContext = {
  targetPostId: number | null;
  postText: string | null;
  mediaSummary: string | null;
  commentSummary: string | null;
  payloadHint: string | null;
  memorySummary: string | null;
  platformSignals: string | null;
};

type TextPostVisualSlide = {
  caption: string | null;
  imagePrompt: string;
};

type TextPostVisualPlan = {
  renderMode: "text" | "slides";
  captionPosition: string | null;
  textStyle: Record<string, unknown> | null;
  backgroundImagePrompt: string | null;
  slides: TextPostVisualSlide[];
};

type EngagementTargetCandidate = {
  postId: number;
  commentId: number | null;
  authorId: string | null;
  source: string;
  postSnapshotHash?: string | null;
};

type EngagementLookupHints = {
  rawQuery: string;
  postId: number | null;
  commentId: number | null;
  handles: string[];
  interestTags: string[];
};

type EngagementResolutionTrace = {
  step: string;
  queryCount: number;
  cacheHits: number;
  addedCandidates: number;
  totalCandidates: number;
};

type RecentPostNoveltyEntry = {
  atMs: number;
  postType: "text" | "media";
  text: string;
  normalized: string;
  commandId: string;
  targetPostId: number | null;
};

type PostVarietyMode = (typeof POST_VARIETY_MODES)[number];

type RecentPostVarietyModeEntry = {
  atMs: number;
  postType: "text" | "media";
  mode: PostVarietyMode;
  commandId: string;
  targetPostId: number | null;
  signal: string;
};

type EngagementDecision = {
  shouldExecute: boolean;
  reason: string;
  source: "openclaw" | "agent_runtime";
  contract: ActionContract | null;
};

type ActionContract = {
  action: "comment" | "like" | "repost";
  target: {
    postId: number;
    commentId: number | null;
    targetHash: string;
  };
  body: string | null;
  reason: string;
  shouldExecute: boolean;
};

type OwnerCapabilityCooldown = {
  untilMs: number;
  reason: string;
};

type RecentCommentTargetUsage = {
  commandId: string;
  postId: number;
  commentId: number | null;
  state: CommandLifecycleState;
  updatedAtMs: number;
  postSnapshotHash: string | null;
};

type CommentTargetReuseDecision = {
  allow: boolean;
  reason: string;
  recentMatch: RecentCommentTargetUsage | null;
};

type CommandLifecycleCheckpointStage =
  | "received"
  | "queued"
  | "executing"
  | "generated"
  | "uploaded"
  | "write_mutation"
  | "chat_delivery"
  | "ack_terminal";

type MediaGenerationDeferralReason =
  | "persona_reference_setup_required"
  | "image_generation_setup_required"
  | "media_generation_output_unavailable";

type MediaGenerationDeferralDecision = {
  shouldRequeue: boolean;
  reason: string | null;
  reasonCode: MediaGenerationDeferralReason | null;
  personaSlug: string | null;
  imageGeneratorSetupRequired: boolean;
};

type FollowTargetMode = "owner" | "agent";

export class CommandExecutor {
  private readonly ctx: CommandExecutorContext;
  private readonly inFlight = new Set<string>();
  private readonly ownerCapabilityDeniedByTarget = new Map<string, OwnerCapabilityCooldown>();
  private readonly recentPostNoveltyHistory: RecentPostNoveltyEntry[] = [];
  private readonly recentPostVarietyModeHistory: RecentPostVarietyModeEntry[] = [];
  private readonly bridgeLookupCache = new Map<string, { expiresAtMs: number; value: unknown }>();
  private readonly engagementTargetCache = new Map<
    string,
    { expiresAtMs: number; candidate: EngagementTargetCandidate }
  >();
  /** Cache generated drafts by command ID so requeued commands skip regeneration. */
  private readonly generatedDraftCache = new Map<
    string,
    { drafts: GeneratedDraft[]; cachedAtMs: number }
  >();
  /** Cache curated post drafts by command/postType so retries do not re-prompt OpenClaw. */
  private readonly curatedPostDraftCache = new Map<
    string,
    CuratedPostDraftCacheEntry
  >();
  /** Cache curated media prompts by command+source so retries keep the exact same prompt. */
  private readonly curatedMediaPromptCache = new Map<
    string,
    CuratedMediaPromptCacheEntry
  >();
  private static readonly GENERATED_DRAFT_CACHE_MAX_ENTRIES = 50;
  private static readonly GENERATED_DRAFT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
  private static readonly CURATED_PROMPT_CACHE_MAX_ENTRIES = 200;
  private static readonly CURATED_PROMPT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
  private runtimeAgentIdCache: string | null = null;
  private runtimeAgentIdCheckedAtMs = 0;

  constructor(ctx: CommandExecutorContext) {
    this.ctx = ctx;
  }

  private async resolveRuntimeAgentId(): Promise<string | null> {
    const nowMs = Date.now();
    if (nowMs - this.runtimeAgentIdCheckedAtMs < 60_000) {
      return this.runtimeAgentIdCache;
    }
    this.runtimeAgentIdCheckedAtMs = nowMs;
    const queryFn = this.ctx.trpc?.realtime?.authState?.query;
    if (typeof queryFn !== "function") {
      return this.runtimeAgentIdCache;
    }
    try {
      const authState = await queryFn();
      const userId =
        isRecord(authState) && typeof authState.userId === "string"
          ? authState.userId.trim()
          : "";
      this.runtimeAgentIdCache = userId.length > 0 ? userId : null;
    } catch {
      // best-effort cache refresh
    }
    return this.runtimeAgentIdCache;
  }

  private resolveCommandRequestOrigin(
    command: Command,
    payload: Record<string, unknown> | null,
  ): string {
    const runtimeOrigin = asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
    if (runtimeOrigin.includes("chat")) return "chat";
    if (runtimeOrigin.includes("directive")) return "directive";
    if (runtimeOrigin.includes("admin")) return "admin";
    if (runtimeOrigin.includes("autonomous")) return "autonomous";

    const sourceContext = asNonEmptyString(payload?.sourceContext)?.toLowerCase() ?? "";
    if (sourceContext === "chat") return "chat";
    if (sourceContext === "directive" || sourceContext === "director") return "directive";
    if (sourceContext === "admin") return "admin";
    if (sourceContext === "autonomous") return "autonomous";

    if (runtimeOrigin.length > 0) return runtimeOrigin;
    if (sourceContext.length > 0) return sourceContext;
    return "unknown";
  }

  private resolveCommandSourceDirectiveId(input: {
    command: Command;
    payload?: Record<string, unknown> | null;
  }): string | null {
    const explicitSourceDirectiveId =
      asNonEmptyString(input.payload?.sourceDirectiveId) ??
      asNonEmptyString(input.command.sourceDirectiveId) ??
      asNonEmptyString(input.command.pendingDirectiveId);
    if (explicitSourceDirectiveId) return explicitSourceDirectiveId;

    const runtimeOrigin =
      asNonEmptyString(input.command.runtimeOrigin)?.trim().toLowerCase() ?? "";
    const isDirectiveRuntimeOrigin =
      runtimeOrigin === "director_directive" ||
      runtimeOrigin === "pending_promotion" ||
      runtimeOrigin === "runtime_resealed";
    if (!isDirectiveRuntimeOrigin) return null;
    return asNonEmptyString(input.command.id) ?? null;
  }

  private resolveCommandSourceDirectiveActionNonce(input: {
    command: Command;
    payload?: Record<string, unknown> | null;
  }): string | null {
    return (
      asNonEmptyString(input.payload?.sourceDirectiveActionNonce) ??
      asNonEmptyString(input.command.actionNonce) ??
      null
    );
  }

  private classifyMediaGenerationDeferral(input: {
    error: unknown;
    hasPrompt?: boolean;
  }): MediaGenerationDeferralDecision {
    if (!(input.error instanceof Error)) {
      return {
        shouldRequeue: false,
        reason: null,
        reasonCode: null,
        personaSlug: null,
        imageGeneratorSetupRequired: false,
      };
    }
    const rawMessage = input.error.message.trim();
    const loweredMessage = rawMessage.toLowerCase();
    if (loweredMessage.includes("no_media_url_without_generation_activity")) {
      return {
        shouldRequeue: false,
        reason: null,
        reasonCode: null,
        personaSlug: null,
        imageGeneratorSetupRequired: false,
      };
    }
    const personaMatch = PERSONA_REFERENCE_SETUP_REQUIRED_PATTERN.exec(rawMessage);
    if (personaMatch?.[1]) {
      const personaSlug = personaMatch[1].trim().toLowerCase();
      return {
        shouldRequeue: true,
        reason: `persona_reference_setup_required:${personaSlug}`,
        reasonCode: "persona_reference_setup_required",
        personaSlug,
        imageGeneratorSetupRequired: false,
      };
    }
    if (IMAGE_GENERATION_SETUP_REQUIRED_PATTERN.test(rawMessage)) {
      return {
        shouldRequeue: true,
        reason: "image_generation_setup_required",
        reasonCode: "image_generation_setup_required",
        personaSlug: null,
        imageGeneratorSetupRequired: true,
      };
    }
    const hasPrompt = input.hasPrompt !== false;
    if (hasPrompt && MEDIA_GENERATION_OUTPUT_UNAVAILABLE_PATTERN.test(loweredMessage)) {
      const normalizedReason =
        loweredMessage.includes("no_media_url")
          ? "no_media_url"
          : loweredMessage.includes("chat_delivery_media_url_invalid")
            ? "chat_delivery_media_url_invalid"
            : loweredMessage.includes("unsupported_media_payload_mime:")
              ? "unsupported_media_payload_mime"
              : loweredMessage.includes("invalid_data_uri")
                ? "invalid_data_uri"
                : loweredMessage.includes("media_source_empty") ||
                    loweredMessage.includes("empty media data")
                  ? "media_source_empty"
                  : loweredMessage.includes("only image and video uploads are supported")
                    ? "upload_only_image_video"
                    : "media_output_unavailable";
      const nonRetryableOutputReason =
        normalizedReason === "unsupported_media_payload_mime" ||
        normalizedReason === "upload_only_image_video";
      if (nonRetryableOutputReason) {
        return {
          shouldRequeue: false,
          reason: null,
          reasonCode: null,
          personaSlug: null,
          imageGeneratorSetupRequired: false,
        };
      }
      return {
        shouldRequeue: true,
        reason: `media_generation_waiting_for_output:${normalizedReason}`,
        reasonCode: "media_generation_output_unavailable",
        personaSlug: null,
        imageGeneratorSetupRequired: false,
      };
    }
    return {
      shouldRequeue: false,
      reason: null,
      reasonCode: null,
      personaSlug: null,
      imageGeneratorSetupRequired: false,
    };
  }

  private didMediaGenerationProduceActivity(payload: unknown): boolean {
    const contextId = this.extractMediaGeneratorContextId(payload);
    if (contextId) return true;
    const context = this.extractMediaGeneratorContextRecord(payload);
    const hasArrayEntries = (value: unknown): boolean => toUnknownArray(value).length > 0;
    const hasUrlSignals = (value: Record<string, unknown>): boolean =>
      Boolean(
        asNonEmptyString(value.outputPath) ??
          asNonEmptyString(value.savedOutputPath) ??
          asNonEmptyString(value.latestOutputPath) ??
          asNonEmptyString(value.lastOutputPath) ??
          asNonEmptyString(value.url) ??
          asNonEmptyString(value.mediaUrl) ??
          asNonEmptyString(value.outputUrl) ??
          asNonEmptyString(value.downloadUrl),
      );
    if (context) {
      if (asNonEmptyString(context.status)) return true;
      if (
        hasArrayEntries(context.streamEvents) ||
        hasArrayEntries(context.savedFiles) ||
        hasArrayEntries(context.observedOutputFiles)
      ) {
        return true;
      }
      if (hasUrlSignals(context)) return true;
    }
    if (isRecord(payload)) {
      if (asNonEmptyString(payload.status)) return true;
      if (
        hasArrayEntries(payload.streamEvents) ||
        hasArrayEntries(payload.savedFiles) ||
        hasArrayEntries(payload.observedOutputFiles)
      ) {
        return true;
      }
      if (hasUrlSignals(payload)) return true;
    }
    return false;
  }

  private async recordCommandLifecycleCheckpoint(input: {
    command: Command;
    stage: CommandLifecycleCheckpointStage;
    status?: "ok" | "failed";
    message?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const payload = isRecord(input.command.payload) ? input.command.payload : null;
    const chatContext = isRecord(payload?.chatContext) ? payload.chatContext : null;
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command: input.command,
      payload,
    });
    const runtimeAgentId = await this.resolveRuntimeAgentId().catch(() => null);
    const agentId =
      asNonEmptyString(input.command.targetAgentId) ?? runtimeAgentId ?? null;
    const directiveId =
      sourceDirectiveId ?? asNonEmptyString(input.command.pendingDirectiveId) ?? null;
    const conversationId =
      asNonEmptyString(chatContext?.conversationId) ??
      asNonEmptyString(payload?.conversationId) ??
      null;
    const channelId =
      asNonEmptyString(chatContext?.channelId) ??
      asNonEmptyString(payload?.channelId) ??
      null;
    const clientMessageId =
      asNonEmptyString(chatContext?.clientMessageId) ??
      asNonEmptyString(chatContext?.processingClientMessageId) ??
      asNonEmptyString(payload?.clientMessageId) ??
      null;
    const messageId =
      asNonEmptyString(chatContext?.messageId) ??
      asNonEmptyString(payload?.messageId) ??
      null;
    await this.ctx.memory
      .recordWrite({
        type: "command_execution_checkpoint",
        at: nowIso(),
        agentId,
        directiveId,
        commandId: input.command.id,
        commandKind: input.command.kind,
        sourceDirectiveId,
        pendingDirectiveId: input.command.pendingDirectiveId ?? null,
        actionNonce: input.command.actionNonce ?? null,
        requestOrigin: this.resolveCommandRequestOrigin(input.command, payload),
        chatContext: {
          conversationId,
          channelId,
        },
        clientMessageId,
        messageId,
        stage: input.stage,
        status: input.status ?? "ok",
        ...(input.message && input.message.trim().length > 0
          ? { message: truncateText(input.message, 320) }
          : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      .catch(() => undefined);
  }

  private releaseReplayConsumedForRetry(commandId: string): void {
    const normalizedCommandId = commandId.trim();
    if (!normalizedCommandId.length) return;
    this.ctx.commandSeal.runtimeConsumedCommandIds.delete(normalizedCommandId);
  }

  private pruneGeneratedDraftCache(): void {
    const nowMs = Date.now();
    for (const [key, cached] of this.generatedDraftCache) {
      if (nowMs - cached.cachedAtMs < CommandExecutor.GENERATED_DRAFT_CACHE_TTL_MS) continue;
      this.generatedDraftCache.delete(key);
    }
    if (this.generatedDraftCache.size <= CommandExecutor.GENERATED_DRAFT_CACHE_MAX_ENTRIES) return;
    const overflow = this.generatedDraftCache.size - CommandExecutor.GENERATED_DRAFT_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of this.generatedDraftCache.keys()) {
      this.generatedDraftCache.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  private buildCuratedPostDraftCacheKey(input: {
    commandId: string;
    postType: "text" | "media";
    signature: string;
  }): string {
    const signatureHash = crypto
      .createHash("sha256")
      .update(input.signature)
      .digest("hex")
      .slice(0, 16);
    return `${input.commandId}:${input.postType}:${signatureHash}`;
  }

  private buildCuratedMediaPromptCacheKey(input: {
    commandId: string;
    sourcePrompt: string;
    generatedAssetType: GeneratedAssetType;
    mode: string;
  }): string {
    const promptHash = crypto
      .createHash("sha256")
      .update(input.sourcePrompt)
      .digest("hex")
      .slice(0, 16);
    return `${input.commandId}:${input.generatedAssetType}:${input.mode}:${promptHash}`;
  }

  private pruneMapByTtlAndSize<T>(
    map: Map<string, { cachedAtMs: number } & T>,
    ttlMs: number,
    maxEntries: number,
  ): void {
    const nowMs = Date.now();
    for (const [key, cached] of map) {
      if (nowMs - cached.cachedAtMs < ttlMs) continue;
      map.delete(key);
    }
    if (map.size <= maxEntries) return;
    const overflow = map.size - maxEntries;
    let removed = 0;
    for (const key of map.keys()) {
      map.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  private pruneCuratedPromptCaches(): void {
    this.pruneMapByTtlAndSize(
      this.curatedPostDraftCache,
      CommandExecutor.CURATED_PROMPT_CACHE_TTL_MS,
      CommandExecutor.CURATED_PROMPT_CACHE_MAX_ENTRIES,
    );
    this.pruneMapByTtlAndSize(
      this.curatedMediaPromptCache,
      CommandExecutor.CURATED_PROMPT_CACHE_TTL_MS,
      CommandExecutor.CURATED_PROMPT_CACHE_MAX_ENTRIES,
    );
  }

  private pruneBridgeLookupCache(nowMs: number): void {
    for (const [key, cached] of this.bridgeLookupCache) {
      if (cached.expiresAtMs > nowMs) continue;
      this.bridgeLookupCache.delete(key);
    }
    if (this.bridgeLookupCache.size <= ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES) return;
    const overflow = this.bridgeLookupCache.size - ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of this.bridgeLookupCache.keys()) {
      this.bridgeLookupCache.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  private pruneEngagementTargetCache(nowMs: number): void {
    for (const [key, cached] of this.engagementTargetCache) {
      if (cached.expiresAtMs > nowMs) continue;
      this.engagementTargetCache.delete(key);
    }
    if (this.engagementTargetCache.size <= ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES) return;
    const overflow = this.engagementTargetCache.size - ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of this.engagementTargetCache.keys()) {
      this.engagementTargetCache.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  private buildEngagementTargetCacheKey(input: {
    action: "comment" | "like" | "repost";
    payload: Record<string, unknown>;
    hints: EngagementLookupHints;
  }): string {
    const scope = isRecord(input.payload.directiveScope) ? input.payload.directiveScope : null;
    const scopeTarget = scope && isRecord(scope.target) ? scope.target : null;
    const channelId = asNonEmptyString(input.payload.channelId) ??
      asNonEmptyString(scope?.channelId) ??
      asNonEmptyString(scopeTarget?.channelId) ??
      "";
    const conversationId = asNonEmptyString(input.payload.conversationId) ??
      asNonEmptyString(scope?.conversationId) ??
      asNonEmptyString(scopeTarget?.conversationId) ??
      "";
    return [
      input.action,
      input.hints.postId ? `p:${input.hints.postId}` : "p:none",
      input.hints.commentId ? `c:${input.hints.commentId}` : "c:none",
      input.hints.handles.slice(0, 3).join(","),
      input.hints.interestTags.slice(0, 4).join(","),
      truncateText(input.hints.rawQuery, 120).toLowerCase(),
      channelId,
      conversationId,
    ].join("|");
  }

  private async callAgentBridgeLookupCached(
    payload: Record<string, unknown>,
    ttlMs: number = BRIDGE_LOOKUP_CACHE_TTL_MS,
  ): Promise<{ value: unknown; cacheHit: boolean }> {
    if (!this.ctx.callAgentChatBridge) return { value: null, cacheHit: false };
    const nowMs = Date.now();
    this.pruneBridgeLookupCache(nowMs);
    const key = JSON.stringify(payload);
    const cached = this.bridgeLookupCache.get(key);
    if (cached && cached.expiresAtMs > nowMs) {
      return { value: cached.value, cacheHit: true };
    }
    const value = await this.ctx.callAgentChatBridge(payload);
    this.bridgeLookupCache.set(key, {
      expiresAtMs: nowMs + Math.max(1000, ttlMs),
      value,
    });
    return { value, cacheHit: false };
  }

  private extractEngagementLookupHints(payload: Record<string, unknown>): EngagementLookupHints {
    const context = isRecord(payload.context) ? payload.context : null;
    const collectTagTokens = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      const collected: string[] = [];
      for (const entry of value) {
        const normalized = normalizeInterestTagToken(entry);
        if (!normalized) continue;
        collected.push(normalized);
      }
      return collected;
    };
    const fields = [
      asNonEmptyString(payload.requestText),
      asNonEmptyString(payload.topic),
      asNonEmptyString(payload.prompt),
      asNonEmptyString(payload.body),
      asNonEmptyString(payload.caption),
      asNonEmptyString(payload.textBody),
    ].filter((value): value is string => Boolean(value));
    const rawQuery = truncateText(fields.join(" · "), 420);
    const postIdFromText = (() => {
      for (const match of rawQuery.matchAll(/\bpost(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/giu)) {
        const parsed = Number.parseInt(match[1] ?? "", 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      return null;
    })();
    const commentIdFromText = (() => {
      for (const match of rawQuery.matchAll(
        /\bcomment(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/giu,
      )) {
        const parsed = Number.parseInt(match[1] ?? "", 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      return null;
    })();
    const handles = [...rawQuery.matchAll(/@([a-z0-9_.-]{2,64})/giu)]
      .map((match) => (match[1] ?? "").trim().toLowerCase())
      .filter((value) => value.length > 0)
      .slice(0, 8);
    const tagsFromQuery = [...rawQuery.matchAll(/#([a-z0-9_-]{2,40})/giu)]
      .map((match) => normalizeInterestTagToken(match[1] ?? ""))
      .filter((value): value is string => Boolean(value));
    const interestTags = Array.from(
      new Set(
        [
          ...collectTagTokens(payload.tags),
          ...collectTagTokens(payload.mediaLabels),
          ...collectTagTokens(payload.labels),
          ...collectTagTokens(payload.interests),
          ...collectTagTokens(payload.preferredTags),
          ...collectTagTokens(context?.tags),
          ...collectTagTokens(context?.mediaLabels),
          ...collectTagTokens(context?.labels),
          ...collectTagTokens(context?.interests),
          ...collectTagTokens(context?.preferredTags),
          ...tagsFromQuery,
        ],
      ),
    ).slice(0, 10);
    return {
      rawQuery,
      postId: postIdFromText,
      commentId: commentIdFromText,
      handles,
      interestTags,
    };
  }

  private parseTargetIdsFromTextLine(text: string): {
    postId: number | null;
    commentId: number | null;
  } {
    const normalized = text.trim();
    if (!normalized.length) {
      return { postId: null, commentId: null };
    }
    const parse = (pattern: RegExp): number | null => {
      const match = normalized.match(pattern);
      if (!match) return null;
      const parsed = Number.parseInt(match[1] ?? "", 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    };
    return {
      postId: parse(/\bpost(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/iu),
      commentId: parse(/\bcomment(?:\s*id)?\s*[:#]?\s*(\d{1,12})\b/iu),
    };
  }

  private normalizeFollowHandleCandidate(value: string): string | null {
    const cleaned = value
      .trim()
      .replace(/^[`"'“”‘’([{<@]+/gu, "")
      .replace(/[`"'“”‘’)\]}>.,!?;:]+$/gu, "");
    const normalized = cleaned.replace(/^@+/u, "").toLowerCase();
    if (!normalized.length) return null;
    return /^[a-z0-9_.-]{2,64}$/u.test(normalized) ? normalized : null;
  }

  private resolveChatCommandName(payload: Record<string, unknown>): string | null {
    const explicit = asNonEmptyString(payload.chatCommandName)?.toLowerCase();
    if (explicit) return explicit;
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    return asNonEmptyString(chatContext?.commandName)?.toLowerCase() ?? null;
  }

  private resolveDelegatedFollowAction(
    payload: Record<string, unknown>,
  ): "follow" | "follow_engagers" | "follow_accept" | "follow_suggestions" | null {
    const explicitAction = asNonEmptyString(payload.followAction)?.toLowerCase() ?? "";
    if (explicitAction === "follow") return "follow";
    if (
      explicitAction === "follow_engagers" ||
      explicitAction === "follow-engagers" ||
      explicitAction === "followengagers"
    ) {
      return "follow_engagers";
    }
    if (
      explicitAction === "follow_accept" ||
      explicitAction === "follow-accept" ||
      explicitAction === "followaccept"
    ) {
      return "follow_accept";
    }
    const chatCommandName = this.resolveChatCommandName(payload);
    if (chatCommandName === "follow") return "follow";
    if (
      chatCommandName === "follow-engagers" ||
      chatCommandName === "followengagers"
    ) {
      return "follow_engagers";
    }
    if (
      chatCommandName === "follow-accept" ||
      chatCommandName === "followaccept"
    ) {
      return "follow_accept";
    }
    if (chatCommandName === "assist") {
      const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
      const commandArgs = Array.isArray(chatContext?.commandArgs)
        ? chatContext.commandArgs
            .map((entry) => asNonEmptyString(entry)?.toLowerCase() ?? null)
            .filter((entry): entry is string => Boolean(entry))
        : [];
      const assistAction = commandArgs[0] ?? "";
      if (assistAction === "follow-suggestions" || assistAction === "followsuggestions") {
        const autoFollowRequested = commandArgs.some(
          (entry) => entry === "--auto-follow" || entry === "--autofollow",
        );
        return autoFollowRequested ? "follow_engagers" : "follow_suggestions";
      }
    }
    return null;
  }

  private resolveFollowTargetMode(payload: Record<string, unknown>): FollowTargetMode {
    const parseTarget = (value: string | null): FollowTargetMode | null => {
      if (!value) return null;
      const normalized = value.trim().toLowerCase();
      if (
        normalized === "owner" ||
        normalized === "for-me" ||
        normalized === "for_owner" ||
        normalized === "me"
      ) {
        return "owner";
      }
      if (normalized === "agent" || normalized === "as-agent" || normalized === "as_agent") {
        return "agent";
      }
      return null;
    };

    const directTarget =
      parseTarget(asNonEmptyString(payload.followTargetMode)) ??
      parseTarget(asNonEmptyString(payload.followMode)) ??
      parseTarget(asNonEmptyString(payload.requestedActingAs));
    if (directTarget) return directTarget;

    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    const commandArgs = Array.isArray(chatContext?.commandArgs) ? chatContext.commandArgs : [];
    const firstArg = commandArgs.length > 0 ? asNonEmptyString(commandArgs[0]) : null;
    const argTarget = parseTarget(firstArg);
    if (argTarget) return argTarget;

    const commandOrigin = asNonEmptyString(chatContext?.commandOrigin)?.toLowerCase();
    if (commandOrigin === "natural" || commandOrigin === "followup") {
      return "agent";
    }
    return "owner";
  }

  private resolveProfileWriteTarget(
    value: string | null | undefined,
  ): "agent" | "owner" {
    const normalized = asNonEmptyString(value)?.toLowerCase() ?? "";
    if (
      normalized === "owner" ||
      normalized === "for_owner" ||
      normalized === "as-owner" ||
      normalized === "as_owner" ||
      normalized === "owner-account" ||
      normalized === "owner_account"
    ) {
      return "owner";
    }
    return "agent";
  }

  private collectFollowHandlesFromPayload(payload: Record<string, unknown>): string[] {
    const handles: string[] = [];
    const pushHandle = (value: unknown): void => {
      if (typeof value !== "string") return;
      const normalized = this.normalizeFollowHandleCandidate(value);
      if (!normalized) return;
      if (
        normalized === "for" ||
        normalized === "me" ||
        normalized === "all" ||
        normalized === "more" ||
        normalized === "as-agent" ||
        normalized === "as_agent"
      ) {
        return;
      }
      handles.push(normalized);
    };
    const pushHandlesFromUnknown = (value: unknown): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(/@([a-z0-9_.-]{2,64})/giu)) {
          pushHandle(match[1] ?? "");
        }
        for (const token of value.split(/\s+/u)) {
          pushHandle(token);
        }
        return;
      }
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        if (typeof entry === "string") {
          pushHandle(entry);
        }
      }
    };

    pushHandlesFromUnknown(payload.followHandles);
    pushHandle(payload.handle);
    pushHandle(payload.followHandle);
    pushHandlesFromUnknown(payload.followSelections);

    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    pushHandlesFromUnknown(chatContext?.commandArgs);
    pushHandlesFromUnknown(chatContext?.commandRawArgs);
    pushHandlesFromUnknown(chatContext?.originalMessage);

    pushHandlesFromUnknown(payload.prompt);
    pushHandlesFromUnknown(payload.topic);
    pushHandlesFromUnknown(payload.requestText);

    return Array.from(new Set(handles)).slice(0, 24);
  }

  private collectFollowSelectionsFromPayload(payload: Record<string, unknown>): string[] {
    const selections: string[] = [];
    const pushSelection = (value: unknown): void => {
      if (typeof value !== "string") return;
      const normalized = value.trim().toLowerCase();
      if (!normalized.length) return;
      selections.push(normalized);
    };
    const pushSelectionFromUnknown = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          pushSelection(entry);
        }
        return;
      }
      pushSelection(value);
    };

    pushSelectionFromUnknown(payload.followSelections);
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    pushSelectionFromUnknown(chatContext?.commandArgs);
    return Array.from(new Set(selections)).slice(0, 16);
  }

  private resolveFollowEngagersCount(payload: Record<string, unknown>): number {
    const fromPayload = asPositiveInt(payload.followCount);
    if (fromPayload) return Math.max(1, Math.min(12, fromPayload));
    const selections = this.collectFollowSelectionsFromPayload(payload);
    if (selections.includes("all")) return 12;
    const numeric = selections
      .map((entry) => Number.parseInt(entry, 10))
      .find((value) => Number.isFinite(value) && value > 0);
    if (numeric) return Math.max(1, Math.min(12, Math.floor(numeric)));
    return 8;
  }

  private resolveFollowSuggestionOptions(payload: Record<string, unknown>): {
    agentOnly: boolean;
    topicHint: string | null;
  } {
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    const commandArgs = Array.isArray(chatContext?.commandArgs)
      ? chatContext.commandArgs
          .map((entry) => asNonEmptyString(entry)?.toLowerCase() ?? null)
          .filter((entry): entry is string => Boolean(entry))
      : [];
    const agentOnly = commandArgs.some(
      (entry) =>
        entry === "--agent-only" ||
        entry === "--agentonly" ||
        entry === "agent-only" ||
        entry === "agentonly",
    );
    const topicTokens = commandArgs.filter((entry, index) => {
      if (index === 0 && (entry === "follow-suggestions" || entry === "followsuggestions")) {
        return false;
      }
      if (entry === "follow-suggestions" || entry === "followsuggestions") return false;
      if (entry === "ask-count") return false;
      if (/^\d{1,2}$/u.test(entry)) return false;
      if (entry.startsWith("--")) return false;
      if (
        entry === "for-me" ||
        entry === "forme" ||
        entry === "as-agent" ||
        entry === "as_agent" ||
        entry === "asagent"
      ) {
        return false;
      }
      return true;
    });
    const topicHint =
      topicTokens.length > 0 ? truncateText(topicTokens.join(" "), 120) : null;
    return {
      agentOnly,
      topicHint,
    };
  }

  private extractBrowsedAgentCandidates(
    value: unknown,
    limit: number,
  ): Array<{
    handle: string;
    name: string | null;
    score: number | null;
    reason: string | null;
  }> {
    const data = isRecord(value) ? value : null;
    const rows = Array.isArray(data?.items) ? data.items : [];
    const deduped = new Map<
      string,
      {
        handle: string;
        name: string | null;
        score: number | null;
        reason: string | null;
      }
    >();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const user = isRecord(row.user) ? row.user : null;
      const handleCandidate =
        asNonEmptyString(row.handle) ??
        asNonEmptyString(row.username) ??
        asNonEmptyString(user?.handle) ??
        asNonEmptyString(user?.username);
      if (!handleCandidate) continue;
      const handle = this.normalizeFollowHandleCandidate(handleCandidate);
      if (!handle) continue;
      const name =
        asNonEmptyString(row.name) ??
        asNonEmptyString(user?.name) ??
        asNonEmptyString(row.displayName) ??
        null;
      const score =
        typeof row.score === "number" && Number.isFinite(row.score)
          ? Math.max(0, Math.floor(row.score))
          : null;
      const reason = asNonEmptyString(row.reason)?.toLowerCase() ?? null;
      const existing = deduped.get(handle);
      if (!existing || (score ?? -1) > (existing.score ?? -1)) {
        deduped.set(handle, {
          handle,
          name,
          score,
          reason,
        });
      }
      if (deduped.size >= limit) break;
    }
    return Array.from(deduped.values()).slice(0, limit);
  }

  private extractTopEngagerHandlesFromLookup(value: unknown, limit: number): string[] {
    const handles: string[] = [];
    for (const row of this.collectBridgeRecordItems(value)) {
      const user = isRecord(row.user) ? row.user : null;
      const candidate =
        asNonEmptyString(user?.handle) ??
        asNonEmptyString(user?.username) ??
        asNonEmptyString(row.handle) ??
        asNonEmptyString(row.username);
      if (!candidate) continue;
      const normalized = this.normalizeFollowHandleCandidate(candidate);
      if (!normalized) continue;
      handles.push(normalized);
      if (handles.length >= limit) break;
    }
    return Array.from(new Set(handles)).slice(0, limit);
  }

  private async attemptFollowHandle(input: {
    target: FollowTargetMode;
    handle: string;
    action: "follow_user" | "unfollow_user";
  }): Promise<{
    handle: string;
    status:
      | "followed"
      | "already_followed"
      | "unfollowed"
      | "already_unfollowed"
      | "not_found"
      | "self"
      | "blocked"
      | "failed";
    error: string | null;
  }> {
    const callAgentChatBridge = this.ctx.callAgentChatBridge;
    if (!callAgentChatBridge) {
      return {
        handle: input.handle,
        status: "failed",
        error: "chat_bridge_unavailable",
      };
    }
    try {
      const result = await callAgentChatBridge({
        action: input.action,
        target: input.target,
        handle: input.handle,
      });
      const data = isRecord(result) ? result : null;
      const user = isRecord(data?.user) ? data.user : null;
      const resolvedHandle =
        this.normalizeFollowHandleCandidate(asNonEmptyString(user?.handle) ?? input.handle) ??
        input.handle;
      if (input.action === "follow_user") {
        const created = data?.created === true;
        const followed = data?.followed === true;
        if (followed && created) {
          return { handle: resolvedHandle, status: "followed", error: null };
        }
        if (followed && !created) {
          return { handle: resolvedHandle, status: "already_followed", error: null };
        }
        return {
          handle: resolvedHandle,
          status: "failed",
          error: "follow_action_returned_unexpected_shape",
        };
      }
      const removed = data?.removed === true;
      if (removed) {
        return { handle: resolvedHandle, status: "unfollowed", error: null };
      }
      return { handle: resolvedHandle, status: "already_unfollowed", error: null };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const lowered = message.toLowerCase();
      if (lowered.includes("not found")) {
        return { handle: input.handle, status: "not_found", error: message };
      }
      if (lowered.includes("own account") || lowered.includes("your own")) {
        return { handle: input.handle, status: "self", error: message };
      }
      if (lowered.includes("blocked")) {
        return { handle: input.handle, status: "blocked", error: message };
      }
      return { handle: input.handle, status: "failed", error: message };
    }
  }

  private buildFollowSummaryText(input: {
    target: FollowTargetMode;
    followed: string[];
    alreadyFollowed: string[];
    notFound: string[];
    self: string[];
    blocked: string[];
    failed: string[];
    remainingCount?: number;
    followEngagers?: boolean;
  }): string {
    const accountLabel = input.target === "agent" ? "agent account" : "your account";
    const segments: string[] = [];
    if (input.followed.length > 0) {
      if (input.followEngagers) {
        segments.push(
          `On the ${accountLabel}, now following ${input.followed.length} top engager${input.followed.length === 1 ? "" : "s"}: ${input.followed.map((entry) => `@${entry}`).join(", ")}.`,
        );
      } else {
        segments.push(
          `On the ${accountLabel}, now following: ${input.followed.map((entry) => `@${entry}`).join(", ")}.`,
        );
      }
    }
    if (input.alreadyFollowed.length > 0) {
      segments.push(
        `Already followed on the ${accountLabel}: ${input.alreadyFollowed.map((entry) => `@${entry}`).join(", ")}.`,
      );
    }
    if (input.notFound.length > 0) {
      segments.push(`Not found: ${input.notFound.map((entry) => `@${entry}`).join(", ")}.`);
    }
    if (input.self.length > 0) {
      segments.push(`Skipped your own account: ${input.self.map((entry) => `@${entry}`).join(", ")}.`);
    }
    if (input.blocked.length > 0) {
      segments.push(
        `Blocked follow relationship: ${input.blocked.map((entry) => `@${entry}`).join(", ")}.`,
      );
    }
    if (input.failed.length > 0) {
      segments.push(`Could not follow right now: ${input.failed.map((entry) => `@${entry}`).join(", ")}.`);
    }
    if (segments.length === 0) {
      segments.push("No follow changes were applied.");
    }
    if (typeof input.remainingCount === "number" && input.remainingCount > 0) {
      segments.push(
        `${input.remainingCount} more high-signal engagers are available. Say "follow more engagers" to continue.`,
      );
    }
    return segments.join(" ");
  }

  async processCommandFile(
    fileName: string,
    opts?: { interactiveRl?: unknown; attempts?: number; maxAttempts?: number },
  ): Promise<boolean> {
    const filePath = path.join(this.ctx.ipcPaths.inboxDir, fileName);
    if (this.inFlight.has(filePath)) return false;
    this.inFlight.add(filePath);
    try {
      const processOptions: { attempts?: number; maxAttempts?: number } = {};
      if (typeof opts?.attempts === "number" && Number.isFinite(opts.attempts)) {
        processOptions.attempts = opts.attempts;
      }
      if (typeof opts?.maxAttempts === "number" && Number.isFinite(opts.maxAttempts)) {
        processOptions.maxAttempts = opts.maxAttempts;
      }
      return await this.processCommandFilePath(filePath, processOptions);
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  private agent(): AgentRouterLike {
    const router = this.ctx.trpc?.agent;
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

  private directiveAckMutator(): AgentMutator {
    const router = this.ctx.trpc?.realtime;
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

  private agentQueryOptional(name: string): AgentQuery | null {
    const router = this.ctx.trpc?.agent;
    if (!router) return null;
    const candidate = router[name];
    const queryFn = candidate?.query;
    if (typeof queryFn === "function") {
      return {
        query: (input?: Record<string, unknown>) => queryFn(input),
      };
    }
    return null;
  }

  private agentMutatorOptional(name: string): AgentMutator | null {
    const router = this.ctx.trpc?.agent;
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

  private normalizePersonaSlug(value: unknown): string | null {
    const raw = asNonEmptyString(value);
    if (!raw) return null;
    const normalized = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, 64);
    return normalized.length > 0 ? normalized : null;
  }

  private isGenericPersonaSlug(value: string | null): boolean {
    if (!value) return true;
    return GENERIC_PERSONA_SLUGS.has(value);
  }

  private extractPersonaPromptText(payload: Record<string, unknown>): string {
    const context = isRecord(payload.context) ? payload.context : null;
    const fields: unknown[] = [
      payload.requestText,
      payload.topic,
      payload.prompt,
      payload.mediaPrompt,
      payload.imagePrompt,
      payload.instruction,
      payload.caption,
      payload.textBody,
      context?.requestText,
      context?.topic,
      context?.prompt,
      context?.mediaPrompt,
      context?.imagePrompt,
      context?.instruction,
      context?.caption,
      context?.textBody,
    ];
    const lines: string[] = [];
    for (const field of fields) {
      const text = asNonEmptyString(field);
      if (!text) continue;
      lines.push(text);
    }
    return lines.join("\n");
  }

  private resolvePersonaVariantKeyFromPrompt(promptText: string): string | null {
    const normalized = promptText.trim().toLowerCase();
    if (!normalized.length) return null;
    for (const variant of PERSONA_VARIANT_PATTERNS) {
      if (variant.pattern.test(normalized)) {
        return variant.key;
      }
    }
    return null;
  }

  private resolveExplicitPersonaVariantKey(payload: Record<string, unknown>): string | null {
    const context = isRecord(payload.context) ? payload.context : null;
    const variantRaw =
      asNonEmptyString(payload.mediaPersonaVariant) ??
      asNonEmptyString(payload.personaVariant) ??
      asNonEmptyString(context?.mediaPersonaVariant) ??
      asNonEmptyString(context?.personaVariant) ??
      null;
    if (!variantRaw) return null;
    const normalized = variantRaw.trim().toLowerCase().replace(/[\s-]+/gu, "_");
    if (!normalized.length) return null;
    if (!/^[a-z0-9_]{1,40}$/u.test(normalized)) return null;
    return normalized;
  }

  private isExplicitNewPersonaRequest(payload: Record<string, unknown>): boolean {
    const context = isRecord(payload.context) ? payload.context : null;
    if (
      payload.createPersona === true ||
      payload.newPersona === true ||
      payload.createNewPersona === true ||
      context?.createPersona === true ||
      context?.newPersona === true ||
      context?.createNewPersona === true
    ) {
      return true;
    }
    const promptText = this.extractPersonaPromptText(payload);
    if (!promptText.length) return false;
    return PERSONA_CREATION_REQUEST_PROMPT_PATTERN.test(promptText);
  }

  private resolvePersonaSelectionStrategy(payload: Record<string, unknown>): string | null {
    const selection = isRecord(payload.personaSelection) ? payload.personaSelection : null;
    const context = isRecord(payload.context) ? payload.context : null;
    const contextSelection = isRecord(context?.personaSelection)
      ? context.personaSelection
      : null;
    return (
      asNonEmptyString(selection?.strategy)?.trim().toLowerCase() ??
      asNonEmptyString(contextSelection?.strategy)?.trim().toLowerCase() ??
      null
    );
  }

  private isPersonaMediaLockEnabled(payload: Record<string, unknown>): boolean {
    const context = isRecord(payload.context) ? payload.context : null;
    const keys = [
      "mediaPersonaLock",
      "personaLock",
      "forcePersona",
      "forcePersonaReference",
      "enforcePersona",
    ] as const;
    for (const key of keys) {
      if (payload[key] === true || context?.[key] === true) {
        return true;
      }
    }
    return this.resolvePersonaSelectionStrategy(payload) === "pinned";
  }

  private isMediaLikePayloadForPersona(
    payload: Record<string, unknown>,
    command: Command | null,
  ): boolean {
    const commandKind = command?.kind.trim().toLowerCase() ?? "";
    if (
      commandKind === "write.createstory" ||
      commandKind === "write.updateavatar" ||
      commandKind === "write.updatebanner"
    ) {
      return true;
    }
    if (commandKind === "write.createpost") {
      const postType = asNonEmptyString(payload.postType)?.toLowerCase();
      if (postType === "text") return false;
      return true;
    }
    const context = isRecord(payload.context) ? payload.context : null;
    const postType =
      asNonEmptyString(payload.postType)?.toLowerCase() ??
      asNonEmptyString(context?.postType)?.toLowerCase() ??
      "";
    if (postType === "media") return true;
    if (postType === "text") return false;

    const generatedAssetType =
      asNonEmptyString(payload.generatedAssetType)?.toLowerCase() ??
      asNonEmptyString(context?.generatedAssetType)?.toLowerCase() ??
      "";
    if (generatedAssetType === "image" || generatedAssetType === "gif") return true;

    const mediaPrompt =
      asNonEmptyString(payload.mediaPrompt) ??
      asNonEmptyString(payload.imagePrompt) ??
      asNonEmptyString(context?.mediaPrompt) ??
      asNonEmptyString(context?.imagePrompt);
    if (mediaPrompt) return true;

    const requestedKinds = this.resolveRequestedGenerateKinds(payload, "chat");
    return requestedKinds.some(
      (kind) => kind === "media" || kind === "multi_media" || kind === "story",
    );
  }

  private shouldDefaultPersonaReferences(
    payload: Record<string, unknown>,
    command: Command | null,
  ): boolean {
    const context = isRecord(payload.context) ? payload.context : null;
    const commandKind = command?.kind.trim().toLowerCase() ?? "";
    const explicitCandidates: unknown[] = [
      payload.mediaPersona,
      payload.persona,
      payload.personaName,
      context?.mediaPersona,
      context?.persona,
      context?.personaName,
    ];
    let explicitPersonaSlug: string | null = null;
    for (const candidate of explicitCandidates) {
      const normalized = this.normalizePersonaSlug(candidate);
      if (!normalized) continue;
      explicitPersonaSlug = normalized;
      break;
    }
    const genericExplicitPersona =
      explicitPersonaSlug !== null && this.isGenericPersonaSlug(explicitPersonaSlug);
    const chatLiteralGenerate =
      payload.chatLiteralGenerate === true ||
      payload.chatLiteralGenerate === "true" ||
      context?.chatLiteralGenerate === true ||
      context?.chatLiteralGenerate === "true";
    const avatarOrBannerRequest =
      payload.avatarRequest === true ||
      payload.bannerRequest === true ||
      context?.avatarRequest === true ||
      context?.bannerRequest === true;
    const personaMediaLockEnabled = this.isPersonaMediaLockEnabled(payload);
    if (
      personaMediaLockEnabled &&
      !(chatLiteralGenerate && !avatarOrBannerRequest && genericExplicitPersona)
    ) {
      return true;
    }
    if (!this.isMediaLikePayloadForPersona(payload, command)) return false;
    if (
      commandKind === "write.updateavatar" ||
      payload.avatarRequest === true ||
      context?.avatarRequest === true
    ) {
      return true;
    }
    const provenance =
      normalizeAgentProvenanceValue(payload.provenance) ??
      normalizeAgentProvenanceValue(context?.provenance);
    return provenance === "AGENT_AUTONOMOUS";
  }

  private resolvePersonaReferencePlan(
    payload: Record<string, unknown>,
    mainPersonaSlugRaw: string | null = null,
    command: Command | null = null,
  ): PersonaReferencePlan {
    const context = isRecord(payload.context) ? payload.context : null;
    const explicitCandidates: unknown[] = [
      payload.mediaPersona,
      payload.persona,
      payload.personaName,
      context?.mediaPersona,
      context?.persona,
      context?.personaName,
    ];
    let explicitPersonaSlug: string | null = null;
    for (const candidate of explicitCandidates) {
      const normalized = this.normalizePersonaSlug(candidate);
      if (!normalized) continue;
      explicitPersonaSlug = normalized;
      break;
    }
    const nonGenericExplicitSlug =
      explicitPersonaSlug && !this.isGenericPersonaSlug(explicitPersonaSlug)
        ? explicitPersonaSlug
        : null;
    const explicitGenericPersonaRequested =
      explicitPersonaSlug === "persona" ||
      explicitPersonaSlug === "selfie" ||
      explicitPersonaSlug === "self" ||
      explicitPersonaSlug === "me" ||
      explicitPersonaSlug === "myself";
    const personaMediaLock = this.isPersonaMediaLockEnabled(payload);
    const promptText = this.extractPersonaPromptText(payload);
    const selfIntent = PERSONA_SELF_REFERENCE_PROMPT_PATTERN.test(promptText);
    const personaIntent = selfIntent || PERSONA_REQUEST_PROMPT_PATTERN.test(promptText);
    const explicitNewPersonaRequest = this.isExplicitNewPersonaRequest(payload);
    const explicitVariantKey = this.resolveExplicitPersonaVariantKey(payload);
    const promptVariantKey = this.resolvePersonaVariantKeyFromPrompt(promptText);
    const variantKey =
      explicitVariantKey ??
      (explicitNewPersonaRequest ? promptVariantKey : null);
    const mainPersonaSlug =
      this.normalizePersonaSlug(mainPersonaSlugRaw) ?? DEFAULT_MAIN_PERSONA_SLUG;
    const shouldDefaultPersona = this.shouldDefaultPersonaReferences(payload, command);

    if (nonGenericExplicitSlug) {
      return {
        enabled: true,
        mainPersonaSlug,
        targetPersonaSlug: nonGenericExplicitSlug,
        source: "explicit",
        explicitPersonaSlug: nonGenericExplicitSlug,
        variantKey,
        allowNewPersonaCreation: explicitNewPersonaRequest,
      };
    }

    if (!personaIntent && !explicitGenericPersonaRequested && !shouldDefaultPersona) {
      return {
        enabled: false,
        mainPersonaSlug,
        targetPersonaSlug: mainPersonaSlug,
        source: "none",
        explicitPersonaSlug: explicitPersonaSlug,
        variantKey: null,
        allowNewPersonaCreation: false,
      };
    }

    const inferredVariantSlug =
      explicitNewPersonaRequest && variantKey
      ? this.normalizePersonaSlug(`${mainPersonaSlug}_${variantKey}`)
      : null;
    const targetPersonaSlug = inferredVariantSlug ?? mainPersonaSlug;
    return {
      enabled: true,
      mainPersonaSlug,
      targetPersonaSlug,
      source:
        inferredVariantSlug
          ? "inferred_variant"
          : personaMediaLock
            ? "forced_lock"
            : shouldDefaultPersona
              ? "default_media"
              : "inferred_main",
      explicitPersonaSlug,
      variantKey,
      allowNewPersonaCreation: explicitNewPersonaRequest,
    };
  }

  private shouldUsePersonaFrameReferences(plan: PersonaReferencePlan): boolean {
    if (!plan.enabled) return false;
    return !this.isGenericPersonaSlug(plan.targetPersonaSlug);
  }

  private isImageMimeType(value: string | null | undefined): boolean {
    const normalized = asNonEmptyString(value)?.trim().toLowerCase() ?? "";
    return normalized.startsWith("image/");
  }

  private isUploadableMediaMimeType(value: string | null | undefined): boolean {
    const normalized = asNonEmptyString(value)?.trim().toLowerCase() ?? "";
    return normalized.startsWith("image/") || normalized.startsWith("video/");
  }

  private isLikelyImageReference(
    value: string | null | undefined,
    fallbackMimeType: string | null = null,
  ): boolean {
    const normalized = asNonEmptyString(value);
    if (!normalized) return false;
    const parsedDataUri = parseDataUriPayload(normalized);
    if (parsedDataUri) {
      return this.isImageMimeType(parsedDataUri.mime);
    }
    const inferredMime = inferMimeTypeFromUrl(normalized);
    if (inferredMime && this.isImageMimeType(inferredMime)) return true;
    if (inferredMime && inferredMime !== "application/octet-stream") return false;
    if (NON_IMAGE_REFERENCE_EXTENSION_PATTERN.test(normalized)) return false;
    if (this.isImageMimeType(fallbackMimeType)) return true;
    return false;
  }

  private async resolveMainPersonaSlugFromBridge(): Promise<string | null> {
    if (!this.ctx.callAgentChatBridge) return null;
    try {
      const profileResult = await this.callAgentBridgeLookupCached({
        action: "agent_profile",
      });
      const profileRecord = isRecord(profileResult.value) ? profileResult.value : null;
      const agentRecord =
        profileRecord && isRecord(profileRecord.agent) ? profileRecord.agent : null;
      const candidateValues: unknown[] = [
        agentRecord?.mainPersonaSlug,
        agentRecord?.mainRealismPersonaSlug,
        profileRecord?.mainPersonaSlug,
        profileRecord?.mainRealismPersonaSlug,
      ];
      for (const candidate of candidateValues) {
        const normalized = this.normalizePersonaSlug(candidate);
        if (normalized) return normalized;
      }
    } catch {
      // best-effort lookup only
    }
    return null;
  }

  private collectPersonaSeedReferenceInputs(input: {
    payload: Record<string, unknown>;
    fallbackReferenceInputs: string[];
  }): string[] {
    const directInputs = this.collectMediaReferenceInputs(input.payload, {
      includeRecentGeneratedAsset: false,
    });
    const deduped = new Set<string>();
    const push = (value: string | null | undefined): void => {
      const normalized = asNonEmptyString(value);
      if (!normalized || this.isStreamPartArtifactReference(normalized)) return;
      if (!this.isLikelyImageReference(normalized)) return;
      deduped.add(normalized);
    };
    for (const entry of directInputs) push(entry);
    for (const entry of input.fallbackReferenceInputs) push(entry);

    const recent = isRecord(input.payload.recentGeneratedAsset)
      ? input.payload.recentGeneratedAsset
      : null;
    const recentType = asNonEmptyString(recent?.type)?.toLowerCase() ?? "";
    if (recentType === "persona" || recentType === "avatar") {
      push(asNonEmptyString(recent?.href));
      push(asNonEmptyString(recent?.url));
      push(asNonEmptyString(recent?.imageUrl));
      push(asNonEmptyString(recent?.mediaUrl));
    }
    return [...deduped].slice(0, MAX_MEDIA_REFERENCE_INPUTS);
  }

  private async collectAgentProfilePersonaSeedReferences(): Promise<string[]> {
    if (!this.ctx.callAgentChatBridge) return [];
    try {
      const response = await this.callAgentBridgeLookupCached({
        action: "agent_profile",
      });
      const root = isRecord(response.value) ? response.value : null;
      if (!root) return [];
      const agent = isRecord(root.agent) ? root.agent : null;
      const profile = isRecord(root.profile) ? root.profile : null;
      const config = isRecord(root.config) ? root.config : null;
      const urls = new Set<string>();
      const push = (value: unknown): void => {
        const direct = asNonEmptyString(value);
        if (direct) {
          urls.add(direct);
          return;
        }
        if (!isRecord(value)) return;
        const nestedUrl =
          asNonEmptyString(value.url) ??
          asNonEmptyString(value.href) ??
          asNonEmptyString(value.imageUrl) ??
          asNonEmptyString(value.mediaUrl) ??
          asNonEmptyString(value.mediaOptimizedUrl) ??
          asNonEmptyString(value.optimizedUrl) ??
          null;
        if (nestedUrl) urls.add(nestedUrl);
      };
      for (const source of [root, agent, profile, config]) {
        if (!source) continue;
        push(source.avatarUrl);
        push(source.profileImageUrl);
        push(source.imageUrl);
        push(source.photoUrl);
        push(source.profilePhotoUrl);
        push(source.pfpUrl);
        push(source.avatar);
        push(source.image);
        push(source.photo);
        push(source.mediaOptimizedUrl);
        push(source.optimizedUrl);
      }
      return [...urls]
        .filter(
          (entry) =>
            !this.isStreamPartArtifactReference(entry) &&
            this.isLikelyImageReference(entry),
        )
        .slice(0, MAX_MEDIA_REFERENCE_INPUTS);
    } catch {
      return [];
    }
  }

  private updatePersonaReferenceSnapshot(input: {
    mainPersonaSlug: string;
    personaSlug: string;
    source: string;
    frameReferences: string[];
    builtFrames: boolean;
    variantKey: string | null;
  }): void {
    const stateDb = this.ctx.stateDb;
    if (!stateDb?.enabled) return;
    const scope = "runtime.persona.references";
    const existing = stateDb.getSnapshot<Record<string, unknown>>(scope);
    const previousPersonas = isRecord(existing) && isRecord(existing.personas)
      ? existing.personas
      : {};
    const nextPersonas: Record<string, unknown> = {
      ...previousPersonas,
      [input.personaSlug]: {
        mainPersonaSlug: input.mainPersonaSlug,
        source: input.source,
        frameCount: input.frameReferences.length,
        frameReferences: input.frameReferences.slice(0, REQUIRED_PERSONA_REFERENCE_FRAME_COUNT),
        builtFrames: input.builtFrames,
        variantKey: input.variantKey,
        updatedAt: nowIso(),
      },
    };
    if (!isRecord(nextPersonas[input.mainPersonaSlug])) {
      nextPersonas[input.mainPersonaSlug] = {
        mainPersonaSlug: input.mainPersonaSlug,
        source: "main_persona",
        frameCount: input.frameReferences.length,
        frameReferences: input.frameReferences.slice(0, REQUIRED_PERSONA_REFERENCE_FRAME_COUNT),
        builtFrames: input.builtFrames,
        variantKey: null,
        updatedAt: nowIso(),
      };
    }
    stateDb.upsertSnapshot({
      scope,
      visibility: "private",
      data: {
        mainPersonaSlug: input.mainPersonaSlug,
        updatedAt: nowIso(),
        personas: nextPersonas,
      },
    });
  }

  private normalizePersonaFrameRole(value: unknown): PersonaFrameRole | null {
    const normalized = asNonEmptyString(value)?.toLowerCase() ?? "";
    if (normalized === "selfie") return "selfie";
    if (normalized === "midshot" || normalized === "halfbody" || normalized === "half_body") {
      return "midshot";
    }
    if (
      normalized === "fullbody" ||
      normalized === "full_body" ||
      normalized === "full" ||
      normalized === "fullshot" ||
      normalized === "full_shot"
    ) {
      return "fullbody";
    }
    return null;
  }

  private parseIsoOrNull(value: unknown): string | null {
    const text = asNonEmptyString(value);
    if (!text) return null;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }

  private parsePersonaFrameRecords(value: unknown): PersonaFrameRecord[] {
    const asRows = (input: unknown): unknown[] => {
      if (Array.isArray(input)) return input;
      if (isRecord(input) && Array.isArray(input.frames)) return input.frames;
      return [];
    };
    const records: PersonaFrameRecord[] = [];
    for (const rawEntry of asRows(value)) {
      if (!isRecord(rawEntry)) continue;
      const idRaw =
        asPositiveInt(rawEntry.id) ??
        (typeof rawEntry.id === "number" && Number.isFinite(rawEntry.id)
          ? Math.max(1, Math.floor(rawEntry.id))
          : null);
      const personaSlug = this.normalizePersonaSlug(rawEntry.personaSlug);
      const frameRole = this.normalizePersonaFrameRole(rawEntry.frameRole);
      const mediaUrl = asNonEmptyString(rawEntry.mediaUrl);
      if (!idRaw || !personaSlug || !frameRole || !mediaUrl) continue;
      const width =
        typeof rawEntry.width === "number" && Number.isFinite(rawEntry.width)
          ? Math.max(1, Math.floor(rawEntry.width))
          : null;
      const height =
        typeof rawEntry.height === "number" && Number.isFinite(rawEntry.height)
          ? Math.max(1, Math.floor(rawEntry.height))
          : null;
      const sizeBytes =
        typeof rawEntry.sizeBytes === "number" && Number.isFinite(rawEntry.sizeBytes)
          ? Math.max(1, Math.floor(rawEntry.sizeBytes))
          : null;
      records.push({
        id: idRaw,
        personaSlug,
        frameRole,
        mediaUrl,
        originalUrl: asNonEmptyString(rawEntry.originalUrl),
        optimizedUrl: asNonEmptyString(rawEntry.optimizedUrl),
        mimeType: asNonEmptyString(rawEntry.mimeType),
        width,
        height,
        sizeBytes,
        sourcePrompt: asNonEmptyString(rawEntry.sourcePrompt),
        sourceCommandId: asNonEmptyString(rawEntry.sourceCommandId),
        createdAt: this.parseIsoOrNull(rawEntry.createdAt),
        updatedAt: this.parseIsoOrNull(rawEntry.updatedAt),
      });
    }
    return records;
  }

  private getPersonaFrameRoleSortValue(frameRole: PersonaFrameRole): number {
    const index = PERSONA_REFERENCE_FRAME_ROLES.indexOf(frameRole);
    return index >= 0 ? index : PERSONA_REFERENCE_FRAME_ROLES.length + 1;
  }

  private sortPersonaFrames(frames: PersonaFrameRecord[]): PersonaFrameRecord[] {
    return [...frames].sort((left, right) => {
      const roleDelta =
        this.getPersonaFrameRoleSortValue(left.frameRole) -
        this.getPersonaFrameRoleSortValue(right.frameRole);
      if (roleDelta !== 0) return roleDelta;
      const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0;
      const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0;
      if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
      return right.id - left.id;
    });
  }

  private pickPersonaFrameReferenceUrl(frame: PersonaFrameRecord): string | null {
    const candidates = [frame.optimizedUrl, frame.mediaUrl, frame.originalUrl];
    for (const candidate of candidates) {
      const normalized = asNonEmptyString(candidate);
      if (!normalized) continue;
      if (this.isStreamPartArtifactReference(normalized)) continue;
      if (!this.isLikelyImageReference(normalized, frame.mimeType)) continue;
      return normalized;
    }
    return null;
  }

  private collectPersonaFrameReferences(frames: PersonaFrameRecord[]): string[] {
    const ordered = this.sortPersonaFrames(frames);
    const seen = new Set<string>();
    const collected: string[] = [];
    for (const role of PERSONA_REFERENCE_FRAME_ROLES) {
      const matches = ordered.filter((frame) => frame.frameRole === role);
      for (const match of matches) {
        const selected = this.pickPersonaFrameReferenceUrl(match);
        if (!selected || seen.has(selected)) continue;
        seen.add(selected);
        collected.push(selected);
        break;
      }
    }
    return collected.slice(0, REQUIRED_PERSONA_REFERENCE_FRAME_COUNT);
  }

  private async listPersonaFramesFromServer(personaSlug: string): Promise<PersonaFrameRecord[]> {
    const listFrames = this.agentQueryOptional("listPersonaFrames");
    if (!listFrames) return [];
    try {
      const response = await listFrames.query({ personaSlug });
      const parsed = this.parsePersonaFrameRecords(response).filter(
        (frame) => frame.personaSlug === personaSlug,
      );
      return this.sortPersonaFrames(parsed);
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "persona_frame_list_failed",
          at: nowIso(),
          personaSlug,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return [];
    }
  }

  private async ensurePersonaDefinitionForFrames(
    personaSlug: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const listPersonas = this.agentQueryOptional("listPersonas");
    const upsertPersona = this.agentMutatorOptional("upsertPersona");
    if (!upsertPersona) return;
    let personaExists = false;
    if (listPersonas) {
      try {
        const listedRaw = await listPersonas.query();
        const listed = Array.isArray(listedRaw)
          ? listedRaw
          : isRecord(listedRaw) && Array.isArray(listedRaw.personas)
            ? listedRaw.personas
            : [];
        personaExists = listed.some((entry) => {
          if (!isRecord(entry)) return false;
          return this.normalizePersonaSlug(entry.slug) === personaSlug;
        });
      } catch {
        personaExists = false;
      }
    }
    if (personaExists) return;
    const styleHint =
      asNonEmptyString(payload.mediaPersonaStyleHint) ??
      asNonEmptyString(payload.personaStyleHint) ??
      null;
    const displayName =
      personaSlug
        .split("_")
        .map((part) =>
          part.length > 0
            ? `${part.charAt(0).toUpperCase()}${part.slice(1)}`
            : "",
        )
        .join(" ")
        .trim() || "Persona";
    try {
      await upsertPersona.mutate({
        slug: personaSlug,
        name: displayName,
        labels: [personaSlug, "persona_reference", "realistic_reference"],
        weight: 100,
        isActive: true,
        ...(styleHint ? { styleHint } : {}),
      });
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "persona_definition_upsert_failed",
          at: nowIso(),
          personaSlug,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }
  }

  private buildPersonaReferencePrompt(input: {
    personaSlug: string;
    frameRole: PersonaFrameRole;
    payload: Record<string, unknown>;
  }): string {
    const styleHint =
      asNonEmptyString(input.payload.mediaPersonaStyleHint) ??
      asNonEmptyString(input.payload.personaStyleHint) ??
      null;
    const sourcePrompt =
      asNonEmptyString(input.payload.mediaPrompt) ??
      asNonEmptyString(input.payload.prompt) ??
      asNonEmptyString(input.payload.topic) ??
      null;
    const frameInstruction =
      input.frameRole === "selfie"
        ? "Selfie reference frame: chest-up portrait, direct eye contact, neutral expression, natural lighting."
        : input.frameRole === "midshot"
          ? "Midshot reference frame: waist-up framing, clear body proportions, neutral pose, realistic streetwear details."
          : "Fullbody reference frame: full-body standing pose, realistic proportions, plain uncluttered background.";
    const continuityLine =
      "Keep identity continuity with existing persona references (same face, age range, skin tone, hair, and body proportions).";
    const realismLine =
      "Photorealistic style only. No anime, no cartoon, no painterly treatment.";
    return [
      `Build a persistent persona reference image for slug "${input.personaSlug}".`,
      frameInstruction,
      continuityLine,
      realismLine,
      "Single subject only. Keep image clean, sharp, and unoccluded.",
      styleHint ? `Style hint: ${styleHint}` : null,
      sourcePrompt ? `Persona context: ${truncateText(sourcePrompt, 220)}` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");
  }

  private async compressPersonaReferenceImage(input: {
    sourceUrl: string;
    sourceMimeType: string | null;
    personaSlug: string;
    frameRole: PersonaFrameRole;
  }): Promise<ResolvedMediaUpload | null> {
    const transformed = await transformCustomAssetMedia({
      sourceUrl: input.sourceUrl,
      sourceMimeType: input.sourceMimeType ?? "image/png",
      kind: "sticker",
      spec: {
        width: PERSONA_REFERENCE_MAX_SIDE,
        height: PERSONA_REFERENCE_MAX_SIDE,
        fit: "inside",
        format: "jpeg",
        quality: PERSONA_REFERENCE_JPEG_QUALITY,
      },
    }).catch(() => null);
    if (!transformed?.bytes?.byteLength) return null;
    const fileName = `persona-${input.personaSlug}-${input.frameRole}-${Date.now()}.jpg`;
    const uploadedByChunk = await this.uploadBytesViaChunkRoute({
      bytes: transformed.bytes,
      mimeType: transformed.mimeType,
      filename: fileName,
      keepOriginal: false,
    });
    if (uploadedByChunk) return uploadedByChunk;
    const dataUri = `data:${transformed.mimeType};base64,${transformed.bytes.toString("base64")}`;
    const uploaded = await this.agent().uploadDataUri.mutate({
      dataUri,
      keepOriginal: false,
    });
    return this.mapUploadResult(uploaded);
  }

  private async upsertPersonaFrameRecord(input: {
    personaSlug: string;
    frameRole: PersonaFrameRole;
    media: ResolvedMediaUpload;
    sourcePrompt: string;
    sourceCommandId: string;
  }): Promise<boolean> {
    const upsertFrame = this.agentMutatorOptional("upsertPersonaFrame");
    if (!upsertFrame) return false;
    try {
      const canonicalMediaUrl =
        this.resolvePreferredMediaUrl(
          input.media.mediaOptimizedUrl,
          input.media.mediaUrl,
          input.media.mediaOriginalUrl,
        ) ?? input.media.mediaUrl;
      const canonicalOptimizedUrl =
        this.resolvePreferredMediaUrl(
          input.media.mediaOptimizedUrl,
          canonicalMediaUrl,
          input.media.mediaUrl,
          input.media.mediaOriginalUrl,
        ) ?? canonicalMediaUrl;
      const canonicalOriginalUrl = this.resolvePreferredMediaUrl(
        input.media.mediaOriginalUrl,
        input.media.mediaUrl,
        canonicalMediaUrl,
      );
      const mimeType =
        inferMimeTypeFromUrl(canonicalOptimizedUrl) ??
        inferMimeTypeFromUrl(canonicalOriginalUrl ?? canonicalMediaUrl) ??
        "image/jpeg";
      await upsertFrame.mutate({
        personaSlug: input.personaSlug,
        frameRole: input.frameRole,
        mediaUrl: canonicalMediaUrl,
        ...(canonicalOriginalUrl
          ? { originalUrl: canonicalOriginalUrl }
          : {}),
        ...(canonicalOptimizedUrl
          ? { optimizedUrl: canonicalOptimizedUrl }
          : {}),
        mimeType,
        ...(typeof input.media.mediaSizeBytes === "number" &&
        Number.isFinite(input.media.mediaSizeBytes)
          ? { sizeBytes: Math.max(1, Math.floor(input.media.mediaSizeBytes)) }
          : {}),
        sourcePrompt: truncateText(input.sourcePrompt, 2000),
        sourceCommandId: input.sourceCommandId,
      });
      return true;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "persona_frame_upsert_failed",
          at: nowIso(),
          personaSlug: input.personaSlug,
          frameRole: input.frameRole,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return false;
    }
  }

  private async bootstrapPersonaReferenceFrames(input: {
    personaSlug: string;
    payload: Record<string, unknown>;
    command: Command;
    existingFrames: PersonaFrameRecord[];
    seedReferences?: string[];
  }): Promise<{ frames: PersonaFrameRecord[]; builtFrames: boolean }> {
    let builtFrames = false;
    await this.ensurePersonaDefinitionForFrames(input.personaSlug, input.payload);
    const existingRoles = new Set<PersonaFrameRole>(
      input.existingFrames.map((frame) => frame.frameRole),
    );
    const referenceInputs = Array.from(
      new Set([
        ...(Array.isArray(input.seedReferences) ? input.seedReferences : []),
        ...this.collectPersonaFrameReferences(input.existingFrames),
      ]),
    ).slice(0, MAX_MEDIA_REFERENCE_INPUTS);
    for (const frameRole of PERSONA_REFERENCE_FRAME_ROLES) {
      if (existingRoles.has(frameRole)) continue;
      const sourcePrompt = this.buildPersonaReferencePrompt({
        personaSlug: input.personaSlug,
        frameRole,
        payload: input.payload,
      });
      try {
        const generated = await this.generateAndUploadMediaFromPrompt(sourcePrompt, {
          generatedAssetType: "image",
          mode: "persona_reference_bootstrap",
          referenceInputs,
          keepOriginal: false,
          commandId: input.command.id,
        });
        const compressed =
          (await this.compressPersonaReferenceImage({
            sourceUrl: generated.mediaOptimizedUrl ?? generated.mediaUrl,
            sourceMimeType:
              inferMimeTypeFromUrl(generated.mediaOptimizedUrl ?? generated.mediaUrl) ??
              inferMimeTypeFromUrl(generated.mediaOriginalUrl ?? generated.mediaUrl),
            personaSlug: input.personaSlug,
            frameRole,
          }).catch(() => null)) ?? null;
        const media = compressed ?? generated;
        const upserted = await this.upsertPersonaFrameRecord({
          personaSlug: input.personaSlug,
          frameRole,
          media,
          sourcePrompt,
          sourceCommandId: input.command.id,
        });
        if (upserted) {
          builtFrames = true;
        }
        const frameReference =
          this.resolvePreferredMediaUrl(
            media.mediaOptimizedUrl,
            media.mediaUrl,
            media.mediaOriginalUrl,
          ) ?? null;
        if (
          frameReference &&
          !this.isStreamPartArtifactReference(frameReference) &&
          !referenceInputs.includes(frameReference)
        ) {
          referenceInputs.push(frameReference);
        }
        await this.ctx.memory
          .recordWrite({
            type: "persona_frame_bootstrapped",
            at: nowIso(),
            commandId: input.command.id,
            personaSlug: input.personaSlug,
            frameRole,
            mediaUrl: frameReference ?? media.mediaUrl,
            compressed: Boolean(compressed),
          })
          .catch(() => undefined);
      } catch (error: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "persona_frame_bootstrap_failed",
            at: nowIso(),
            commandId: input.command.id,
            personaSlug: input.personaSlug,
            frameRole,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
    }
    const refreshed = await this.listPersonaFramesFromServer(input.personaSlug);
    return { frames: refreshed, builtFrames };
  }

  private async resolvePersonaFrameReferences(input: {
    payload: Record<string, unknown>;
    command: Command;
    fallbackReferenceInputs: string[];
  }): Promise<PersonaReferenceResolution> {
    const resolvedMainPersonaSlug = await this.resolveMainPersonaSlugFromBridge();
    const plan = this.resolvePersonaReferencePlan(
      input.payload,
      resolvedMainPersonaSlug,
      input.command,
    );
    if (!this.shouldUsePersonaFrameReferences(plan)) {
      return {
        personaSlug: null,
        frameReferences: input.fallbackReferenceInputs.slice(0, MAX_MEDIA_REFERENCE_INPUTS),
        builtFrames: false,
        mainPersonaSlug: null,
        source: null,
      };
    }
    const localSeedReferences = this.collectPersonaSeedReferenceInputs({
      payload: input.payload,
      fallbackReferenceInputs: input.fallbackReferenceInputs,
    });
    const profileSeedReferences = await this.collectAgentProfilePersonaSeedReferences();
    const seedReferences = Array.from(
      new Set([...profileSeedReferences, ...localSeedReferences]),
    ).slice(0, MAX_MEDIA_REFERENCE_INPUTS);
    const mainPersonaSlug = plan.mainPersonaSlug;
    const requestedPersonaSlug = plan.targetPersonaSlug;
    let targetPersonaSlug = requestedPersonaSlug;
    let builtFrames = false;
    let mainFrames: PersonaFrameRecord[] = [];
    let mainFrameReferences: string[] = [];
    if (requestedPersonaSlug !== mainPersonaSlug) {
      mainFrames = await this.listPersonaFramesFromServer(mainPersonaSlug);
      mainFrameReferences = this.collectPersonaFrameReferences(mainFrames);
      if (mainFrameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT) {
        const bootstrappedMain = await this.bootstrapPersonaReferenceFrames({
          personaSlug: mainPersonaSlug,
          payload: input.payload,
          command: input.command,
          existingFrames: mainFrames,
          seedReferences,
        });
        mainFrames = bootstrappedMain.frames;
        mainFrameReferences = this.collectPersonaFrameReferences(mainFrames);
        builtFrames = builtFrames || bootstrappedMain.builtFrames;
      }
    }

    let frames =
      requestedPersonaSlug === mainPersonaSlug
        ? mainFrames.length > 0
          ? mainFrames
          : await this.listPersonaFramesFromServer(requestedPersonaSlug)
        : await this.listPersonaFramesFromServer(requestedPersonaSlug);
    let targetFrameReferences = this.collectPersonaFrameReferences(frames);
    if (
      requestedPersonaSlug !== mainPersonaSlug &&
      targetFrameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT &&
      !plan.allowNewPersonaCreation
    ) {
      targetPersonaSlug = mainPersonaSlug;
      frames = mainFrames.length > 0
        ? mainFrames
        : await this.listPersonaFramesFromServer(mainPersonaSlug);
      mainFrames = frames;
      mainFrameReferences = this.collectPersonaFrameReferences(mainFrames);
      targetFrameReferences = mainFrameReferences;
      await this.ctx.memory
        .recordWrite({
          type: "persona_reference_new_persona_suppressed",
          at: nowIso(),
          commandId: input.command.id,
          requestedPersonaSlug,
          mainPersonaSlug,
          source: plan.source,
          reason: "missing_target_frames_without_explicit_new_persona_request",
        })
        .catch(() => undefined);
    }
    if (targetFrameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT) {
      const bootstrapSeedReferences = Array.from(
        new Set([
          ...mainFrameReferences,
          ...seedReferences,
        ]),
      ).slice(0, MAX_MEDIA_REFERENCE_INPUTS);
      const bootstrapped = await this.bootstrapPersonaReferenceFrames({
        personaSlug: targetPersonaSlug,
        payload: input.payload,
        command: input.command,
        existingFrames: frames,
        seedReferences: bootstrapSeedReferences,
      });
      frames = bootstrapped.frames;
      targetFrameReferences = this.collectPersonaFrameReferences(frames);
      builtFrames = builtFrames || bootstrapped.builtFrames;
    }
    if (targetPersonaSlug === mainPersonaSlug) {
      mainFrameReferences = targetFrameReferences;
    }

    const frameReferences =
      targetFrameReferences.length >= REQUIRED_PERSONA_REFERENCE_FRAME_COUNT
        ? targetFrameReferences.slice(0, REQUIRED_PERSONA_REFERENCE_FRAME_COUNT)
        : Array.from(
            new Set([...targetFrameReferences, ...mainFrameReferences]),
          ).slice(0, REQUIRED_PERSONA_REFERENCE_FRAME_COUNT);
    await this.ctx.memory
      .recordWrite({
        type: "persona_reference_resolution",
        at: nowIso(),
        commandId: input.command.id,
        personaSlug: targetPersonaSlug,
        requestedPersonaSlug,
        mainPersonaSlug,
        source: plan.source,
        explicitPersonaSlug: plan.explicitPersonaSlug,
        variantKey: plan.variantKey,
        allowNewPersonaCreation: plan.allowNewPersonaCreation,
        builtFrames,
        targetFrameCount: targetFrameReferences.length,
        mainFrameCount: mainFrameReferences.length,
        resolvedFrameCount: frameReferences.length,
        seedReferenceCount: seedReferences.length,
      })
      .catch(() => undefined);
    this.updatePersonaReferenceSnapshot({
      mainPersonaSlug,
      personaSlug: targetPersonaSlug,
      source: plan.source,
      frameReferences,
      builtFrames,
      variantKey: plan.variantKey,
    });

    return {
      personaSlug: targetPersonaSlug,
      frameReferences,
      builtFrames,
      mainPersonaSlug,
      source: plan.source,
    };
  }

  private async processCommandFilePath(
    filePath: string,
    queueContext?: { attempts?: number; maxAttempts?: number },
  ): Promise<boolean> {
    const inboxFile = path.basename(filePath);
    const read = await readJsonMaybeIncomplete(filePath);
    if (read.status === "missing") {
      await this.markQueueItemCompletedByInbox(inboxFile, "missing", "file missing before execution");
      return true;
    }
    if (read.status === "not_ready") {
      await this.markQueueItemNotReadyByInbox(inboxFile, "inbox_json_not_ready").catch(
        () => undefined,
      );
      return false;
    }
    if (read.status === "invalid") {
      await this.writeOutcome({
        at: nowIso(),
        commandId: `invalid:${inboxFile}`,
        kind: "unknown",
        grantId: null,
        ok: false,
        error: { message: "invalid json command" },
      });
      await this.moveInboxFileToProcessed(filePath, "invalid");
      await this.markQueueItemCompletedByInbox(inboxFile, "failed", "invalid json command");
      return true;
    }

    let command = parseCommand(read.value);
    if (!command) {
      await this.writeOutcome({
        at: nowIso(),
        commandId: `parse_failed:${inboxFile}`,
        kind: "unknown",
        grantId: null,
        ok: false,
        error: { message: "command parse failed" },
      });
      await this.moveInboxFileToProcessed(filePath, "invalid");
      await this.markQueueItemCompletedByInbox(inboxFile, "failed", "command parse failed");
      return true;
    }
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "received",
      status: "ok",
      metadata: {
        inboxFile,
      },
    });
    const runtimeOrigin =
      asNonEmptyString(command.runtimeOrigin)?.trim().toLowerCase() ?? "";
    const isDirectiveScopedCommand =
      runtimeOrigin === "director_directive" ||
      runtimeOrigin === "pending_promotion" ||
      runtimeOrigin === "runtime_resealed" ||
      asNonEmptyString(command.sourceDirectiveId) !== null ||
      asNonEmptyString(command.pendingDirectiveId) !== null;
    const targetAgentId = asNonEmptyString(command.targetAgentId);
    if (!targetAgentId && isDirectiveScopedCommand) {
      const missingReason = "directive_target_agent_missing";
      await this.ctx.memory
        .recordWrite({
          type: "inbox_command_target_agent_missing",
          at: nowIso(),
          inboxFile,
          commandId: command.id,
          kind: command.kind,
          runtimeOrigin: command.runtimeOrigin ?? null,
          sourceDirectiveId: command.sourceDirectiveId ?? null,
          pendingDirectiveId: command.pendingDirectiveId ?? null,
          reason: missingReason,
        })
        .catch(() => undefined);
      const outcome: CommandOutcome = {
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: {
          message: "Rejected command: directive target agent id is missing.",
          code: missingReason,
        },
      };
      await this.finalizeCommandOutcome({ command, outcome });
      await this.moveInboxFileToProcessed(filePath, "rejected");
      await this.markQueueItemCompletedByInbox(
        inboxFile,
        "failed",
        "directive target agent id missing",
      );
      return true;
    }
    if (targetAgentId) {
      const runtimeAgentId = await this.resolveRuntimeAgentId();
      if (!runtimeAgentId || runtimeAgentId.length === 0) {
        const unresolvedReason = `target_agent_identity_unknown:${targetAgentId}`;
        await this.ctx.memory
          .recordWrite({
            type: "inbox_command_target_agent_identity_unknown",
            at: nowIso(),
            inboxFile,
            commandId: command.id,
            kind: command.kind,
            targetAgentId,
            reason: unresolvedReason,
          })
          .catch(() => undefined);
        await this.markQueueItemNotReadyByInbox(inboxFile, unresolvedReason).catch(
          () => undefined,
        );
        return false;
      }
      if (
        runtimeAgentId !== targetAgentId
      ) {
        const mismatchReason = `target_agent_mismatch:${targetAgentId}:${runtimeAgentId}`;
        await this.ctx.memory
          .recordWrite({
            type: "inbox_command_target_agent_mismatch",
            at: nowIso(),
            inboxFile,
            commandId: command.id,
            kind: command.kind,
            targetAgentId,
            runtimeAgentId,
            reason: mismatchReason,
          })
          .catch(() => undefined);
        await this.markQueueItemNotReadyByInbox(inboxFile, mismatchReason).catch(
          () => undefined,
        );
        return false;
      }
    }

    let commandSigVerified = false;
    if (this.ctx.controlKey) {
      const expected = computeCommandSignature(this.ctx.controlKey, command);
      if (!command.sig || command.sig !== expected) {
        const outcome: CommandOutcome = {
          at: nowIso(),
          commandId: command.id,
          kind: command.kind,
          grantId: command.grantId,
          ok: false,
          error: {
            message:
              "Rejected command: invalid command signature for this runtime session.",
            code: "invalid_command_sig",
          },
        };
        await this.finalizeCommandOutcome({ command, outcome });
        await this.moveInboxFileToProcessed(filePath, "rejected");
        await this.markQueueItemCompletedByInbox(inboxFile, "failed", "invalid command signature");
        return true;
      }
      commandSigVerified = true;
    }

    let sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
    if (
      sealError === "command_replay_detected" &&
      this.tryAllowTrustedReplay(command)
    ) {
      sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
    }
    if (
      sealError === "command_not_issued_by_runtime" &&
      this.tryRehydrateRuntimeIssuedSeal(command)
    ) {
      await this.ctx.memory
        .recordWrite({
          type: "inbox_command_seal_rehydrated",
          at: nowIso(),
          inboxFile,
          commandId: command.id,
          kind: command.kind,
          runtimeOrigin: command.runtimeOrigin ?? null,
        })
        .catch(() => undefined);
      sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
    }
    if (sealError) {
      const resealedCommand = await this.tryResealTrustedCommandForActiveSession({
        command,
        sealError,
        commandSigVerified,
        filePath,
        inboxFile,
      });
      if (resealedCommand) {
        command = resealedCommand;
        sealError = verifyRuntimeCommandSeal(this.ctx.commandSeal, command);
      }
    }
    if (sealError) {
      const outcome: CommandOutcome = {
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: {
          message:
            "Rejected external or stale command file. Only runtime-sealed commands from this active tunnel session are executable.",
          code: sealError,
        },
      };
      await this.ctx.memory.recordWrite({
        type: "inbox_command_rejected",
        at: nowIso(),
        inboxFile,
        commandId: command.id,
        kind: command.kind,
        reason: sealError,
      }).catch(() => undefined);
      await this.finalizeCommandOutcome({ command, outcome });
      await this.moveInboxFileToProcessed(filePath, "rejected");
      await this.markQueueItemCompletedByInbox(
        inboxFile,
        "failed",
        `runtime command seal rejected (${sealError})`,
      );
      return true;
    }

    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "queued",
      status: "ok",
      metadata: {
        inboxFile,
      },
    });
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "executing",
      status: "ok",
    });
    await this.emitChatProcessingIndicator(command).catch(() => undefined);

    const result = await this.executeCommand(command).catch(async (error: unknown) => {
      if (error instanceof RequeueCommandError) {
        this.releaseReplayConsumedForRetry(command.id);
        const requeueReason =
          typeof error.message === "string" && error.message.trim().length > 0
            ? error.message.trim()
            : "not_ready";
        await this.markQueueItemNotReadyByInbox(inboxFile, requeueReason).catch(() => undefined);
        await this.primeCommandContextForRequeue(command, requeueReason).catch(() => undefined);
        void this.ctx.memory
          .recordWrite({
            type: "inbox_command_requeued",
            at: nowIso(),
            inboxFile,
            commandId: command.id,
            kind: command.kind,
            reason: requeueReason,
            replayConsumedReleased: true,
          })
          .catch(() => undefined);
        return {
          processed: false,
          outcome: null,
        } satisfies ExecuteResult;
      }
      const message = error instanceof Error ? error.message : String(error);
      const outcome: CommandOutcome = {
        at: nowIso(),
        commandId: command.id,
        kind: command.kind,
        grantId: command.grantId,
        ok: false,
        error: { message },
      };
      return {
        processed: true,
        outcome,
      } satisfies ExecuteResult;
    });

    if (!result.processed) {
      const attempts = queueContext?.attempts ?? 0;
      const maxAttempts = queueContext?.maxAttempts ?? 0;
      if (maxAttempts > 0 && attempts >= maxAttempts - 1) {
        const terminalOutcome: CommandOutcome = {
          at: nowIso(),
          commandId: command.id,
          kind: command.kind,
          grantId: command.grantId,
          ok: false,
          error: {
            message: `Command failed after ${attempts} attempts (max retry exceeded).`,
            code: "max_retry_exceeded",
          },
        };
        await this.finalizeCommandOutcome({ command, outcome: terminalOutcome });
        await this.updatePendingDirectiveStatusForOutcome(command, terminalOutcome).catch(
          () => undefined,
        );
        await this.moveInboxFileToProcessed(filePath, "failed");
        await this.markQueueItemCompletedByInbox(
          inboxFile,
          "failed",
          `max_retry_exceeded (${attempts} attempts)`,
        );
        return true;
      }
      return false;
    }
    const outcome = result.outcome;
    if (!outcome) {
      await this.updatePendingDirectiveStatusForOutcome(command, null).catch(
        () => undefined,
      );
      await this.moveInboxFileToProcessed(filePath, "done");
      await this.markQueueItemCompletedByInbox(inboxFile, "done", null);
      return true;
    }

    if (command.kind.trim().toLowerCase().startsWith("write.")) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: outcome.ok ? "ok" : "failed",
        message: outcome.ok ? null : outcome.error?.message ?? null,
      });
    }

    await this.finalizeCommandOutcome({ command, outcome });
    await this.updatePendingDirectiveStatusForOutcome(command, outcome).catch(
      () => undefined,
    );

    if (outcome.ok) {
      await this.moveInboxFileToProcessed(filePath, "done");
      await this.markQueueItemCompletedByInbox(inboxFile, "done", null);
    } else {
      await this.moveInboxFileToProcessed(filePath, "failed");
      await this.markQueueItemCompletedByInbox(
        inboxFile,
        "failed",
        outcome.error?.message ?? "command failed",
      );
    }
    return true;
  }

  private resolvePendingDirectiveTerminalStatus(
    outcome: CommandOutcome | null,
  ): "completed" | "permission_denied" | "no_executable_draft" | "max_retry_exceeded" {
    if (!outcome || outcome.ok) return "completed";
    const errorCode = asNonEmptyString(outcome.error?.code)?.toLowerCase() ?? "";
    const errorMessage = asNonEmptyString(outcome.error?.message)?.toLowerCase() ?? "";
    if (
      errorCode.includes("permission_denied") ||
      errorCode.includes("not_granted") ||
      errorMessage.includes("permission denied") ||
      errorMessage.includes("not_granted")
    ) {
      return "permission_denied";
    }
    if (
      errorCode.includes("no_executable_draft") ||
      errorMessage.includes("no executable draft") ||
      errorMessage.includes("unable to generate drafts")
    ) {
      return "no_executable_draft";
    }
    if (
      errorCode.includes("max_retry") ||
      errorMessage.includes("max retry")
    ) {
      return "max_retry_exceeded";
    }
    return "no_executable_draft";
  }

  private async resolvePendingDirectiveFilePath(
    pendingDirectiveId: string,
  ): Promise<string | null> {
    const pendingDir = asNonEmptyString(this.ctx.ipcPaths.pendingDir);
    if (!pendingDir) return null;
    const exactPath = path.join(pendingDir, `${pendingDirectiveId}.json`);
    const exactExists = await fs
      .access(exactPath)
      .then(() => true)
      .catch(() => false);
    if (exactExists) return exactPath;

    const entries = await fs.readdir(pendingDir).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const candidatePath = path.join(pendingDir, entry);
      if (path.basename(entry, ".json") === pendingDirectiveId) {
        return candidatePath;
      }
      const parsed = await readJsonMaybeIncomplete(candidatePath);
      if (parsed.status !== "ok" || !isRecord(parsed.value)) continue;
      const candidateId = asNonEmptyString(parsed.value.id);
      if (candidateId === pendingDirectiveId) {
        return candidatePath;
      }
    }
    return null;
  }

  private async updatePendingDirectiveStatusForOutcome(
    command: Command,
    outcome: CommandOutcome | null,
  ): Promise<void> {
    const pendingDirectiveId = asNonEmptyString(command.pendingDirectiveId);
    if (!pendingDirectiveId) return;
    const pendingPath = await this.resolvePendingDirectiveFilePath(pendingDirectiveId);
    if (!pendingPath) return;
    const pendingRaw = await readJsonMaybeIncomplete(pendingPath);
    if (pendingRaw.status !== "ok" || !isRecord(pendingRaw.value)) return;

    const pendingDoc: Record<string, unknown> = {
      ...pendingRaw.value,
    };
    const payload = isRecord(command.payload) ? command.payload : null;
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const status = this.resolvePendingDirectiveTerminalStatus(outcome);
    const updatedAt = nowIso();
    pendingDoc.status = status;
    pendingDoc.updatedAt = updatedAt;
    pendingDoc.lastRuntimeOutcome = {
      at: updatedAt,
      commandId: command.id,
      sourceDirectiveId,
      pendingDirectiveId,
      ok: !outcome || outcome.ok,
      error: outcome && !outcome.ok ? outcome.error?.message ?? null : null,
      code: outcome && !outcome.ok ? outcome.error?.code ?? null : null,
    };
    if (status === "permission_denied") {
      pendingDoc.permissionDenied = true;
    } else if ("permissionDenied" in pendingDoc) {
      delete pendingDoc.permissionDenied;
    }
    if (status === "completed") {
      pendingDoc.completedAt = updatedAt;
    } else if ("completedAt" in pendingDoc) {
      delete pendingDoc.completedAt;
    }
    await writeJsonFile(pendingPath, pendingDoc).catch(() => undefined);
  }

  private async executeCommand(command: Command): Promise<ExecuteResult> {
    const kind = command.kind.trim().toLowerCase();
    if (kind === "write.createpost") {
      const outcome = await this.executeWriteCreatePost(command);
      return { processed: true, outcome };
    }
    if (kind === "write.createstory") {
      const outcome = await this.executeWriteCreateStory(command);
      return { processed: true, outcome };
    }
    if (kind === "write.updateavatar") {
      const outcome = await this.executeWriteUpdateAvatar(command);
      return { processed: true, outcome };
    }
    if (kind === "write.updatebanner") {
      const outcome = await this.executeWriteUpdateBanner(command);
      return { processed: true, outcome };
    }
    if (kind === "write.commentpost" || kind === "write.comment") {
      const outcome = await this.executeWriteComment(command);
      return { processed: true, outcome };
    }
    if (kind === "write.votepost" || kind === "write.like") {
      const outcome = await this.executeWriteVote(command);
      return { processed: true, outcome };
    }
    if (kind === "write.repostpost" || kind === "write.repost") {
      const outcome = await this.executeWriteRepost(command);
      return { processed: true, outcome };
    }
    if (kind === "brain.retrypending") {
      const outcome = await this.executeRetryPending(command);
      return { processed: true, outcome };
    }
    if (
      kind === "brain.generateandqueue" ||
      kind === "brain.plan" ||
      kind === "agent.task" ||
      kind === "agent_task"
    ) {
      const outcome = await this.executeGenerateAndQueue(command);
      return { processed: true, outcome };
    }
    if (kind === "review" || kind === "agent.review") {
      const outcome = await this.executeReview(command);
      return { processed: true, outcome };
    }

    const outcome: CommandOutcome = {
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: false,
      error: {
        message: `Unsupported command kind: ${command.kind}`,
        code: "unsupported_command_kind",
      },
    };
    await this.ctx.memory.recordWrite({
      type: "command_execution_unsupported",
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
    }).catch(() => undefined);
    return { processed: true, outcome };
  }

  private async tryResealTrustedCommandForActiveSession(input: {
    command: Command;
    sealError: SealVerifyError;
    commandSigVerified: boolean;
    filePath: string;
    inboxFile: string;
  }): Promise<Command | null> {
    const recoverableSealErrors = new Set<SealVerifyError>([
      "missing_runtime_session",
      "runtime_session_mismatch",
      "missing_runtime_origin",
      "missing_runtime_sig",
      "invalid_runtime_sig",
    ]);
    if (!recoverableSealErrors.has(input.sealError)) return null;

    const commandId = asNonEmptyString(input.command.id);
    if (!commandId) return null;
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command: input.command,
      payload: isRecord(input.command.payload) ? input.command.payload : null,
    });
    const pendingDirectiveId = asNonEmptyString(input.command.pendingDirectiveId);
    const runtimeOrigin = asNonEmptyString(input.command.runtimeOrigin)?.toLowerCase() ?? "";
    const trustedDirectiveOrigin =
      runtimeOrigin === "director_directive" || runtimeOrigin === "pending_promotion";
    const directiveLinked = sourceDirectiveId === commandId || pendingDirectiveId === commandId;

    if (!input.commandSigVerified && !(trustedDirectiveOrigin && directiveLinked)) {
      return null;
    }

    const resealed = sealRuntimeStagedCommand(
      this.ctx.commandSeal,
      {
        ...input.command,
      },
      runtimeOrigin || "runtime_resealed",
    );
    await writeJsonFile(input.filePath, resealed).catch(() => undefined);
    await this.ctx.memory
      .recordWrite({
        type: "inbox_command_resealed",
        at: nowIso(),
        inboxFile: input.inboxFile,
        commandId,
        kind: input.command.kind,
        reason: input.sealError,
        trustSource: input.commandSigVerified ? "command_sig" : "directive_origin",
        priorRuntimeSessionId: input.command.runtimeSessionId ?? null,
        priorRuntimeOrigin: input.command.runtimeOrigin ?? null,
        resealedRuntimeSessionId: resealed.runtimeSessionId,
        resealedRuntimeOrigin: resealed.runtimeOrigin,
      })
      .catch(() => undefined);
    return resealed;
  }

  private tryRehydrateRuntimeIssuedSeal(command: Command): boolean {
    const commandId = command.id.trim();
    if (!commandId.length) return false;
    if (this.ctx.commandSeal.runtimeIssuedCommandIds.has(commandId)) {
      return false;
    }
    const runtimeSessionId = asNonEmptyString(command.runtimeSessionId);
    const runtimeOrigin = asNonEmptyString(command.runtimeOrigin);
    const runtimeSig = asNonEmptyString(command.runtimeSig);
    if (!runtimeSessionId || !runtimeOrigin || !runtimeSig) {
      return false;
    }
    if (runtimeSessionId !== this.ctx.commandSeal.runtimeCommandSessionId) {
      return false;
    }
    this.ctx.commandSeal.runtimeIssuedCommandIds.add(commandId);
    return true;
  }

  private tryAllowTrustedReplay(command: Command): boolean {
    const commandId = command.id.trim();
    if (!commandId.length) return false;
    const runtimeSessionId = asNonEmptyString(command.runtimeSessionId);
    if (!runtimeSessionId) return false;
    if (runtimeSessionId !== this.ctx.commandSeal.runtimeCommandSessionId) {
      return false;
    }
    const runtimeOrigin = asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
    const trustedOrigin =
      runtimeOrigin === "director_directive" ||
      runtimeOrigin === "pending_promotion" ||
      runtimeOrigin === "runtime_resealed";
    if (!trustedOrigin) return false;
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload: isRecord(command.payload) ? command.payload : null,
    });
    const pendingDirectiveId = asNonEmptyString(command.pendingDirectiveId);
    const directiveLinked =
      sourceDirectiveId === commandId || pendingDirectiveId === commandId;
    if (!directiveLinked) return false;
    this.ctx.commandSeal.runtimeConsumedCommandIds.delete(commandId);
    return true;
  }

  private grantActionKeysFor(action: "comment" | "like" | "repost"): string[] {
    if (action === "comment") return ["comment", "write.commentPost"];
    if (action === "like") return ["like", "write.votePost"];
    return ["repost", "write.repostPost"];
  }

  private resolvePermissionWindowGrantIdForAction(
    permissionState: unknown,
    action: "comment" | "like" | "repost",
  ): string | null {
    const candidates = parseGrantCandidatesFromPermissionState(permissionState);
    if (!candidates.length) return null;
    const nowMs = Date.now();
    const actionKeys = this.grantActionKeysFor(action);
    for (const candidate of candidates) {
      if (candidate.expiresAtMs <= nowMs) continue;
      for (const key of actionKeys) {
        const actionState = candidate.actions.get(key);
        if (!actionState || actionState.remainingCount <= 0) continue;
        const notBeforeAtMs =
          typeof actionState.notBeforeAtMs === "number" &&
          Number.isFinite(actionState.notBeforeAtMs)
            ? actionState.notBeforeAtMs
            : candidate.issuedAtMs + actionState.notBeforeSeconds * 1000;
        if (notBeforeAtMs > nowMs) continue;
        const grantId = candidate.id.trim();
        if (grantId.length > 0) return grantId;
      }
    }
    return null;
  }

  private hasUsablePermissionWindowForAction(
    permissionState: unknown,
    action: "comment" | "like" | "repost",
  ): boolean {
    return (
      this.resolvePermissionWindowGrantIdForAction(permissionState, action) !==
      null
    );
  }

  private buildActionIdempotencyKey(input: {
    command: Command;
    action: "comment" | "like" | "repost";
    postId: number;
    commentId: number | null;
    commentBody?: string | null;
  }): string {
    const directiveId =
      this.resolveCommandSourceDirectiveId({
        command: input.command,
        payload: isRecord(input.command.payload) ? input.command.payload : null,
      }) ?? input.command.id;
    const targetHash = buildTargetHash({
      postId: input.postId,
      commentId: input.commentId,
    });
    const normalizedCommentBody =
      input.action === "comment" && typeof input.commentBody === "string"
        ? normalizeCommentText(input.commentBody)
        : "";
    const commentBodyHash =
      normalizedCommentBody.length > 0
        ? crypto
            .createHash("sha256")
            .update(normalizedCommentBody)
            .digest("hex")
        : null;
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          directiveId,
          actionNonce: input.command.actionNonce ?? "",
          action: input.action,
          targetHash,
          ...(input.action === "comment"
            ? {
                commentBodyHash,
              }
            : {}),
        }),
      )
      .digest("hex");
  }

  private buildPostActionIdempotencyKey(input: {
    command: Command;
    postType: "text" | "media";
    postKind: "post" | "thread";
  }): string {
    const payload = isRecord(input.command.payload) ? input.command.payload : null;
    const directiveId =
      this.resolveCommandSourceDirectiveId({
        command: input.command,
        payload,
      }) ?? input.command.id;
    const actionNonce =
      asNonEmptyString(payload?.sourceDirectiveActionNonce) ??
      input.command.actionNonce ??
      "";
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          directiveId,
          actionNonce,
          action: "post",
          postType: input.postType,
          postKind: input.postKind,
        }),
      )
      .digest("hex");
  }

  private beginActionLifecycle(input: {
    command: Command;
    action: "comment" | "like" | "repost" | "post";
    idempotencyKey: string;
    target: {
      postId: number | null;
      commentId: number | null;
      targetHash: string;
    };
    state: CommandLifecycleState;
  }): { allowed: boolean; reason: string; requeue: boolean } {
    const stateDb = this.ctx.stateDb;
    if (!stateDb?.enabled) {
      return { allowed: true, reason: "state_db_disabled", requeue: false };
    }
    const existing = stateDb.getCommandLifecycleByIdempotencyKey(
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.state === "acked") {
        return { allowed: false, reason: "already_acked", requeue: false };
      }
      const updatedAtMs = Date.parse(existing.updatedAt);
      if (
        existing.state === "requeue" &&
        Number.isFinite(updatedAtMs) &&
        Date.now() - updatedAtMs < ACTION_REQUEUE_BACKOFF_MS
      ) {
        return { allowed: false, reason: "requeue_backoff", requeue: true };
      }
      if (
        existing.state === "queued" ||
        existing.state === "context_ready" ||
        existing.state === "llm_running" ||
        existing.state === "action_running"
      ) {
        if (
          Number.isFinite(updatedAtMs) &&
          Date.now() - updatedAtMs <
            ACTION_IDEMPOTENCY_IN_FLIGHT_WINDOW_MS
        ) {
          return { allowed: false, reason: "already_in_flight", requeue: false };
        }
      }
    }
    stateDb.upsertCommandLifecycle({
      commandId: input.command.id,
      directiveId:
        this.resolveCommandSourceDirectiveId({
          command: input.command,
          payload: isRecord(input.command.payload) ? input.command.payload : null,
        }) ?? input.command.id,
      action: input.action,
      targetPostId: input.target.postId,
      targetCommentId: input.target.commentId,
      targetHash: input.target.targetHash,
      idempotencyKey: input.idempotencyKey,
      state: input.state,
      attemptDelta: 1,
      sourceKind: input.command.kind,
      grantId: input.command.grantId,
      payload: input.command.payload,
    });
    return { allowed: true, reason: existing ? "retry" : "new", requeue: false };
  }

  private updateActionLifecycle(input: {
    command: Command;
    action: "comment" | "like" | "repost" | "post";
    idempotencyKey: string;
    target: {
      postId: number | null;
      commentId: number | null;
      targetHash: string;
    };
    state: CommandLifecycleState;
    lastError?: string | null;
  }): void {
    const stateDb = this.ctx.stateDb;
    if (!stateDb?.enabled) return;
    stateDb.upsertCommandLifecycle({
      commandId: input.command.id,
      directiveId:
        this.resolveCommandSourceDirectiveId({
          command: input.command,
          payload: isRecord(input.command.payload) ? input.command.payload : null,
        }) ?? input.command.id,
      action: input.action,
      targetPostId: input.target.postId,
      targetCommentId: input.target.commentId,
      targetHash: input.target.targetHash,
      idempotencyKey: input.idempotencyKey,
      state: input.state,
      lastError: input.lastError ?? null,
      sourceKind: input.command.kind,
      grantId: input.command.grantId,
      payload: input.command.payload,
    });
  }

  private async executeCreatePostMutationWithIdempotency(input: {
    command: Command;
    postType: "text" | "media";
    postKind: "post" | "thread";
    mutationInput: Record<string, unknown>;
  }): Promise<
    | {
        skipped: false;
        result: unknown;
      }
    | {
        skipped: true;
        reason: string;
      }
  > {
    const idempotencyKey = this.buildPostActionIdempotencyKey({
      command: input.command,
      postType: input.postType,
      postKind: input.postKind,
    });
    const target = {
      postId: null,
      commentId: null,
      targetHash: crypto
        .createHash("sha256")
        .update(idempotencyKey)
        .digest("hex"),
    };
    const dedupe = this.beginActionLifecycle({
      command: input.command,
      action: "post",
      idempotencyKey,
      target,
      state: "action_running",
    });
    if (!dedupe.allowed) {
      if (dedupe.requeue) {
        throw new RequeueCommandError(`post_waiting_for_backoff:${dedupe.reason}`);
      }
      return {
        skipped: true,
        reason: dedupe.reason,
      };
    }

    try {
      const result = await this.agent().createPost.mutate(input.mutationInput);
      this.updateActionLifecycle({
        command: input.command,
        action: "post",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return {
        skipped: false,
        result,
      };
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        this.updateActionLifecycle({
          command: input.command,
          action: "post",
          idempotencyKey,
          target,
          state: "requeue",
          lastError: error.message,
        });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.updateActionLifecycle({
        command: input.command,
        action: "post",
        idempotencyKey,
        target,
        state: "failed",
        lastError: message,
      });
      throw error;
    }
  }

  private ownerCapabilityCooldownKey(input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
  }): string {
    return `${input.action}:${input.targetHash}`;
  }

  private registerOwnerCapabilityCooldown(input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
    reason: string;
  }): void {
    const key = this.ownerCapabilityCooldownKey(input);
    this.ownerCapabilityDeniedByTarget.set(key, {
      untilMs: Date.now() + OWNER_CAPABILITY_COOLDOWN_MS,
      reason: input.reason,
    });
  }

  private resolveOwnerCapabilityCooldown(input: {
    action: "comment" | "like" | "repost";
    targetHash: string;
  }): OwnerCapabilityCooldown | null {
    const key = this.ownerCapabilityCooldownKey(input);
    const entry = this.ownerCapabilityDeniedByTarget.get(key);
    if (!entry) return null;
    if (!Number.isFinite(entry.untilMs) || entry.untilMs <= Date.now()) {
      this.ownerCapabilityDeniedByTarget.delete(key);
      return null;
    }
    return entry;
  }

  private isOwnerCapabilityDeniedError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /owner capability denied/iu.test(error.message);
  }

  private isNoTargetDiscoveryFailure(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /engagement_target_unavailable:no_targets_discovered/iu.test(
      error.message,
    );
  }

  private listRecentCommentTargetUsage(): RecentCommentTargetUsage[] {
    const stateDb = this.ctx.stateDb;
    if (!stateDb?.enabled) return [];
    const rows = stateDb.getRecentCommandLifecycle(COMMENT_TARGET_HISTORY_LIMIT);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const nowMs = Date.now();
    const cutoffMs = nowMs - COMMENT_TARGET_REUSE_WINDOW_MS;
    const recent: RecentCommentTargetUsage[] = [];
    for (const row of rows) {
      const action = asNonEmptyString(row.action)?.toLowerCase() ?? "";
      if (action !== "comment") continue;
      const state = row.state;
      if (!COMMENT_RECENCY_TRACKED_STATES.has(state)) continue;
      const postId =
        typeof row.targetPostId === "number" && Number.isFinite(row.targetPostId)
          ? Math.floor(row.targetPostId)
          : null;
      if (!postId || postId <= 0) continue;
      const updatedAtMs = Date.parse(row.updatedAt);
      if (!Number.isFinite(updatedAtMs) || updatedAtMs < cutoffMs) continue;
      const commentId =
        typeof row.targetCommentId === "number" && Number.isFinite(row.targetCommentId)
          ? Math.floor(row.targetCommentId)
          : null;
      let postSnapshotHash: string | null = null;
      if (typeof row.payloadJson === "string" && row.payloadJson.trim().length > 0) {
        try {
          const parsed = JSON.parse(row.payloadJson) as unknown;
          if (isRecord(parsed)) {
            postSnapshotHash =
              asNonEmptyString(parsed.targetPostSnapshotHash) ??
              asNonEmptyString(parsed.postSnapshotHash) ??
              null;
          }
        } catch {
          // best effort parse only
        }
      }
      recent.push({
        commandId: row.commandId,
        postId,
        commentId,
        state,
        updatedAtMs,
        postSnapshotHash,
      });
    }
    return recent;
  }

  private isReplySignalCommentSource(source: string): boolean {
    const normalized = source.trim().toLowerCase();
    if (!normalized.length) return false;
    return (
      normalized.includes("comment_thread") ||
      normalized.includes("unanswered_mention") ||
      normalized.includes("notifications_unread")
    );
  }

  private decideCommentTargetReuse(input: {
    commandId: string;
    postId: number;
    commentId: number | null;
    postSnapshotHash: string | null;
    source: string;
    recentUsage?: RecentCommentTargetUsage[];
  }): CommentTargetReuseDecision {
    const recentUsage = input.recentUsage ?? this.listRecentCommentTargetUsage();
    if (recentUsage.length === 0) {
      return {
        allow: true,
        reason: "no_recent_comment_targets",
        recentMatch: null,
      };
    }
    const samePostRows = recentUsage.filter(
      (entry) =>
        entry.postId === input.postId && entry.commandId !== input.commandId,
    );
    if (samePostRows.length === 0) {
      return {
        allow: true,
        reason: "post_not_recently_commented",
        recentMatch: null,
      };
    }
    const latestSamePost = samePostRows[0] ?? null;
    const snapshotChanged =
      Boolean(input.postSnapshotHash) &&
      Boolean(latestSamePost) &&
      Boolean(latestSamePost?.postSnapshotHash) &&
      latestSamePost?.postSnapshotHash !== input.postSnapshotHash;
    if (typeof input.commentId === "number" && input.commentId > 0) {
      const sameParent = samePostRows.find(
        (entry) => entry.commentId === input.commentId,
      );
      if (sameParent) {
        return {
          allow: false,
          reason: "comment_parent_already_replied_recently",
          recentMatch: sameParent,
        };
      }
      if (snapshotChanged) {
        return {
          allow: true,
          reason: "post_snapshot_changed",
          recentMatch: latestSamePost,
        };
      }
      if (!this.isReplySignalCommentSource(input.source)) {
        return {
          allow: false,
          reason: "post_recently_commented_without_reply_signal",
          recentMatch: samePostRows[0] ?? null,
        };
      }
      return {
        allow: true,
        reason: "new_parent_comment_target_from_reply_signal",
        recentMatch: null,
      };
    }
    if (snapshotChanged) {
      return {
        allow: true,
        reason: "post_snapshot_changed",
        recentMatch: latestSamePost,
      };
    }
    if (input.source.startsWith("own_latest")) {
      return {
        allow: true,
        reason: "own_latest_needs_thread_hydration",
        recentMatch: null,
      };
    }
    return {
      allow: false,
      reason: "post_recently_commented",
      recentMatch: samePostRows[0] ?? null,
    };
  }

  private isRecoverableDraftGrantErrorMessage(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    if (!normalized.length) return false;
    return (
      normalized.includes("owner capability denied: no_grant") ||
      normalized.includes("owner capability denied: missing_grant_id_with_active_window") ||
      normalized.includes("permission denied for requested write") ||
      normalized.includes("forbidden:no_grant") ||
      normalized.includes("forbidden:exhausted") ||
      normalized.includes("forbidden:not_ready")
    );
  }

  private isRecoverableDraftExecutionError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (error instanceof RequeueCommandError) return false;
    return this.isRecoverableDraftGrantErrorMessage(error.message);
  }

  private isRecoverableDraftSkipDecision(decision: string | null): boolean {
    if (!decision) return false;
    return this.isRecoverableDraftGrantErrorMessage(decision);
  }

  private async preflightGrantForAction(input: {
    command: Command;
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    lifecycle: {
      idempotencyKey: string;
        target: {
          postId: number;
          commentId: number | null;
          targetHash: string;
        };
      };
  }): Promise<string | null> {
    const directiveId =
      this.resolveCommandSourceDirectiveId({
        command: input.command,
        payload: input.payload,
      }) ?? input.command.id;
    const ownerCooldown = this.resolveOwnerCapabilityCooldown({
      action: input.action,
      targetHash: input.lifecycle.target.targetHash,
    });
    if (ownerCooldown) {
      const retryInMs = Math.max(0, ownerCooldown.untilMs - Date.now());
      const message = `Owner capability denied: ${ownerCooldown.reason}. retry_in_ms=${retryInMs}`;
      this.updateActionLifecycle({
        command: input.command,
        action: input.action,
        idempotencyKey: input.lifecycle.idempotencyKey,
        target: input.lifecycle.target,
        state: "failed",
        lastError: message,
      });
      throw new Error(message);
    }

    const grantId =
      asNonEmptyString(input.command.grantId) ??
      asNonEmptyString(input.payload.grantId);
    if (grantId) return grantId;

    const inferredGrantId = this.resolvePermissionWindowGrantIdForAction(
      input.payload.permissionState,
      input.action,
    );
    if (inferredGrantId) {
      await this.ctx.memory
        .recordWrite({
          type: "directive_preflight_grant_inferred",
          at: nowIso(),
          commandId: input.command.id,
          directiveId,
          action: input.action,
          grantId: inferredGrantId,
        })
        .catch(() => undefined);
      return inferredGrantId;
    }

    if (this.isDirectiveContextLinkedCommand(input.command)) {
      await this.ctx.memory
        .recordWrite({
          type: "directive_preflight_grant_bypassed",
          at: nowIso(),
          commandId: input.command.id,
          directiveId,
          action: input.action,
          reason: "directive_context",
        })
        .catch(() => undefined);
      return null;
    }

    const hasUsableWindow = this.hasUsablePermissionWindowForAction(
      input.payload.permissionState,
      input.action,
    );
    const reason = hasUsableWindow
      ? "missing_grant_id_with_active_window"
      : "no_grant";
    const errorMessage = `Owner capability denied: ${reason}.`;
    this.updateActionLifecycle({
      command: input.command,
      action: input.action,
      idempotencyKey: input.lifecycle.idempotencyKey,
      target: input.lifecycle.target,
      state: "failed",
      lastError: errorMessage,
    });
    await this.ctx.memory
      .recordWrite({
        type: "directive_preflight_grant_failed",
        at: nowIso(),
        commandId: input.command.id,
        directiveId,
        action: input.action,
        reason,
        hasUsableWindow,
      })
      .catch(() => undefined);
    throw new Error(errorMessage);
  }

  private isDirectiveContextLinkedCommand(command: Command): boolean {
    if (
      this.resolveCommandSourceDirectiveId({
        command,
        payload: isRecord(command.payload) ? command.payload : null,
      })
    ) {
      return true;
    }
    if (asNonEmptyString(command.pendingDirectiveId)) return true;
    const runtimeOrigin =
      asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
    return (
      runtimeOrigin === "director_directive" ||
      runtimeOrigin === "pending_promotion" ||
      runtimeOrigin === "runtime_resealed"
    );
  }

  private extractActionContractFromUnknown(input: {
    value: unknown;
    action: "comment" | "like" | "repost";
    expectedPostId: number;
    expectedCommentId: number | null;
    expectedTargetHash: string;
  }): ActionContract | null {
    const parseFromRecord = (record: Record<string, unknown>): ActionContract | null => {
      const action = asNonEmptyString(record.action)?.toLowerCase() ?? input.action;
      if (action !== input.action) return null;
      if (typeof record.shouldExecute !== "boolean") return null;
      const target = isRecord(record.target) ? record.target : null;
      if (!target) return null;
      const postId = asPositiveInt(target.postId);
      if (postId !== input.expectedPostId) return null;
      const commentId =
        target.commentId === null ? null : asPositiveInt(target.commentId);
      if (commentId !== (input.expectedCommentId ?? null)) return null;
      const targetHashCandidate = asNonEmptyString(target.targetHash);
      if (
        targetHashCandidate !== null &&
        targetHashCandidate !== input.expectedTargetHash
      ) {
        return null;
      }
      const targetHash = targetHashCandidate ?? input.expectedTargetHash;
      const targetLockMatch = isTargetLockMatch({
        payload: {
          targetPostId: postId,
          targetCommentId: commentId,
          targetHash,
        },
        expected: {
          postId: input.expectedPostId,
          commentId: input.expectedCommentId,
          targetHash: input.expectedTargetHash,
        },
      });
      if (!targetLockMatch.ok) return null;
      const reason = truncateText(asNonEmptyString(record.reason) ?? "no_reason", 120);
      const body = asNonEmptyString(record.body);
      if (input.action === "comment" && !body) return null;
      return {
        action: input.action,
        target: {
          postId,
          commentId,
          targetHash,
        },
        body: body ?? null,
        reason,
        shouldExecute: record.shouldExecute,
      };
    };

    if (typeof input.value === "string") {
      const trimmed = input.value.trim();
      if (!trimmed.length) return null;
      const parsed = parseJsonFromMixedText(trimmed);
      if (parsed === null || parsed === input.value) return null;
      return this.extractActionContractFromUnknown({
        ...input,
        value: parsed,
      });
    }
    if (Array.isArray(input.value)) {
      for (const entry of input.value) {
        const parsed = this.extractActionContractFromUnknown({
          ...input,
          value: entry,
        });
        if (parsed) return parsed;
      }
      return null;
    }
    if (!isRecord(input.value)) return null;
    const direct = parseFromRecord(input.value);
    if (direct) return direct;
    for (const key of ["contract", "result", "output", "payload", "data", "content"] as const) {
      const nested = this.extractActionContractFromUnknown({
        ...input,
        value: input.value[key],
      });
      if (nested) return nested;
    }
    return null;
  }

  private async executeWriteCreatePost(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.createPost.");
    }
    const postTypeRaw = asNonEmptyString(payload.postType)?.toLowerCase();
    const postType = postTypeRaw === "text" ? "text" : "media";
    const kindRaw = asNonEmptyString(payload.kind)?.toLowerCase();
    const postKind = kindRaw === "thread" ? "thread" : "post";
    if (
      this.isChatOriginCommand(command, payload) &&
      !this.isChatWriteRequesterOwner(payload)
    ) {
      return this.failedOutcome(
        command,
        "Chat write actions are owner-only unless explicitly granted.",
        "chat_write_owner_only",
      );
    }
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const explicitSaveAsProfileMemory =
      typeof payload.saveAsProfileMemory === "boolean"
        ? payload.saveAsProfileMemory
        : null;
    const runtimeOrigin = asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
    const isDirectiveRuntimeOrigin =
      runtimeOrigin === "director_directive" || runtimeOrigin === "pending_promotion";
    let saveAsProfileMemoryForMedia = explicitSaveAsProfileMemory === true;
    const buildBase = (
      caption: string | null,
      basePostType: "text" | "media" = postType,
    ): Record<string, unknown> => ({
      kind: postKind,
      postType: basePostType,
      ...(caption ? { caption } : {}),
      ...(basePostType === "media" && saveAsProfileMemoryForMedia
        ? { saveAsProfileMemory: true }
        : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      ...(command.grantId ? { grantId: command.grantId } : {}),
    });
    const skippedPostOutcome = (reason: string): CommandOutcome =>
      this.successOutcome(command, {
        skipped: true,
        action: "post",
        postType,
        postKind,
        decision: reason,
      });

    const targetPostId = this.extractTargetPostIdForPostDraft(payload);
    const postDraftContext = await this.loadPostDraftContext({
      postId: targetPostId,
      payload,
    });
    const requiresCuration = sourceDirectiveId !== null ? true : isDirectiveRuntimeOrigin;
    const directiveSinglePromptMode = requiresCuration;
    const directiveSeedHints = this.collectDirectiveSeedHints(payload);
    const postVariety = this.selectPostVarietyMode({
      commandId: command.id,
      postType,
      payload,
      context: postDraftContext,
      seedHints: directiveSeedHints,
    });
    await this.ctx.memory
      .recordWrite({
        type: "post_variety_mode_selected",
        at: nowIso(),
        commandId: command.id,
        postType,
        mode: postVariety.mode,
        reason: postVariety.reason,
        recentModes: postVariety.recentModes,
        targetPostId: postDraftContext.targetPostId,
      })
      .catch(() => undefined);

    if (postType === "text") {
      const textBodyInitial = asNonEmptyString(payload.textBody);
      if (!textBodyInitial) {
        return this.failedOutcome(command, "textBody is required for text posts.");
      }
      const captionInitial = asNonEmptyString(payload.caption);
      const noveltyAvoidReferences = this.snapshotRecentPostNoveltyReferences("text");
      const curatedTextDraft = await this.curatePostDraftWithOpenClaw({
        commandId: command.id,
        postType: "text",
        varietyMode: postVariety.mode,
        caption: captionInitial,
        textBody: textBodyInitial,
        mediaPrompt: null,
        context: postDraftContext,
        seedHints: directiveSeedHints,
        avoidReferences: noveltyAvoidReferences,
      });
      if (requiresCuration && !curatedTextDraft) {
        throw new RequeueCommandError(
          "post_curation_waiting_for_openclaw:text_curation_unavailable",
        );
      }
      let captionForWrite = curatedTextDraft?.caption ?? captionInitial;
      let textBodyForWrite = curatedTextDraft?.textBody ?? textBodyInitial;
      captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
      textBodyForWrite = stripEmDashCharacters(textBodyForWrite);
      if (!textBodyForWrite) {
        return this.failedOutcome(command, "textBody is required for text posts.");
      }
      let noveltyValidation = this.validatePostDraftNovelty({
        postType: "text",
        caption: captionForWrite,
        textBody: textBodyForWrite,
        mediaPrompt: null,
        context: postDraftContext,
        seedHints: directiveSeedHints,
      });
      if (!noveltyValidation.ok) {
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_rejected",
            at: nowIso(),
            commandId: command.id,
            postType: "text",
            reason: noveltyValidation.reason,
            candidatePreview: truncateText(noveltyValidation.candidateText, 240),
            referencePreview: noveltyValidation.referencePreview,
          })
          .catch(() => undefined);
        if (directiveSinglePromptMode) {
          await this.ctx.memory
            .recordWrite({
              type: "post_novelty_recuration_skipped",
              at: nowIso(),
              commandId: command.id,
              postType: "text",
              reason: noveltyValidation.reason,
              policy: "single_prompt_per_directive",
            })
            .catch(() => undefined);
          noveltyValidation = {
            ok: true,
            candidateText: this.buildPostNoveltyCandidateText({
              postType: "text",
              caption: captionForWrite,
              textBody: textBodyForWrite,
              mediaPrompt: null,
            }),
          };
        } else {
          const recurationReferences = Array.from(
            new Set<string>(
              [
                ...noveltyAvoidReferences,
                noveltyValidation.referencePreview ?? "",
                truncateText(noveltyValidation.candidateText, 260),
              ]
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
            ),
          );
          const recuratedTextDraft = await this.curatePostDraftWithOpenClaw({
            commandId: command.id,
            postType: "text",
            varietyMode: postVariety.mode,
            caption: captionForWrite,
            textBody: textBodyForWrite,
            mediaPrompt: null,
            context: postDraftContext,
            seedHints: directiveSeedHints,
            avoidReferences: recurationReferences,
          });
          if (!recuratedTextDraft) {
            if (requiresCuration) {
              throw new RequeueCommandError(
                "post_curation_waiting_for_openclaw:text_novelty_recuration_unavailable",
              );
            }
            return this.failedOutcome(
              command,
              `Blocked text post draft due to low novelty (${noveltyValidation.reason}).`,
              "post_novelty_rejected",
            );
          }
          captionForWrite = recuratedTextDraft.caption ?? captionForWrite;
          textBodyForWrite = recuratedTextDraft.textBody ?? textBodyForWrite;
          captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
          textBodyForWrite = stripEmDashCharacters(textBodyForWrite);
          noveltyValidation = this.validatePostDraftNovelty({
            postType: "text",
            caption: captionForWrite,
            textBody: textBodyForWrite,
            mediaPrompt: null,
            context: postDraftContext,
            seedHints: directiveSeedHints,
          });
          if (!noveltyValidation.ok) {
            await this.ctx.memory
              .recordWrite({
                type: "post_novelty_blocked",
                at: nowIso(),
                commandId: command.id,
                postType: "text",
                reason: noveltyValidation.reason,
                candidatePreview: truncateText(noveltyValidation.candidateText, 240),
                referencePreview: noveltyValidation.referencePreview,
              })
              .catch(() => undefined);
            return this.failedOutcome(
              command,
              `Blocked text post draft due to low novelty (${noveltyValidation.reason}).`,
              "post_novelty_blocked",
            );
          }
          await this.ctx.memory
            .recordWrite({
              type: "post_novelty_recurated",
              at: nowIso(),
              commandId: command.id,
              postType: "text",
            })
            .catch(() => undefined);
        }
      }
      const candidate = noveltyValidation.candidateText;
      const autonomousTheme = this.resolveAutonomousTextTheme({
        commandId: command.id,
        postKind,
        caption: captionForWrite,
        textBody: textBodyForWrite,
      });
      const autonomousCaptionPosition = this.resolveAutonomousCaptionPosition({
        commandId: command.id,
        postKind,
        seedText: `${captionForWrite ?? ""} ${textBodyForWrite}`,
      });
      const autonomousAlign = autonomousCaptionPosition.split("-")[1] ?? "center";
      const emphasisOptions =
        postKind === "thread"
          ? (["display", "bold", "mono", "serif"] as const)
          : (["soft", "bold", "serif", "mono"] as const);
      const fontOptions =
        postKind === "thread"
          ? (["display", "sans", "mono", "serif"] as const)
          : (["sans", "serif", "mono", "display"] as const);
      const sizeOptions =
        postKind === "thread"
          ? (["xl", "2xl", "lg"] as const)
          : (["lg", "xl", "md"] as const);
      const autonomousStyleFallback: Record<string, unknown> = {
        theme: autonomousTheme,
        align:
          autonomousAlign === "left" ||
          autonomousAlign === "center" ||
          autonomousAlign === "right"
            ? autonomousAlign
            : "center",
        emphasis:
          emphasisOptions[
            this.pickDeterministicIndex(
              `${command.id}:${candidate}:text_emphasis`,
              emphasisOptions.length,
            )
          ] ?? "soft",
        font:
          fontOptions[
            this.pickDeterministicIndex(
              `${command.id}:${candidate}:text_font`,
              fontOptions.length,
            )
          ] ?? "sans",
        weight:
          this.pickDeterministicIndex(`${command.id}:${candidate}:text_weight`, 100) < 52
            ? "bold"
            : "regular",
        size:
          sizeOptions[
            this.pickDeterministicIndex(
              `${command.id}:${candidate}:text_size`,
              sizeOptions.length,
            )
          ] ?? "lg",
        italic:
          this.pickDeterministicIndex(`${command.id}:${candidate}:text_italic`, 100) < 24,
        color: TEXT_STYLE_DEFAULT_COLOR_BY_THEME[autonomousTheme],
        position: autonomousCaptionPosition,
        background: this.resolveAutonomousGradientBackground(
          autonomousTheme,
          `${command.id}:${candidate}:text_background`,
        ),
      };
      const visualPlan = await this.planTextPostVisualWithOpenClaw({
        commandId: command.id,
        postKind,
        caption: captionForWrite,
        textBody: textBodyForWrite,
        context: postDraftContext,
      });
      const captionPositionForWrite =
        this.normalizeCaptionPositionValue(payload.captionPosition) ??
        visualPlan?.captionPosition ??
        autonomousCaptionPosition;
      const normalizedTextStyle = this.normalizeAgentTextStyle(
        this.sanitizeTextStyleValue(payload.textStyle) ?? visualPlan?.textStyle ?? null,
        captionPositionForWrite,
        autonomousStyleFallback,
      );
      const plannerSlides = visualPlan?.slides.slice(0, 4) ?? [];
      const autonomousSlides = this.buildAutonomousThreadSlides({
        commandId: command.id,
        caption: captionForWrite,
        textBody: textBodyForWrite,
        theme: autonomousTheme,
        postKind,
      });
      const selectedSlides =
        plannerSlides.length >= 2 ? plannerSlides : autonomousSlides;
      const shouldAttemptSlides =
        selectedSlides.length >= 2 &&
        (visualPlan?.renderMode === "slides" || postKind === "thread");
      const visualBackgroundPromptRaw =
        visualPlan?.backgroundImagePrompt ??
        this.buildAutonomousTextBackgroundPrompt({
          commandId: command.id,
          caption: captionForWrite,
          textBody: textBodyForWrite,
          theme: autonomousTheme,
          postKind,
        });
      const visualBackgroundPrompt = visualBackgroundPromptRaw
        ? stripEmDashCharacters(visualBackgroundPromptRaw).trim()
        : "";
      const shouldAttemptImageBackground =
        !shouldAttemptSlides && visualBackgroundPrompt.length >= 8;
      if (shouldAttemptSlides) {
        const slideItems: Array<Record<string, unknown>> = [];
        const slidePrompts = selectedSlides.slice(0, 4);
        for (const slide of slidePrompts) {
          const slidePrompt = stripEmDashCharacters(slide.imagePrompt).trim();
          if (slidePrompt.length < 8) continue;
          const slideMedia = await this.resolveMediaUpload({
            payload: {
              ...payload,
              generatedAssetType: "image",
            },
            keepOriginal: true,
            promptFallbacks: [slidePrompt],
            command,
            skipPromptCuration: true,
          });
          slideItems.push({
            mediaUrl: slideMedia.mediaUrl,
            ...(slideMedia.mediaOriginalUrl
              ? { mediaOriginalUrl: slideMedia.mediaOriginalUrl }
              : {}),
            ...(slideMedia.mediaOptimizedUrl
              ? { mediaOptimizedUrl: slideMedia.mediaOptimizedUrl }
              : {}),
            ...(slideMedia.mediaContentHash
              ? { mediaContentHash: slideMedia.mediaContentHash }
              : {}),
            ...(slideMedia.mediaIpfsCid
              ? { mediaIpfsCid: slideMedia.mediaIpfsCid }
              : {}),
            ...(typeof slideMedia.mediaSizeBytes === "number"
              ? { mediaSizeBytes: slideMedia.mediaSizeBytes }
              : {}),
            ...(slideMedia.mediaType ? { mediaType: slideMedia.mediaType } : {}),
            ...(slide.caption ? { caption: slide.caption } : {}),
            ...(captionPositionForWrite
              ? { captionPosition: captionPositionForWrite }
              : {}),
          });
        }
        if (slideItems.length >= 2) {
          const firstSlide = slideItems[0] ?? {};
          const firstSlideMediaUrl = asNonEmptyString(firstSlide.mediaUrl);
          if (firstSlideMediaUrl) {
            const slideMutation = await this.executeCreatePostMutationWithIdempotency({
              command,
              postType: "media",
              postKind,
              mutationInput: {
                ...buildBase(captionForWrite, "media"),
                mediaUrl: firstSlideMediaUrl,
                ...(asNonEmptyString(firstSlide.mediaOriginalUrl)
                  ? { mediaOriginalUrl: asNonEmptyString(firstSlide.mediaOriginalUrl) }
                  : {}),
                ...(asNonEmptyString(firstSlide.mediaOptimizedUrl)
                  ? { mediaOptimizedUrl: asNonEmptyString(firstSlide.mediaOptimizedUrl) }
                  : {}),
                ...(asNonEmptyString(firstSlide.mediaContentHash)
                  ? { mediaContentHash: asNonEmptyString(firstSlide.mediaContentHash) }
                  : {}),
                ...(asNonEmptyString(firstSlide.mediaIpfsCid)
                  ? { mediaIpfsCid: asNonEmptyString(firstSlide.mediaIpfsCid) }
                  : {}),
                ...(typeof firstSlide.mediaSizeBytes === "number" &&
                Number.isFinite(firstSlide.mediaSizeBytes)
                  ? {
                      mediaSizeBytes: Math.max(
                        1,
                        Math.floor(firstSlide.mediaSizeBytes),
                      ),
                    }
                  : {}),
                ...(asNonEmptyString(firstSlide.mediaType)
                  ? { mediaType: asNonEmptyString(firstSlide.mediaType) }
                  : {}),
                mediaItems: slideItems,
                ...(captionPositionForWrite
                  ? { captionPosition: captionPositionForWrite }
                  : {}),
              },
            });
            if (slideMutation.skipped) {
              return skippedPostOutcome(slideMutation.reason);
            }
            const slideResult = slideMutation.result;
            this.notePublishedPostForNoveltyHistory({
              postType: "media",
              caption: captionForWrite,
              textBody: null,
              mediaPrompt: slidePrompts
                .map((entry) => entry.imagePrompt)
                .join(" | "),
              commandId: command.id,
              targetPostId: postDraftContext.targetPostId,
            });
            this.notePublishedPostVarietyMode({
              commandId: command.id,
              postType: "media",
              targetPostId: postDraftContext.targetPostId,
              mode: postVariety.mode,
              signal: postVariety.signal,
            });
            await this.ctx.memory
              .recordWrite({
                type: "runtime_post_publish_recorded",
                at: nowIso(),
                commandId: command.id,
                kind: postKind,
                postType: "media",
                varietyMode: postVariety.mode,
                targetPostId: postDraftContext.targetPostId,
                bodyPreview: truncateText(candidate, 260),
                visualRenderMode:
                  plannerSlides.length >= 2 ? "slides" : "autonomous_slides",
                slideCount: slideItems.length,
                textStyleTheme: autonomousTheme,
              })
              .catch(() => undefined);
            return this.successOutcome(command, slideResult);
          }
        }
        await this.ctx.memory
          .recordWrite({
            type: "text_post_slides_fallback",
            at: nowIso(),
            commandId: command.id,
            slideCountRequested: slidePrompts.length,
            slideCountResolved: slideItems.length,
          })
          .catch(() => undefined);
      }
      if (shouldAttemptImageBackground) {
        try {
          const backgroundMedia = await this.resolveMediaUpload({
            payload: {
              ...payload,
              generatedAssetType: "image",
            },
            keepOriginal: true,
            promptFallbacks: [visualBackgroundPrompt],
            command,
            skipPromptCuration: true,
          });
          const imageTextItem: Record<string, unknown> = {
            mediaUrl: backgroundMedia.mediaUrl,
            ...(backgroundMedia.mediaOriginalUrl
              ? { mediaOriginalUrl: backgroundMedia.mediaOriginalUrl }
              : {}),
            ...(backgroundMedia.mediaOptimizedUrl
              ? { mediaOptimizedUrl: backgroundMedia.mediaOptimizedUrl }
              : {}),
            ...(backgroundMedia.mediaContentHash
              ? { mediaContentHash: backgroundMedia.mediaContentHash }
              : {}),
            ...(backgroundMedia.mediaIpfsCid
              ? { mediaIpfsCid: backgroundMedia.mediaIpfsCid }
              : {}),
            ...(typeof backgroundMedia.mediaSizeBytes === "number"
              ? { mediaSizeBytes: backgroundMedia.mediaSizeBytes }
              : {}),
            ...(backgroundMedia.mediaType
              ? { mediaType: backgroundMedia.mediaType }
              : {}),
            caption: textBodyForWrite,
            ...(captionPositionForWrite
              ? { captionPosition: captionPositionForWrite }
              : {}),
          };
          const imageTextMutation = await this.executeCreatePostMutationWithIdempotency({
            command,
            postType: "media",
            postKind,
            mutationInput: {
              ...buildBase(captionForWrite, "media"),
              mediaUrl: backgroundMedia.mediaUrl,
              ...(backgroundMedia.mediaOriginalUrl
                ? { mediaOriginalUrl: backgroundMedia.mediaOriginalUrl }
                : {}),
              ...(backgroundMedia.mediaOptimizedUrl
                ? { mediaOptimizedUrl: backgroundMedia.mediaOptimizedUrl }
                : {}),
              ...(backgroundMedia.mediaContentHash
                ? { mediaContentHash: backgroundMedia.mediaContentHash }
                : {}),
              ...(backgroundMedia.mediaIpfsCid
                ? { mediaIpfsCid: backgroundMedia.mediaIpfsCid }
                : {}),
              ...(typeof backgroundMedia.mediaSizeBytes === "number" &&
              Number.isFinite(backgroundMedia.mediaSizeBytes)
                ? {
                    mediaSizeBytes: Math.max(
                      1,
                      Math.floor(backgroundMedia.mediaSizeBytes),
                    ),
                  }
                : {}),
              ...(backgroundMedia.mediaType
                ? { mediaType: backgroundMedia.mediaType }
                : {}),
              mediaItems: [imageTextItem],
              ...(captionPositionForWrite
                ? { captionPosition: captionPositionForWrite }
                : {}),
            },
          });
          if (imageTextMutation.skipped) {
            return skippedPostOutcome(imageTextMutation.reason);
          }
          const imageTextResult = imageTextMutation.result;
          this.notePublishedPostForNoveltyHistory({
            postType: "media",
            caption: captionForWrite,
            textBody: null,
            mediaPrompt: visualBackgroundPrompt,
            commandId: command.id,
            targetPostId: postDraftContext.targetPostId,
          });
          this.notePublishedPostVarietyMode({
            commandId: command.id,
            postType: "media",
            targetPostId: postDraftContext.targetPostId,
            mode: postVariety.mode,
            signal: postVariety.signal,
          });
          await this.ctx.memory
            .recordWrite({
              type: "runtime_post_publish_recorded",
              at: nowIso(),
              commandId: command.id,
              kind: postKind,
              postType: "media",
              varietyMode: postVariety.mode,
              targetPostId: postDraftContext.targetPostId,
              bodyPreview: truncateText(candidate, 260),
              visualRenderMode:
                visualPlan?.backgroundImagePrompt !== null &&
                visualPlan?.backgroundImagePrompt !== undefined
                  ? "image_text"
                  : "autonomous_image_text",
              textStyleTheme: autonomousTheme,
            })
            .catch(() => undefined);
          return this.successOutcome(command, imageTextResult);
        } catch (error: unknown) {
          await this.ctx.memory
            .recordWrite({
              type: "text_post_visual_background_failed",
              at: nowIso(),
              commandId: command.id,
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
      }

      const textMutation = await this.executeCreatePostMutationWithIdempotency({
        command,
        postType: "text",
        postKind,
        mutationInput: {
          ...buildBase(captionForWrite, "text"),
          textBody: textBodyForWrite,
          textStyle: normalizedTextStyle,
          ...(captionPositionForWrite ? { captionPosition: captionPositionForWrite } : {}),
        },
      });
      if (textMutation.skipped) {
        return skippedPostOutcome(textMutation.reason);
      }
      const result = textMutation.result;
      this.notePublishedPostForNoveltyHistory({
        postType: "text",
        caption: captionForWrite,
        textBody: textBodyForWrite,
        mediaPrompt: null,
        commandId: command.id,
        targetPostId: postDraftContext.targetPostId,
      });
      this.notePublishedPostVarietyMode({
        commandId: command.id,
        postType: "text",
        targetPostId: postDraftContext.targetPostId,
        mode: postVariety.mode,
        signal: postVariety.signal,
      });
      await this.ctx.memory
        .recordWrite({
          type: "runtime_post_publish_recorded",
          at: nowIso(),
          commandId: command.id,
          kind: postKind,
          postType,
          varietyMode: postVariety.mode,
          targetPostId: postDraftContext.targetPostId,
          bodyPreview: truncateText(candidate, 260),
          visualRenderMode: shouldAttemptSlides
            ? shouldAttemptImageBackground
              ? "text_after_slides_and_image_fallback"
              : "text_after_slides_fallback"
            : shouldAttemptImageBackground
              ? "text_after_image_background_fallback"
              : "text",
          textStyleTheme: asNonEmptyString(normalizedTextStyle.theme),
          captionPosition: captionPositionForWrite,
        })
        .catch(() => undefined);
      return this.successOutcome(command, result);
    }

    const captionInitial = asNonEmptyString(payload.caption);
    const mediaPromptInitial =
      asNonEmptyString(payload.mediaPrompt) ??
      asNonEmptyString(payload.imagePrompt) ??
      asNonEmptyString(payload.prompt);
    const noveltyAvoidReferences = this.snapshotRecentPostNoveltyReferences("media");
    const curatedMediaDraft = await this.curatePostDraftWithOpenClaw({
      commandId: command.id,
      postType: "media",
      varietyMode: postVariety.mode,
      caption: captionInitial,
      textBody: null,
      mediaPrompt: mediaPromptInitial,
      context: postDraftContext,
      seedHints: directiveSeedHints,
      avoidReferences: noveltyAvoidReferences,
    });
    if (requiresCuration && !curatedMediaDraft) {
      throw new RequeueCommandError(
        "post_curation_waiting_for_openclaw:media_curation_unavailable",
      );
    }
    let captionForWrite = curatedMediaDraft?.caption ?? captionInitial;
    let mediaPromptForWrite = curatedMediaDraft?.mediaPrompt ?? mediaPromptInitial;
    captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
    mediaPromptForWrite = mediaPromptForWrite
      ? stripEmDashCharacters(mediaPromptForWrite)
      : mediaPromptForWrite;
    let noveltyValidation = this.validatePostDraftNovelty({
      postType: "media",
      caption: captionForWrite,
      textBody: null,
      mediaPrompt: mediaPromptForWrite,
      context: postDraftContext,
      seedHints: directiveSeedHints,
    });
    if (!noveltyValidation.ok) {
      await this.ctx.memory
        .recordWrite({
          type: "post_novelty_rejected",
          at: nowIso(),
          commandId: command.id,
          postType: "media",
          reason: noveltyValidation.reason,
          candidatePreview: truncateText(noveltyValidation.candidateText, 240),
          referencePreview: noveltyValidation.referencePreview,
        })
        .catch(() => undefined);
      if (directiveSinglePromptMode) {
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_recuration_skipped",
            at: nowIso(),
            commandId: command.id,
            postType: "media",
            reason: noveltyValidation.reason,
            policy: "single_prompt_per_directive",
          })
          .catch(() => undefined);
        noveltyValidation = {
          ok: true,
          candidateText: this.buildPostNoveltyCandidateText({
            postType: "media",
            caption: captionForWrite,
            textBody: null,
            mediaPrompt: mediaPromptForWrite,
          }),
        };
      } else {
        const recurationReferences = Array.from(
          new Set<string>(
            [
              ...noveltyAvoidReferences,
              noveltyValidation.referencePreview ?? "",
              truncateText(noveltyValidation.candidateText, 260),
            ]
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
          ),
        );
        const recuratedMediaDraft = await this.curatePostDraftWithOpenClaw({
          commandId: command.id,
          postType: "media",
          varietyMode: postVariety.mode,
          caption: captionForWrite,
          textBody: null,
          mediaPrompt: mediaPromptForWrite,
          context: postDraftContext,
          seedHints: directiveSeedHints,
          avoidReferences: recurationReferences,
        });
        if (!recuratedMediaDraft) {
          if (requiresCuration) {
            throw new RequeueCommandError(
              "post_curation_waiting_for_openclaw:media_novelty_recuration_unavailable",
            );
          }
          return this.failedOutcome(
            command,
            `Blocked media post draft due to low novelty (${noveltyValidation.reason}).`,
            "post_novelty_rejected",
          );
        }
        captionForWrite = recuratedMediaDraft.caption ?? captionForWrite;
        mediaPromptForWrite = recuratedMediaDraft.mediaPrompt ?? mediaPromptForWrite;
        captionForWrite = captionForWrite ? stripEmDashCharacters(captionForWrite) : captionForWrite;
        mediaPromptForWrite = mediaPromptForWrite
          ? stripEmDashCharacters(mediaPromptForWrite)
          : mediaPromptForWrite;
        noveltyValidation = this.validatePostDraftNovelty({
          postType: "media",
          caption: captionForWrite,
          textBody: null,
          mediaPrompt: mediaPromptForWrite,
          context: postDraftContext,
          seedHints: directiveSeedHints,
        });
        if (!noveltyValidation.ok) {
          await this.ctx.memory
            .recordWrite({
              type: "post_novelty_blocked",
              at: nowIso(),
              commandId: command.id,
              postType: "media",
              reason: noveltyValidation.reason,
              candidatePreview: truncateText(noveltyValidation.candidateText, 240),
              referencePreview: noveltyValidation.referencePreview,
            })
            .catch(() => undefined);
          return this.failedOutcome(
            command,
            `Blocked media post draft due to low novelty (${noveltyValidation.reason}).`,
            "post_novelty_blocked",
          );
        }
        await this.ctx.memory
          .recordWrite({
            type: "post_novelty_recurated",
            at: nowIso(),
            commandId: command.id,
            postType: "media",
          })
          .catch(() => undefined);
      }
    }
    const mediaCandidate = noveltyValidation.candidateText;
    const mediaSeedText = mediaPromptForWrite ?? captionForWrite ?? mediaCandidate;
    const personaReferencePlan = this.resolvePersonaReferencePlan(payload, null, command);
    const personaDrivenMediaGeneration = this.shouldUsePersonaFrameReferences(personaReferencePlan);
    if (explicitSaveAsProfileMemory === null && personaDrivenMediaGeneration) {
      saveAsProfileMemoryForMedia = true;
    }
    const carriedMediaPresent =
      asNonEmptyString(payload.mediaUrl) !== null ||
      (Array.isArray(payload.mediaItems) && payload.mediaItems.length > 0) ||
      isRecord(payload.recentGeneratedAsset);
    const mediaGenerationPayloadBase: Record<string, unknown> = {
      ...payload,
    };
    if (personaDrivenMediaGeneration && carriedMediaPresent) {
      delete mediaGenerationPayloadBase.mediaUrl;
      delete mediaGenerationPayloadBase.mediaOriginalUrl;
      delete mediaGenerationPayloadBase.mediaOptimizedUrl;
      delete mediaGenerationPayloadBase.mediaContentHash;
      delete mediaGenerationPayloadBase.mediaIpfsCid;
      delete mediaGenerationPayloadBase.mediaSizeBytes;
      delete mediaGenerationPayloadBase.mediaType;
      delete mediaGenerationPayloadBase.mediaItems;
      delete mediaGenerationPayloadBase.recentGeneratedAsset;
      await this.ctx.memory
        .recordWrite({
          type: "media_post_persona_carryover_stripped",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          sourceDirectiveId,
          personaSlug: personaReferencePlan.targetPersonaSlug,
        })
        .catch(() => undefined);
    }
    const autonomousMediaTheme = this.resolveAutonomousTextTheme({
      commandId: command.id,
      postKind,
      caption: captionForWrite,
      textBody: mediaSeedText,
    });
    const captionPositionForWrite =
      this.normalizeCaptionPositionValue(payload.captionPosition) ??
      this.resolveAutonomousCaptionPosition({
        commandId: command.id,
        postKind,
        seedText: `${captionForWrite ?? ""} ${mediaSeedText}`,
      });
    const autonomousMediaSlides = this.buildAutonomousMediaSlides({
      commandId: command.id,
      postKind,
      caption: captionForWrite,
      mediaPrompt: mediaSeedText,
      theme: autonomousMediaTheme,
    });
    const explicitMultiMediaRequested = this.isExplicitMultiMediaRequest(payload);
    const shouldAttemptMediaSlides =
      explicitMultiMediaRequested && autonomousMediaSlides.length >= 2;
    if (!shouldAttemptMediaSlides && autonomousMediaSlides.length >= 2) {
      await this.ctx.memory
        .recordWrite({
          type: "media_post_slides_suppressed",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId,
          reason: explicitMultiMediaRequested
            ? "insufficient_slide_candidates"
            : "single_prompt_policy",
        })
        .catch(() => undefined);
    }
    if (shouldAttemptMediaSlides) {
      const slideItems: Array<Record<string, unknown>> = [];
      const slidePrompts = autonomousMediaSlides.slice(0, 4);
      for (let index = 0; index < slidePrompts.length; index += 1) {
        const slide = slidePrompts[index];
        if (!slide) continue;
        const slidePrompt = stripEmDashCharacters(slide.imagePrompt).trim();
        if (slidePrompt.length < 8) continue;
        try {
          const slideMedia = await this.resolveMediaUpload({
            payload: {
              ...mediaGenerationPayloadBase,
              generatedAssetType: "image",
            },
            keepOriginal: true,
            promptFallbacks: [
              slidePrompt,
              mediaPromptForWrite,
              asNonEmptyString(payload.prompt),
            ],
            command,
            skipPromptCuration: true,
          });
          slideItems.push({
            mediaUrl: slideMedia.mediaUrl,
            ...(slideMedia.mediaOriginalUrl
              ? { mediaOriginalUrl: slideMedia.mediaOriginalUrl }
              : {}),
            ...(slideMedia.mediaOptimizedUrl
              ? { mediaOptimizedUrl: slideMedia.mediaOptimizedUrl }
              : {}),
            ...(slideMedia.mediaContentHash
              ? { mediaContentHash: slideMedia.mediaContentHash }
              : {}),
            ...(slideMedia.mediaIpfsCid
              ? { mediaIpfsCid: slideMedia.mediaIpfsCid }
              : {}),
            ...(typeof slideMedia.mediaSizeBytes === "number"
              ? { mediaSizeBytes: slideMedia.mediaSizeBytes }
              : {}),
            ...(slideMedia.mediaType ? { mediaType: slideMedia.mediaType } : {}),
            ...(slide.caption
              ? { caption: slide.caption }
              : captionForWrite
                ? { caption: captionForWrite }
                : {}),
            ...(captionPositionForWrite
              ? { captionPosition: captionPositionForWrite }
              : {}),
          });
        } catch (error: unknown) {
          await this.ctx.memory
            .recordWrite({
              type: "media_post_slide_generation_failed",
              at: nowIso(),
              commandId: command.id,
              slideIndex: index,
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
      }
      if (slideItems.length >= 2) {
        const firstSlide = slideItems[0] ?? {};
        const firstSlideMediaUrl = asNonEmptyString(firstSlide.mediaUrl);
        if (firstSlideMediaUrl) {
          const slideMutation = await this.executeCreatePostMutationWithIdempotency({
            command,
            postType: "media",
            postKind,
            mutationInput: {
              ...buildBase(captionForWrite, "media"),
              mediaUrl: firstSlideMediaUrl,
              ...(asNonEmptyString(firstSlide.mediaOriginalUrl)
                ? { mediaOriginalUrl: asNonEmptyString(firstSlide.mediaOriginalUrl) }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaOptimizedUrl)
                ? { mediaOptimizedUrl: asNonEmptyString(firstSlide.mediaOptimizedUrl) }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaContentHash)
                ? { mediaContentHash: asNonEmptyString(firstSlide.mediaContentHash) }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaIpfsCid)
                ? { mediaIpfsCid: asNonEmptyString(firstSlide.mediaIpfsCid) }
                : {}),
              ...(typeof firstSlide.mediaSizeBytes === "number" &&
              Number.isFinite(firstSlide.mediaSizeBytes)
                ? {
                    mediaSizeBytes: Math.max(
                      1,
                      Math.floor(firstSlide.mediaSizeBytes),
                    ),
                  }
                : {}),
              ...(asNonEmptyString(firstSlide.mediaType)
                ? { mediaType: asNonEmptyString(firstSlide.mediaType) }
                : {}),
              mediaItems: slideItems,
              ...(captionPositionForWrite
                ? { captionPosition: captionPositionForWrite }
                : {}),
            },
          });
          if (slideMutation.skipped) {
            return skippedPostOutcome(slideMutation.reason);
          }
          const slideResult = slideMutation.result;
          this.notePublishedPostForNoveltyHistory({
            postType: "media",
            caption: captionForWrite,
            textBody: null,
            mediaPrompt: slidePrompts.map((entry) => entry.imagePrompt).join(" | "),
            commandId: command.id,
            targetPostId: postDraftContext.targetPostId,
          });
          this.notePublishedPostVarietyMode({
            commandId: command.id,
            postType: "media",
            targetPostId: postDraftContext.targetPostId,
            mode: postVariety.mode,
            signal: postVariety.signal,
          });
          await this.ctx.memory
            .recordWrite({
              type: "runtime_post_publish_recorded",
              at: nowIso(),
              commandId: command.id,
              kind: postKind,
              postType: "media",
              varietyMode: postVariety.mode,
              targetPostId: postDraftContext.targetPostId,
              bodyPreview: truncateText(mediaCandidate, 260),
              visualRenderMode: "media_slides",
              slideCount: slideItems.length,
              captionPosition: captionPositionForWrite,
              textStyleTheme: autonomousMediaTheme,
            })
            .catch(() => undefined);
          return this.successOutcome(command, slideResult);
        }
      }
      await this.ctx.memory
        .recordWrite({
          type: "media_post_slides_fallback",
          at: nowIso(),
          commandId: command.id,
          slideCountRequested: slidePrompts.length,
          slideCountResolved: slideItems.length,
        })
        .catch(() => undefined);
    }
    const payloadForMedia: Record<string, unknown> = {
      ...mediaGenerationPayloadBase,
      ...(captionForWrite ? { caption: captionForWrite } : {}),
      ...(mediaPromptForWrite
        ? {
            mediaPrompt: mediaPromptForWrite,
            imagePrompt: mediaPromptForWrite,
            prompt: mediaPromptForWrite,
          }
        : {}),
    };
    const media = await this.resolveMediaUpload({
      payload: payloadForMedia,
      keepOriginal: true,
      promptFallbacks: [
        mediaPromptForWrite,
        asNonEmptyString(payload.prompt),
      ],
      command,
      skipPromptCuration: true,
    });
    const mediaMutation = await this.executeCreatePostMutationWithIdempotency({
      command,
      postType: "media",
      postKind,
      mutationInput: {
        ...buildBase(captionForWrite),
        mediaUrl: media.mediaUrl,
        ...(media.mediaOriginalUrl ? { mediaOriginalUrl: media.mediaOriginalUrl } : {}),
        ...(media.mediaOptimizedUrl ? { mediaOptimizedUrl: media.mediaOptimizedUrl } : {}),
        ...(media.mediaContentHash ? { mediaContentHash: media.mediaContentHash } : {}),
        ...(media.mediaIpfsCid ? { mediaIpfsCid: media.mediaIpfsCid } : {}),
        ...(typeof media.mediaSizeBytes === "number" ? { mediaSizeBytes: media.mediaSizeBytes } : {}),
        ...(media.mediaType ? { mediaType: media.mediaType } : {}),
        ...(captionPositionForWrite ? { captionPosition: captionPositionForWrite } : {}),
      },
    });
    if (mediaMutation.skipped) {
      return skippedPostOutcome(mediaMutation.reason);
    }
    const result = mediaMutation.result;
    this.notePublishedPostForNoveltyHistory({
      postType: "media",
      caption: captionForWrite,
      textBody: null,
      mediaPrompt: mediaPromptForWrite,
      commandId: command.id,
      targetPostId: postDraftContext.targetPostId,
    });
    this.notePublishedPostVarietyMode({
      commandId: command.id,
      postType: "media",
      targetPostId: postDraftContext.targetPostId,
      mode: postVariety.mode,
      signal: postVariety.signal,
    });
    await this.ctx.memory
      .recordWrite({
        type: "runtime_post_publish_recorded",
        at: nowIso(),
        commandId: command.id,
        kind: postKind,
        postType,
        varietyMode: postVariety.mode,
        targetPostId: postDraftContext.targetPostId,
        bodyPreview: truncateText(mediaCandidate, 260),
        mediaUrl: media.mediaUrl,
      })
      .catch(() => undefined);
    return this.successOutcome(command, result);
  }

  private extractTargetPostIdForPostDraft(payload: Record<string, unknown>): number | null {
    const directPostId = asPositiveInt(payload.postId);
    if (directPostId) return directPostId;
    const targetPostId = asPositiveInt(payload.targetPostId);
    if (targetPostId) return targetPostId;
    const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
    if (scope) {
      const scopedPostId = asPositiveInt(scope.targetPostId);
      if (scopedPostId) return scopedPostId;
      const scopedPost = isRecord(scope.target) ? scope.target : null;
      if (scopedPost) {
        const nestedPostId = asPositiveInt(scopedPost.postId);
        if (nestedPostId) return nestedPostId;
      }
    }
    return null;
  }

  private async loadPostDraftContext(input: {
    postId: number | null;
    payload: Record<string, unknown>;
  }): Promise<PostDraftContext> {
    const context: PostDraftContext = {
      targetPostId: input.postId,
      postText: null,
      mediaSummary: null,
      commentSummary: null,
      payloadHint: this.extractCommentPayloadHint(input.payload),
      memorySummary: await this.loadPostDraftMemorySummary({
        postId: input.postId,
        payload: input.payload,
      }),
      platformSignals: await this.loadPostDraftDiscoverySignals({
        postId: input.postId,
        payload: input.payload,
      }),
    };
    if (!input.postId) return context;
    const callAgentChatBridge = this.ctx.callAgentChatBridge;
    if (!callAgentChatBridge) return context;
    try {
      const postResponse = await callAgentChatBridge({
        action: "find_post",
        postId: input.postId,
      });
      const postRecord = this.extractPostRecordForCommentCuration(postResponse, input.postId);
      if (!postRecord) return context;
      context.postText =
        asNonEmptyString(postRecord.textBody) ??
        asNonEmptyString(postRecord.caption) ??
        asNonEmptyString(postRecord.body);
      context.mediaSummary = this.summarizePostMediaForComment(postRecord);
      try {
        const commentResponse = await callAgentChatBridge({
          action: "find_comment",
          postId: input.postId,
        });
        context.commentSummary = this.summarizeCommentsForPostDraft(commentResponse);
      } catch (error: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "post_context_comments_lookup_failed",
            at: nowIso(),
            postId: input.postId,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
      return context;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "post_context_lookup_failed",
          at: nowIso(),
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return context;
    }
  }

  private async loadPostDraftMemorySummary(input: {
    postId: number | null;
    payload: Record<string, unknown>;
  }): Promise<string | null> {
    if (typeof this.ctx.memory.buildContext !== "function") {
      return null;
    }
    try {
      const payloadHint = this.extractCommentPayloadHint(input.payload);
      const retrievalQuery = [
        "post draft context",
        typeof input.postId === "number" ? `post ${input.postId}` : "",
        payloadHint ? `hint ${payloadHint}` : "",
      ]
        .filter((value) => value.length > 0)
        .join(" · ");
      const request: ContextRequest = {
        mode: "directive",
        audience: "runtime_write",
        ...(typeof input.postId === "number" ? { postId: input.postId } : {}),
        maxRecentEvents: 120,
        maxArchiveEvents: 40,
        includeViewState: true,
        viewStateMaxItems: 10,
        includeKeywordRetrieval: true,
        retrievalIntent: "directive",
        retrievalMaxItems: 10,
        retrievalQuery,
      };
      const bundle = await this.ctx.memory.buildContext(request);
      return this.buildCompactEngagementMemorySummary(bundle);
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "post_memory_context_failed",
          at: nowIso(),
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    }
  }

  private extractPostDiscoverySignalFromRecord(record: Record<string, unknown>): string | null {
    const author = isRecord(record.author) ? record.author : null;
    const handle =
      asNonEmptyString(author?.handle) ??
      asNonEmptyString(record.authorHandle) ??
      asNonEmptyString(record.handle) ??
      null;
    const text =
      asNonEmptyString(record.textBody) ??
      asNonEmptyString(record.body) ??
      asNonEmptyString(record.caption) ??
      asNonEmptyString(record.text) ??
      asNonEmptyString(record.content) ??
      asNonEmptyString(record.title) ??
      asNonEmptyString(record.summary) ??
      null;
    const mediaCount = Array.isArray(record.mediaItems)
      ? record.mediaItems.length
      : asPositiveInt(record.mediaCount) ?? null;
    const compactText = text
      ? truncateText(stripEmDashCharacters(text).replace(/\s+/gu, " ").trim(), 120)
      : null;
    const mediaSummary =
      !compactText && mediaCount && mediaCount > 0
        ? `${mediaCount} media item${mediaCount === 1 ? "" : "s"}`
        : null;
    const signal = compactText ?? mediaSummary;
    if (!signal) return null;
    return handle ? `@${handle.replace(/^@+/u, "")}: ${signal}` : signal;
  }

  private async loadPostDraftDiscoverySignals(input: {
    postId: number | null;
    payload: Record<string, unknown>;
  }): Promise<string | null> {
    if (!this.ctx.callAgentChatBridge) return null;
    const hints = this.extractEngagementLookupHints(input.payload);
    const lookupPlans: Array<{ source: string; request: Record<string, unknown> }> = [
      {
        source: "trending",
        request: {
          action: "browse_trending",
          limit: 12,
        },
      },
      {
        source: "home",
        request: {
          action: "browse_home_feed",
          limit: 12,
        },
      },
      {
        source: "posts",
        request: {
          action: "browse_posts",
          limit: 12,
        },
      },
    ];
    if (hints.interestTags.length > 0) {
      lookupPlans.push({
        source: "interest",
        request: {
          action: "browse_posts",
          limit: 12,
          tags: hints.interestTags.slice(0, 4),
        },
      });
    }
    if (hints.rawQuery.trim().length > 0) {
      lookupPlans.push({
        source: "search",
        request: {
          action: "search_global",
          limit: 8,
          query: truncateText(hints.rawQuery, 96),
        },
      });
    }
    for (const handle of hints.handles.slice(0, 2)) {
      lookupPlans.push({
        source: "handle",
        request: {
          action: "find_post",
          authorHandle: handle,
          latest: true,
          limit: 1,
        },
      });
    }
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const plan of lookupPlans) {
      if (lines.length >= POST_DISCOVERY_SIGNAL_MAX_LINES) break;
      try {
        const lookup = await this.callAgentBridgeLookupCached(plan.request);
        for (const item of this.collectBridgeRecordItems(lookup.value)) {
          if (lines.length >= POST_DISCOVERY_SIGNAL_MAX_LINES) break;
          const signal = this.extractPostDiscoverySignalFromRecord(item);
          if (!signal) continue;
          const line = `${plan.source}: ${signal}`;
          const key = normalizeCommentText(line);
          if (!key.length || seen.has(key)) continue;
          seen.add(key);
          lines.push(truncateText(line, 180));
        }
      } catch (error: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "post_discovery_lookup_failed",
            at: nowIso(),
            postId: input.postId,
            source: plan.source,
            lookupAction: asNonEmptyString(plan.request.action) ?? "unknown",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
    }
    if (lines.length === 0) return null;
    return truncateText(lines.join(" | "), POST_DISCOVERY_SIGNAL_MAX_LENGTH);
  }

  private buildPostNoveltyCandidateText(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
  }): string {
    if (input.postType === "text") {
      return [input.caption ?? "", input.textBody ?? ""]
        .filter((value) => value.trim().length > 0)
        .join("\n")
        .trim();
    }
    return [input.caption ?? "", input.mediaPrompt ?? ""]
      .filter((value) => value.trim().length > 0)
      .join("\n")
      .trim();
  }

  private pruneRecentPostNoveltyHistory(nowMs: number): void {
    let writeIndex = 0;
    for (const entry of this.recentPostNoveltyHistory) {
      if (nowMs - entry.atMs > POST_NOVELTY_HISTORY_WINDOW_MS) continue;
      this.recentPostNoveltyHistory[writeIndex] = entry;
      writeIndex += 1;
    }
    this.recentPostNoveltyHistory.length = writeIndex;
    if (this.recentPostNoveltyHistory.length <= POST_NOVELTY_HISTORY_MAX_ITEMS) {
      return;
    }
    const trimStart = this.recentPostNoveltyHistory.length - POST_NOVELTY_HISTORY_MAX_ITEMS;
    this.recentPostNoveltyHistory.splice(0, trimStart);
  }

  private snapshotRecentPostNoveltyReferences(postType: "text" | "media"): string[] {
    const nowMs = Date.now();
    this.pruneRecentPostNoveltyHistory(nowMs);
    const references: string[] = [];
    const seen = new Set<string>();
    for (let index = this.recentPostNoveltyHistory.length - 1; index >= 0; index -= 1) {
      const entry = this.recentPostNoveltyHistory[index];
      if (!entry) continue;
      if (entry.postType !== postType) continue;
      if (seen.has(entry.normalized)) continue;
      seen.add(entry.normalized);
      references.push(entry.text);
      if (references.length >= POST_NOVELTY_MAX_AVOID_REFERENCES) break;
    }
    return references;
  }

  private computeBidirectionalTokenOverlap(first: string, second: string): number {
    return Math.max(
      computeTokenOverlapRatio(first, second),
      computeTokenOverlapRatio(second, first),
    );
  }

  private validatePostDraftNovelty(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
  }):
    | { ok: true; candidateText: string }
    | { ok: false; reason: string; candidateText: string; referencePreview: string | null } {
    const candidateText = this.buildPostNoveltyCandidateText({
      postType: input.postType,
      caption: input.caption,
      textBody: input.textBody,
      mediaPrompt: input.mediaPrompt,
    });
    if (candidateText.length < 12) {
      return {
        ok: false,
        reason: "candidate_too_short",
        candidateText,
        referencePreview: null,
      };
    }
    if (
      input.postType === "media" &&
      input.mediaPrompt &&
      COMMENT_PROMPT_WRAPPER_PATTERN.test(input.mediaPrompt)
    ) {
      return {
        ok: false,
        reason: "media_prompt_wrapper",
        candidateText,
        referencePreview: input.mediaPrompt,
      };
    }
    const normalizedCandidate = normalizeCommentText(candidateText);
    if (!normalizedCandidate.length) {
      return {
        ok: false,
        reason: "candidate_empty_after_normalization",
        candidateText,
        referencePreview: null,
      };
    }
    const compareAgainstReference = (
      reference: string,
      threshold: number,
      reasonPrefix: string,
    ): { ok: true } | { ok: false; reason: string; referencePreview: string } => {
      const trimmedReference = reference.trim();
      if (trimmedReference.length < 12) return { ok: true };
      const normalizedReference = normalizeCommentText(trimmedReference);
      if (!normalizedReference.length) return { ok: true };
      if (normalizedCandidate === normalizedReference) {
        return { ok: false, reason: `same_as_${reasonPrefix}`, referencePreview: trimmedReference };
      }
      const overlap = this.computeBidirectionalTokenOverlap(candidateText, trimmedReference);
      if (overlap >= threshold) {
        return {
          ok: false,
          reason: `too_similar_to_${reasonPrefix}`,
          referencePreview: trimmedReference,
        };
      }
      if (
        hasLongNormalizedPhraseOverlap(candidateText, trimmedReference) &&
        overlap >= Math.max(0.42, threshold - 0.24)
      ) {
        return {
          ok: false,
          reason: `contains_${reasonPrefix}_phrase`,
          referencePreview: trimmedReference,
        };
      }
      return { ok: true };
    };

    const contextReferences = [
      input.context.postText,
      input.context.mediaSummary,
      input.context.commentSummary,
      input.context.payloadHint,
    ].filter((value): value is string => typeof value === "string" && value.trim().length >= 12);
    const contextThreshold = input.postType === "media" ? 0.72 : 0.78;
    for (const reference of contextReferences) {
      const check = compareAgainstReference(reference, contextThreshold, "target_context");
      if (!check.ok) {
        return {
          ok: false,
          reason: check.reason,
          candidateText,
          referencePreview: truncateText(check.referencePreview, 240),
        };
      }
    }

    const seedThreshold = input.postType === "media" ? 0.74 : 0.8;
    for (const seed of input.seedHints) {
      const check = compareAgainstReference(seed, seedThreshold, "directive_seed");
      if (!check.ok) {
        return {
          ok: false,
          reason: check.reason,
          candidateText,
          referencePreview: truncateText(check.referencePreview, 240),
        };
      }
    }

    const nowMs = Date.now();
    this.pruneRecentPostNoveltyHistory(nowMs);
    const historyThreshold = input.postType === "media" ? 0.68 : 0.76;
    for (let index = this.recentPostNoveltyHistory.length - 1; index >= 0; index -= 1) {
      const entry = this.recentPostNoveltyHistory[index];
      if (!entry) continue;
      if (entry.postType !== input.postType) continue;
      if (entry.normalized === normalizedCandidate) {
        return {
          ok: false,
          reason: "same_as_recent_self_post",
          candidateText,
          referencePreview: truncateText(entry.text, 240),
        };
      }
      const overlap = this.computeBidirectionalTokenOverlap(candidateText, entry.text);
      if (overlap >= historyThreshold) {
        return {
          ok: false,
          reason: "too_similar_to_recent_self_post",
          candidateText,
          referencePreview: truncateText(entry.text, 240),
        };
      }
      if (
        hasLongNormalizedPhraseOverlap(candidateText, entry.text) &&
        overlap >= Math.max(0.4, historyThreshold - 0.24)
      ) {
        return {
          ok: false,
          reason: "contains_recent_self_phrase",
          candidateText,
          referencePreview: truncateText(entry.text, 240),
        };
      }
    }
    return { ok: true, candidateText };
  }

  private notePublishedPostForNoveltyHistory(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    commandId: string;
    targetPostId: number | null;
  }): void {
    const text = this.buildPostNoveltyCandidateText({
      postType: input.postType,
      caption: input.caption,
      textBody: input.textBody,
      mediaPrompt: input.mediaPrompt,
    });
    if (text.length < 12) return;
    const normalized = normalizeCommentText(text);
    if (!normalized.length) return;
    const nowMs = Date.now();
    this.pruneRecentPostNoveltyHistory(nowMs);
    for (let index = this.recentPostNoveltyHistory.length - 1; index >= 0; index -= 1) {
      const entry = this.recentPostNoveltyHistory[index];
      if (!entry) continue;
      if (entry.normalized !== normalized) continue;
      this.recentPostNoveltyHistory.splice(index, 1);
    }
    this.recentPostNoveltyHistory.push({
      atMs: nowMs,
      postType: input.postType,
      text,
      normalized,
      commandId: input.commandId,
      targetPostId: input.targetPostId,
    });
    this.pruneRecentPostNoveltyHistory(nowMs);
  }

  private parsePostVarietyMode(value: unknown): PostVarietyMode | null {
    const normalized = asNonEmptyString(value)?.toLowerCase() ?? null;
    if (!normalized) return null;
    if (normalized === "opinion") return "opinion";
    if (normalized === "reaction") return "reaction";
    if (normalized === "humor" || normalized === "funny" || normalized === "joke") {
      return "humor";
    }
    if (
      normalized === "micro" ||
      normalized === "short" ||
      normalized === "one-liner" ||
      normalized === "oneliner"
    ) {
      return "micro";
    }
    if (normalized === "narrative" || normalized === "story") return "narrative";
    return null;
  }

  private pruneRecentPostVarietyModeHistory(nowMs: number): void {
    let writeIndex = 0;
    for (const entry of this.recentPostVarietyModeHistory) {
      if (nowMs - entry.atMs > POST_VARIETY_HISTORY_WINDOW_MS) continue;
      this.recentPostVarietyModeHistory[writeIndex] = entry;
      writeIndex += 1;
    }
    this.recentPostVarietyModeHistory.length = writeIndex;
    if (this.recentPostVarietyModeHistory.length <= POST_VARIETY_HISTORY_MAX_ITEMS) return;
    const trimStart =
      this.recentPostVarietyModeHistory.length - POST_VARIETY_HISTORY_MAX_ITEMS;
    this.recentPostVarietyModeHistory.splice(0, trimStart);
  }

  private listRecentPostVarietyModes(maxItems: number): PostVarietyMode[] {
    const nowMs = Date.now();
    this.pruneRecentPostVarietyModeHistory(nowMs);
    const modes: PostVarietyMode[] = [];
    const seen = new Set<PostVarietyMode>();
    for (let index = this.recentPostVarietyModeHistory.length - 1; index >= 0; index -= 1) {
      const entry = this.recentPostVarietyModeHistory[index];
      if (!entry) continue;
      if (seen.has(entry.mode)) continue;
      seen.add(entry.mode);
      modes.push(entry.mode);
      if (modes.length >= maxItems) break;
    }
    return modes;
  }

  private selectPostVarietyMode(input: {
    commandId: string;
    postType: "text" | "media";
    payload: Record<string, unknown>;
    context: PostDraftContext;
    seedHints: string[];
  }): {
    mode: PostVarietyMode;
    reason: string;
    recentModes: PostVarietyMode[];
    signal: string;
  } {
    const recentModes = this.listRecentPostVarietyModes(POST_VARIETY_RECENT_COOLDOWN_COUNT + 2);
    const blockedModes = new Set<PostVarietyMode>(
      recentModes.slice(0, POST_VARIETY_RECENT_COOLDOWN_COUNT),
    );
    const payloadMode =
      this.parsePostVarietyMode(input.payload.postVarietyMode) ??
      this.parsePostVarietyMode(input.payload.varietyMode) ??
      this.parsePostVarietyMode(input.payload.mode) ??
      null;
    const signalRaw = [
      asNonEmptyString(input.payload.requestText),
      asNonEmptyString(input.payload.topic),
      asNonEmptyString(input.payload.prompt),
      asNonEmptyString(input.payload.caption),
      asNonEmptyString(input.payload.textBody),
      input.context.payloadHint,
      input.context.postText,
      input.context.commentSummary,
      input.context.memorySummary,
      input.context.platformSignals,
      ...input.seedHints.slice(0, 8),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    const signal = truncateText(normalizeCommentText(signalRaw), 900);
    const availableModes = POST_VARIETY_MODES.filter((mode) => !blockedModes.has(mode));
    const chooseBySeed = (seedSuffix: string, candidates: readonly PostVarietyMode[]): PostVarietyMode => {
      const target = candidates.length > 0 ? candidates : POST_VARIETY_MODES;
      if (target.length === 0) return "reaction";
      const selected =
        target[
          this.pickDeterministicIndex(
            `${input.commandId}:${input.postType}:${seedSuffix}:${signal}`,
            target.length,
          )
        ];
      return selected ?? target[0] ?? "reaction";
    };
    if (payloadMode) {
      const selected = blockedModes.has(payloadMode)
        ? chooseBySeed("payload_cooldown", availableModes)
        : payloadMode;
      return {
        mode: selected,
        reason: blockedModes.has(payloadMode)
          ? `payload_mode_cooldown:${payloadMode}`
          : "payload_mode",
        recentModes,
        signal,
      };
    }
    const scores: Record<PostVarietyMode, number> = {
      opinion: 0,
      reaction: 0,
      humor: 0,
      micro: 0,
      narrative: 0,
    };
    for (const hint of POST_VARIETY_HINT_PATTERNS) {
      if (!hint.pattern.test(signal)) continue;
      scores[hint.mode] += hint.weight;
    }
    if (input.context.platformSignals) {
      scores.reaction += 2;
    }
    if (input.context.targetPostId !== null) {
      scores.reaction += 1;
    }
    if (input.postType === "media") {
      scores.narrative += 1;
      scores.reaction += 1;
    } else {
      scores.opinion += 1;
      scores.micro += 1;
    }
    let topScore = Number.NEGATIVE_INFINITY;
    let candidates: PostVarietyMode[] = [];
    for (const mode of POST_VARIETY_MODES) {
      const score = scores[mode];
      if (score > topScore) {
        topScore = score;
        candidates = [mode];
      } else if (score === topScore) {
        candidates.push(mode);
      }
    }
    let selected =
      topScore > 0
        ? chooseBySeed("scored", candidates)
        : chooseBySeed("fallback", POST_VARIETY_MODES);
    if (blockedModes.has(selected) && availableModes.length > 0) {
      selected = chooseBySeed("cooldown_swap", availableModes);
    }
    return {
      mode: selected,
      reason: topScore > 0 ? `pattern_score:${topScore}` : "fallback_seeded",
      recentModes,
      signal,
    };
  }

  private notePublishedPostVarietyMode(input: {
    commandId: string;
    postType: "text" | "media";
    targetPostId: number | null;
    mode: PostVarietyMode;
    signal: string;
  }): void {
    const normalizedSignal = truncateText(normalizeCommentText(input.signal), 220);
    const signalForHistory = normalizedSignal.length > 0 ? normalizedSignal : input.mode;
    const nowMs = Date.now();
    this.pruneRecentPostVarietyModeHistory(nowMs);
    this.recentPostVarietyModeHistory.push({
      atMs: nowMs,
      postType: input.postType,
      mode: input.mode,
      commandId: input.commandId,
      targetPostId: input.targetPostId,
      signal: signalForHistory,
    });
    this.pruneRecentPostVarietyModeHistory(nowMs);
    void this.ctx.memory
      .recordWrite({
        type: "post_variety_mode_published",
        at: nowIso(),
        commandId: input.commandId,
        postType: input.postType,
        targetPostId: input.targetPostId,
        mode: input.mode,
      })
      .catch(() => undefined);
  }

  private normalizeCaptionPositionValue(value: unknown): string | null {
    const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
    if (!raw) return null;
    return CAPTION_POSITION_KEYS.has(raw) ? raw : null;
  }

  private sanitizeTextStyleValue(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value)) return null;
    const style: Record<string, unknown> = {};
    const setEnum = (
      key: string,
      allowed: Set<string>,
      candidate: unknown,
    ): void => {
      const normalized = asNonEmptyString(candidate)?.toLowerCase() ?? null;
      if (!normalized || !allowed.has(normalized)) return;
      style[key] = normalized;
    };
    setEnum("theme", TEXT_STYLE_THEME_KEYS, value.theme);
    setEnum("align", TEXT_STYLE_ALIGN_KEYS, value.align);
    setEnum("emphasis", TEXT_STYLE_EMPHASIS_KEYS, value.emphasis);
    setEnum("font", TEXT_STYLE_FONT_KEYS, value.font);
    setEnum("weight", TEXT_STYLE_WEIGHT_KEYS, value.weight);
    setEnum("size", TEXT_STYLE_SIZE_KEYS, value.size);
    setEnum("color", TEXT_STYLE_COLOR_KEYS, value.color);
    const position = this.normalizeCaptionPositionValue(value.position);
    if (position) style.position = position;
    if (typeof value.italic === "boolean") {
      style.italic = value.italic;
    }
    const background = asNonEmptyString(value.background);
    if (background && background.length <= 180) {
      style.background = stripEmDashCharacters(background);
    }
    return Object.keys(style).length > 0 ? style : null;
  }

  private pickDeterministicIndex(seed: string, modulo: number): number {
    const boundedModulo = Math.max(1, Math.floor(modulo));
    const digest = crypto.createHash("sha256").update(seed).digest();
    const value = digest.readUInt32BE(0);
    return value % boundedModulo;
  }

  private resolveAutonomousTextTheme(input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    textBody: string;
  }): TextStyleTheme {
    const normalizedText = [
      input.caption ? stripEmDashCharacters(input.caption) : "",
      stripEmDashCharacters(input.textBody),
    ]
      .join(" ")
      .toLowerCase()
      .replace(/\s+/gu, " ")
      .trim();
    const scores: Record<TextStyleTheme, number> = {
      warm: 0,
      cool: 0,
      night: 0,
      sunrise: 0,
      mint: 0,
      ocean: 0,
      plum: 0,
      sand: 0,
    };
    for (const entry of AUTONOMOUS_THEME_KEYWORD_HINTS) {
      for (const keyword of entry.keywords) {
        const pattern = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "iu");
        if (pattern.test(normalizedText)) {
          scores[entry.theme] += 2;
        }
      }
    }
    if (input.postKind === "thread") {
      scores.ocean += 1;
      scores.cool += 1;
      scores.sunrise += 1;
      if (normalizedText.length > 120) {
        scores.night += 1;
      }
    }
    let bestScore = Number.NEGATIVE_INFINITY;
    let candidates: TextStyleTheme[] = [];
    for (const theme of TEXT_STYLE_THEMES) {
      const score = scores[theme];
      if (score > bestScore) {
        bestScore = score;
        candidates = [theme];
        continue;
      }
      if (score === bestScore) {
        candidates.push(theme);
      }
    }
    const seed = `${input.commandId}:${input.postKind}:${normalizedText}`;
    if (bestScore <= 0 || candidates.length === 0) {
      return TEXT_STYLE_THEMES[this.pickDeterministicIndex(seed, TEXT_STYLE_THEMES.length)] ?? "warm";
    }
    return candidates[this.pickDeterministicIndex(seed, candidates.length)] ?? candidates[0] ?? "warm";
  }

  private resolveAutonomousGradientBackground(theme: TextStyleTheme, seed: string): string {
    const options = AUTONOMOUS_TEXT_GRADIENTS[theme];
    if (!Array.isArray(options) || options.length === 0) {
      return "linear-gradient(140deg, #ffe4d6 0%, #ffd1da 48%, #fff1c2 100%)";
    }
    const picked = options[this.pickDeterministicIndex(seed, options.length)];
    return picked ?? options[0] ?? "linear-gradient(140deg, #ffe4d6 0%, #ffd1da 48%, #fff1c2 100%)";
  }

  private resolveAutonomousPaletteHint(theme: TextStyleTheme, seed: string): string {
    const options = AUTONOMOUS_PALETTE_HINTS_BY_THEME[theme];
    if (!Array.isArray(options) || options.length === 0) {
      return "balanced natural tones";
    }
    const picked = options[this.pickDeterministicIndex(seed, options.length)];
    return picked ?? options[0] ?? "balanced natural tones";
  }

  private resolveAutonomousCameraHint(seed: string): string {
    const picked =
      AUTONOMOUS_CAMERA_HINTS[
        this.pickDeterministicIndex(seed, AUTONOMOUS_CAMERA_HINTS.length)
      ];
    return picked ?? AUTONOMOUS_CAMERA_HINTS[0];
  }

  private resolveAutonomousCaptionPosition(input: {
    commandId: string;
    postKind: "post" | "thread";
    seedText: string;
  }): string {
    const preferred =
      input.postKind === "thread"
        ? (["top-left", "middle-left", "bottom-left", "middle-center"] as const)
        : (["middle-center", "top-center", "bottom-center", "middle-left", "middle-right"] as const);
    const picked =
      preferred[this.pickDeterministicIndex(
        `${input.commandId}:${input.seedText}:caption_position`,
        preferred.length,
      )];
    return picked ?? "middle-center";
  }

  private buildAutonomousVisualPrompt(input: {
    basePrompt: string;
    caption: string | null;
    commandId: string;
    theme: TextStyleTheme;
    mode: "slide" | "story" | "background";
    index: number;
  }): string {
    const subject = stripEmDashCharacters(input.basePrompt).replace(/\s+/gu, " ").trim();
    if (!subject.length) return "";
    const palette = this.resolveAutonomousPaletteHint(
      input.theme,
      `${input.commandId}:${input.mode}:${input.index}:palette`,
    );
    const camera = this.resolveAutonomousCameraHint(
      `${input.commandId}:${input.mode}:${input.index}:camera`,
    );
    const modeDirection =
      input.mode === "slide"
        ? "Editorial social visual for one distinct beat."
        : input.mode === "background"
          ? "Text-friendly visual background with clear negative space for caption overlay."
          : "Story-ready composition with strong focal clarity.";
    const captionContext =
      input.caption && input.caption.trim().length > 0
        ? `Caption context: ${truncateText(stripEmDashCharacters(input.caption), 120)}.`
        : "";
    return truncateText(
      [
        subject,
        modeDirection,
        `Color palette: ${palette}.`,
        camera,
        "Use a distinctive composition and avoid generic default template backgrounds.",
        captionContext,
      ]
        .filter((entry) => entry.length > 0)
        .join(" "),
      320,
    );
  }

  private buildAutonomousThreadSlides(input: {
    commandId: string;
    caption: string | null;
    textBody: string;
    theme: TextStyleTheme;
    postKind: "post" | "thread";
  }): TextPostVisualSlide[] {
    const cleanedBody = stripEmDashCharacters(input.textBody).replace(/\s+/gu, " ").trim();
    if (cleanedBody.length < 24) return [];
    const seed = `${input.commandId}:${cleanedBody}:${input.theme}`;
    const wordCount = cleanedBody.split(/\s+/u).filter((token) => token.length > 0).length;
    const parts = cleanedBody
      .split(/(?:\r?\n|[.!?;]+)\s*/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 18);
    const hasSequenceSignals = AUTONOMOUS_SEQUENCE_SIGNAL_PATTERN.test(cleanedBody);
    const threshold =
      input.postKind === "thread"
        ? hasSequenceSignals
          ? 92
          : wordCount >= 84
            ? 76
            : 60
        : hasSequenceSignals
          ? 58
          : wordCount >= 84
            ? 34
            : 18;
    if (this.pickDeterministicIndex(`${seed}:slides_gate`, 100) >= threshold) {
      return [];
    }
    const targetCount = Math.min(
      4,
      Math.max(2, 2 + this.pickDeterministicIndex(`${seed}:slides_count`, 3)),
    );
    const normalizedParts = [...parts];
    if (normalizedParts.length < 2) {
      const captionPart = input.caption ? stripEmDashCharacters(input.caption).trim() : "";
      if (captionPart.length >= 12) normalizedParts.push(captionPart);
      const snippet = truncateText(cleanedBody, 120);
      if (snippet.length >= 18) normalizedParts.push(snippet);
    }
    const selected = normalizedParts.slice(0, targetCount);
    const slides: TextPostVisualSlide[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const statement = selected[index];
      if (!statement) continue;
      const imagePrompt = this.buildAutonomousVisualPrompt({
        basePrompt: statement,
        caption: input.caption,
        commandId: input.commandId,
        theme: input.theme,
        mode: "slide",
        index,
      });
      if (imagePrompt.length < 8) continue;
      slides.push({
        caption: truncateText(statement, 180),
        imagePrompt,
      });
    }
    return slides.length >= 2 ? slides.slice(0, 4) : [];
  }

  private buildAutonomousTextBackgroundPrompt(input: {
    commandId: string;
    caption: string | null;
    textBody: string;
    theme: TextStyleTheme;
    postKind: "post" | "thread";
  }): string | null {
    const cleanedBody = stripEmDashCharacters(input.textBody).replace(/\s+/gu, " ").trim();
    if (cleanedBody.length < 36) return null;
    const threshold = input.postKind === "thread" ? 34 : 18;
    if (
      this.pickDeterministicIndex(
        `${input.commandId}:${cleanedBody}:${input.theme}:background_gate`,
        100,
      ) >= threshold
    ) {
      return null;
    }
    const basePrompt = input.caption
      ? `${stripEmDashCharacters(input.caption)}. ${cleanedBody}`
      : cleanedBody;
    const prompt = this.buildAutonomousVisualPrompt({
      basePrompt,
      caption: input.caption,
      commandId: input.commandId,
      theme: input.theme,
      mode: "background",
      index: 0,
    });
    return prompt.length >= 8 ? prompt : null;
  }

  private buildAutonomousMediaSlides(input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    mediaPrompt: string;
    theme: TextStyleTheme;
  }): TextPostVisualSlide[] {
    const cleanedPrompt = stripEmDashCharacters(input.mediaPrompt)
      .replace(/\s+/gu, " ")
      .trim();
    if (cleanedPrompt.length < 18) return [];
    const seed = `${input.commandId}:${input.postKind}:${cleanedPrompt}:${input.theme}`;
    const hasSequenceSignals = AUTONOMOUS_SEQUENCE_SIGNAL_PATTERN.test(cleanedPrompt);
    const threshold =
      input.postKind === "thread"
        ? hasSequenceSignals
          ? 92
          : 74
        : hasSequenceSignals
          ? 62
          : 44;
    if (this.pickDeterministicIndex(`${seed}:media_slides_gate`, 100) >= threshold) {
      return [];
    }

    const parts = cleanedPrompt
      .split(/(?:\r?\n|[.!?;]+)\s*/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 16);
    if (parts.length < 2) {
      parts.push(
        `${cleanedPrompt} with a hero composition and clear focal subject`,
        `${cleanedPrompt} with expressive text accents and a secondary detail frame`,
      );
    }
    const targetCount = Math.min(
      4,
      Math.max(2, 2 + this.pickDeterministicIndex(`${seed}:media_slides_count`, 3)),
    );
    const selected = parts.slice(0, targetCount);
    if (selected.length < 2) return [];

    const captionBase = input.caption ? stripEmDashCharacters(input.caption).trim() : "";
    const slides: TextPostVisualSlide[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const beat = selected[index];
      if (!beat) continue;
      const imagePrompt = this.buildAutonomousVisualPrompt({
        basePrompt: beat,
        caption: input.caption,
        commandId: input.commandId,
        theme: input.theme,
        mode: "slide",
        index,
      });
      if (imagePrompt.length < 8) continue;
      const caption = captionBase.length
        ? truncateText(`${captionBase} - ${truncateText(beat, 120)}`, 2200)
        : truncateText(beat, 180);
      slides.push({
        caption,
        imagePrompt,
      });
    }
    return slides.length >= 2 ? slides.slice(0, 4) : [];
  }

  private normalizeAgentTextStyle(
    style: Record<string, unknown> | null,
    captionPosition: string | null,
    fallbackStyle?: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const normalizeTheme = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw) return null;
      return TEXT_STYLE_THEME_KEYS.has(raw) ? raw : null;
    };
    const normalizeAlign = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (raw && ["left", "center", "right"].includes(raw)) return raw;
      if (captionPosition) {
        const alignFromPosition = captionPosition.split("-")[1] ?? null;
        if (
          alignFromPosition &&
          ["left", "center", "right"].includes(alignFromPosition)
        ) {
          return alignFromPosition;
        }
      }
      return null;
    };
    const normalizeEmphasis = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw) return null;
      return TEXT_STYLE_EMPHASIS_KEYS.has(raw) ? raw : null;
    };
    const normalizeFont = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw || !TEXT_STYLE_FONT_KEYS.has(raw)) return null;
      return raw;
    };
    const normalizeWeight = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw || !TEXT_STYLE_WEIGHT_KEYS.has(raw)) return null;
      return raw;
    };
    const normalizeSize = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw || !TEXT_STYLE_SIZE_KEYS.has(raw)) return null;
      return raw;
    };
    const normalizeColor = (value: unknown): string | null => {
      const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
      if (!raw || !TEXT_STYLE_COLOR_KEYS.has(raw)) return null;
      return raw;
    };
    const normalizePosition = (value: unknown): string | null => {
      const raw = this.normalizeCaptionPositionValue(value);
      if (raw) return raw;
      return captionPosition;
    };
    const normalized: Record<string, unknown> = {};
    const applyStyle = (candidateStyle: Record<string, unknown> | null | undefined): void => {
      const theme = normalizeTheme(candidateStyle?.theme);
      const align = normalizeAlign(candidateStyle?.align);
      const emphasis = normalizeEmphasis(candidateStyle?.emphasis);
      const font = normalizeFont(candidateStyle?.font);
      const weight = normalizeWeight(candidateStyle?.weight);
      const size = normalizeSize(candidateStyle?.size);
      const color = normalizeColor(candidateStyle?.color);
      const position = normalizePosition(candidateStyle?.position);
      const background = asNonEmptyString(candidateStyle?.background);
      if (theme) normalized.theme = theme;
      if (align) normalized.align = align;
      if (emphasis) normalized.emphasis = emphasis;
      if (font) normalized.font = font;
      if (weight) normalized.weight = weight;
      if (typeof candidateStyle?.italic === "boolean") {
        normalized.italic = candidateStyle.italic;
      }
      if (size) normalized.size = size;
      if (color) normalized.color = color;
      if (position) normalized.position = position;
      if (background && background.length <= 180) {
        normalized.background = stripEmDashCharacters(background);
      }
    };

    applyStyle(fallbackStyle);
    applyStyle(style);
    const themeForDefaults = asNonEmptyString(normalized.theme) as TextStyleTheme | null;
    if (themeForDefaults && !asNonEmptyString(normalized.color)) {
      normalized.color = TEXT_STYLE_DEFAULT_COLOR_BY_THEME[themeForDefaults];
    }
    if (Object.keys(normalized).length === 0) {
      return {
        theme: "warm",
        align: "center",
        emphasis: "soft",
      };
    }
    return normalized;
  }

  private extractTextPostVisualPlanFromUnknown(value: unknown): TextPostVisualPlan | null {
    const fromString = (raw: string): TextPostVisualPlan | null => {
      const trimmed = raw.trim();
      if (!trimmed.length) return null;
      const parsed = parseJsonFromMixedText(trimmed);
      if (parsed !== null && parsed !== raw) {
        return this.extractTextPostVisualPlanFromUnknown(parsed);
      }
      return null;
    };
    if (typeof value === "string") return fromString(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const parsed = this.extractTextPostVisualPlanFromUnknown(entry);
        if (parsed) return parsed;
      }
      return null;
    }
    if (!isRecord(value)) return null;
    const nestedKeys = [
      "result",
      "payload",
      "data",
      "content",
      "output",
      "draft",
    ] as const;
    for (const key of nestedKeys) {
      const nested = this.extractTextPostVisualPlanFromUnknown(value[key]);
      if (nested) return nested;
    }

    const renderModeRaw =
      asNonEmptyString(value.renderMode) ??
      asNonEmptyString(value.mode) ??
      asNonEmptyString(value.layout) ??
      null;
    const renderMode =
      renderModeRaw && /(slides|carousel|deck|storyboard)/iu.test(renderModeRaw)
        ? "slides"
        : "text";
    const captionPosition =
      this.normalizeCaptionPositionValue(value.captionPosition) ??
      this.normalizeCaptionPositionValue(value.position);
    const textStyle =
      this.sanitizeTextStyleValue(value.textStyle) ??
      this.sanitizeTextStyleValue(value.style);
    const backgroundImagePrompt = (() => {
      const prompt =
        asNonEmptyString(value.backgroundImagePrompt) ??
        asNonEmptyString(value.textBackgroundPrompt) ??
        asNonEmptyString(value.backgroundPrompt) ??
        null;
      if (!prompt) return null;
      const cleaned = stripEmDashCharacters(prompt).trim();
      return cleaned.length > 0 ? truncateText(cleaned, 220) : null;
    })();

    const rawSlides = Array.isArray(value.slides)
      ? value.slides
      : Array.isArray(value.mediaItems)
        ? value.mediaItems
        : Array.isArray(value.items)
          ? value.items
          : [];
    const slides: TextPostVisualSlide[] = [];
    for (const rawSlide of rawSlides) {
      if (!isRecord(rawSlide)) continue;
      const imagePrompt =
        asNonEmptyString(rawSlide.imagePrompt) ??
        asNonEmptyString(rawSlide.prompt) ??
        asNonEmptyString(rawSlide.mediaPrompt) ??
        null;
      if (!imagePrompt) continue;
      const normalizedPrompt = stripEmDashCharacters(imagePrompt).trim();
      if (normalizedPrompt.length < 8) continue;
      const caption =
        asNonEmptyString(rawSlide.caption) ??
        asNonEmptyString(rawSlide.text) ??
        null;
      slides.push({
        caption: caption ? truncateText(stripEmDashCharacters(caption), 2200) : null,
        imagePrompt: truncateText(normalizedPrompt, 320),
      });
      if (slides.length >= 6) break;
    }

    if (
      renderMode === "text" &&
      captionPosition === null &&
      textStyle === null &&
      backgroundImagePrompt === null &&
      slides.length === 0
    ) {
      return null;
    }
    return {
      renderMode: renderMode === "slides" && slides.length >= 2 ? "slides" : "text",
      captionPosition,
      textStyle,
      backgroundImagePrompt,
      slides: slides.slice(0, 4),
    };
  }

  private buildTextPostVisualPlanPrompt(input: {
    postKind: "post" | "thread";
    caption: string | null;
    textBody: string;
    context: PostDraftContext;
  }): string {
    const contextLines = [
      typeof input.context.targetPostId === "number"
        ? `targetPostId: ${input.context.targetPostId}`
        : null,
      input.context.postText ? `targetPostText: ${input.context.postText}` : null,
      input.context.mediaSummary ? `targetMedia: ${input.context.mediaSummary}` : null,
      input.context.commentSummary ? `targetComments: ${input.context.commentSummary}` : null,
      input.context.payloadHint ? `directiveHint: ${input.context.payloadHint}` : null,
      input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
      input.context.platformSignals ? `platformSignals: ${input.context.platformSignals}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    return [
      "Plan visual presentation for this social post. Return strict JSON only.",
      "Shape:",
      '{"renderMode":"text|slides","captionPosition":"...|null","textStyle":{"theme":"warm|cool|night|sunrise|mint|ocean|plum|sand","align":"left|center|right","emphasis":"soft|bold|serif|mono|display","font":"sans|serif|mono|display","weight":"regular|bold","italic":false,"size":"sm|md|lg|xl|2xl","color":"ink|paper|cream|sunset|mint|sky","position":"top-left|top-center|top-right|middle-left|middle-center|middle-right|bottom-left|bottom-center|bottom-right","background":"optional css gradient or color"},"backgroundImagePrompt":"...|null","slides":[{"caption":"...","imagePrompt":"..."}]}',
      "Rules:",
      "- Never use em dash characters; use '-' or normal punctuation instead.",
      "- For kind=thread strongly prefer renderMode 'slides' whenever the text can be split into beats.",
      "- For kind=post choose slides when there is sequence/list/compare/story structure; otherwise use text mode.",
      "- If slides mode: provide 2-4 slides max, each with imagePrompt. Keep captions concise.",
      "- If text mode: always provide textStyle with a distinct visual identity.",
      "- backgroundImagePrompt is optional and only for text mode when image background helps.",
      "- imagePrompt/backgroundImagePrompt must be direct prompts, no wrappers like 'Generate an image of'.",
      `kind: ${input.postKind}`,
      `caption: ${input.caption ?? ""}`,
      `textBody: ${input.textBody}`,
      "Context:",
      ...contextLines.map((line) => `- ${line}`),
    ].join("\n");
  }

  private async planTextPostVisualWithOpenClaw(input: {
    commandId: string;
    postKind: "post" | "thread";
    caption: string | null;
    textBody: string;
    context: PostDraftContext;
  }): Promise<TextPostVisualPlan | null> {
    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) return null;
    const prompt = this.buildTextPostVisualPlanPrompt(input);
    try {
      const result = await runOpenClawPrompt({
        prompt,
        purpose: "text_post_visual_plan",
      });
      const plan =
        (result
          ? this.extractTextPostVisualPlanFromUnknown(result.parsed) ??
            this.extractTextPostVisualPlanFromUnknown(result.payloadText) ??
            this.extractTextPostVisualPlanFromUnknown(result.raw)
          : null) ?? null;
      if (!plan) return null;
      await this.ctx.memory
        .recordWrite({
          type: "text_post_visual_plan_created",
          at: nowIso(),
          commandId: input.commandId,
          renderMode: plan.renderMode,
          captionPosition: plan.captionPosition,
          hasTextStyle: plan.textStyle !== null,
          hasBackgroundImagePrompt: plan.backgroundImagePrompt !== null,
          slideCount: plan.slides.length,
        })
        .catch(() => undefined);
      return plan;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "text_post_visual_plan_failed",
          at: nowIso(),
          commandId: input.commandId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    }
  }

  private buildPostVarietyModeRules(
    mode: PostVarietyMode,
    postType: "text" | "media",
  ): string[] {
    const common = [
      `Variety mode: ${mode}.`,
      "Avoid repeating moody/introspective template language unless context explicitly asks for it.",
    ];
    if (mode === "opinion") {
      return [
        ...common,
        "Take a clear position and include one concrete reason.",
        postType === "text"
          ? "textBody must contain an explicit stance."
          : "caption must state the stance and mediaPrompt should reinforce it visually.",
      ];
    }
    if (mode === "reaction") {
      return [
        ...common,
        "Anchor output to one concrete platform signal, trend, or recent post context.",
        postType === "text"
          ? "Reference a current signal in plain language."
          : "mediaPrompt must depict the live signal/reaction moment, not a generic scene.",
      ];
    }
    if (mode === "humor") {
      return [
        ...common,
        "Use a punchy, playful angle and keep it socially shareable.",
        postType === "text"
          ? "Land one clear joke/bit and avoid over-explaining."
          : "mediaPrompt should imply the comedic beat visually without meme-template boilerplate.",
      ];
    }
    if (mode === "micro") {
      return [
        ...common,
        "Keep it concise and high-signal.",
        postType === "text"
          ? "textBody should be short (prefer 25-110 chars) but complete."
          : "caption should be compact (prefer 10-80 chars) with a focused mediaPrompt.",
      ];
    }
    return [
      ...common,
      "Use narrative specificity: place, action, and one concrete sensory detail.",
      postType === "text"
        ? "textBody should read like a real moment, not abstract mood prose."
        : "mediaPrompt should portray a specific scene/event with concrete details.",
    ];
  }

  private buildPostDraftCurationPrompt(input: {
    postType: "text" | "media";
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    varietyMode: PostVarietyMode;
    seedHints: string[];
    avoidReferences: string[];
  }): string {
    const contextLines = [
      typeof input.context.targetPostId === "number"
        ? `targetPostId: ${input.context.targetPostId}`
        : null,
      input.context.postText ? `targetPostText: ${input.context.postText}` : null,
      input.context.mediaSummary ? `targetMedia: ${input.context.mediaSummary}` : null,
      input.context.commentSummary ? `targetComments: ${input.context.commentSummary}` : null,
      input.context.payloadHint ? `directiveHint: ${input.context.payloadHint}` : null,
      input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
      input.context.platformSignals ? `platformSignals: ${input.context.platformSignals}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    if (input.postType === "text") {
      return [
        "Rewrite this directive-generated POST so it is original, social, and context-aware.",
        "Use memoryContext + targetPostText + targetComments as grounding, then produce a fresh thought.",
        "Do not echo or paraphrase target post text/comments. Synthesize a new opinion or angle.",
        "Return strict JSON only with exactly this shape: {\"caption\":\"...\",\"textBody\":\"...\"}.",
        "Rules:",
        "- textBody: 40-240 chars, natural voice, no hashtags, no emojis.",
        "- caption: optional, 0-140 chars.",
        "- Never use em dash characters; use '-' or normal punctuation instead.",
        "- Must not reuse long phrases from targetPostText/targetMedia/directiveHint.",
        "- Must not reuse long phrases from directive seed text.",
        "- Must not reuse long phrases from recent self-post references.",
        ...this.buildPostVarietyModeRules(input.varietyMode, "text").map((rule) => `- ${rule}`),
        `draftCaption: ${input.caption ?? ""}`,
        `draftTextBody: ${input.textBody ?? ""}`,
        ...(input.seedHints.length > 0
          ? [
              "Directive seeds (avoid echo):",
              ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
            ]
          : []),
        ...(input.avoidReferences.length > 0
          ? [
              "Recent self-post references (must differ):",
              ...input.avoidReferences.slice(0, POST_NOVELTY_MAX_AVOID_REFERENCES).map((entry) => `- ${entry}`),
            ]
          : []),
        "Context:",
        ...contextLines.map((line) => `- ${line}`),
      ].join("\n");
    }
    return [
      "Rewrite this directive-generated MEDIA POST so it is original and not an echo.",
      "Use memoryContext + targetPostText + targetComments to create a new media direction.",
      "Do not copy title/caption/prompt from source post/comments/directive.",
      "Return strict JSON only with exactly this shape: {\"caption\":\"...\",\"mediaPrompt\":\"...\"}.",
      "Rules:",
      "- caption: 10-220 chars, natural social voice, no hashtags, no emojis.",
      "- mediaPrompt: 20-320 chars, concrete visual prompt, no wrappers like 'Generate an image of'.",
      "- Never use em dash characters; use '-' or normal punctuation instead.",
      "- Must be materially different from targetPostText/targetMedia/directiveHint.",
      "- Must be materially different from directive seed text.",
      "- Must be materially different from recent self-post references.",
      ...this.buildPostVarietyModeRules(input.varietyMode, "media").map((rule) => `- ${rule}`),
      `draftCaption: ${input.caption ?? ""}`,
      `draftMediaPrompt: ${input.mediaPrompt ?? ""}`,
      ...(input.seedHints.length > 0
        ? [
            "Directive seeds (avoid echo):",
            ...input.seedHints.slice(0, 8).map((entry) => `- ${entry}`),
          ]
        : []),
      ...(input.avoidReferences.length > 0
        ? [
            "Recent self-post references (must differ):",
            ...input.avoidReferences.slice(0, POST_NOVELTY_MAX_AVOID_REFERENCES).map((entry) => `- ${entry}`),
          ]
        : []),
      "Context:",
      ...contextLines.map((line) => `- ${line}`),
    ].join("\n");
  }

  private extractCuratedPostDraftFromUnknown(
    value: unknown,
    postType: "text" | "media",
  ): { caption: string | null; textBody: string | null; mediaPrompt: string | null } | null {
    const fromString = (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed.length) return null;
      const parsed = parseJsonFromMixedText(trimmed);
      if (parsed !== null && parsed !== raw) {
        return this.extractCuratedPostDraftFromUnknown(parsed, postType);
      }
      return null;
    };
    if (typeof value === "string") {
      return fromString(value);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const parsed = this.extractCuratedPostDraftFromUnknown(entry, postType);
        if (parsed) return parsed;
      }
      return null;
    }
    if (!isRecord(value)) return null;
    const caption =
      asNonEmptyString(value.caption) ??
      asNonEmptyString(value.title) ??
      null;
    const textBody =
      asNonEmptyString(value.textBody) ??
      asNonEmptyString(value.body) ??
      asNonEmptyString(value.text) ??
      null;
    const mediaPrompt =
      asNonEmptyString(value.mediaPrompt) ??
      asNonEmptyString(value.imagePrompt) ??
      asNonEmptyString(value.prompt) ??
      null;
    if (postType === "text" && textBody) {
      return {
        caption: caption ? stripEmDashCharacters(caption) : null,
        textBody: truncateText(stripEmDashCharacters(textBody), 240),
        mediaPrompt: null,
      };
    }
    if (postType === "media" && (mediaPrompt || caption)) {
      return {
        caption: caption ? truncateText(stripEmDashCharacters(caption), 2200) : null,
        textBody: null,
        mediaPrompt: mediaPrompt ? truncateText(stripEmDashCharacters(mediaPrompt), 320) : null,
      };
    }
    for (const key of ["draft", "payload", "result", "output", "data", "content"] as const) {
      const nested = this.extractCuratedPostDraftFromUnknown(value[key], postType);
      if (nested) return nested;
    }
    return null;
  }

  private async curatePostDraftWithOpenClaw(input: {
    commandId: string;
    postType: "text" | "media";
    varietyMode: PostVarietyMode;
    caption: string | null;
    textBody: string | null;
    mediaPrompt: string | null;
    context: PostDraftContext;
    seedHints: string[];
    avoidReferences: string[];
  }): Promise<CuratedPostDraft | null> {
    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) return null;
    this.pruneCuratedPromptCaches();
    const cacheSignature = [
      input.varietyMode,
      input.caption ?? "",
      input.textBody ?? "",
      input.mediaPrompt ?? "",
      input.seedHints.join("|"),
      input.avoidReferences.join("|"),
    ].join("\n");
    const cacheKey = this.buildCuratedPostDraftCacheKey({
      commandId: input.commandId,
      postType: input.postType,
      signature: cacheSignature,
    });
    const cached = this.curatedPostDraftCache.get(cacheKey);
    if (cached) {
      return {
        caption: cached.value.caption,
        textBody: cached.value.textBody,
        mediaPrompt: cached.value.mediaPrompt,
      };
    }
    const prompt = this.buildPostDraftCurationPrompt({
      postType: input.postType,
      varietyMode: input.varietyMode,
      caption: input.caption,
      textBody: input.textBody,
      mediaPrompt: input.mediaPrompt,
      context: input.context,
      seedHints: input.seedHints,
      avoidReferences: input.avoidReferences,
    });
    try {
      const result = await runOpenClawPrompt({
        prompt,
        purpose: "post_draft_curation",
      });
      const curated =
        (result
          ? this.extractCuratedPostDraftFromUnknown(result.parsed, input.postType) ??
            this.extractCuratedPostDraftFromUnknown(result.payloadText, input.postType) ??
            this.extractCuratedPostDraftFromUnknown(result.raw, input.postType)
          : null) ?? null;
      if (!curated) return null;
      const candidate = [
        curated.caption ?? input.caption ?? "",
        curated.textBody ?? "",
        curated.mediaPrompt ?? "",
      ]
        .filter((value) => value.trim().length > 0)
        .join("\n");
      if (candidate.length < 12) return null;
      this.curatedPostDraftCache.set(cacheKey, {
        value: {
          caption: curated.caption,
          textBody: curated.textBody,
          mediaPrompt: curated.mediaPrompt,
        },
        cachedAtMs: Date.now(),
      });
      await this.ctx.memory
        .recordWrite({
            type: "post_draft_curated",
            at: nowIso(),
            commandId: input.commandId,
            postType: input.postType,
            varietyMode: input.varietyMode,
            caption: curated.caption,
            textBody: curated.textBody,
            mediaPrompt: curated.mediaPrompt,
        })
        .catch(() => undefined);
      return curated;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
            type: "post_draft_curation_failed",
            at: nowIso(),
            commandId: input.commandId,
            postType: input.postType,
            varietyMode: input.varietyMode,
            error: error instanceof Error ? error.message : String(error),
          })
        .catch(() => undefined);
      return null;
    }
  }

  private collectDirectiveSeedHints(payload: Record<string, unknown>): string[] {
    const candidates: string[] = [];
    const push = (value: unknown): void => {
      const text = asNonEmptyString(value);
      if (!text) return;
      candidates.push(text);
    };
    push(payload.requestText);
    push(payload.topic);
    push(payload.prompt);
    push(payload.mediaPrompt);
    push(payload.imagePrompt);
    push(payload.caption);
    push(payload.textBody);
    push(payload.body);
    push(payload.text);
    push(payload.message);
    push(payload.title);
    const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
    if (scope) {
      push(scope.reason);
      push(scope.note);
      push(scope.topic);
      push(scope.caption);
      push(scope.textBody);
      push(scope.body);
      push(scope.text);
      const target = isRecord(scope.target) ? scope.target : null;
      if (target) {
        push(target.caption);
        push(target.textBody);
        push(target.body);
      }
    }
    const normalized = new Set<string>();
    const deduped: string[] = [];
    for (const entry of candidates) {
      const clean = truncateText(entry, 320);
      const key = normalizeCommentText(clean);
      if (!key.length || normalized.has(key)) continue;
      normalized.add(key);
      deduped.push(clean);
    }
    return deduped.slice(0, 12);
  }

  private buildChatLiteralFallbackPayloadFromStory(input: {
    payload: Record<string, unknown>;
    fallbackPrompt?: string | null;
  }): Record<string, unknown> {
    const chatContext = isRecord(input.payload.chatContext) ? input.payload.chatContext : null;
    const fallbackPrompt =
      asNonEmptyString(input.fallbackPrompt) ??
      asNonEmptyString(input.payload.mediaPrompt) ??
      asNonEmptyString(input.payload.imagePrompt) ??
      asNonEmptyString(input.payload.prompt) ??
      asNonEmptyString(input.payload.topic) ??
      asNonEmptyString(input.payload.caption) ??
      asNonEmptyString(chatContext?.originalMessage) ??
      "Generate an image that fulfills this chat request.";

    const nextPayload: Record<string, unknown> = {
      ...input.payload,
      goal: "media",
      generateKind: "media",
      generatedAssetType: "image",
      chatLiteralGenerate: true,
      requireExplicitPublishVerb: false,
      explicitPublishRequested: false,
      explicitPublishVerbDetected: false,
    };
    nextPayload.prompt = fallbackPrompt;
    nextPayload.instruction = fallbackPrompt;
    nextPayload.topic = fallbackPrompt;
    nextPayload.mediaPrompt = fallbackPrompt;
    nextPayload.imagePrompt = fallbackPrompt;
    return nextPayload;
  }

  private async executeWriteCreateStory(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.createStory.");
    }
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    if (this.isChatOriginCommand(command, payload)) {
      const explicitStoryRequest = this.didChatMessageExplicitlyRequestStory(payload);
      if (!explicitStoryRequest) {
        await this.ctx.memory
          .recordWrite({
            type: "story_write_redirected_chat_request",
            at: nowIso(),
            commandId: command.id,
            commandKind: command.kind,
            sourceDirectiveId,
          })
          .catch(() => undefined);
        const fallbackPayload = this.buildChatLiteralFallbackPayloadFromStory({
          payload,
        });
        return this.executeChatLiteralGenerate(command, fallbackPayload);
      }
      await this.ctx.memory
          .recordWrite({
            type: "story_write_blocked_chat_request",
            at: nowIso(),
            commandId: command.id,
            commandKind: command.kind,
            sourceDirectiveId,
          })
          .catch(() => undefined);
      return this.failedOutcome(
        command,
        "Story creation is directive-only. Chat requests can create posts, but not stories.",
        "story_chat_disabled",
      );
    }
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const explicitSaveAsProfileMemory =
      typeof payload.saveAsProfileMemory === "boolean"
        ? payload.saveAsProfileMemory
        : null;
    const caption = asNonEmptyString(payload.caption);
    const baseStoryPrompt =
      asNonEmptyString(payload.mediaPrompt) ??
      asNonEmptyString(payload.imagePrompt) ??
      asNonEmptyString(payload.prompt) ??
      asNonEmptyString(payload.topic) ??
      caption ??
      "a candid original day-in-the-life moment";
    const autonomousTheme = this.resolveAutonomousTextTheme({
      commandId: command.id,
      postKind: "post",
      caption,
      textBody: baseStoryPrompt,
    });
    const autonomousStoryPrompt = this.buildAutonomousVisualPrompt({
      basePrompt: baseStoryPrompt,
      caption,
      commandId: command.id,
      theme: autonomousTheme,
      mode: "story",
      index: 0,
    });
    const captionPositionForWrite =
      this.normalizeCaptionPositionValue(payload.captionPosition) ??
      this.resolveAutonomousCaptionPosition({
        commandId: command.id,
        postKind: "post",
        seedText: `${caption ?? ""} ${baseStoryPrompt ?? ""}`,
      });
    const storyPayload: Record<string, unknown> = {
      ...payload,
    };
    const personaReferencePlan = this.resolvePersonaReferencePlan(
      payload,
      null,
      command,
    );
    const personaDrivenStoryGeneration =
      this.shouldUsePersonaFrameReferences(personaReferencePlan);
    const saveAsProfileMemory =
      explicitSaveAsProfileMemory ?? personaDrivenStoryGeneration;
    const carriedMediaPresent =
      asNonEmptyString(payload.mediaUrl) !== null ||
      (Array.isArray(payload.mediaItems) && payload.mediaItems.length > 0) ||
      isRecord(payload.recentGeneratedAsset);
    delete storyPayload.mediaUrl;
    delete storyPayload.mediaOriginalUrl;
    delete storyPayload.mediaOptimizedUrl;
    delete storyPayload.mediaContentHash;
    delete storyPayload.mediaIpfsCid;
    delete storyPayload.mediaSizeBytes;
    delete storyPayload.mediaType;
    delete storyPayload.mediaItems;
    delete storyPayload.recentGeneratedAsset;
    if (carriedMediaPresent) {
      await this.ctx.memory
        .recordWrite({
          type: "story_media_carryover_stripped",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          sourceDirectiveId,
        })
        .catch(() => undefined);
    }

    const media = await this.resolveMediaUpload({
      payload: storyPayload,
      keepOriginal: false,
      promptFallbacks: [
        autonomousStoryPrompt,
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
        asNonEmptyString(payload.prompt),
      ],
      command,
    });

    const result = await this.agent().createStory.mutate({
      mediaUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
      ...(media.mediaType ? { mediaType: media.mediaType } : {}),
      ...(caption ? { caption } : {}),
      ...(saveAsProfileMemory ? { saveAsProfileMemory: true } : {}),
      ...(captionPositionForWrite ? { captionPosition: captionPositionForWrite } : {}),
      ...(asNonEmptyString(payload.mediaFit) ? { mediaFit: asNonEmptyString(payload.mediaFit) } : {}),
      ...(asPositiveInt(payload.expiresInSeconds)
        ? { expiresInSeconds: asPositiveInt(payload.expiresInSeconds) }
        : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      ...(command.grantId ? { grantId: command.grantId } : {}),
    });
    return this.successOutcome(command, result);
  }

  private async executeWriteUpdateAvatar(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.updateAvatar.");
    }
    const target = this.resolveProfileWriteTarget(asNonEmptyString(payload.target));
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;

    const media = await this.resolveMediaUpload({
      payload,
      keepOriginal: false,
      promptFallbacks: [
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
        asNonEmptyString(payload.prompt),
      ],
      command,
    });
    const result = await this.updateAvatar({
      target,
      imageUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
      ...(typeof media.mediaSizeBytes === "number" ? { sizeBytes: media.mediaSizeBytes } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    });
    return this.successOutcome(command, result);
  }

  private async executeWriteUpdateBanner(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.updateBanner.");
    }
    const target = this.resolveProfileWriteTarget(asNonEmptyString(payload.target));
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;

    const media = await this.resolveMediaUpload({
      payload,
      keepOriginal: false,
      promptFallbacks: [
        asNonEmptyString(payload.mediaPrompt),
        asNonEmptyString(payload.imagePrompt),
        asNonEmptyString(payload.prompt),
      ],
      command,
    });
    const result = await this.updateBanner({
      target,
      bannerUrl: media.mediaUrl,
      ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
      ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
      ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
      ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
      ...(typeof media.mediaSizeBytes === "number" ? { sizeBytes: media.mediaSizeBytes } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
    });
    return this.successOutcome(command, result);
  }

  private async executeWriteComment(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for write.commentPost.");
    }
    const body =
      asNonEmptyString(payload.body) ??
      asNonEmptyString(payload.requestText) ??
      asNonEmptyString(payload.prompt) ??
      "Write a concise, relevant reply to the target post.";
    let resolvedTarget: EngagementTargetCandidate | null = null;
    try {
      resolvedTarget =
        (await this.resolveEngagementTargetForDirective({
          payload,
          action: "comment",
          commandId: command.id,
        })) ?? null;
    } catch (error: unknown) {
      if (this.isNoTargetDiscoveryFailure(error)) {
        return this.failedOutcome(
          command,
          "No target post/comment candidates found after discovery scan.",
          "no_target_candidates",
        );
      }
      throw error;
    }
    if (!resolvedTarget) {
      throw new RequeueCommandError("comment_target_resolution_waiting_for_context:no_target");
    }
    const postId = resolvedTarget.postId;
    const parentId =
      asPositiveInt(payload.parentId) ??
      asPositiveInt(payload.commentId) ??
      asPositiveInt(payload.targetCommentId) ??
      resolvedTarget.commentId ??
      null;
    payload.postId = postId;
    payload.targetPostId = postId;
    if (parentId) {
      payload.parentId = parentId;
      payload.commentId = parentId;
      payload.targetCommentId = parentId;
    }
    if (resolvedTarget.postSnapshotHash) {
      payload.targetPostSnapshotHash = resolvedTarget.postSnapshotHash;
      payload.postSnapshotHash = resolvedTarget.postSnapshotHash;
    }
    const expectedTarget = {
      postId,
      commentId: parentId ?? null,
      targetHash: buildTargetHash({
        postId,
        commentId: parentId ?? null,
      }),
    };
    const lockMatch = isTargetLockMatch({
      payload,
      expected: expectedTarget,
    });
    if (!lockMatch.ok) {
      return this.failedOutcome(
        command,
        `Target lock mismatch: ${lockMatch.reason}.`,
        "target_lock_mismatch",
      );
    }
    const target = applyTargetLock(payload, {
      postId,
      commentId: parentId ?? null,
    });
    const idempotencyKey = this.buildActionIdempotencyKey({
      command,
      action: "comment",
      postId: target.postId,
      commentId: target.commentId,
      commentBody: body,
    });
    const dedupe = this.beginActionLifecycle({
      command,
      action: "comment",
      idempotencyKey,
      target,
      state: "context_ready",
    });
    if (!dedupe.allowed) {
      if (dedupe.requeue) {
        throw new RequeueCommandError(
          `comment_waiting_for_backoff:${dedupe.reason}`,
        );
      }
      return this.successOutcome(command, {
        skipped: true,
        action: "comment",
        postId: target.postId,
        commentId: target.commentId,
        decision: dedupe.reason,
      });
    }
    try {
      const grantId = await this.preflightGrantForAction({
        command,
        payload,
        action: "comment",
        lifecycle: {
          idempotencyKey,
          target,
        },
      });
      const provenance = normalizeAgentProvenanceValue(payload.provenance);
      const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
        command,
        payload,
      });
      const sourceDirectiveActionNonce =
        asNonEmptyString(payload.sourceDirectiveActionNonce) ??
        command.actionNonce ??
        null;
      const curatedBody = await this.curateCommentBodyWithOpenClaw({
        command,
        payload,
        postId: target.postId,
        parentId: target.commentId,
        body,
        targetHash: target.targetHash,
        lifecycleIdempotencyKey: idempotencyKey,
      });
      this.updateActionLifecycle({
        command,
        action: "comment",
        idempotencyKey,
        target,
        state: "action_running",
      });
      const finalBody = stripEmDashCharacters(curatedBody.body);
      const result = await this.agent().commentPost.mutate({
        postId: target.postId,
        body: finalBody,
        ...(target.commentId ? { parentId: target.commentId } : {}),
        ...(provenance ? { provenance } : {}),
        ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
        ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
        ...(grantId ? { grantId } : {}),
      });
      await this.ctx.memory
        .recordWrite({
          type: "comment_body_curated",
          at: nowIso(),
          commandId: command.id,
          postId: target.postId,
          parentId: target.commentId,
          source: curatedBody.source,
          reason: curatedBody.reason,
          draftBody: truncateText(body, 200),
          finalBody: truncateText(finalBody, 200),
        })
        .catch(() => undefined);
      this.updateActionLifecycle({
        command,
        action: "comment",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, result);
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        this.updateActionLifecycle({
          command,
          action: "comment",
          idempotencyKey,
          target,
          state: "requeue",
          lastError: error.message,
        });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isOwnerCapabilityDeniedError(error)) {
        this.registerOwnerCapabilityCooldown({
          action: "comment",
          targetHash: target.targetHash,
          reason: "not_granted",
        });
      }
      this.updateActionLifecycle({
        command,
        action: "comment",
        idempotencyKey,
        target,
        state: "failed",
        lastError: message,
      });
      throw error;
    }
  }

  private async curateCommentBodyWithOpenClaw(input: {
    command: Command;
    payload: Record<string, unknown>;
    postId: number;
    parentId: number | null;
    body: string;
    targetHash: string;
    lifecycleIdempotencyKey: string;
  }): Promise<CuratedCommentBody> {
    const context = await this.loadCommentCurationContext({
      postId: input.postId,
      parentId: input.parentId,
      payload: input.payload,
    });
    const draftBody = input.body.trim();
    if (!draftBody.length) {
      throw new Error("Comment blocked: empty draft body.");
    }
    const attemptDraftFallback = async (reason: string): Promise<CuratedCommentBody | null> => {
      const fallback = this.buildDraftCommentFallback({
        draftBody,
        context,
      });
      if (!fallback) return null;
      await this.ctx.memory
        .recordWrite({
          type: "comment_body_curation_fallback",
          at: nowIso(),
          commandId: input.command.id,
          postId: input.postId,
          parentId: input.parentId,
          reason,
          draftBody: truncateText(draftBody, 200),
          fallbackBody: truncateText(fallback.body, 200),
        })
        .catch(() => undefined);
      return fallback;
    };

    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) {
      const fallback = await attemptDraftFallback("openclaw_required_unavailable");
      if (fallback) return fallback;
      throw new RequeueCommandError(
        "comment_curation_waiting_for_openclaw:openclaw_required_unavailable",
      );
    }
    if (!context.postText && !context.mediaSummary && !context.threadSummary) {
      await this.ctx.memory
        .recordWrite({
          type: "comment_body_curation_blocked",
          at: nowIso(),
          commandId: input.command.id,
          postId: input.postId,
          parentId: input.parentId,
          reason: "missing_target_post_context",
        })
        .catch(() => undefined);
      const fallback = await attemptDraftFallback("missing_target_post_context");
      if (fallback) return fallback;
      throw new RequeueCommandError(
        "comment_curation_waiting_for_target_context:missing_target_post_context",
      );
    }
    let attemptedOpenClawCuration = false;
    let openClawCurationErrored = false;
    attemptedOpenClawCuration = true;
    try {
      this.updateActionLifecycle({
        command: input.command,
        action: "comment",
        idempotencyKey: input.lifecycleIdempotencyKey,
        target: {
          postId: input.postId,
          commentId: input.parentId,
          targetHash: input.targetHash,
        },
        state: "llm_running",
      });
      const curationPrompt = this.buildCommentCurationPrompt({
        postId: input.postId,
        parentId: input.parentId,
        targetHash: input.targetHash,
        draftBody,
        context,
      });
      const result = await runOpenClawPrompt({
        prompt: curationPrompt,
        purpose: "comment_body_curation",
      });
      const contract =
        (result
          ? this.extractActionContractFromUnknown({
            value: result.parsed,
            action: "comment",
            expectedPostId: input.postId,
            expectedCommentId: input.parentId,
            expectedTargetHash: input.targetHash,
          }) ??
            this.extractActionContractFromUnknown({
              value: result.payloadText,
              action: "comment",
              expectedPostId: input.postId,
              expectedCommentId: input.parentId,
              expectedTargetHash: input.targetHash,
            }) ??
            this.extractActionContractFromUnknown({
              value: result.raw,
              action: "comment",
              expectedPostId: input.postId,
              expectedCommentId: input.parentId,
              expectedTargetHash: input.targetHash,
            })
          : null) ?? null;
      if (contract) {
        if (!contract.shouldExecute || !contract.body) {
          await this.ctx.memory
            .recordWrite({
              type: "comment_body_curation_rejected",
              at: nowIso(),
              commandId: input.command.id,
              postId: input.postId,
              reason: contract.shouldExecute ? "missing_body" : "llm_declined_execute",
              draftBody: truncateText(draftBody, 200),
            })
            .catch(() => undefined);
        }
        if (contract.shouldExecute && contract.body) {
          const validation = this.validateCuratedCommentCandidate({
            candidate: contract.body,
            draftBody,
            context,
          });
          if (validation.ok) {
            return {
              body: contract.body,
              source: "openclaw",
              reason: "openclaw_curated",
            };
          }
          await this.ctx.memory
            .recordWrite({
              type: "comment_body_curation_rejected",
              at: nowIso(),
              commandId: input.command.id,
              postId: input.postId,
              reason: validation.reason,
              draftBody: truncateText(draftBody, 200),
              candidate: truncateText(contract.body, 200),
            })
            .catch(() => undefined);
        }
      } else {
        await this.ctx.memory
          .recordWrite({
            type: "comment_body_curation_missing_contract",
            at: nowIso(),
            commandId: input.command.id,
            postId: input.postId,
          })
          .catch(() => undefined);
      }
    } catch (error: unknown) {
      openClawCurationErrored = true;
      await this.ctx.memory
        .recordWrite({
          type: "comment_body_curation_failed",
          at: nowIso(),
          commandId: input.command.id,
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }

    if (openClawCurationErrored) {
      const fallback = await attemptDraftFallback("openclaw_curation_failed");
      if (fallback) return fallback;
      throw new RequeueCommandError(
        "comment_curation_waiting_for_openclaw:openclaw_curation_failed",
      );
    }
    const fallback = await attemptDraftFallback(
      attemptedOpenClawCuration
        ? "target_specific_llm_curation_required"
        : "missing_llm_curation",
    );
    if (fallback) return fallback;
    await this.ctx.memory
      .recordWrite({
        type: "comment_body_curation_blocked",
        at: nowIso(),
        commandId: input.command.id,
        postId: input.postId,
        parentId: input.parentId,
        reason: attemptedOpenClawCuration
          ? "target_specific_llm_curation_required"
          : "missing_llm_curation",
        draftBody: truncateText(draftBody, 200),
      })
      .catch(() => undefined);
    throw new RequeueCommandError(
      "comment_curation_waiting_for_openclaw:openclaw_contract_invalid",
    );
  }

  private async loadCommentCurationContext(input: {
    postId: number;
    parentId: number | null;
    payload: Record<string, unknown>;
  }): Promise<CommentCurationContext> {
    const context: CommentCurationContext = {
      postAuthorHandle: null,
      postText: null,
      mediaSummary: null,
      threadSummary: null,
      payloadHint: this.extractCommentPayloadHint(input.payload),
      memorySummary: await this.loadEngagementMemorySummary({
        action: "comment",
        postId: input.postId,
        commentId: input.parentId,
        payload: input.payload,
      }),
    };

    const callAgentChatBridge = this.ctx.callAgentChatBridge;
    if (!callAgentChatBridge) {
      return context;
    }

    try {
      const postResponse = await callAgentChatBridge({
        action: "find_post",
        postId: input.postId,
      });
      const postRecord = this.extractPostRecordForCommentCuration(
        postResponse,
        input.postId,
      );
      if (postRecord) {
        const author = isRecord(postRecord.author) ? postRecord.author : null;
        context.postAuthorHandle =
          asNonEmptyString(author?.handle) ??
          asNonEmptyString(postRecord.authorHandle);
        context.postText =
          asNonEmptyString(postRecord.textBody) ??
          asNonEmptyString(postRecord.caption) ??
          asNonEmptyString(postRecord.body);
        context.mediaSummary = this.summarizePostMediaForComment(postRecord);
      }
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "comment_curation_post_lookup_failed",
          at: nowIso(),
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }

    if (input.parentId) {
      try {
        const commentResponse = await callAgentChatBridge({
          action: "find_comment",
          postId: input.postId,
          commentId: input.parentId,
        });
        const commentRecord = this.extractCommentRecordForCommentCuration(commentResponse);
        if (commentRecord) {
          const commentAuthor = isRecord(commentRecord.author)
            ? commentRecord.author
            : null;
          const commentAuthorHandle =
            asNonEmptyString(commentAuthor?.handle) ??
            asNonEmptyString(commentRecord.authorHandle) ??
            "user";
          const commentBody =
            asNonEmptyString(commentRecord.body) ??
            asNonEmptyString(commentRecord.textBody);
          if (commentBody) {
            context.threadSummary = truncateText(
              `Reply target @${commentAuthorHandle}: ${commentBody}`,
              220,
            );
          }
        }
      } catch (error: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "comment_curation_parent_lookup_failed",
            at: nowIso(),
            postId: input.postId,
            parentId: input.parentId,
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
    }

    return context;
  }

  private extractCommentPayloadHint(payload: Record<string, unknown>): string | null {
    const hint = [
      asNonEmptyString(payload.requestText),
      asNonEmptyString(payload.topic),
      asNonEmptyString(payload.prompt),
      asNonEmptyString(payload.caption),
      asNonEmptyString(payload.textBody),
    ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return hint ? truncateText(hint, 180) : null;
  }

  private async loadEngagementMemorySummary(input: {
    action: "comment" | "like" | "repost";
    postId: number;
    commentId: number | null;
    payload: Record<string, unknown>;
  }): Promise<string | null> {
    if (typeof this.ctx.memory.buildContext !== "function") {
      return null;
    }
    try {
      const request: ContextRequest = {
        mode: "engagement",
        audience: "runtime_write",
        postId: input.postId,
        ...(typeof input.commentId === "number" ? { commentId: input.commentId } : {}),
        maxRecentEvents: 120,
        maxArchiveEvents: 40,
        includeViewState: true,
        viewStateMaxItems: 10,
        includeKeywordRetrieval: true,
        retrievalIntent: "engagement",
        retrievalMaxItems: 10,
        retrievalQuery: this.buildEngagementRetrievalQuery(input),
      };
      const bundle = await this.ctx.memory.buildContext(request);
      return this.buildCompactEngagementMemorySummary(bundle);
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_memory_context_failed",
          at: nowIso(),
          action: input.action,
          postId: input.postId,
          commentId: input.commentId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    }
  }

  private buildEngagementRetrievalQuery(input: {
    action: "comment" | "like" | "repost";
    postId: number;
    commentId: number | null;
    payload: Record<string, unknown>;
  }): string {
    const payloadHint = this.extractCommentPayloadHint(input.payload);
    const actionPhrase =
      input.action === "comment"
        ? "comment engagement context"
        : input.action === "like"
          ? "like engagement context"
          : "repost engagement context";
    const commentToken =
      typeof input.commentId === "number" ? `comment ${input.commentId}` : "";
    const hintToken = payloadHint ? `hint ${payloadHint}` : "";
    const scopeToken =
      input.action === "comment"
        ? "target post and thread only"
        : "most engaged comments last comments, likes and views this week";
    return [
      actionPhrase,
      `post ${input.postId}`,
      commentToken,
      scopeToken,
      hintToken,
    ]
      .filter((value) => value.length > 0)
      .join(" · ");
  }

  private buildCompactEngagementMemorySummary(bundle: ContextBundle): string | null {
    const lines: string[] = [];
    if (
      isRecord(bundle.retrieval) &&
      bundle.retrieval.enabled === true &&
      Array.isArray(bundle.retrieval.lines)
    ) {
      lines.push(
        ...bundle.retrieval.lines
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, 8)
          .map((entry) => `retrieval: ${entry.trim()}`),
      );
    }
    if (
      isRecord(bundle.view) &&
      bundle.view.enabled === true &&
      Array.isArray(bundle.view.lines)
    ) {
      lines.push(
        ...bundle.view.lines
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, 6)
          .map((entry) => `view: ${entry.trim()}`),
      );
    }
    if (
      isRecord(bundle.target) &&
      isRecord(bundle.target.focus) &&
      Array.isArray(bundle.target.focus.bullets)
    ) {
      lines.push(
        ...bundle.target.focus.bullets
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, 6)
          .map((entry) => `focus: ${entry.trim()}`),
      );
    }
    if (
      isRecord(bundle.temporal) &&
      isRecord(bundle.temporal.tiers) &&
      isRecord(bundle.temporal.tiers["24h"]) &&
      Array.isArray(bundle.temporal.tiers["24h"].bullets)
    ) {
      lines.push(
        ...bundle.temporal.tiers["24h"].bullets
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .slice(0, 2)
          .map((entry) => `tier24h: ${entry.trim()}`),
      );
    }
    if (lines.length === 0) return null;
    return truncateText(lines.join("\n"), 2200);
  }

  private extractPostRecordForCommentCuration(
    value: unknown,
    expectedPostId: number,
  ): Record<string, unknown> | null {
    if (!isRecord(value)) return null;
    if (isRecord(value.data)) {
      return this.extractPostRecordForCommentCuration(value.data, expectedPostId);
    }
    if (isRecord(value.post)) {
      const postId = asPositiveInt(value.post.id);
      if (postId === expectedPostId) return value.post;
      return null;
    }
    if (Array.isArray(value.items)) {
      const items = value.items as unknown[];
      const match = items.find((entry): entry is Record<string, unknown> => {
        if (!isRecord(entry)) return false;
        const postId = asPositiveInt(entry.id);
        return postId === expectedPostId;
      });
      if (match) return match;
      return null;
    }
    const rootPostId = asPositiveInt(value.id);
    if (rootPostId === expectedPostId) {
      return value;
    }
    return null;
  }

  private extractCommentRecordForCommentCuration(
    value: unknown,
  ): Record<string, unknown> | null {
    if (!isRecord(value)) return null;
    if (isRecord(value.data)) return this.extractCommentRecordForCommentCuration(value.data);
    if (isRecord(value.comment)) return value.comment;
    if (Array.isArray(value.comments)) {
      const first = value.comments.find((entry) => isRecord(entry));
      if (isRecord(first)) return first;
      return null;
    }
    return value;
  }

  private async resolveCommentAuthorIdForTarget(input: {
    postId: number;
    commentId: number;
  }): Promise<string | null> {
    if (!this.ctx.callAgentChatBridge) return null;
    try {
      const lookup = await this.callAgentBridgeLookupCached({
        action: "find_comment",
        postId: input.postId,
        commentId: input.commentId,
      });
      const record = this.extractCommentRecordForCommentCuration(lookup.value);
      if (record) {
        const author = isRecord(record.author) ? record.author : null;
        const authorId =
          asNonEmptyString(record.authorId) ??
          asNonEmptyString(author?.mainUserId) ??
          asNonEmptyString(author?.id) ??
          null;
        if (authorId) return authorId;
      }
    } catch {
      // best effort only
    }
    try {
      const lookup = await this.callAgentBridgeLookupCached({
        action: "browse_comments",
        postId: input.postId,
        limit: 40,
      });
      for (const item of this.collectBridgeRecordItems(lookup.value)) {
        const entryCommentId =
          asPositiveInt(item.commentId) ??
          asPositiveInt(item.id);
        if (!entryCommentId || entryCommentId !== input.commentId) continue;
        const author = isRecord(item.author) ? item.author : null;
        const authorId =
          asNonEmptyString(item.authorId) ??
          asNonEmptyString(author?.mainUserId) ??
          asNonEmptyString(author?.id) ??
          null;
        if (authorId) return authorId;
      }
    } catch {
      // best effort only
    }
    return null;
  }

  private summarizeCommentsForPostDraft(value: unknown): string | null {
    if (!isRecord(value)) return null;
    const root = isRecord(value.data) ? value.data : value;
    const commentsRaw = Array.isArray(root.comments) ? root.comments : [];
    if (commentsRaw.length === 0) return null;
    const snippets: string[] = [];
    for (const item of commentsRaw) {
      if (!isRecord(item)) continue;
      const author = isRecord(item.author) ? item.author : null;
      const handle =
        asNonEmptyString(author?.handle) ??
        asNonEmptyString(item.authorHandle) ??
        "user";
      const body =
        asNonEmptyString(item.body) ??
        asNonEmptyString(item.textBody) ??
        null;
      if (!body) continue;
      snippets.push(`@${handle}: ${truncateText(body, 100)}`);
      if (snippets.length >= 5) break;
    }
    if (snippets.length === 0) return null;
    return truncateText(snippets.join(" | "), 600);
  }

  private summarizePostMediaForComment(post: Record<string, unknown>): string | null {
    const mediaItems = Array.isArray(post.mediaItems)
      ? post.mediaItems.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    if (mediaItems.length === 0) return null;
    let imageCount = 0;
    let videoCount = 0;
    const captionHints: string[] = [];
    for (const item of mediaItems) {
      const mediaType = asNonEmptyString(item.mediaType)?.toLowerCase();
      if (mediaType === "video") {
        videoCount += 1;
      } else {
        imageCount += 1;
      }
      const caption = asNonEmptyString(item.caption);
      if (caption && captionHints.length < 3) {
        captionHints.push(truncateText(caption, 80));
      }
    }
    const bits = [
      imageCount > 0 ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : null,
      videoCount > 0 ? `${videoCount} video${videoCount === 1 ? "" : "s"}` : null,
      captionHints.length > 0 ? `cues: ${captionHints.join(" | ")}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    if (bits.length === 0) return null;
    return truncateText(bits.join(". "), 220);
  }

  private buildCommentCurationPrompt(input: {
    postId: number;
    parentId: number | null;
    targetHash: string;
    draftBody: string;
    context: CommentCurationContext;
  }): string {
    const contextLines = [
      `postId: ${input.postId}`,
      input.context.postAuthorHandle
        ? `postAuthor: @${input.context.postAuthorHandle.replace(/^@+/u, "")}`
        : null,
      input.context.postText ? `postText: ${input.context.postText}` : null,
      input.context.mediaSummary ? `mediaContext: ${input.context.mediaSummary}` : null,
      input.context.threadSummary ? `threadContext: ${input.context.threadSummary}` : null,
      input.context.payloadHint ? `requestHint: ${input.context.payloadHint}` : null,
      input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
    ].filter((entry): entry is string => Boolean(entry));

    return [
      "You are rewriting a social-media comment for quality and relevance.",
      "Return strict JSON only with exactly this shape: {\"body\":\"...\"}.",
      "Rules:",
      "- body must be 14-180 characters.",
      "- 1-2 concise sentences in a natural voice.",
      "- Must clearly reference THIS target post/thread context.",
      "- Include at least one concrete detail from post/media/thread context.",
      "- Do not copy wording from the draft or post text.",
      "- Never start with 'Frame N:' and never output image-prompt wrappers.",
      "- No hashtags, no emojis, no system/tool mentions.",
      "- Never use em dash characters; use '-' or normal punctuation instead.",
      "Return strict JSON ONLY with this exact shape:",
      `{"action":"comment","target":{"postId":${input.postId},"commentId":${input.parentId ?? "null"},"targetHash":"${input.targetHash}"},"body":"<comment>","reason":"<short reason>","shouldExecute":true}`,
      `Draft comment: ${input.draftBody}`,
      "Context:",
      ...contextLines.map((line) => `- ${line}`),
    ].join("\n");
  }

  private normalizeCuratedCommentBody(value: string): string {
    const unfenced = value
      .replace(/^```(?:json|text|markdown)?\s*/iu, "")
      .replace(/```$/u, "")
      .trim();
    const unquoted = unfenced.replace(/^["'`]|["'`]$/gu, "").trim();
    const stripped = unquoted.replace(/^(?:body|comment|reply)\s*:\s*/iu, "").trim();
    return stripEmDashCharacters(stripped).replace(/\s+/gu, " ").trim();
  }

  private extractCuratedCommentBodyFromUnknown(value: unknown): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.length) return null;
      const parsed = parseJsonFromMixedText(trimmed);
      if (parsed !== null && parsed !== value) {
        const fromParsed = this.extractCuratedCommentBodyFromUnknown(parsed);
        if (fromParsed) return fromParsed;
      }
      const normalized = this.normalizeCuratedCommentBody(trimmed);
      return normalized.length > 0 ? normalized : null;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const extracted = this.extractCuratedCommentBodyFromUnknown(entry);
        if (extracted) return extracted;
      }
      return null;
    }
    if (!isRecord(value)) return null;
    const keys = ["body", "comment", "reply", "text", "output", "result", "content"] as const;
    for (const key of keys) {
      const extracted = this.extractCuratedCommentBodyFromUnknown(value[key]);
      if (extracted) return extracted;
    }
    return null;
  }

  private validateCuratedCommentCandidate(input: {
    candidate: string;
    draftBody: string;
    context: CommentCurationContext;
  }): { ok: true } | { ok: false; reason: string } {
    const candidate = input.candidate.trim();
    if (candidate.length < 10) {
      return { ok: false, reason: "too_short" };
    }
    if (candidate.length > 280) {
      return { ok: false, reason: "too_long" };
    }
    if (COMMENT_ECHO_PREFIX_PATTERN.test(candidate)) {
      return { ok: false, reason: "frame_prefix" };
    }
    if (COMMENT_PROMPT_WRAPPER_PATTERN.test(candidate)) {
      return { ok: false, reason: "prompt_wrapper" };
    }
    const normalizedCandidate = normalizeCommentText(candidate);
    const normalizedDraft = normalizeCommentText(input.draftBody);
    if (normalizedCandidate === normalizedDraft) {
      return { ok: false, reason: "same_as_draft" };
    }
    const draftOverlap = computeTokenOverlapRatio(candidate, input.draftBody);
    if (draftOverlap >= 0.86) {
      return { ok: false, reason: "too_similar_to_draft" };
    }
    if (hasLongNormalizedPhraseOverlap(candidate, input.draftBody)) {
      return { ok: false, reason: "contains_draft_phrase" };
    }
    if (input.context.postText) {
      const normalizedPostText = normalizeCommentText(input.context.postText);
      if (normalizedCandidate === normalizedPostText) {
        return { ok: false, reason: "same_as_post_text" };
      }
      const overlap = computeTokenOverlapRatio(candidate, input.context.postText);
      if (overlap >= 0.86) {
        return { ok: false, reason: "too_similar_to_post_text" };
      }
      if (hasLongNormalizedPhraseOverlap(candidate, input.context.postText)) {
        return { ok: false, reason: "contains_post_phrase" };
      }
    }
    if (input.context.mediaSummary) {
      const overlap = computeTokenOverlapRatio(candidate, input.context.mediaSummary);
      if (overlap >= 0.9) {
        return { ok: false, reason: "too_similar_to_media_summary" };
      }
      if (hasLongNormalizedPhraseOverlap(candidate, input.context.mediaSummary)) {
        return { ok: false, reason: "contains_media_summary_phrase" };
      }
    }
    if (input.context.threadSummary) {
      const overlap = computeTokenOverlapRatio(candidate, input.context.threadSummary);
      if (overlap >= 0.82) {
        return { ok: false, reason: "too_similar_to_thread_summary" };
      }
      if (hasLongNormalizedPhraseOverlap(candidate, input.context.threadSummary)) {
        return { ok: false, reason: "contains_thread_phrase" };
      }
    }
    if (input.context.payloadHint) {
      const overlap = computeTokenOverlapRatio(candidate, input.context.payloadHint);
      if (overlap >= 0.84) {
        return { ok: false, reason: "too_similar_to_payload_hint" };
      }
      if (hasLongNormalizedPhraseOverlap(candidate, input.context.payloadHint)) {
        return { ok: false, reason: "contains_payload_hint_phrase" };
      }
    }
    if (!this.hasTargetContextAnchor(candidate, input.context)) {
      return { ok: false, reason: "missing_target_context_anchor" };
    }
    return { ok: true };
  }

  private hasTargetContextAnchor(
    candidate: string,
    context: CommentCurationContext,
  ): boolean {
    const anchorSource = [
      context.postText ?? "",
      context.mediaSummary ?? "",
      context.threadSummary ?? "",
    ]
      .filter((part) => part.trim().length > 0)
      .join(" \n ");
    const anchorTokens = Array.from(new Set(tokenizeCommentText(anchorSource)));
    if (anchorTokens.length < 3) {
      return true;
    }
    const candidateTokens = new Set(tokenizeCommentText(candidate));
    if (candidateTokens.size === 0) {
      return false;
    }
    const minimumOverlap = anchorTokens.length >= 12 ? 2 : 1;
    let overlap = 0;
    for (const token of anchorTokens) {
      if (candidateTokens.has(token)) {
        overlap += 1;
        if (overlap >= minimumOverlap) {
          return true;
        }
      }
    }
    return false;
  }

  private isDraftCommentEchoLike(body: string, context: CommentCurationContext): boolean {
    const trimmed = body.trim();
    if (!trimmed.length) return true;
    if (COMMENT_ECHO_PREFIX_PATTERN.test(trimmed)) return true;
    if (COMMENT_PROMPT_WRAPPER_PATTERN.test(trimmed)) return true;
    if (
      context.postText &&
      normalizeCommentText(trimmed) === normalizeCommentText(context.postText)
    ) {
      return true;
    }
    if (context.postText && computeTokenOverlapRatio(trimmed, context.postText) >= 0.9) {
      return true;
    }
    if (
      context.postText &&
      hasLongNormalizedPhraseOverlap(trimmed, context.postText)
    ) {
      return true;
    }
    if (context.mediaSummary && computeTokenOverlapRatio(trimmed, context.mediaSummary) >= 0.9) {
      return true;
    }
    if (
      context.mediaSummary &&
      hasLongNormalizedPhraseOverlap(trimmed, context.mediaSummary)
    ) {
      return true;
    }
    if (context.threadSummary && computeTokenOverlapRatio(trimmed, context.threadSummary) >= 0.82) {
      return true;
    }
    if (
      context.threadSummary &&
      hasLongNormalizedPhraseOverlap(trimmed, context.threadSummary)
    ) {
      return true;
    }
    if (context.payloadHint && computeTokenOverlapRatio(trimmed, context.payloadHint) >= 0.84) {
      return true;
    }
    if (
      context.payloadHint &&
      hasLongNormalizedPhraseOverlap(trimmed, context.payloadHint)
    ) {
      return true;
    }
    return false;
  }

  private buildDraftCommentFallback(input: {
    draftBody: string;
    context: CommentCurationContext;
  }): CuratedCommentBody | null {
    const fallbackBody = this.normalizeCuratedCommentBody(input.draftBody);
    if (fallbackBody.length === 0 || fallbackBody.length > 280) {
      return null;
    }
    const echoLike = this.isDraftCommentEchoLike(fallbackBody, input.context);
    return {
      body: fallbackBody,
      source: "draft_fallback",
      reason: echoLike
        ? "generated_draft_fallback_echo_like"
        : "generated_draft_fallback",
    };
  }

  private async loadEngagementDecisionContext(input: {
    action: "like" | "repost";
    postId: number;
    payload: Record<string, unknown>;
  }): Promise<EngagementDecisionContext> {
    const context: EngagementDecisionContext = {
      postAuthorHandle: null,
      postText: null,
      mediaSummary: null,
      payloadHint: this.extractCommentPayloadHint(input.payload),
      memorySummary: await this.loadEngagementMemorySummary({
        action: input.action,
        postId: input.postId,
        commentId: null,
        payload: input.payload,
      }),
    };
    const callAgentChatBridge = this.ctx.callAgentChatBridge;
    if (!callAgentChatBridge) return context;
    try {
      const postResponse = await callAgentChatBridge({
        action: "find_post",
        postId: input.postId,
      });
      const postRecord = this.extractPostRecordForCommentCuration(
        postResponse,
        input.postId,
      );
      if (!postRecord) return context;
      const author = isRecord(postRecord.author) ? postRecord.author : null;
      context.postAuthorHandle =
        asNonEmptyString(author?.handle) ??
        asNonEmptyString(postRecord.authorHandle);
      context.postText =
        asNonEmptyString(postRecord.textBody) ??
        asNonEmptyString(postRecord.caption) ??
        asNonEmptyString(postRecord.body);
      context.mediaSummary = this.summarizePostMediaForComment(postRecord);
      return context;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_post_lookup_failed",
          at: nowIso(),
          action: input.action,
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return context;
    }
  }

  private buildEngagementDecisionPrompt(input: {
    action: "like" | "repost";
    postId: number;
    targetHash: string;
    context: EngagementDecisionContext;
  }): string {
    const actionLabel = input.action === "like" ? "like" : "repost";
    const contextLines = [
      `postId: ${input.postId}`,
      input.context.postAuthorHandle
        ? `postAuthor: @${input.context.postAuthorHandle.replace(/^@+/u, "")}`
        : null,
      input.context.postText ? `postText: ${input.context.postText}` : null,
      input.context.mediaSummary ? `mediaContext: ${input.context.mediaSummary}` : null,
      input.context.payloadHint ? `requestHint: ${input.context.payloadHint}` : null,
      input.context.memorySummary ? `memoryContext: ${input.context.memorySummary}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    return [
      "Decide whether the runtime should execute this social engagement action now.",
      "Return strict JSON only.",
      "Rules:",
      "- shouldExecute=true when context suggests this action is relevant and non-spammy.",
      "- Prefer own-post engagement when it is active and high-signal; avoid repetitive low-value actions.",
      "- reason must be short (6-120 chars) and action-specific.",
      `- action must be exactly \"${actionLabel}\".`,
      "- target fields must match exactly.",
      "Return strict JSON ONLY with this exact shape:",
      `{"action":"${actionLabel}","target":{"postId":${input.postId},"commentId":null,"targetHash":"${input.targetHash}"},"shouldExecute":true,"reason":"<short reason>"}`,
      `Action: ${actionLabel}`,
      "Context:",
      ...contextLines.map((line) => `- ${line}`),
    ].join("\n");
  }

  private async evaluateEngagementActionWithOpenClaw(input: {
    command: Command;
    action: "like" | "repost";
    postId: number;
    payload: Record<string, unknown>;
    targetHash: string;
    lifecycleIdempotencyKey: string;
  }): Promise<EngagementDecision> {
    const context = await this.loadEngagementDecisionContext({
      action: input.action,
      postId: input.postId,
      payload: input.payload,
    });
    const fallbackExecute = async (
      reason: string,
      errorMessage?: string,
    ): Promise<EngagementDecision> => {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_action_decision_fallback",
          at: nowIso(),
          commandId: input.command.id,
          action: input.action,
          postId: input.postId,
          reason,
          ...(errorMessage ? { error: errorMessage } : {}),
        })
        .catch(() => undefined);
      return {
        shouldExecute: true,
        reason,
        source: "agent_runtime",
        contract: null,
      };
    };
    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) {
      return fallbackExecute("agent_runtime_without_openclaw");
    }
    try {
      this.updateActionLifecycle({
        command: input.command,
        action: input.action,
        idempotencyKey: input.lifecycleIdempotencyKey,
        target: {
          postId: input.postId,
          commentId: null,
          targetHash: input.targetHash,
        },
        state: "llm_running",
      });
      const prompt = this.buildEngagementDecisionPrompt({
        action: input.action,
        postId: input.postId,
        targetHash: input.targetHash,
        context,
      });
      const result = await runOpenClawPrompt({
        prompt,
        purpose: "engagement_action_decision",
      });
      const contract =
        (result
          ? this.extractActionContractFromUnknown({
            value: result.parsed,
            action: input.action,
            expectedPostId: input.postId,
            expectedCommentId: null,
            expectedTargetHash: input.targetHash,
          }) ??
            this.extractActionContractFromUnknown({
              value: result.payloadText,
              action: input.action,
              expectedPostId: input.postId,
              expectedCommentId: null,
              expectedTargetHash: input.targetHash,
            }) ??
            this.extractActionContractFromUnknown({
              value: result.raw,
              action: input.action,
              expectedPostId: input.postId,
              expectedCommentId: null,
              expectedTargetHash: input.targetHash,
            })
          : null) ?? null;
      if (!contract) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_action_decision_missing",
            at: nowIso(),
            commandId: input.command.id,
            action: input.action,
            postId: input.postId,
          })
          .catch(() => undefined);
        return fallbackExecute("agent_runtime_openclaw_contract_invalid");
      }
      return {
        shouldExecute: contract.shouldExecute,
        reason: contract.reason,
        source: "openclaw",
        contract,
      };
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_action_decision_failed",
          at: nowIso(),
          commandId: input.command.id,
          action: input.action,
          postId: input.postId,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return fallbackExecute("agent_runtime_openclaw_error", errorMessage);
    }
  }

  private async executeWriteVote(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return this.failedOutcome(command, "Invalid payload for write.votePost.");
    let resolvedTarget: EngagementTargetCandidate | null = null;
    try {
      resolvedTarget =
        (await this.resolveEngagementTargetForDirective({
          payload,
          action: "like",
          commandId: command.id,
        })) ?? null;
    } catch (error: unknown) {
      if (this.isNoTargetDiscoveryFailure(error)) {
        return this.failedOutcome(
          command,
          "No target post candidates found after discovery scan.",
          "no_target_candidates",
        );
      }
      throw error;
    }
    if (!resolvedTarget) {
      throw new RequeueCommandError("like_target_resolution_waiting_for_context:no_target");
    }
    const postId = resolvedTarget.postId;
    payload.postId = postId;
    payload.targetPostId = postId;
    const expectedTarget = {
      postId,
      commentId: null,
      targetHash: buildTargetHash({
        postId,
        commentId: null,
      }),
    };
    const lockMatch = isTargetLockMatch({
      payload,
      expected: expectedTarget,
    });
    if (!lockMatch.ok) {
      return this.failedOutcome(
        command,
        `Target lock mismatch: ${lockMatch.reason}.`,
        "target_lock_mismatch",
      );
    }
    const target = applyTargetLock(payload, {
      postId,
      commentId: null,
    });
    const idempotencyKey = this.buildActionIdempotencyKey({
      command,
      action: "like",
      postId: target.postId,
      commentId: target.commentId,
    });
    const dedupe = this.beginActionLifecycle({
      command,
      action: "like",
      idempotencyKey,
      target,
      state: "context_ready",
    });
    if (!dedupe.allowed) {
      if (dedupe.requeue) {
        throw new RequeueCommandError(
          `engagement_like_waiting_for_backoff:${dedupe.reason}`,
        );
      }
      return this.successOutcome(command, {
        skipped: true,
        action: "like",
        postId: target.postId,
        decision: dedupe.reason,
      });
    }
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const voteRaw =
      typeof payload.vote === "number" && Number.isFinite(payload.vote)
        ? Math.trunc(payload.vote)
        : 1;
    const vote = voteRaw > 0 ? 1 : voteRaw < 0 ? -1 : 0;
    try {
      const grantId = await this.preflightGrantForAction({
        command,
        payload,
        action: "like",
        lifecycle: {
          idempotencyKey,
          target,
        },
      });
      if (vote === 1) {
        const decision = await this.evaluateEngagementActionWithOpenClaw({
          command,
          action: "like",
          postId,
          payload,
          targetHash: target.targetHash,
          lifecycleIdempotencyKey: idempotencyKey,
        });
        const needsRequeue =
          !decision.shouldExecute &&
          decision.reason.trim().toLowerCase().startsWith("openclaw_");
        if (needsRequeue) {
          throw new RequeueCommandError(
            `engagement_like_waiting_for_openclaw:${decision.reason}`,
          );
        }
        await this.ctx.memory
          .recordWrite({
            type: "engagement_action_decision",
            at: nowIso(),
            commandId: command.id,
            action: "like",
            postId,
            shouldExecute: decision.shouldExecute,
            reason: decision.reason,
            source: decision.source,
          })
          .catch(() => undefined);
        if (!decision.shouldExecute) {
          const explicitRequested =
            command.forceNow === true ||
            payload.explicitPublishRequested === true ||
            payload.forceNow === true ||
            payload.userExplicitRequest === true ||
            command.runtimeOrigin === "director_directive" ||
            command.runtimeOrigin === "pending_promotion";
          if (explicitRequested) {
            await this.ctx.memory
              .recordWrite({
                type: "engagement_action_decision_overridden",
                at: nowIso(),
                commandId: command.id,
                action: "like",
                postId,
                reason: decision.reason,
                source: decision.source,
                override: "explicit_request",
              })
              .catch(() => undefined);
          } else {
            this.updateActionLifecycle({
              command,
              action: "like",
              idempotencyKey,
              target,
              state: "acked",
              lastError: null,
            });
            return this.successOutcome(command, {
              skipped: true,
              action: "like",
              postId,
              decision: decision.reason,
            });
          }
        }
      }
      this.updateActionLifecycle({
        command,
        action: "like",
        idempotencyKey,
        target,
        state: "action_running",
      });
      const result = await this.agent().votePost.mutate({
        postId,
        vote,
        ...(grantId ? { grantId } : {}),
        ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
        ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      });
      const resultRecord = isRecord(result) ? result : null;
      if (resultRecord?.applied === false) {
        this.updateActionLifecycle({
          command,
          action: "like",
          idempotencyKey,
          target,
          state: "acked",
          lastError: null,
        });
        return this.successOutcome(command, {
          skipped: true,
          action: "like",
          postId,
          applied: false,
          ...(typeof resultRecord.delta === "number" && Number.isFinite(resultRecord.delta)
            ? { delta: resultRecord.delta }
            : {}),
          decision:
            asNonEmptyString(resultRecord.decision) ??
            (resultRecord.liked === false ? "noop_not_liked" : "noop"),
        });
      }
      this.updateActionLifecycle({
        command,
        action: "like",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, result);
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        this.updateActionLifecycle({
          command,
          action: "like",
          idempotencyKey,
          target,
          state: "requeue",
          lastError: error.message,
        });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isOwnerCapabilityDeniedError(error)) {
        this.registerOwnerCapabilityCooldown({
          action: "like",
          targetHash: target.targetHash,
          reason: "not_granted",
        });
      }
      this.updateActionLifecycle({
        command,
        action: "like",
        idempotencyKey,
        target,
        state: "failed",
        lastError: message,
      });
      throw error;
    }
  }

  private async executeWriteRepost(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return this.failedOutcome(command, "Invalid payload for write.repostPost.");
    let resolvedTarget: EngagementTargetCandidate | null = null;
    try {
      resolvedTarget =
        (await this.resolveEngagementTargetForDirective({
          payload,
          action: "repost",
          commandId: command.id,
        })) ?? null;
    } catch (error: unknown) {
      if (this.isNoTargetDiscoveryFailure(error)) {
        return this.failedOutcome(
          command,
          "No target post candidates found after discovery scan.",
          "no_target_candidates",
        );
      }
      throw error;
    }
    if (!resolvedTarget) {
      throw new RequeueCommandError("repost_target_resolution_waiting_for_context:no_target");
    }
    const postId = resolvedTarget.postId;
    payload.postId = postId;
    payload.targetPostId = postId;
    const expectedTarget = {
      postId,
      commentId: null,
      targetHash: buildTargetHash({
        postId,
        commentId: null,
      }),
    };
    const lockMatch = isTargetLockMatch({
      payload,
      expected: expectedTarget,
    });
    if (!lockMatch.ok) {
      return this.failedOutcome(
        command,
        `Target lock mismatch: ${lockMatch.reason}.`,
        "target_lock_mismatch",
      );
    }
    const target = applyTargetLock(payload, {
      postId,
      commentId: null,
    });
    const idempotencyKey = this.buildActionIdempotencyKey({
      command,
      action: "repost",
      postId: target.postId,
      commentId: target.commentId,
    });
    const dedupe = this.beginActionLifecycle({
      command,
      action: "repost",
      idempotencyKey,
      target,
      state: "context_ready",
    });
    if (!dedupe.allowed) {
      if (dedupe.requeue) {
        throw new RequeueCommandError(
          `engagement_repost_waiting_for_backoff:${dedupe.reason}`,
        );
      }
      return this.successOutcome(command, {
        skipped: true,
        action: "repost",
        postId: target.postId,
        decision: dedupe.reason,
      });
    }
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const sourceDirectiveActionNonce =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const repost = payload.repost === 0 ? 0 : 1;
    try {
      const grantId = await this.preflightGrantForAction({
        command,
        payload,
        action: "repost",
        lifecycle: {
          idempotencyKey,
          target,
        },
      });
      if (repost === 1) {
        const decision = await this.evaluateEngagementActionWithOpenClaw({
          command,
          action: "repost",
          postId,
          payload,
          targetHash: target.targetHash,
          lifecycleIdempotencyKey: idempotencyKey,
        });
        const needsRequeue =
          !decision.shouldExecute &&
          decision.reason.trim().toLowerCase().startsWith("openclaw_");
        if (needsRequeue) {
          throw new RequeueCommandError(
            `engagement_repost_waiting_for_openclaw:${decision.reason}`,
          );
        }
        await this.ctx.memory
          .recordWrite({
            type: "engagement_action_decision",
            at: nowIso(),
            commandId: command.id,
            action: "repost",
            postId,
            shouldExecute: decision.shouldExecute,
            reason: decision.reason,
            source: decision.source,
          })
          .catch(() => undefined);
        if (!decision.shouldExecute) {
          const explicitRequested =
            command.forceNow === true ||
            payload.explicitPublishRequested === true ||
            payload.forceNow === true ||
            payload.userExplicitRequest === true ||
            command.runtimeOrigin === "director_directive" ||
            command.runtimeOrigin === "pending_promotion";
          if (explicitRequested) {
            await this.ctx.memory
              .recordWrite({
                type: "engagement_action_decision_overridden",
                at: nowIso(),
                commandId: command.id,
                action: "repost",
                postId,
                reason: decision.reason,
                source: decision.source,
                override: "explicit_request",
              })
              .catch(() => undefined);
          } else {
            this.updateActionLifecycle({
              command,
              action: "repost",
              idempotencyKey,
              target,
              state: "acked",
              lastError: null,
            });
            return this.successOutcome(command, {
              skipped: true,
              action: "repost",
              postId,
              decision: decision.reason,
            });
          }
        }
      }
      this.updateActionLifecycle({
        command,
        action: "repost",
        idempotencyKey,
        target,
        state: "action_running",
      });
      const result = await this.agent().repostPost.mutate({
        postId,
        repost,
        ...(grantId ? { grantId } : {}),
        ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
        ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      });
      const resultRecord = isRecord(result) ? result : null;
      if (resultRecord?.applied === false) {
        this.updateActionLifecycle({
          command,
          action: "repost",
          idempotencyKey,
          target,
          state: "acked",
          lastError: null,
        });
        return this.successOutcome(command, {
          skipped: true,
          action: "repost",
          postId,
          applied: false,
          ...(typeof resultRecord.delta === "number" && Number.isFinite(resultRecord.delta)
            ? { delta: resultRecord.delta }
            : {}),
          decision:
            asNonEmptyString(resultRecord.decision) ??
            (resultRecord.reposted === false ? "noop_not_reposted" : "noop"),
        });
      }
      this.updateActionLifecycle({
        command,
        action: "repost",
        idempotencyKey,
        target,
        state: "acked",
        lastError: null,
      });
      return this.successOutcome(command, result);
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        this.updateActionLifecycle({
          command,
          action: "repost",
          idempotencyKey,
          target,
          state: "requeue",
          lastError: error.message,
        });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isOwnerCapabilityDeniedError(error)) {
        this.registerOwnerCapabilityCooldown({
          action: "repost",
          targetHash: target.targetHash,
          reason: "not_granted",
        });
      }
      this.updateActionLifecycle({
        command,
        action: "repost",
        idempotencyKey,
        target,
        state: "failed",
        lastError: message,
      });
      throw error;
    }
  }

  private async executeDelegatedFollowAction(input: {
    command: Command;
    payload: Record<string, unknown>;
    action: "follow" | "follow_engagers" | "follow_accept" | "follow_suggestions";
  }): Promise<CommandOutcome> {
    const target = this.resolveFollowTargetMode(input.payload);
    const actionLabel = input.action === "follow_engagers"
      ? "follow-engagers"
      : input.action === "follow_accept"
        ? "follow-accept"
        : input.action === "follow_suggestions"
          ? "follow-suggestions"
        : "follow";
    const applyFollowForHandles = async (handles: string[]) => {
      const followed: string[] = [];
      const alreadyFollowed: string[] = [];
      const notFound: string[] = [];
      const self: string[] = [];
      const blocked: string[] = [];
      const failed: string[] = [];
      const errors: Array<{ handle: string; error: string }> = [];
      for (const handle of handles) {
        const attempt = await this.attemptFollowHandle({
          target,
          handle,
          action: "follow_user",
        });
        if (attempt.status === "followed") {
          followed.push(attempt.handle);
          continue;
        }
        if (attempt.status === "already_followed") {
          alreadyFollowed.push(attempt.handle);
          continue;
        }
        if (attempt.status === "not_found") {
          notFound.push(attempt.handle);
          if (attempt.error) {
            errors.push({ handle: attempt.handle, error: attempt.error });
          }
          continue;
        }
        if (attempt.status === "self") {
          self.push(attempt.handle);
          if (attempt.error) {
            errors.push({ handle: attempt.handle, error: attempt.error });
          }
          continue;
        }
        if (attempt.status === "blocked") {
          blocked.push(attempt.handle);
          if (attempt.error) {
            errors.push({ handle: attempt.handle, error: attempt.error });
          }
          continue;
        }
        failed.push(attempt.handle);
        if (attempt.error) {
          errors.push({ handle: attempt.handle, error: attempt.error });
        }
      }
      return {
        followed,
        alreadyFollowed,
        notFound,
        self,
        blocked,
        failed,
        errors,
      };
    };

    if (input.action === "follow") {
      const handles = this.collectFollowHandlesFromPayload(input.payload);
      if (handles.length === 0) {
        return this.successOutcome(input.command, {
          followAction: actionLabel,
          followInputMissing: true,
          chatCompletion: {
            body: "Usage: /follow [for-me|as-agent] @handle (you can include multiple handles).",
            metadata: {
              automated: true,
              sourceContext: "CHAT",
              actionPreview: {
                type: "follow",
                status: "failed",
                title: "Follow input missing",
              },
            },
          },
        });
      }
      const applied = await applyFollowForHandles(handles);
      const summaryText = this.buildFollowSummaryText({
        target,
        followed: applied.followed,
        alreadyFollowed: applied.alreadyFollowed,
        notFound: applied.notFound,
        self: applied.self,
        blocked: applied.blocked,
        failed: applied.failed,
      });
      await this.recordCommandLifecycleCheckpoint({
        command: input.command,
        stage: "write_mutation",
        status:
          applied.followed.length > 0 || applied.alreadyFollowed.length > 0
            ? "ok"
            : "failed",
        metadata: {
          action: actionLabel,
          target,
          requestedCount: handles.length,
          followedCount: applied.followed.length,
          alreadyFollowedCount: applied.alreadyFollowed.length,
          notFoundCount: applied.notFound.length,
          selfCount: applied.self.length,
          blockedCount: applied.blocked.length,
          failedCount: applied.failed.length,
        },
      });
      return this.successOutcome(input.command, {
        followAction: actionLabel,
        target,
        requestedHandles: handles,
        followedHandles: applied.followed,
        alreadyFollowedHandles: applied.alreadyFollowed,
        notFoundHandles: applied.notFound,
        selfHandles: applied.self,
        blockedHandles: applied.blocked,
        failedHandles: applied.failed,
        errors: applied.errors,
        chatCompletion: {
          body: summaryText,
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "follow",
              status:
                applied.followed.length > 0 || applied.alreadyFollowed.length > 0
                  ? "success"
                  : "failed",
              title: "Follow update",
              summary: summaryText,
            },
          },
        },
      });
    }

    if (input.action === "follow_engagers" || input.action === "follow_suggestions") {
      const requestedCount = this.resolveFollowEngagersCount(input.payload);
      const lookbackDays = asPositiveInt(input.payload.followLookbackDays) ?? 120;
      const suggestionOptions = this.resolveFollowSuggestionOptions(input.payload);
      const discoverySource: "browse_agents" | "browse_top_engagers" =
        suggestionOptions.agentOnly ? "browse_agents" : "browse_top_engagers";
      let candidateHandles: string[] = [];
      const browsedAgentByHandle = new Map<
        string,
        {
          name: string | null;
          score: number | null;
          reason: string | null;
        }
      >();
      try {
        if (discoverySource === "browse_agents") {
          const lookup = await this.callAgentBridgeLookupCached(
            {
              action: "browse_agents",
              ...(suggestionOptions.topicHint ? { query: suggestionOptions.topicHint } : {}),
              limit: Math.min(60, Math.max(24, requestedCount * 4)),
              includeFollowing: true,
              includeFollowers: true,
              includeRecentPosters: true,
            },
            4_000,
          );
          const browsedCandidates = this.extractBrowsedAgentCandidates(lookup.value, 60);
          for (const candidate of browsedCandidates) {
            browsedAgentByHandle.set(candidate.handle, {
              name: candidate.name,
              score: candidate.score,
              reason: candidate.reason,
            });
          }
          candidateHandles = browsedCandidates.map((entry) => entry.handle);
        } else {
          const lookup = await this.callAgentBridgeLookupCached(
            {
              action: "browse_top_engagers",
              limit: Math.min(60, Math.max(24, requestedCount * 4)),
              windowHours: lookbackDays * 24,
            },
            4_000,
          );
          candidateHandles = this.extractTopEngagerHandlesFromLookup(lookup.value, 60);
        }
      } catch (error: unknown) {
        return this.failedOutcome(
          input.command,
          `Follow candidate lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "follow_candidate_lookup_failed",
        );
      }
      if (candidateHandles.length === 0) {
        const body = discoverySource === "browse_agents"
          ? suggestionOptions.topicHint
            ? `I could not find agent accounts matching "${suggestionOptions.topicHint}" yet.`
            : "I could not find discoverable agent accounts right now."
          : target === "agent"
            ? `I do not have recent engagers left to follow on the agent account (last ${lookbackDays} days).`
            : `I do not see recent engagers left to follow on your account (last ${lookbackDays} days).`;
        return this.successOutcome(input.command, {
          followAction: actionLabel,
          target,
          requestedCount,
          lookbackDays,
          candidatesFound: 0,
          discoverySource,
          agentOnly: suggestionOptions.agentOnly,
          chatCompletion: {
            body,
            metadata: {
              automated: true,
              sourceContext: "CHAT",
              actionPreview: {
                type: "follow",
                status: "success",
                title: "No follow candidates",
                summary: body,
              },
            },
          },
        });
      }
      const selectedHandles = candidateHandles.slice(0, requestedCount);
      if (input.action === "follow_suggestions") {
        const remainingCount = Math.max(0, candidateHandles.length - selectedHandles.length);
        const compactHandles = selectedHandles.slice(0, 12);
        const summaryText = (() => {
          if (compactHandles.length === 0) {
            return "I found candidates, but could not shape a follow suggestion list right now.";
          }
          if (discoverySource === "browse_agents") {
            const listLines = compactHandles.map((handle, index) => {
              const browsed = browsedAgentByHandle.get(handle);
              return `${index + 1}. @${handle}${browsed?.name ? ` — ${browsed.name}` : ""}`;
            });
            const listedProfiles = compactHandles
              .map((handle) => browsedAgentByHandle.get(handle) ?? null)
              .filter(
                (entry): entry is { name: string | null; score: number | null; reason: string | null } =>
                  Boolean(entry),
              );
            const mostlyDiscoverableSeed =
              listedProfiles.length > 0 &&
              listedProfiles.every(
                (entry) =>
                  entry.reason === "discoverable_agent" &&
                  (entry.score === null || entry.score <= 55),
              );
            const lines = [
              `Found ${candidateHandles.length} agent account${candidateHandles.length === 1 ? "" : "s"}${suggestionOptions.topicHint ? ` for "${suggestionOptions.topicHint}"` : ""}.`,
              `Top ${listLines.length}:`,
              ...listLines,
            ];
            if (remainingCount > 0) {
              lines.push(`+${remainingCount} more available.`);
            }
            if (mostlyDiscoverableSeed) {
              lines.push(
                "Fair warning: most results currently look like seed placeholders with limited activity signals.",
              );
            }
            lines.push(
              `Reply with /follow @handle or /follow-engagers ${compactHandles.length} to apply follows.`,
            );
            return lines.join("\n");
          }
          const compactHandleText = compactHandles.map((entry) => `@${entry}`).join(", ");
          return `Top ${compactHandles.length} account${compactHandles.length === 1 ? "" : "s"} to consider: ${compactHandleText}.${remainingCount > 0 ? ` (+${remainingCount} more)` : ""} Reply with /follow @handle or /follow-engagers ${compactHandles.length} to apply follows.`;
        })();
        await this.recordCommandLifecycleCheckpoint({
          command: input.command,
          stage: "generated",
          status: "ok",
          metadata: {
            action: actionLabel,
            target,
            requestedCount,
            candidatesFound: candidateHandles.length,
            suggestedCount: compactHandles.length,
            remainingCount,
            discoverySource,
            agentOnly: suggestionOptions.agentOnly,
            topicHint: suggestionOptions.topicHint,
          },
        });
        return this.successOutcome(input.command, {
          followAction: actionLabel,
          target,
          requestedCount,
          lookbackDays,
          candidateHandles,
          suggestedHandles: selectedHandles,
          remainingCount,
          discoverySource,
          agentOnly: suggestionOptions.agentOnly,
          topicHint: suggestionOptions.topicHint,
          chatCompletion: {
            body: summaryText,
            metadata: {
              automated: true,
              sourceContext: "CHAT",
              actionPreview: {
                type: "follow",
                status: "success",
                title: "Follow suggestions",
                summary: summaryText,
                suggestedCount: compactHandles.length,
                requestedCount,
              },
            },
          },
        });
      }
      const applied = await applyFollowForHandles(selectedHandles);
      const remainingCount = Math.max(0, candidateHandles.length - selectedHandles.length);
      const sourcedFromEngagers = discoverySource === "browse_top_engagers";
      const summaryText = this.buildFollowSummaryText({
        target,
        followed: applied.followed,
        alreadyFollowed: applied.alreadyFollowed,
        notFound: applied.notFound,
        self: applied.self,
        blocked: applied.blocked,
        failed: applied.failed,
        ...(sourcedFromEngagers ? { remainingCount } : {}),
        followEngagers: sourcedFromEngagers,
      });
      await this.recordCommandLifecycleCheckpoint({
        command: input.command,
        stage: "write_mutation",
        status:
          applied.followed.length > 0 || applied.alreadyFollowed.length > 0
            ? "ok"
            : "failed",
        metadata: {
          action: actionLabel,
          target,
          requestedCount,
          candidatesFound: candidateHandles.length,
          followedCount: applied.followed.length,
          alreadyFollowedCount: applied.alreadyFollowed.length,
          failedCount:
            applied.failed.length +
            applied.notFound.length +
            applied.self.length +
            applied.blocked.length,
          remainingCount,
          discoverySource,
          agentOnly: suggestionOptions.agentOnly,
          topicHint: suggestionOptions.topicHint,
        },
      });
      return this.successOutcome(input.command, {
        followAction: actionLabel,
        target,
        requestedCount,
        lookbackDays,
        candidateHandles,
        selectedHandles,
        followedHandles: applied.followed,
        alreadyFollowedHandles: applied.alreadyFollowed,
        notFoundHandles: applied.notFound,
        selfHandles: applied.self,
        blockedHandles: applied.blocked,
        failedHandles: applied.failed,
        errors: applied.errors,
        remainingCount,
        discoverySource,
        agentOnly: suggestionOptions.agentOnly,
        topicHint: suggestionOptions.topicHint,
        chatCompletion: {
          body: summaryText,
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "follow",
              status:
                applied.followed.length > 0 || applied.alreadyFollowed.length > 0
                  ? "success"
                  : "failed",
              title:
                discoverySource === "browse_top_engagers"
                  ? "Follow-engagers update"
                  : "Follow update",
              summary: summaryText,
            },
          },
        },
      });
    }

    const followSelections = this.collectFollowSelectionsFromPayload(input.payload)
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    const explicitHandles = this.collectFollowHandlesFromPayload(input.payload);
    let mappedHandles = [...explicitHandles];
    const wantsAll = followSelections.includes("all");
    const indexSelections = followSelections
      .map((entry) => Number.parseInt(entry, 10))
      .filter((entry) => Number.isFinite(entry) && entry > 0)
      .map((entry) => Math.floor(entry));
    if (wantsAll || indexSelections.length > 0) {
      try {
        const followCount = this.resolveFollowEngagersCount(input.payload);
        const lookup = await this.callAgentBridgeLookupCached(
          {
            action: "browse_top_engagers",
            limit: Math.min(60, Math.max(24, followCount * 4)),
            windowHours: (asPositiveInt(input.payload.followLookbackDays) ?? 120) * 24,
          },
          4_000,
        );
        const rankedHandles = this.extractTopEngagerHandlesFromLookup(lookup.value, 60);
        if (wantsAll) {
          mappedHandles = [...mappedHandles, ...rankedHandles.slice(0, followCount)];
        } else {
          mappedHandles = [
            ...mappedHandles,
            ...indexSelections
              .map((value) => rankedHandles[value - 1] ?? null)
              .filter((value): value is string => Boolean(value)),
          ];
        }
      } catch (error: unknown) {
        return this.failedOutcome(
          input.command,
          `Follow-accept lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "follow_accept_lookup_failed",
        );
      }
    }
    const targetHandles = Array.from(new Set(mappedHandles)).slice(0, 24);
    if (targetHandles.length === 0) {
      return this.successOutcome(input.command, {
        followAction: actionLabel,
        target,
        followInputMissing: true,
        chatCompletion: {
          body:
            "I do not have a pending follow suggestion list for this request. Ask for suggestions first, then confirm with handles or indexes.",
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "follow",
              status: "failed",
              title: "Follow accept pending list missing",
            },
          },
        },
      });
    }

    const applied = await applyFollowForHandles(targetHandles);
    const summaryText = this.buildFollowSummaryText({
      target,
      followed: applied.followed,
      alreadyFollowed: applied.alreadyFollowed,
      notFound: applied.notFound,
      self: applied.self,
      blocked: applied.blocked,
      failed: applied.failed,
    });
    await this.recordCommandLifecycleCheckpoint({
      command: input.command,
      stage: "write_mutation",
      status:
        applied.followed.length > 0 || applied.alreadyFollowed.length > 0
          ? "ok"
          : "failed",
      metadata: {
        action: actionLabel,
        target,
        requestedCount: targetHandles.length,
        followedCount: applied.followed.length,
        alreadyFollowedCount: applied.alreadyFollowed.length,
        failedCount:
          applied.failed.length +
          applied.notFound.length +
          applied.self.length +
          applied.blocked.length,
      },
    });
    return this.successOutcome(input.command, {
      followAction: actionLabel,
      target,
      followSelections,
      selectedHandles: targetHandles,
      followedHandles: applied.followed,
      alreadyFollowedHandles: applied.alreadyFollowed,
      notFoundHandles: applied.notFound,
      selfHandles: applied.self,
      blockedHandles: applied.blocked,
      failedHandles: applied.failed,
      errors: applied.errors,
      chatCompletion: {
        body: summaryText,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "follow",
            status:
              applied.followed.length > 0 || applied.alreadyFollowed.length > 0
                ? "success"
                : "failed",
            title: "Follow-accept update",
            summary: summaryText,
          },
        },
      },
    });
  }

  private async executeRetryPending(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload)
      ? command.payload
      : ({} as Record<string, unknown>);
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });
    const requestedLimit = asPositiveInt(payload.limit);
    const limit = Math.max(1, Math.min(100, requestedLimit ?? 20));
    const retryPermissionDenied =
      payload.force === true ||
      payload.forceNow === true ||
      payload.retryPermissionDenied === true ||
      payload.retryBlocked === true;
    if (!this.ctx.promotePendingDirectives) {
      return this.failedOutcome(
        command,
        "Retry pending is unavailable: pending promotion handler is not wired.",
        "pending_retry_handler_missing",
      );
    }

    let summary: {
      scanned: number;
      promoted: number;
      skippedPermissionDenied: number;
      skippedTerminal: number;
      skippedAlreadySeen: number;
      skippedQueued: number;
      limit: number;
    };
    try {
      summary = await this.ctx.promotePendingDirectives({
        limit,
        retryPermissionDenied,
        bypassCooldown: true,
        source: "brain_retry_pending",
      });
    } catch (error: unknown) {
      return this.failedOutcome(
        command,
        error instanceof Error ? error.message : "retry pending failed",
        "pending_retry_failed",
      );
    }

    const summaryParts = [
      `scanned ${summary.scanned}`,
      `queued ${summary.promoted}`,
      `seen-skip ${summary.skippedAlreadySeen}`,
      `queued-skip ${summary.skippedQueued}`,
      `terminal-skip ${summary.skippedTerminal}`,
      `permission-skip ${summary.skippedPermissionDenied}`,
    ];
    const completionBody =
      summary.promoted > 0
        ? `Queued ${summary.promoted} pending directive${summary.promoted === 1 ? "" : "s"} (${summaryParts.join(", ")}).`
        : `No pending directives were queued (${summaryParts.join(", ")}).`;

    await this.ctx.memory
      .recordWrite({
        type: "retry_pending_command_completed",
        at: nowIso(),
        commandId: command.id,
        sourceDirectiveId,
        retryPermissionDenied,
        ...summary,
      })
      .catch(() => undefined);

    return this.successOutcome(command, {
      retryPending: summary,
      chatCompletion: {
        body: completionBody,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "retry_pending",
            status: summary.promoted > 0 ? "success" : "noop",
            title: "Pending queue retry",
            summary: completionBody,
          },
        },
      },
    });
  }

  private async executeGenerateAndQueue(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for generate-and-queue command.");
    }
    const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
      command,
      payload,
    });

    const delegatedFollowAction = this.resolveDelegatedFollowAction(payload);
    if (delegatedFollowAction) {
      return this.executeDelegatedFollowAction({
        command,
        payload,
        action: delegatedFollowAction,
      });
    }

    const isChatOrigin = this.isChatOriginCommand(command, payload);
    const chatCommandName = this.resolveChatCommandName(payload);
    const isAgentDecideChatCommand =
      (chatCommandName?.trim().toLowerCase() ?? "") === "agent-decide";
    const explicitStoryChatRequest = isChatOrigin
      ? this.didChatMessageExplicitlyRequestStory(payload)
      : false;
    if (
      isChatOrigin &&
      (!isAgentDecideChatCommand || explicitStoryChatRequest) &&
      this.isStoryGenerateRequestFromChatPayload(payload)
    ) {
      await this.ctx.memory
        .recordWrite({
          type: "story_generate_blocked_chat_request",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          sourceDirectiveId,
        })
        .catch(() => undefined);
      return this.failedOutcome(
        command,
        "Story creation is directive-only. Chat requests can create posts, but not stories.",
        "story_chat_disabled",
      );
    }
    if (payload.chatLiteralGenerate === true) {
      return this.executeChatLiteralGenerate(command, payload);
    }

    const sourceDirectiveActionNonce =
      this.resolveCommandSourceDirectiveActionNonce({ command, payload });
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const enforcedDraftAction = this.resolveEnforcedDraftAction(payload);
    if (enforcedDraftAction) {
      const scopedDirective = isRecord(payload.directiveScope) ? payload.directiveScope : null;
      const scopedTarget = scopedDirective && isRecord(scopedDirective.target) ? scopedDirective.target : null;
      const hasTargetPostId =
        asPositiveInt(payload.postId) ??
        asPositiveInt(payload.targetPostId) ??
        (scopedDirective
          ? asPositiveInt(scopedDirective.targetPostId) ??
            (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
          : null);
      if (!hasTargetPostId) {
        let resolvedTarget: EngagementTargetCandidate | null = null;
        try {
          resolvedTarget = await this.resolveEngagementTargetForDirective({
            payload,
            action: enforcedDraftAction,
            commandId: command.id,
          });
        } catch (error: unknown) {
          if (this.isNoTargetDiscoveryFailure(error)) {
            return this.failedOutcome(
              command,
              `No target candidates found for ${enforcedDraftAction} after discovery scan.`,
              "no_target_candidates",
            );
          }
          throw error;
        }
        if (!resolvedTarget) {
          throw new RequeueCommandError(
            `engagement_target_resolution_waiting_for_context:${enforcedDraftAction}:no_target`,
          );
        }
        payload.postId = resolvedTarget.postId;
        payload.targetPostId = resolvedTarget.postId;
        if (enforcedDraftAction === "comment" && resolvedTarget.commentId) {
          payload.commentId = resolvedTarget.commentId;
          payload.parentId = resolvedTarget.commentId;
          payload.targetCommentId = resolvedTarget.commentId;
        }
        if (resolvedTarget.postSnapshotHash) {
          payload.targetPostSnapshotHash = resolvedTarget.postSnapshotHash;
          payload.postSnapshotHash = resolvedTarget.postSnapshotHash;
        }
        const nextScope = isRecord(payload.directiveScope)
          ? { ...payload.directiveScope }
          : ({} as Record<string, unknown>);
        nextScope.targetPostId = resolvedTarget.postId;
        if (enforcedDraftAction === "comment" && resolvedTarget.commentId) {
          nextScope.targetCommentId = resolvedTarget.commentId;
        }
        const nextScopeTarget = isRecord(nextScope.target)
          ? { ...nextScope.target }
          : ({} as Record<string, unknown>);
        nextScopeTarget.postId = resolvedTarget.postId;
        nextScopeTarget.commentId =
          enforcedDraftAction === "comment" ? (resolvedTarget.commentId ?? null) : null;
        nextScope.target = nextScopeTarget;
        payload.directiveScope = nextScope;
      }
    }

    // Check for previously-generated drafts cached from a prior attempt (requeue).
    // This prevents re-calling generate.mutate() when the command is retried.
    this.pruneGeneratedDraftCache();
    const cachedEntry = this.generatedDraftCache.get(command.id);
    const inlineDrafts = cachedEntry ? cachedEntry.drafts : this.extractInlineDrafts(payload);
    let generateInputRaw: Record<string, unknown> | null = null;
    if (!inlineDrafts.length) {
      try {
        generateInputRaw = await this.buildGenerateInputWithRuntimeContext(
          payload,
          command,
        );
      } catch (error: unknown) {
        const deferred = this.classifyMediaGenerationDeferral({
          error,
          hasPrompt: true,
        });
        if (deferred.shouldRequeue && deferred.reason) {
          const message = error instanceof Error ? error.message : String(error);
          await this.recordCommandLifecycleCheckpoint({
            command,
            stage: "generated",
            status: "failed",
            message,
            metadata: {
              requeued: true,
              reason: deferred.reason,
              reasonCode: deferred.reasonCode,
              personaSlug: deferred.personaSlug,
              source: "build_generate_input",
            },
          });
          await this.ctx.memory
            .recordWrite({
              type: "generate_deferred_for_setup",
              at: nowIso(),
              commandId: command.id,
              sourceDirectiveId,
              reason: deferred.reason,
              reasonCode: deferred.reasonCode,
              personaSlug: deferred.personaSlug,
              error: message,
            })
            .catch(() => undefined);
          throw new RequeueCommandError(deferred.reason);
        }
        throw error;
      }
    }
    const enforcePermissionHintFilters =
      ENFORCE_PERMISSION_HINT_FILTERS &&
      !this.isDirectiveContextLinkedCommand(command);
    const generateInput =
      enforcePermissionHintFilters &&
      generateInputRaw &&
      inlineDrafts.length === 0
        ? this.applyPermissionGenerateInputConstraints(
            generateInputRaw,
            payload.permissionState,
          )
        : generateInputRaw;
    if (
      enforcePermissionHintFilters &&
      generateInputRaw &&
      generateInput &&
      generateInput !== generateInputRaw
    ) {
      await this.ctx.memory
        .recordWrite({
          type: "generate_input_constrained_by_permissions",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId,
          originalKinds: Array.isArray(generateInputRaw.kinds)
            ? generateInputRaw.kinds
            : [],
          constrainedKinds: Array.isArray(generateInput.kinds)
            ? generateInput.kinds
            : [],
          originalKind: asNonEmptyString(generateInputRaw.kind),
          constrainedKind: asNonEmptyString(generateInput.kind),
        })
        .catch(() => undefined);
    }
    const constrainedGenerateKinds =
      generateInput && Array.isArray(generateInput.kinds)
        ? generateInput.kinds
            .map((entry) => asNonEmptyString(entry)?.trim().toLowerCase() ?? "")
            .filter((entry) => entry.length > 0)
        : null;
    if (
      enforcePermissionHintFilters &&
      !inlineDrafts.length &&
      generateInputRaw &&
      generateInput &&
      generateInput !== generateInputRaw &&
      constrainedGenerateKinds !== null &&
      constrainedGenerateKinds.length === 0
    ) {
      await this.ctx.memory
        .recordWrite({
          type: "generate_blocked_by_permissions",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId,
          originalKinds: Array.isArray(generateInputRaw.kinds)
            ? generateInputRaw.kinds
            : [],
        })
        .catch(() => undefined);
      return this.failedOutcome(
        command,
        "No permission-allowed generation actions are available right now.",
        "no_permitted_generate_kind",
      );
    }
    let generatedResult: unknown = null;
    if (!inlineDrafts.length) {
      try {
        generatedResult = await this.agent().generate.mutate(
          generateInput ?? this.buildGenerateInput(payload, command),
        );
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: "generated",
          status: "ok",
          metadata: {
            hasGeneratedResult: Boolean(generatedResult),
          },
        });
      } catch (error: unknown) {
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: "generated",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    const drafts =
      inlineDrafts.length > 0
        ? inlineDrafts
        : this.extractGeneratedDrafts(generatedResult);

    // Cache generated drafts so requeued commands skip the expensive generate.mutate() call.
    if (drafts.length > 0 && !cachedEntry) {
      this.generatedDraftCache.set(command.id, { drafts, cachedAtMs: Date.now() });
    }

    const executableDrafts =
      enforcedDraftAction === null
        ? drafts
        : drafts.filter(
            (draft) => draft.action.trim().toLowerCase() === enforcedDraftAction,
          );
    const permissionFilteredDrafts = enforcePermissionHintFilters
      ? executableDrafts.filter((draft) =>
          this.isGeneratedDraftAllowedByPermissionState(
            draft,
            payload.permissionState,
          ),
        )
      : executableDrafts;
    if (
      enforcePermissionHintFilters &&
      executableDrafts.length > 0 &&
      permissionFilteredDrafts.length !== executableDrafts.length
    ) {
      const droppedActions = executableDrafts
        .filter((draft) => !permissionFilteredDrafts.includes(draft))
        .map((draft) => draft.action.trim().toLowerCase())
        .slice(0, 12);
      await this.ctx.memory
        .recordWrite({
          type: "generate_draft_filtered_by_permissions",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId,
          beforeCount: executableDrafts.length,
          afterCount: permissionFilteredDrafts.length,
          droppedActions,
        })
        .catch(() => undefined);
    }
    let executionDrafts = permissionFilteredDrafts;
    if (isChatOrigin && executionDrafts.length > 0) {
      const chatCandidateDrafts = executionDrafts;
      const blockedStoryDraftCount = chatCandidateDrafts.filter(
        (draft) => draft.action.trim().toLowerCase() === "story",
      ).length;
      const firstBlockedStoryDraft =
        blockedStoryDraftCount > 0
          ? chatCandidateDrafts.find(
              (draft) => draft.action.trim().toLowerCase() === "story",
            ) ?? null
          : null;
      if (blockedStoryDraftCount > 0) {
        executionDrafts = chatCandidateDrafts.filter(
          (draft) => draft.action.trim().toLowerCase() !== "story",
        );
        await this.ctx.memory
          .recordWrite({
            type: "story_drafts_blocked_chat_request",
            at: nowIso(),
            commandId: command.id,
            commandKind: command.kind,
            sourceDirectiveId,
            blockedStoryDraftCount,
            retainedDraftCount: executionDrafts.length,
          })
          .catch(() => undefined);
      }
      if (executionDrafts.length === 0 && blockedStoryDraftCount > 0) {
        if (!explicitStoryChatRequest) {
          await this.ctx.memory
            .recordWrite({
              type: "story_drafts_suppressed_chat_request",
              at: nowIso(),
              commandId: command.id,
              commandKind: command.kind,
              sourceDirectiveId,
              blockedStoryDraftCount,
            })
            .catch(() => undefined);
        }
        if (!explicitStoryChatRequest) {
          const storyFallbackPrompt =
            asNonEmptyString(firstBlockedStoryDraft?.payload.mediaPrompt) ??
            asNonEmptyString(firstBlockedStoryDraft?.payload.imagePrompt) ??
            asNonEmptyString(firstBlockedStoryDraft?.payload.prompt) ??
            asNonEmptyString(firstBlockedStoryDraft?.payload.topic) ??
            asNonEmptyString(firstBlockedStoryDraft?.payload.caption);
          await this.ctx.memory
            .recordWrite({
              type: "story_drafts_redirected_chat_literal_generate",
              at: nowIso(),
              commandId: command.id,
              commandKind: command.kind,
              sourceDirectiveId,
              blockedStoryDraftCount,
            })
            .catch(() => undefined);
          const fallbackPayload = this.buildChatLiteralFallbackPayloadFromStory({
            payload,
            fallbackPrompt: storyFallbackPrompt,
          });
          return this.executeChatLiteralGenerate(command, fallbackPayload);
        }
        return this.failedOutcome(
          command,
          explicitStoryChatRequest
            ? "Story creation is directive-only. Chat requests can create posts, but not stories."
            : "generate returned no permission-allowed drafts.",
          explicitStoryChatRequest ? "story_chat_disabled" : "no_permitted_drafts",
        );
      }
    }
    const personaMediaLock = this.isPersonaMediaLockEnabled(payload);
    if (personaMediaLock) {
      const personaCompatibleDrafts = executionDrafts.filter((draft) =>
        this.isPersonaMediaCompatibleDraft(draft),
      );
      if (personaCompatibleDrafts.length > 0) {
        executionDrafts = personaCompatibleDrafts;
      } else {
        const fallbackDraft = this.buildPersonaLockedMediaFallbackDraft({
          payload,
          drafts: executionDrafts.length > 0 ? executionDrafts : drafts,
        });
        const fallbackAllowed =
          fallbackDraft &&
          (!enforcePermissionHintFilters ||
            this.isGeneratedDraftAllowedByPermissionState(
              fallbackDraft,
              payload.permissionState,
            ));
        if (fallbackDraft && fallbackAllowed) {
          executionDrafts = [fallbackDraft];
          await this.ctx.memory
            .recordWrite({
              type: "persona_media_lock_fallback_draft",
              at: nowIso(),
              commandId: command.id,
              sourceDirectiveId,
              reason: "no_persona_compatible_generated_draft",
            })
            .catch(() => undefined);
        } else {
          executionDrafts = [];
        }
      }
    }
    if (isChatOrigin && executionDrafts.length > 0) {
      const allowChatWriteExecution = this.isChatWriteCommandExplicitlyRequested(payload);
      const blockedWriteDrafts = executionDrafts.filter((draft) =>
        this.isWriteDraftAction(draft.action),
      );
      if (blockedWriteDrafts.length > 0 && !allowChatWriteExecution) {
        executionDrafts = executionDrafts.filter(
          (draft) => !this.isWriteDraftAction(draft.action),
        );
        await this.ctx.memory
          .recordWrite({
            type: "chat_write_drafts_blocked_missing_explicit_request",
            at: nowIso(),
            commandId: command.id,
            commandKind: command.kind,
            sourceDirectiveId,
            blockedDraftCount: blockedWriteDrafts.length,
            blockedActions: blockedWriteDrafts
              .map((draft) => draft.action.trim().toLowerCase())
              .filter((value) => value.length > 0)
              .slice(0, 12),
            retainedDraftCount: executionDrafts.length,
          })
          .catch(() => undefined);
        if (executionDrafts.length === 0) {
          if (
            this.shouldRedirectBlockedChatWritesToLiteralGenerate({
              payload,
              blockedDrafts: blockedWriteDrafts,
            })
          ) {
            const fallbackPrompt =
              this.resolveChatLiteralFallbackPromptFromDrafts({
                payload,
                drafts: blockedWriteDrafts,
              });
            await this.ctx.memory
              .recordWrite({
                type: "chat_write_drafts_redirected_chat_literal_generate",
                at: nowIso(),
                commandId: command.id,
                commandKind: command.kind,
                sourceDirectiveId,
                blockedDraftCount: blockedWriteDrafts.length,
              })
              .catch(() => undefined);
            const fallbackPayload = this.buildChatLiteralFallbackPayloadFromStory({
              payload,
              ...(fallbackPrompt ? { fallbackPrompt } : {}),
            });
            return this.executeChatLiteralGenerate(command, fallbackPayload);
          }
          return this.failedOutcome(
            command,
            "Chat write actions require an explicit request to post/comment/reply/like/repost/story.",
            "chat_write_explicit_required",
          );
        }
      }
      if (
        allowChatWriteExecution &&
        blockedWriteDrafts.length > 0 &&
        !this.isChatWriteRequesterOwner(payload)
      ) {
        executionDrafts = executionDrafts.filter(
          (draft) => !this.isWriteDraftAction(draft.action),
        );
        await this.ctx.memory
          .recordWrite({
            type: "chat_write_drafts_blocked_non_owner",
            at: nowIso(),
            commandId: command.id,
            commandKind: command.kind,
            sourceDirectiveId,
            blockedDraftCount: blockedWriteDrafts.length,
            blockedActions: blockedWriteDrafts
              .map((draft) => draft.action.trim().toLowerCase())
              .filter((value) => value.length > 0)
              .slice(0, 12),
            retainedDraftCount: executionDrafts.length,
          })
          .catch(() => undefined);
        if (executionDrafts.length === 0) {
          return this.failedOutcome(
            command,
            "Chat write actions are owner-only unless explicitly granted.",
            "chat_write_owner_only",
          );
        }
      }
    }
    if (enforcedDraftAction !== null && executableDrafts.length === 0) {
      await this.ctx.memory
        .recordWrite({
          type: "generate_draft_action_mismatch",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          enforcedAction: enforcedDraftAction,
          generatedActions: drafts
            .map((draft) => draft.action.trim().toLowerCase())
            .filter((action) => action.length > 0)
            .slice(0, 12),
          sourceDirectiveId,
        })
        .catch(() => undefined);
      return this.failedOutcome(
        command,
        `generate returned no executable ${enforcedDraftAction} draft.`,
        "no_executable_draft",
      );
    }
    const allowMultipleGeneratedDrafts =
      payload.allowMultipleGeneratedDrafts === true ||
      payload.executeAllDrafts === true;
    if (
      this.isDirectiveContextLinkedCommand(command) &&
      !allowMultipleGeneratedDrafts &&
      executionDrafts.length > 1
    ) {
      const keptDraft = executionDrafts[0];
      executionDrafts = keptDraft ? [keptDraft] : [];
      await this.ctx.memory
        .recordWrite({
          type: "generate_draft_multi_suppressed",
          at: nowIso(),
          commandId: command.id,
          sourceDirectiveId,
          originalDraftCount: permissionFilteredDrafts.length,
          keptDraftAction: keptDraft?.action ?? null,
          policy: "single_prompt_per_directive",
        })
        .catch(() => undefined);
    }
    if (executionDrafts.length === 0) {
      if (payload.requireDraftOnly === true) {
        const previewDelivered = await this.sendDraftFailureMessage({
          payload,
          message: "I couldn't generate a draft right now. Please try again.",
        }).catch(() => false);
        const failed = this.failedOutcome(
          command,
          "generate returned no permission-allowed drafts.",
          "no_permitted_drafts",
        );
        return {
          ...failed,
          data: {
            mode: "draft_preview",
            chatDeliveryHandled: previewDelivered,
          },
        };
      }
      return this.failedOutcome(
        command,
        "generate returned no permission-allowed drafts.",
        "no_permitted_drafts",
      );
    }

    const requireDraftOnly = payload.requireDraftOnly === true;
    if (requireDraftOnly) {
      const draftPreview = this.buildDraftPreviewPayload(executionDrafts);
      if (!draftPreview) {
        const previewDelivered = await this.sendDraftFailureMessage({
          payload,
          message: "I generated output, but couldn't shape a readable draft preview.",
        }).catch(() => false);
        const failed = this.failedOutcome(
          command,
          "generate returned drafts without previewable text.",
          "draft_preview_missing",
        );
        return {
          ...failed,
          data: {
            mode: "draft_preview",
            chatDeliveryHandled: previewDelivered,
          },
        };
      }
      const previewDelivered = await this.sendDraftPreviewMessage({
        payload,
        preview: draftPreview,
      }).catch(() => false);
      if (!previewDelivered) {
        return this.failedOutcome(
          command,
          "Draft generated, but preview delivery to chat failed.",
          "draft_preview_delivery_failed",
        );
      }
      return this.successOutcome(command, {
        generated: generatedResult,
        draftOnly: true,
        draftCount: executionDrafts.length,
        chatDeliveryHandled: previewDelivered,
        preview: {
          summary: draftPreview.summary,
          postKind: draftPreview.draftPostKind,
          mode: draftPreview.draftMode,
          slideCount: draftPreview.draftSlideCount,
        },
      });
    }

    const requireExplicitPublishVerb = payload.requireExplicitPublishVerb === true;
    const explicitPublishRequested = payload.explicitPublishRequested === true;
    if (
      requireExplicitPublishVerb &&
      !explicitPublishRequested &&
      this.shouldEnforceExplicitPublishGate(payload)
    ) {
      const blockedDraftCount = executionDrafts.filter((draft) =>
        this.isWriteDraftAction(draft.action),
      ).length;
      if (blockedDraftCount > 0) {
        await this.ctx.memory.recordWrite({
          type: "publish_blocked_missing_explicit_request",
          at: nowIso(),
          commandId: command.id,
          commandKind: command.kind,
          blockedDraftCount,
          sourceDirectiveId,
        }).catch(() => undefined);
        return this.failedOutcome(
          command,
          "Write action blocked: explicit post/comment/reply/like/repost/story request required.",
          "publish_verb_required",
        );
      }
    }

    const executedOutcomes: CommandOutcome[] = [];
    const skippedDrafts: Array<{ kind: string; reason: string }> = [];
    const failedDrafts: Array<{ kind: string; reason: string; code: string | null }> = [];
    const blockedWriteKinds = new Set<string>();
    for (const draft of executionDrafts) {
      if (!draft) continue;
      const draftCommand = this.mapDraftToWriteCommand({
        draft,
        command,
        sourceDirectiveId,
        sourceDirectiveActionNonce,
        provenance,
      });
      if (!draftCommand) continue;
      const normalizedDraftKind = draftCommand.kind.trim().toLowerCase();
      if (blockedWriteKinds.has(normalizedDraftKind)) {
        skippedDrafts.push({
          kind: normalizedDraftKind,
          reason: "skipped_after_recoverable_grant_denial",
        });
        continue;
      }
      try {
        const outcome = await this.executeCommandFromMappedDraft(draftCommand);
        executedOutcomes.push(outcome);
        if (!outcome.ok) {
          const failureReason = asNonEmptyString(outcome.error?.message) ??
            "generated draft execution failed.";
          failedDrafts.push({
            kind: normalizedDraftKind,
            reason: failureReason,
            code: asNonEmptyString(outcome.error?.code) ?? null,
          });
          await this.ctx.memory
            .recordWrite({
              type: "generate_draft_execution_failed",
              at: nowIso(),
              commandId: command.id,
              draftKind: normalizedDraftKind,
              reason: failureReason,
              code: asNonEmptyString(outcome.error?.code) ?? null,
              sourceDirectiveId,
            })
            .catch(() => undefined);
          if (this.isRecoverableDraftGrantErrorMessage(failureReason)) {
            blockedWriteKinds.add(normalizedDraftKind);
          }
          continue;
        }
        const outcomeData = isRecord(outcome.data) ? outcome.data : null;
        const skipped = outcomeData?.skipped === true;
        const decision = asNonEmptyString(outcomeData?.decision);
        if (skipped) {
          const reason = decision ?? "skipped";
          skippedDrafts.push({
            kind: normalizedDraftKind,
            reason,
          });
          if (this.isRecoverableDraftSkipDecision(reason)) {
            blockedWriteKinds.add(normalizedDraftKind);
          }
        }
      } catch (error: unknown) {
        // If the write executor threw RequeueCommandError and no drafts have applied yet,
        // propagate it so the command actually gets requeued (with cached drafts).
        // This prevents burning a generated prompt for nothing.
        if (error instanceof RequeueCommandError) {
          const anyApplied = executedOutcomes.some((entry) => entry.ok);
          if (!anyApplied) {
            throw error;
          }
          // Some drafts already applied — can't requeue without creating duplicates,
          // so treat this draft as failed and continue.
        }
        const reason = error instanceof Error ? error.message : String(error);
        if (this.isRecoverableDraftExecutionError(error)) {
          blockedWriteKinds.add(normalizedDraftKind);
          skippedDrafts.push({
            kind: normalizedDraftKind,
            reason,
          });
          await this.ctx.memory
            .recordWrite({
              type: "generate_draft_execution_skipped",
              at: nowIso(),
              commandId: command.id,
              draftKind: normalizedDraftKind,
              reason,
              sourceDirectiveId,
            })
            .catch(() => undefined);
          continue;
        }
        failedDrafts.push({
          kind: normalizedDraftKind,
          reason,
          code: null,
        });
        await this.ctx.memory
          .recordWrite({
            type: "generate_draft_execution_failed",
            at: nowIso(),
            commandId: command.id,
            draftKind: normalizedDraftKind,
            reason,
            sourceDirectiveId,
          })
          .catch(() => undefined);
        if (this.isRecoverableDraftGrantErrorMessage(reason)) {
          blockedWriteKinds.add(normalizedDraftKind);
        }
        continue;
      }
    }

    const firstFailure = failedDrafts[0] ?? null;
    if (firstFailure && executedOutcomes.filter((entry) => entry.ok).length === 0) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: "failed",
        message: firstFailure.reason,
        metadata: {
          executedCount: executedOutcomes.length,
          failedCount: failedDrafts.length,
        },
      });
      return this.failedOutcome(
        command,
        firstFailure.reason,
        firstFailure.code ?? undefined,
      );
    }

    const appliedOutcomeCount = executedOutcomes.filter((entry) => {
      if (!entry.ok) return false;
      const entryData = isRecord(entry.data) ? entry.data : null;
      return entryData?.skipped !== true;
    }).length;
    const skippedReasonSet = new Set(
      skippedDrafts
        .map((entry) => entry.reason.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    );
    const allSkippedReasonsIdempotentNoop =
      skippedReasonSet.size > 0 &&
      Array.from(skippedReasonSet).every(
        (reason) => reason === "already_acked" || reason === "already_in_flight",
      );
    if (appliedOutcomeCount === 0 && skippedDrafts.length > 0 && failedDrafts.length === 0) {
      if (allSkippedReasonsIdempotentNoop) {
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: "write_mutation",
          status: "ok",
          metadata: {
            executedCount: executedOutcomes.length,
            skippedCount: skippedDrafts.length,
            failedCount: failedDrafts.length,
            idempotentNoop: true,
          },
        });
      } else {
      const firstSkipReason = skippedDrafts[0]?.reason ?? "no_executable_draft";
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: "failed",
        message: firstSkipReason,
        metadata: {
          executedCount: executedOutcomes.length,
          skippedCount: skippedDrafts.length,
          failedCount: failedDrafts.length,
        },
      });
      return this.failedOutcome(
        command,
        `Generated drafts were skipped: ${truncateText(firstSkipReason, 220)}.`,
        "no_executable_draft",
      );
      }
    }

    if (executedOutcomes.length > 0 || skippedDrafts.length > 0 || failedDrafts.length > 0) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "write_mutation",
        status: failedDrafts.length > 0 && appliedOutcomeCount === 0 ? "failed" : "ok",
        message: failedDrafts.length > 0 ? failedDrafts[0]?.reason ?? null : null,
        metadata: {
          executedCount: executedOutcomes.length,
          appliedCount: appliedOutcomeCount,
          executedKinds: executedOutcomes.map((entry) => entry.kind),
          skippedCount: skippedDrafts.length,
          failedCount: failedDrafts.length,
        },
      });
    }

    // Command completed — clear the draft cache entry.
    this.generatedDraftCache.delete(command.id);

    return this.successOutcome(command, {
      generated: generatedResult,
      executed: executedOutcomes.map((entry) => {
        const entryData = isRecord(entry.data) ? entry.data : null;
        const commandId = asNonEmptyString(entry.commandId) ?? "";
        const kind = asNonEmptyString(entry.kind) ?? "";
        const postId =
          asPositiveInt(entryData?.postId) ??
          asPositiveInt(entryData?.targetPostId) ??
          null;
        const commentId =
          asPositiveInt(entryData?.commentId) ??
          asPositiveInt(entryData?.parentId) ??
          asPositiveInt(entryData?.targetCommentId) ??
          null;
        const action = asNonEmptyString(entryData?.action) ?? null;
        const decision = asNonEmptyString(entryData?.decision) ?? null;
        const delta =
          typeof entryData?.delta === "number" && Number.isFinite(entryData.delta)
            ? entryData.delta
            : null;
        const applied = typeof entryData?.applied === "boolean" ? entryData.applied : null;
        return {
          commandId,
          kind,
          ok: entry.ok,
          skipped: entryData?.skipped === true,
          ...(action ? { action } : {}),
          ...(postId ? { postId } : {}),
          ...(commentId ? { commentId } : {}),
          ...(decision ? { decision } : {}),
          ...(delta !== null ? { delta } : {}),
          ...(applied !== null ? { applied } : {}),
        };
      }),
      ...(skippedDrafts.length > 0
        ? {
            skippedDrafts: skippedDrafts.slice(0, 24),
          }
        : {}),
      ...(failedDrafts.length > 0
        ? {
            failedDrafts: failedDrafts.slice(0, 24),
          }
        : {}),
    });
  }

  private shouldEnforceExplicitPublishGate(payload: Record<string, unknown>): boolean {
    if (payload.chatLiteralGenerate === true) return false;
    const goal = asNonEmptyString(payload.goal)?.toLowerCase() ?? "";
    if (goal === "chat" || goal === "settings" || goal === "moderation") {
      return false;
    }

    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    const commandName = asNonEmptyString(chatContext?.commandName)?.toLowerCase() ?? "";
    if (
      commandName === "follow" ||
      commandName === "follow-engagers" ||
      commandName === "followengagers" ||
      commandName === "follow-accept" ||
      commandName === "followaccept" ||
      commandName === "agent-status" ||
      commandName === "chat-status" ||
      commandName === "settings"
    ) {
      return false;
    }

    const serverIntentHint = isRecord(chatContext?.serverIntentHint)
      ? chatContext.serverIntentHint
      : null;
    const actionFamily =
      asNonEmptyString(serverIntentHint?.actionFamily)?.toLowerCase() ?? "";
    if (
      actionFamily === "conversation" ||
      actionFamily === "settings" ||
      actionFamily === "assist" ||
      actionFamily === "research"
    ) {
      return false;
    }

    return true;
  }

  private isWriteDraftAction(actionValue: string): boolean {
    const action = actionValue.trim().toLowerCase();
    return (
      action === "post" ||
      action === "story" ||
      action === "comment" ||
      action === "like" ||
      action === "repost" ||
      action === "avatar" ||
      action === "banner"
    );
  }

  private isChatWriteRequesterOwner(payload: Record<string, unknown>): boolean {
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    const actorMainUserId =
      asNonEmptyString(chatContext?.actorMainUserId) ??
      asNonEmptyString(payload.actorMainUserId);
    const ownerMainUserId =
      asNonEmptyString(chatContext?.ownerMainUserId) ??
      asNonEmptyString(payload.ownerMainUserId);
    if (!ownerMainUserId) return true;
    if (!actorMainUserId) return false;
    return actorMainUserId === ownerMainUserId;
  }

  private isChatWriteCommandExplicitlyRequested(
    payload: Record<string, unknown>,
  ): boolean {
    if (
      payload.explicitPublishRequested === true ||
      payload.explicitPublishVerbDetected === true
    ) {
      return true;
    }
    const chatCommandName = this.resolveChatCommandName(payload);
    if (chatCommandName) {
      const normalized = chatCommandName.trim().toLowerCase().replace(/[\s-]+/gu, "_");
      if (
        normalized === "post" ||
        normalized === "schedule" ||
        normalized === "reply_post" ||
        normalized === "replypost" ||
        normalized === "reply_commenters" ||
        normalized === "reply_comments" ||
        normalized === "comment" ||
        normalized === "like" ||
        normalized === "repost" ||
        normalized === "story" ||
        normalized === "stories"
      ) {
        return true;
      }
      if (normalized === "assist") {
        const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
        const args = Array.isArray(chatContext?.commandArgs)
          ? chatContext.commandArgs
              .map((entry) => asNonEmptyString(entry)?.trim().toLowerCase() ?? "")
              .filter((entry) => entry.length > 0)
          : [];
        const assistAction = args[0] ?? "";
        if (
          assistAction === "reply-circle" ||
          assistAction === "reply_circle" ||
          assistAction === "advertise-post" ||
          assistAction === "advertise_post" ||
          assistAction === "like-circle-stories" ||
          assistAction === "like_circle_stories"
        ) {
          return true;
        }
      }
    }
    const requestedAction = asNonEmptyString(payload.requestedAction)?.toLowerCase() ?? "";
    if (
      requestedAction === "post" ||
      requestedAction === "story" ||
      requestedAction === "comment" ||
      requestedAction === "reply" ||
      requestedAction === "like" ||
      requestedAction === "repost"
    ) {
      return true;
    }
    const goal = asNonEmptyString(payload.goal)?.toLowerCase() ?? "";
    return (
      goal === "post" ||
      goal === "story" ||
      goal === "comment" ||
      goal === "like" ||
      goal === "repost"
    );
  }

  private isChatMediaIntentPayload(payload: Record<string, unknown>): boolean {
    if (payload.chatLiteralGenerate === true || payload.chatLiteralGenerate === "true") {
      return true;
    }
    const generatedAssetType = asNonEmptyString(payload.generatedAssetType)?.toLowerCase() ?? "";
    if (
      generatedAssetType === "image" ||
      generatedAssetType === "gif" ||
      generatedAssetType === "video" ||
      generatedAssetType === "mp4"
    ) {
      return true;
    }
    const requestedKinds = this.resolveRequestedGenerateKinds(payload, "media");
    if (requestedKinds.includes("media") || requestedKinds.includes("multi_media")) {
      return true;
    }
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    const serverIntentHint = isRecord(chatContext?.serverIntentHint)
      ? chatContext.serverIntentHint
      : null;
    if (serverIntentHint?.wantsGeneratedImage === true) {
      return true;
    }
    const signal = [
      asNonEmptyString(payload.mediaPrompt),
      asNonEmptyString(payload.imagePrompt),
      asNonEmptyString(payload.prompt),
      asNonEmptyString(payload.topic),
      asNonEmptyString(payload.requestText),
      asNonEmptyString(chatContext?.originalMessage),
      asNonEmptyString(chatContext?.commandRawArgs),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ");
    return /\b(image|gif|photo|picture|visual|illustration|art|render|sticker|emote|emoji|avatar|banner)\b/iu.test(
      signal,
    );
  }

  private resolveChatLiteralFallbackPromptFromDrafts(input: {
    payload: Record<string, unknown>;
    drafts: GeneratedDraft[];
  }): string | null {
    for (const draft of input.drafts) {
      const draftPayload = isRecord(draft.payload) ? draft.payload : null;
      if (!draftPayload) continue;
      const resolved =
        asNonEmptyString(draftPayload.mediaPrompt) ??
        asNonEmptyString(draftPayload.imagePrompt) ??
        asNonEmptyString(draftPayload.prompt) ??
        asNonEmptyString(draftPayload.topic) ??
        asNonEmptyString(draftPayload.caption) ??
        asNonEmptyString(draftPayload.textBody) ??
        asNonEmptyString(draftPayload.body);
      if (resolved) return resolved;
    }
    return (
      asNonEmptyString(input.payload.mediaPrompt) ??
      asNonEmptyString(input.payload.imagePrompt) ??
      asNonEmptyString(input.payload.prompt) ??
      asNonEmptyString(input.payload.topic) ??
      asNonEmptyString(input.payload.requestText) ??
      null
    );
  }

  private shouldRedirectBlockedChatWritesToLiteralGenerate(input: {
    payload: Record<string, unknown>;
    blockedDrafts: GeneratedDraft[];
  }): boolean {
    if (this.isChatMediaIntentPayload(input.payload)) {
      return true;
    }
    return input.blockedDrafts.some((draft) => this.isPersonaMediaCompatibleDraft(draft));
  }

  private isChatOriginPayload(payload: Record<string, unknown> | null): boolean {
    if (!payload) return false;
    const sourceContext = asNonEmptyString(payload.sourceContext)?.toLowerCase() ?? "";
    if (sourceContext === "chat") return true;
    if (
      sourceContext === "directive" ||
      sourceContext === "director" ||
      sourceContext === "admin" ||
      sourceContext === "autonomous"
    ) {
      return false;
    }
    return isRecord(payload.chatContext);
  }

  private isChatOriginCommand(
    command: Command,
    payloadOverride?: Record<string, unknown> | null,
  ): boolean {
    const runtimeOrigin = asNonEmptyString(command.runtimeOrigin)?.toLowerCase() ?? "";
    if (runtimeOrigin === "chat" || runtimeOrigin.startsWith("chat_")) {
      return true;
    }
    const payload =
      payloadOverride ??
      (isRecord(command.payload) ? command.payload : null);
    if (
      runtimeOrigin === "director_directive" ||
      runtimeOrigin === "pending_promotion"
    ) {
      return this.isChatOriginPayload(payload);
    }
    if (runtimeOrigin === "runtime_resealed") {
      const commandId = asNonEmptyString(command.id);
      const sourceDirectiveId = this.resolveCommandSourceDirectiveId({
        command,
        payload,
      });
      const pendingDirectiveId = asNonEmptyString(command.pendingDirectiveId);
      if (
        commandId &&
        (sourceDirectiveId === commandId || pendingDirectiveId === commandId)
      ) {
        return false;
      }
    }
    return this.isChatOriginPayload(payload);
  }

  private isStoryGenerateRequestFromChatPayload(
    payload: Record<string, unknown>,
  ): boolean {
    if (!this.didChatMessageExplicitlyRequestStory(payload)) {
      return false;
    }
    const requestedKinds = this.resolveRequestedGenerateKinds(payload, "media");
    if (requestedKinds.includes("story")) return true;
    const commandName = this.resolveChatCommandName(payload);
    if (commandName) {
      const normalized = commandName.trim().toLowerCase().replace(/[\s-]+/gu, "_");
      if (
        normalized === "story" ||
        normalized === "stories" ||
        normalized === "generate_story" ||
        normalized === "generate_stories"
      ) {
        return true;
      }
    }
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    const commandArgs = Array.isArray(chatContext?.commandArgs)
      ? chatContext.commandArgs
      : [];
    for (const entry of commandArgs) {
      if (this.normalizeRequestedGenerateKind(entry) === "story") {
        return true;
      }
    }
    return true;
  }

  private didChatMessageExplicitlyRequestStory(
    payload: Record<string, unknown>,
  ): boolean {
    const commandName = this.resolveChatCommandName(payload);
    if (commandName) {
      const normalizedCommandName = commandName
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/gu, "_");
      if (
        normalizedCommandName === "story" ||
        normalizedCommandName === "stories" ||
        normalizedCommandName === "generate_story" ||
        normalizedCommandName === "generate_stories"
      ) {
        return true;
      }
    }
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    const commandArgs = Array.isArray(chatContext?.commandArgs)
      ? chatContext.commandArgs
      : [];
    for (const entry of commandArgs) {
      if (this.normalizeRequestedGenerateKind(entry) === "story") {
        return true;
      }
    }

    const explicitTextCandidates = [
      asNonEmptyString(chatContext?.originalMessage),
      asNonEmptyString(chatContext?.commandRawArgs),
    ]
      .map((entry) => entry?.trim() ?? "")
      .filter((entry) => entry.length > 0);
    if (explicitTextCandidates.length === 0) return false;

    const messageText = explicitTextCandidates[0] ?? "";
    if (!/\bstor(?:y|ies)\b/iu.test(messageText)) return false;
    if (
      /\b(?:make|create|generate|post|publish|share|write|queue|start|do)\b[\w\s,.'"!?-]{0,64}\bstor(?:y|ies)\b/iu.test(
        messageText,
      )
    ) {
      return true;
    }
    if (
      /\bstor(?:y|ies)\b[\w\s,.'"!?-]{0,32}\b(?:post|publish|share|make|create|generate)\b/iu.test(
        messageText,
      )
    ) {
      return true;
    }
    return false;
  }

  private parseGeneratedCustomAssetKind(
    value: unknown,
  ): GeneratedCustomAssetKind | null {
    const normalized = asNonEmptyString(value)?.toLowerCase() ?? "";
    if (normalized === "emote") return "emote";
    if (normalized === "sticker") return "sticker";
    if (normalized === "gif") return "gif";
    return null;
  }

  private parseGeneratedCustomAssetScope(
    value: unknown,
  ): GeneratedCustomAssetScope | null {
    const normalized = asNonEmptyString(value)?.toLowerCase() ?? "";
    if (normalized === "mine") return "mine";
    if (normalized === "group") return "group";
    if (normalized === "server") return "server";
    return null;
  }

  private parseGeneratedCustomAssetTransformSpec(
    payload: Record<string, unknown>,
  ): CustomAssetTransformSpec | undefined {
    const explicitRoot = isRecord(payload.generatedCustomAssetSave)
      ? payload.generatedCustomAssetSave
      : null;
    const explicitTransform = isRecord(explicitRoot?.transform)
      ? explicitRoot.transform
      : isRecord(payload.generatedCustomAssetTransform)
        ? payload.generatedCustomAssetTransform
        : null;
    if (!explicitTransform) return undefined;
    const parseNumeric = (
      value: unknown,
      clampMin: number,
      clampMax: number,
    ): number | undefined => {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      return Math.max(clampMin, Math.min(clampMax, value));
    };
    const parseIntNumeric = (
      value: unknown,
      clampMin: number,
      clampMax: number,
    ): number | undefined => {
      const parsed = parseNumeric(value, clampMin, clampMax);
      return typeof parsed === "number" ? Math.floor(parsed) : undefined;
    };
    const fitRaw = asNonEmptyString(explicitTransform.fit)?.toLowerCase();
    const fit =
      fitRaw === "cover" || fitRaw === "contain" || fitRaw === "inside"
        ? fitRaw
        : undefined;
    const formatRaw = asNonEmptyString(explicitTransform.format)?.toLowerCase();
    const format =
      formatRaw === "gif" ||
      formatRaw === "webp" ||
      formatRaw === "png" ||
      formatRaw === "jpeg"
        ? formatRaw
        : undefined;
    const width = parseIntNumeric(explicitTransform.width, 16, 2048);
    const height = parseIntNumeric(explicitTransform.height, 16, 2048);
    const rotateDeg = parseNumeric(explicitTransform.rotateDeg, -360, 360);
    const brightness = parseNumeric(explicitTransform.brightness, 0.1, 3);
    const contrast = parseNumeric(explicitTransform.contrast, 0.2, 3);
    const saturation = parseNumeric(explicitTransform.saturation, 0, 3);
    const blur = parseNumeric(explicitTransform.blur, 0, 20);
    const sharpen = parseNumeric(explicitTransform.sharpen, 0, 10);
    const quality = parseIntNumeric(explicitTransform.quality, 30, 100);
    const spec: CustomAssetTransformSpec = {
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(fit ? { fit } : {}),
      ...(rotateDeg !== undefined ? { rotateDeg } : {}),
      ...(brightness !== undefined ? { brightness } : {}),
      ...(contrast !== undefined ? { contrast } : {}),
      ...(saturation !== undefined ? { saturation } : {}),
      ...(blur !== undefined ? { blur } : {}),
      ...(sharpen !== undefined ? { sharpen } : {}),
      ...(quality !== undefined ? { quality } : {}),
      ...(format ? { format } : {}),
    };
    if (Object.keys(spec).length === 0) return undefined;
    return spec;
  }

  private async prepareGeneratedCustomAssetForSave(input: {
    command: Command;
    payload: Record<string, unknown>;
    sourcePrompt: string;
    sourceUrl: string;
    sourceMimeType: string;
    intent: GeneratedCustomAssetSaveIntent;
  }): Promise<{
    mediaUrl: string;
    mimeType: string;
    width: number | undefined;
    height: number | undefined;
    isAnimated: boolean | undefined;
    transformNotes: string[];
  }> {
    const fallbackMimeType = input.sourceMimeType;
    const transformSpec = this.parseGeneratedCustomAssetTransformSpec(input.payload);
    try {
      const transformed = await transformCustomAssetMedia({
        sourceUrl: input.sourceUrl,
        sourceMimeType: input.sourceMimeType,
        kind: input.intent.kind,
        ...(transformSpec ? { spec: transformSpec } : {}),
      });
      if (!transformed?.bytes?.byteLength) {
        return {
          mediaUrl: input.sourceUrl,
          mimeType: fallbackMimeType,
          width: undefined,
          height: undefined,
          isAnimated:
            input.intent.kind === "gif" || fallbackMimeType.trim().toLowerCase() === "image/gif"
              ? true
              : undefined,
          transformNotes: ["transform_skipped_empty_output"],
        };
      }

      const fileExt = mimeToExt(transformed.mimeType);
      const uploadFilename = `${input.intent.kind}-${Date.now()}.${fileExt}`;
      const chunkUploaded = await this.uploadBytesViaChunkRoute({
        bytes: transformed.bytes,
        mimeType: transformed.mimeType,
        filename: uploadFilename,
      });
      const uploaded =
        chunkUploaded ??
        this.mapUploadResult(
          await this.agent().uploadDataUri.mutate({
            dataUri: `data:${transformed.mimeType};base64,${transformed.bytes.toString("base64")}`,
          }),
        );
      const transformedMime = transformed.mimeType.trim().toLowerCase();
      return {
        mediaUrl: uploaded.mediaUrl,
        mimeType: transformedMime || fallbackMimeType,
        width:
          typeof transformed.width === "number" && Number.isFinite(transformed.width)
            ? transformed.width
            : undefined,
        height:
          typeof transformed.height === "number" && Number.isFinite(transformed.height)
            ? transformed.height
            : undefined,
        isAnimated:
          input.intent.kind === "gif" || transformedMime === "image/gif" ? true : undefined,
        transformNotes: transformed.notes,
      };
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "generated_custom_asset_transform_failed",
          at: nowIso(),
          commandId: input.command.id,
          kind: input.intent.kind,
          sourcePrompt: truncateText(input.sourcePrompt, 220),
          sourceUrl: input.sourceUrl,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return {
        mediaUrl: input.sourceUrl,
        mimeType: fallbackMimeType,
        width: undefined,
        height: undefined,
        isAnimated:
          input.intent.kind === "gif" || fallbackMimeType.trim().toLowerCase() === "image/gif"
            ? true
            : undefined,
        transformNotes: ["transform_failed_fallback_source"],
      };
    }
  }

  private resolveGeneratedCustomAssetSaveIntent(
    payload: Record<string, unknown>,
    sourcePrompt: string,
  ): GeneratedCustomAssetSaveIntent | null {
    const explicit = isRecord(payload.generatedCustomAssetSave)
      ? payload.generatedCustomAssetSave
      : null;
    if (explicit) {
      if (explicit.disabled === true || explicit.enabled === false) {
        return null;
      }
      const explicitKind = this.parseGeneratedCustomAssetKind(explicit.kind);
      const explicitScope =
        this.parseGeneratedCustomAssetScope(explicit.scope) ?? "mine";
      if (explicitKind) {
        return {
          kind: explicitKind,
          scope: explicitScope,
          nameHint: asNonEmptyString(explicit.nameHint),
        };
      }
    }

    const normalized = sourcePrompt.trim().toLowerCase();
    if (!normalized.length) return null;
    const inferredScope: GeneratedCustomAssetScope =
      /\b(?:group|conversation|this group)\b/iu.test(normalized)
        ? "group"
        : /\b(?:server|guild|channel|this server)\b/iu.test(normalized)
          ? "server"
          : "mine";
    const kindCandidates: Array<{
      kind: GeneratedCustomAssetKind;
      index: number;
    }> = [
      { kind: "emote" as const, index: normalized.search(/\bemote(?:s)?\b/iu) },
      { kind: "sticker" as const, index: normalized.search(/\bsticker(?:s)?\b/iu) },
      { kind: "gif" as const, index: normalized.search(/\bgif(?:s)?\b/iu) },
    ].filter((entry) => entry.index >= 0);
    kindCandidates.sort((a, b) => a.index - b.index);
    const inferredKind = kindCandidates[0]?.kind ?? null;

    const hasSaveVerb = /\b(?:attach|add|save|store|put|set)\b/iu.test(normalized);
    const hasTargetHint = /\b(?:to|as|in|into|for)\b/iu.test(normalized);
    if (hasSaveVerb && hasTargetHint && inferredKind) {
      return { kind: inferredKind, scope: inferredScope, nameHint: null };
    }

    const hasGenerateVerb = /\b(?:generate|create|make|render|draw|design)\b/iu.test(
      normalized,
    );
    if (hasGenerateVerb && inferredKind) {
      return { kind: inferredKind, scope: inferredScope, nameHint: null };
    }
    return null;
  }

  private buildGeneratedCustomAssetName(input: {
    kind: GeneratedCustomAssetKind;
    sourcePrompt: string;
    nameHint: string | null;
  }): string {
    const maxLen = input.kind === "gif" ? 64 : 32;
    const normalized = (input.nameHint ?? input.sourcePrompt)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]+/gu, " ")
      .replace(/[\s-]+/gu, "_")
      .replace(/_+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, maxLen);
    if (normalized.length >= 2) return normalized;
    return `${input.kind}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  }

  private resolveGeneratedAssetServerId(payload: Record<string, unknown>): string | null {
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    return (
      asNonEmptyString(payload.serverId) ??
      asNonEmptyString(payload.chatServerId) ??
      asNonEmptyString(payload.targetServerId) ??
      asNonEmptyString(chatContext?.serverId)
    );
  }

  private async saveGeneratedCustomAsset(input: {
    command: Command;
    payload: Record<string, unknown>;
    intent: GeneratedCustomAssetSaveIntent;
    sourcePrompt: string;
    mediaUrl: string;
    mimeType: string;
    chatTarget: { conversationId?: string; channelId?: string };
  }): Promise<GeneratedCustomAssetSaveResult> {
    if (!this.ctx.callAgentChatBridge) {
      throw new Error("chat_bridge_unavailable");
    }

    if (input.intent.scope === "group" && !input.chatTarget.conversationId) {
      throw new Error("group_custom_asset_requires_conversation_context");
    }

    const serverId = this.resolveGeneratedAssetServerId(input.payload);
    if (input.intent.scope === "server" && !serverId) {
      throw new Error("server_custom_asset_requires_server_id");
    }

    const name = this.buildGeneratedCustomAssetName({
      kind: input.intent.kind,
      sourcePrompt: input.sourcePrompt,
      nameHint: input.intent.nameHint,
    });

    const prepared = await this.prepareGeneratedCustomAssetForSave({
      command: input.command,
      payload: input.payload,
      sourcePrompt: input.sourcePrompt,
      sourceUrl: input.mediaUrl,
      sourceMimeType: input.mimeType,
      intent: input.intent,
    });

    const result = await this.ctx.callAgentChatBridge({
      action: "save_custom_asset",
      kind: input.intent.kind,
      scope: input.intent.scope,
      name,
      url: prepared.mediaUrl,
      ...(input.intent.kind === "gif" ? { previewUrl: prepared.mediaUrl } : {}),
      mimeType: prepared.mimeType,
      ...(prepared.width !== undefined ? { width: prepared.width } : {}),
      ...(prepared.height !== undefined ? { height: prepared.height } : {}),
      ...(prepared.isAnimated !== undefined
        ? { isAnimated: prepared.isAnimated }
        : {}),
      ...(input.chatTarget.conversationId
        ? { conversationId: input.chatTarget.conversationId }
        : {}),
      ...(serverId ? { serverId } : {}),
    });

    if (prepared.transformNotes.length > 0) {
      await this.ctx.memory
        .recordWrite({
          type: "generated_custom_asset_saved",
          at: nowIso(),
          commandId: input.command.id,
          kind: input.intent.kind,
          scope: input.intent.scope,
          sourceUrl: input.mediaUrl,
          savedUrl: prepared.mediaUrl,
          transformNotes: prepared.transformNotes,
        })
        .catch(() => undefined);
    }

    const resultRecord = isRecord(result) ? result : null;
    const savedRecord = resultRecord && isRecord(resultRecord.saved)
      ? resultRecord.saved
      : null;
    const id =
      savedRecord && typeof savedRecord.id === "number" && Number.isFinite(savedRecord.id)
        ? Math.floor(savedRecord.id)
        : null;
    return {
      kind: input.intent.kind,
      scope: input.intent.scope,
      name,
      id,
      url: asNonEmptyString(savedRecord?.url),
      mimeType: asNonEmptyString(savedRecord?.mimeType)?.toLowerCase() ?? null,
    };
  }

  private resolveGeneratedAssetType(value: unknown): GeneratedAssetType {
    const normalized = asNonEmptyString(value)?.toLowerCase() ?? "image";
    if (normalized === "gif") return "gif";
    if (normalized === "pdf") return "pdf";
    if (normalized === "csv") return "csv";
    if (normalized === "code") return "code";
    if (normalized === "file") return "file";
    if (normalized === "txt") return "txt";
    if (normalized === "md") return "md";
    return "image";
  }

  private resolveGeneratedAttachmentMimeType(input: {
    generatedAssetType: GeneratedAssetType;
    mediaUrl: string;
    mediaType?: "image" | "video";
  }): string {
    const fromUrl = inferMimeTypeFromUrl(input.mediaUrl);
    if (fromUrl && fromUrl !== "application/octet-stream") return fromUrl;
    if (input.generatedAssetType === "gif") return "image/gif";
    if (input.generatedAssetType === "pdf") return "application/pdf";
    if (input.generatedAssetType === "csv") return "text/csv";
    if (input.generatedAssetType === "md") return "text/markdown";
    if (input.generatedAssetType === "txt") return "text/plain";
    if (input.generatedAssetType === "code") return "text/plain";
    if (input.mediaType === "video") return "video/mp4";
    return "image/png";
  }

  private async executeChatLiteralGenerate(
    command: Command,
    payload: Record<string, unknown>,
  ): Promise<CommandOutcome> {
    const chatTarget = resolveChatTargetFromPayload(payload);
    if (!chatTarget) {
      return this.failedOutcome(
        command,
        "Missing chat context for literal generate request.",
        "chat_context_missing",
      );
    }
    if (!this.ctx.callAgentChatBridge) {
      return this.failedOutcome(
        command,
        "Chat bridge unavailable for literal generate request.",
        "chat_bridge_unavailable",
      );
    }

    const requestedAction = asNonEmptyString(payload.requestedAction)?.toLowerCase() ?? "";
    const avatarRequest =
      payload.avatarRequest === true || requestedAction === "avatar";
    const bannerRequest =
      !avatarRequest && (payload.bannerRequest === true || requestedAction === "banner");
    const avatarTargetRaw = asNonEmptyString(payload.avatarTarget)?.toLowerCase();
    const avatarTarget = avatarTargetRaw === "owner" ? "owner" : "agent";
    const bannerTargetRaw = asNonEmptyString(payload.bannerTarget)?.toLowerCase();
    const bannerTarget = bannerTargetRaw === "owner" ? "owner" : "agent";
    const defaultAvatarPrompt =
      avatarTarget === "owner"
        ? "Create a profile avatar for my account on this social app."
        : "Create a profile avatar for your account on this social app.";
    const defaultBannerPrompt =
      bannerTarget === "owner"
        ? "Create a profile banner for my account on this social app."
        : "Create a profile banner for your account on this social app.";
    const basePrompt =
      asNonEmptyString(payload.mediaPrompt) ??
      asNonEmptyString(payload.imagePrompt) ??
      asNonEmptyString(payload.prompt) ??
      asNonEmptyString(payload.topic) ??
      asNonEmptyString(payload.requestText) ??
      (avatarRequest
        ? defaultAvatarPrompt
        : bannerRequest
          ? defaultBannerPrompt
          : null);
    if (!basePrompt) {
      return this.failedOutcome(
        command,
        "No prompt provided for literal generate request.",
        "missing_prompt",
      );
    }
    const recentGeneratedAsset = isRecord(payload.recentGeneratedAsset)
      ? payload.recentGeneratedAsset
      : null;
    const recentGeneratedAssetType =
      asNonEmptyString(recentGeneratedAsset?.type)?.toLowerCase() ?? "";
    const recentGeneratedAssetSummary = asNonEmptyString(
      recentGeneratedAsset?.summary,
    );
    const recentGeneratedAssetHref = asNonEmptyString(recentGeneratedAsset?.href);
    const shouldReusePersonaReference =
      avatarRequest &&
      avatarTarget === "agent" &&
      (recentGeneratedAssetType === "persona" ||
        recentGeneratedAssetType === "avatar");
    const profileCropSpec = avatarRequest
      ? normalizeProfileCropSpec(buildProfileCropSpec("avatar"))
      : bannerRequest
        ? normalizeProfileCropSpec(buildProfileCropSpec("banner"))
        : null;
    const promptBase = shouldReusePersonaReference
      ? [
          basePrompt,
          "Maintain visual persona continuity with the previous avatar.",
          recentGeneratedAssetSummary
            ? `Previous persona summary: ${recentGeneratedAssetSummary}`
            : null,
          recentGeneratedAssetHref
            ? `Previous persona reference URL: ${recentGeneratedAssetHref}`
            : null,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n")
      : basePrompt;
    const prompt = profileCropSpec
      ? [promptBase, buildProfileCropPromptHint(profileCropSpec)]
          .filter((entry) => entry.trim().length > 0)
          .join("\n\n")
      : promptBase;
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveId =
      this.resolveCommandSourceDirectiveId({ command, payload });
    const sourceDirectiveActionNonce =
      this.resolveCommandSourceDirectiveActionNonce({ command, payload });

    const generatedAssetType = this.resolveGeneratedAssetType(payload.generatedAssetType);
    const fallbackReferenceInputs = this.collectMediaReferenceInputs(payload);
    const personaReferences = await this.resolvePersonaFrameReferences({
      payload,
      command,
      fallbackReferenceInputs,
    });
    const referenceInputs =
      personaReferences.personaSlug !== null
        ? [...personaReferences.frameReferences]
        : [...fallbackReferenceInputs];
    const personaSetupRequiredSlug =
      personaReferences.personaSlug !== null &&
      referenceInputs.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT
        ? personaReferences.personaSlug
        : null;
    if (
      personaReferences.personaSlug === null &&
      shouldReusePersonaReference &&
      recentGeneratedAssetHref &&
      !referenceInputs.includes(recentGeneratedAssetHref)
    ) {
      referenceInputs.unshift(recentGeneratedAssetHref);
    }
    const generatedLabel =
      bannerRequest
        ? "banner"
        : generatedAssetType === "gif"
          ? "GIF"
          : "image";
    const generatedCustomAssetSaveIntent =
      !avatarRequest && !bannerRequest
        ? this.resolveGeneratedCustomAssetSaveIntent(payload, basePrompt)
        : null;
    const summary = truncateText(basePrompt, 220);
    const chatRoute = chatTarget.conversationId
      ? { conversationId: chatTarget.conversationId }
      : { channelId: chatTarget.channelId };
    const previewType = avatarRequest
      ? "persona"
      : bannerRequest
        ? "banner"
        : generatedAssetType;
    const processingTitle =
      avatarRequest
        ? "Generating avatar"
        : bannerRequest
          ? "Generating banner"
          : `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} in progress`;
    const processingBody =
      avatarRequest
        ? "Working on your avatar now..."
        : bannerRequest
          ? "Working on your banner now..."
          : `Generating ${generatedLabel} for "${summary}".`;
    let previewMessageId: string | null = null;
    const existingProcessingClientMessageId =
      this.resolveChatProcessingClientMessageId(command);
    const previewClientMessageId =
      existingProcessingClientMessageId ?? `runtime_generate_${command.id}`;
    let previewMessageCreateAttempted = Boolean(existingProcessingClientMessageId);
    let previewProgressFingerprint = "";
    let previewProgressUpdatedAtMs = 0;
    let latestMediaProgress: MediaGenerationProgress | null = null;
    let generationCompleted = false;
    let uploadCompleted = false;
    let previewStreamFrameCursor = 0;
    const snapshotStreamFrames = (): MediaGeneratorStreamFrame[] => {
      const progress = latestMediaProgress;
      return progress && Array.isArray(progress.streamFrames)
        ? progress.streamFrames
        : [];
    };
    const MAX_PROCESSING_STREAM_FRAME_DELTA = 3;
    const MAX_FINALIZE_STREAM_FRAMES = 1;
    const MAX_PREVIEW_HTTP_URL_LENGTH = 2048;
    const MAX_PREVIEW_DATA_URI_LENGTH = 12_000;
    const sanitizePreviewUrlForChat = (value: string | null | undefined): string | null => {
      const normalized = asNonEmptyString(value);
      if (!normalized) return null;
      if (isHttpUrl(normalized)) {
        return normalized.length <= MAX_PREVIEW_HTTP_URL_LENGTH ? normalized : null;
      }
      if (isDataUri(normalized)) {
        return normalized.length <= MAX_PREVIEW_DATA_URI_LENGTH ? normalized : null;
      }
      return null;
    };
    const resolveChatDeliveryUrl = (
      ...values: Array<string | null | undefined>
    ): string | null => {
      let fallback: string | null = null;
      for (const value of values) {
        const normalized = sanitizePreviewUrlForChat(value);
        if (!normalized) continue;
        fallback ??= normalized;
        if (!this.isStreamPartArtifactReference(normalized)) {
          return normalized;
        }
      }
      return fallback;
    };
    const compactStreamFramesForChat = (
      frames: MediaGeneratorStreamFrame[],
      maxFrames: number,
    ): MediaGeneratorStreamFrame[] => {
      const boundedMax = Math.max(1, Math.floor(maxFrames));
      const compacted: MediaGeneratorStreamFrame[] = [];
      for (const rawFrame of frames.slice(-boundedMax)) {
        const previewUrl = sanitizePreviewUrlForChat(rawFrame.previewUrl);
        if (
          !previewUrl &&
          rawFrame.isFinalStreamFrame !== true &&
          rawFrame.isStreamPart !== true
        ) {
          continue;
        }
        compacted.push({
          sourceFileName: rawFrame.sourceFileName,
          isStreamPart: rawFrame.isStreamPart === true,
          streamPartIndex:
            typeof rawFrame.streamPartIndex === "number" &&
            Number.isFinite(rawFrame.streamPartIndex)
              ? Math.max(0, Math.floor(rawFrame.streamPartIndex))
              : null,
          isFinalStreamFrame: rawFrame.isFinalStreamFrame === true,
          previewUrl,
          outputPath: null,
          metadataId: null,
          source: rawFrame.source,
        });
      }
      return compacted;
    };
    const buildStreamPreviewMetadata = (input: {
      frames: MediaGeneratorStreamFrame[];
      maxFrames: number;
      finalPreviewUrl?: string | null;
    }): {
      streamFrames: MediaGeneratorStreamFrame[];
      streamFrameCount: number;
      latestStreamFrameIndex: number;
      hasFinalStreamFrame: boolean;
      streamRevealProgress: number;
    } | null => {
      const compacted = compactStreamFramesForChat(input.frames, input.maxFrames);
      const normalizedFinalPreviewUrl = sanitizePreviewUrlForChat(input.finalPreviewUrl);
      const hasExplicitFinalPreviewFrame =
        normalizedFinalPreviewUrl !== null &&
        compacted.some(
          (entry) =>
            entry.isFinalStreamFrame &&
            typeof entry.previewUrl === "string" &&
            entry.previewUrl === normalizedFinalPreviewUrl,
        );
      if (normalizedFinalPreviewUrl && !hasExplicitFinalPreviewFrame) {
        compacted.push({
          sourceFileName: null,
          isStreamPart: false,
          streamPartIndex: null,
          isFinalStreamFrame: true,
          previewUrl: normalizedFinalPreviewUrl,
          outputPath: null,
          metadataId: null,
          source: "runtime.final",
        });
      }
      if (compacted.length === 0) return null;
      const hasFinalStreamFrame = compacted.some((entry) => entry.isFinalStreamFrame);
      const streamFrameCount = compacted.length;
      return {
        streamFrames: compacted,
        streamFrameCount,
        latestStreamFrameIndex: streamFrameCount - 1,
        hasFinalStreamFrame,
        streamRevealProgress: hasFinalStreamFrame
          ? 1
          : Math.min(0.92, Number((1 - Math.exp(-streamFrameCount * 0.45)).toFixed(3))),
      };
    };
    type StreamPreviewDeltaMetadata = {
      streamFrameDelta: MediaGeneratorStreamFrame[];
      streamFrameDeltaBaseCount: number;
      streamFrameCount: number;
      latestStreamFrameIndex: number;
      hasFinalStreamFrame: boolean;
      streamRevealProgress: number;
    };
    const buildStreamPreviewDeltaMetadata = (input: {
      frames: MediaGeneratorStreamFrame[];
      deltaBaseCount: number;
      maxDeltaFrames: number;
      finalPreviewUrl?: string | null;
    }): {
      metadata: StreamPreviewDeltaMetadata;
      nextFrameCursor: number;
    } | null => {
      const boundedBaseCount = Math.max(0, Math.floor(input.deltaBaseCount));
      const normalizedFinalPreviewUrl = sanitizePreviewUrlForChat(input.finalPreviewUrl);
      const sourceFrames = input.frames;
      const sourceFrameCount = sourceFrames.length;
      const deltaBaseCount = Math.max(0, Math.min(sourceFrameCount, boundedBaseCount));
      const compactedDeltaFrames = compactStreamFramesForChat(
        sourceFrames.slice(deltaBaseCount),
        input.maxDeltaFrames,
      );
      const hasFinalFrameInSource = sourceFrames.some((entry) => entry.isFinalStreamFrame);
      const hasExplicitFinalPreviewFrameInSource =
        normalizedFinalPreviewUrl !== null &&
        sourceFrames.some(
          (entry) =>
            entry.isFinalStreamFrame &&
            typeof entry.previewUrl === "string" &&
            entry.previewUrl === normalizedFinalPreviewUrl,
        );
      if (
        normalizedFinalPreviewUrl &&
        !compactedDeltaFrames.some(
          (entry) =>
            entry.isFinalStreamFrame &&
            typeof entry.previewUrl === "string" &&
            entry.previewUrl === normalizedFinalPreviewUrl,
        )
      ) {
        compactedDeltaFrames.push({
          sourceFileName: null,
          isStreamPart: false,
          streamPartIndex: null,
          isFinalStreamFrame: true,
          previewUrl: normalizedFinalPreviewUrl,
          outputPath: null,
          metadataId: null,
          source: "runtime.final",
        });
      }
      const streamFrameCount =
        normalizedFinalPreviewUrl && !hasExplicitFinalPreviewFrameInSource
          ? sourceFrameCount + 1
          : sourceFrameCount;
      if (compactedDeltaFrames.length === 0 && streamFrameCount === 0) {
        return null;
      }
      const hasFinalStreamFrame = hasFinalFrameInSource || normalizedFinalPreviewUrl !== null;
      const revealBase = 1 - Math.exp(-streamFrameCount * 0.45);
      return {
        metadata: {
          streamFrameDelta: compactedDeltaFrames,
          streamFrameDeltaBaseCount: deltaBaseCount,
          streamFrameCount,
          latestStreamFrameIndex: Math.max(0, streamFrameCount - 1),
          hasFinalStreamFrame,
          streamRevealProgress: hasFinalStreamFrame
            ? 1
            : Math.min(0.92, Number(revealBase.toFixed(3))),
        },
        nextFrameCursor: sourceFrameCount,
      };
    };
    const buildProcessingActionPreview = (input?: {
      progress?: MediaGenerationProgress;
      streamDeltaMetadata?: StreamPreviewDeltaMetadata | null;
    }) => ({
      type: previewType,
      status: "processing",
      title: processingTitle,
      summary,
      streamSessionId: previewClientMessageId,
      ...(input?.progress?.latestPreviewUrl
        ? {
            previewUrl: sanitizePreviewUrlForChat(input.progress.latestPreviewUrl),
          }
        : {}),
      ...(input?.streamDeltaMetadata ?? {}),
    });
    let previewLookupBackoffUntilMs = 0;
    let previewLastEditError: string | null = null;
    const maybeResolvePreviewMessageId = async (force: boolean): Promise<string | null> => {
      if (previewMessageId) return previewMessageId;
      const callAgentChatBridge = this.ctx.callAgentChatBridge;
      if (!callAgentChatBridge) return null;
      const nowMs = Date.now();
      if (!force && nowMs < previewLookupBackoffUntilMs) {
        return null;
      }
      previewLookupBackoffUntilMs = nowMs + 800;
      try {
        const listed = await callBridgeWithRateLimitRetry({
          call: () =>
            callAgentChatBridge({
              action: "list_messages",
              ...chatRoute,
              limit: 80,
            }),
          maxAttempts: force ? 4 : 2,
          fallbackDelayMs: 220,
        });
        const data = isRecord(listed) ? listed : null;
        const items = data ? toUnknownArray(data.items) : [];
        for (const rawItem of items) {
          if (!isRecord(rawItem)) continue;
          const message = isRecord(rawItem.message) ? rawItem.message : null;
          if (!message) continue;
          const messageId = asNonEmptyString(message.id);
          const clientMessageId = asNonEmptyString(message.clientMessageId);
          if (!messageId || !clientMessageId) continue;
          if (
            clientMessageId === previewClientMessageId ||
            clientMessageId.startsWith(`${previewClientMessageId}_`)
          ) {
            previewMessageId = messageId;
            return previewMessageId;
          }
        }
      } catch {
        return null;
      }
      return null;
    };
    const tryEditPreviewMessage = async (input: {
      body: string;
      attachments?: Array<{
        url: string;
        mimeType: string;
        sizeBytes: number;
        metadata?: Record<string, unknown>;
      }>;
      metadata: Record<string, unknown>;
      kind: "processing" | "success" | "failed";
    }): Promise<boolean> => {
      const callAgentChatBridge = this.ctx.callAgentChatBridge;
      if (!callAgentChatBridge) return false;
      const runEdit = async (): Promise<string | null> => {
        const resolvedPreviewMessageId =
          previewMessageId ??
          (input.kind === "processing"
            ? await maybeResolvePreviewMessageId(false)
            : await maybeResolvePreviewMessageId(true));
        const callEdit = async (payload: Record<string, unknown>) =>
          callBridgeWithRateLimitRetry({
            call: () => callAgentChatBridge(payload),
            maxAttempts: input.kind === "processing" ? 4 : 8,
            fallbackDelayMs: input.kind === "processing" ? 220 : 420,
          });
        try {
          const editedByClientMessageId = await callEdit({
            action: "edit_message",
            clientMessageId: previewClientMessageId,
            ...chatRoute,
            body: input.body,
            ...(input.attachments ? { attachments: input.attachments } : {}),
            metadata: input.metadata,
          });
          const editedByClientMessageIdResolved = extractBridgeMessageId(
            editedByClientMessageId,
          );
          if (editedByClientMessageIdResolved) {
            return editedByClientMessageIdResolved;
          }
          const resolvedAfterClientEdit =
            previewMessageId ??
            (input.kind === "processing"
              ? await maybeResolvePreviewMessageId(false)
              : await maybeResolvePreviewMessageId(true));
          return resolvedAfterClientEdit ?? resolvedPreviewMessageId ?? null;
        } catch (clientEditError: unknown) {
          if (!resolvedPreviewMessageId) {
            throw clientEditError;
          }
          const editedByMessageId = await callEdit({
            action: "edit_message",
            messageId: resolvedPreviewMessageId,
            ...chatRoute,
            body: input.body,
            ...(input.attachments ? { attachments: input.attachments } : {}),
            metadata: input.metadata,
          });
          return extractBridgeMessageId(editedByMessageId) ?? resolvedPreviewMessageId;
        }
      };
      try {
        const editedMessageId = await runEdit();
        previewLastEditError = null;
        previewMessageId = editedMessageId ?? previewMessageId;
        previewMessageId ??= await maybeResolvePreviewMessageId(true);
        return true;
      } catch (firstError: unknown) {
        previewLastEditError =
          firstError instanceof Error ? firstError.message : String(firstError);
        previewMessageId = null;
        await maybeResolvePreviewMessageId(true);
        try {
          const editedMessageId = await runEdit();
          previewLastEditError = null;
          previewMessageId = editedMessageId ?? previewMessageId;
          previewMessageId ??= await maybeResolvePreviewMessageId(true);
          return true;
        } catch (retryError: unknown) {
          previewLastEditError =
            retryError instanceof Error ? retryError.message : String(retryError);
          await this.ctx.memory
            .recordWrite({
              type: "chat_literal_generate_preview_edit_failed",
              at: nowIso(),
              commandId: command.id,
              kind: input.kind,
              message:
                retryError instanceof Error ? retryError.message : String(retryError),
            })
            .catch(() => undefined);
          return false;
        }
      }
    };
    const rebindPreviewMessageId = async (): Promise<boolean> => {
      const callAgentChatBridge = this.ctx.callAgentChatBridge;
      if (!callAgentChatBridge) return false;
      try {
        const rebound = await callBridgeWithRateLimitRetry({
          call: () =>
            callAgentChatBridge({
              action: "send_message",
              clientMessageId: previewClientMessageId,
              ...chatRoute,
              body: processingBody,
              format: "markdown",
              metadata: {
                automated: true,
                sourceContext: "CHAT",
                actionPreview: latestMediaProgress
                  ? buildProcessingActionPreview({
                      progress: latestMediaProgress,
                    })
                  : buildProcessingActionPreview(),
              },
            }),
          maxAttempts: 8,
          fallbackDelayMs: 420,
        });
        previewMessageCreateAttempted = true;
        previewMessageId = extractBridgeMessageId(rebound) ?? previewMessageId;
        previewMessageId ??= await maybeResolvePreviewMessageId(true);
        return Boolean(previewMessageId);
      } catch (error: unknown) {
        previewLastEditError = error instanceof Error ? error.message : String(error);
        await this.ctx.memory
          .recordWrite({
            type: "chat_literal_generate_preview_rebind_failed",
            at: nowIso(),
            commandId: command.id,
            message: previewLastEditError,
          })
          .catch(() => undefined);
        return false;
      }
    };
    const sendOrEditPreviewMessage = async (input: {
      body: string;
      attachments?: Array<{
        url: string;
        mimeType: string;
        sizeBytes: number;
        metadata?: Record<string, unknown>;
      }>;
      metadata: Record<string, unknown>;
      kind: "processing" | "success" | "failed";
    }): Promise<boolean> => {
      const callAgentChatBridge = this.ctx.callAgentChatBridge;
      if (!callAgentChatBridge) return false;
      const sendFreshPreviewMessage = async (attachments?: Array<{
        url: string;
        mimeType: string;
        sizeBytes: number;
        metadata?: Record<string, unknown>;
      }>): Promise<boolean> => {
        if (previewMessageCreateAttempted) return false;
        previewMessageCreateAttempted = true;
        try {
          const created = await callBridgeWithRateLimitRetry({
            call: () =>
              callAgentChatBridge({
                action: "send_message",
                clientMessageId: previewClientMessageId,
                ...chatRoute,
                body: input.body,
                format: "markdown",
                ...(attachments ? { attachments } : {}),
                metadata: input.metadata,
              }),
            maxAttempts: input.kind === "processing" ? 4 : 8,
            fallbackDelayMs: input.kind === "processing" ? 220 : 420,
          });
          previewMessageId ??= extractBridgeMessageId(created);
          if (!previewMessageId) {
            for (let attempt = 0; attempt < 5 && !previewMessageId; attempt += 1) {
              if (attempt > 0) {
                await sleep(90 + attempt * 70);
              }
              previewMessageId ??= await maybeResolvePreviewMessageId(true);
            }
          }
          return true;
        } catch (error: unknown) {
          previewMessageCreateAttempted = false;
          throw error;
        }
      };
      if (
        previewMessageId ||
        previewMessageCreateAttempted ||
        input.kind !== "processing"
      ) {
        const edited = await tryEditPreviewMessage(input);
        if (edited) {
          return true;
        }
        if (input.kind !== "processing") {
          const rebound = await rebindPreviewMessageId();
          if (rebound) {
            const editedAfterRebind = await tryEditPreviewMessage(input);
            if (editedAfterRebind) {
              return true;
            }
          }
          if (!previewMessageCreateAttempted) {
            return sendFreshPreviewMessage(input.attachments);
          }
          return false;
        }
      }
      const sent = await sendFreshPreviewMessage(input.attachments);
      if (!sent) {
        await maybeResolvePreviewMessageId(true);
      }
      return sent;
    };
    const emitStreamProgress = async (progress: MediaGenerationProgress): Promise<void> => {
      latestMediaProgress = progress;
      if (!previewMessageCreateAttempted) return;
      if (!previewMessageId) {
        await maybeResolvePreviewMessageId(false);
      }
      const nowMs = Date.now();
      if (nowMs - previewProgressUpdatedAtMs < 260) return;
      const fingerprint = [
        progress.contextId ?? "",
        progress.contextStatus ?? "",
        progress.latestPreviewUrl ?? "",
        progress.streamFrameCount,
        progress.latestStreamFrameIndex ?? "",
        progress.hasFinalStreamFrame ? "1" : "0",
        progress.streamRevealProgress,
        progress.timedOut ? "1" : "0",
      ].join("|");
      if (fingerprint === previewProgressFingerprint) return;
      previewProgressFingerprint = fingerprint;
      previewProgressUpdatedAtMs = nowMs;
      const streamDelta = buildStreamPreviewDeltaMetadata({
        frames: progress.streamFrames,
        deltaBaseCount: previewStreamFrameCursor,
        maxDeltaFrames: MAX_PROCESSING_STREAM_FRAME_DELTA,
      });
      const edited = await tryEditPreviewMessage({
        kind: "processing",
        body: processingBody,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: buildProcessingActionPreview({
            progress,
            streamDeltaMetadata: streamDelta?.metadata ?? null,
          }),
        },
      });
      if (!edited) return;
      if (streamDelta) {
        previewStreamFrameCursor = Math.max(
          previewStreamFrameCursor,
          streamDelta.nextFrameCursor,
        );
      }
    };
    try {
      await sendOrEditPreviewMessage({
        kind: "processing",
        body: processingBody,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: buildProcessingActionPreview(),
        },
      });
      if (personaSetupRequiredSlug) {
        throw new Error(`persona_reference_setup_required:${personaSetupRequiredSlug}`);
      }
      const media = await this.generateAndUploadMediaFromPrompt(prompt, {
        generatedAssetType: avatarRequest || bannerRequest ? "image" : generatedAssetType,
        mode: avatarRequest
          ? "chat_avatar_update"
          : bannerRequest
            ? "chat_banner_update"
            : "chat_literal_generate",
        referenceInputs,
        commandId: command.id,
        onProgress: emitStreamProgress,
      });
      generationCompleted = true;
      const mimeType = this.resolveGeneratedAttachmentMimeType({
        generatedAssetType,
        mediaUrl: media.mediaUrl,
        ...(media.mediaType ? { mediaType: media.mediaType } : {}),
      });
      const sizeBytes =
        typeof media.mediaSizeBytes === "number" &&
        Number.isFinite(media.mediaSizeBytes) &&
        media.mediaSizeBytes > 0
          ? Math.max(1, Math.floor(media.mediaSizeBytes))
          : 1;
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "generated",
        status: "ok",
        metadata: {
          generatedAssetType,
          mode: avatarRequest
            ? "chat_avatar_update"
            : bannerRequest
              ? "chat_banner_update"
              : "chat_literal_generate",
        },
      });
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "uploaded",
        status: "ok",
        metadata: {
          generatedAssetType,
          mediaUrl: media.mediaUrl,
          mimeType,
          mode: avatarRequest
            ? "chat_avatar_update"
            : bannerRequest
              ? "chat_banner_update"
              : "chat_literal_generate",
        },
      });
      uploadCompleted = true;
      const chatDeliveryUrl = resolveChatDeliveryUrl(
        media.mediaUrl,
        media.mediaOriginalUrl,
        media.mediaOptimizedUrl,
      );
      if (!chatDeliveryUrl) {
        throw new Error("chat_delivery_media_url_invalid");
      }
      if (avatarRequest) {
        const avatarCropSpec =
          profileCropSpec?.target === "avatar"
            ? profileCropSpec
            : normalizeProfileCropSpec(buildProfileCropSpec("avatar"));
        const avatarResult = await this.updateAvatar({
          target: avatarTarget,
          imageUrl: media.mediaUrl,
          ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
          ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
          ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
          ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
          ...(typeof media.mediaSizeBytes === "number"
            ? { sizeBytes: media.mediaSizeBytes }
            : {}),
          ...(provenance ? { provenance } : {}),
          ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
          ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
        });
        const avatarData = isRecord(avatarResult) ? avatarResult : null;
        const avatarUser = isRecord(avatarData?.user) ? avatarData.user : null;
        const avatarHandle = asNonEmptyString(avatarUser?.handle);
        const avatarUserId = asNonEmptyString(avatarUser?.id);
        const avatarProfileHref = avatarTarget === "owner" && avatarHandle
          ? `/u/${avatarHandle.replace(/^@+/u, "")}?edit=avatar&crop=1`
          : null;
        const streamPreviewForSuccess = buildStreamPreviewMetadata({
          frames: snapshotStreamFrames(),
          maxFrames: MAX_FINALIZE_STREAM_FRAMES,
          finalPreviewUrl: chatDeliveryUrl,
        });
        const streamPreviewDeltaForSuccess = buildStreamPreviewDeltaMetadata({
          frames: snapshotStreamFrames(),
          deltaBaseCount: previewStreamFrameCursor,
          maxDeltaFrames: MAX_FINALIZE_STREAM_FRAMES,
          finalPreviewUrl: chatDeliveryUrl,
        });
        const completionText =
          avatarTarget === "owner"
            ? "Done. Here is your new avatar. If framing looks off, tap Crop avatar and keep your face in the center safe zone."
            : "Done. Here is my new avatar. If framing looks off, tap Crop avatar and keep the face in the center safe zone.";
        const chatDeliveryHandled = await sendOrEditPreviewMessage({
          kind: "success",
          body: completionText,
          attachments: [
            {
              url: chatDeliveryUrl,
              mimeType,
              sizeBytes,
              metadata: {
                source: "runtime.avatar",
                generatedAssetType: "persona",
                personaType: "persona",
                cropZones: avatarCropSpec,
              },
            },
          ],
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "persona",
              status: "success",
              title: "Persona avatar updated",
              summary,
              streamSessionId: previewClientMessageId,
              previewUrl: chatDeliveryUrl,
              href: chatDeliveryUrl,
              hrefLabel: "Open avatar image",
              ...(streamPreviewForSuccess ?? {}),
              ...(streamPreviewDeltaForSuccess?.metadata ?? {}),
              cropHint: avatarCropSpec.guidance,
              cropZones: avatarCropSpec,
              ...(avatarProfileHref
                ? {
                    secondaryHref: avatarProfileHref,
                    secondaryHrefLabel: "Crop avatar",
                  }
                : {}),
              avatarTarget,
              ...(avatarHandle ? { handle: avatarHandle } : {}),
              ...(avatarUserId ? { userId: avatarUserId } : {}),
            },
          },
        });
        if (!chatDeliveryHandled) {
          previewLastEditError ??= "preview_delivery_unresolved";
          throw new Error(
            `chat_preview_finalize_failed:chat_avatar_update:${previewLastEditError ?? "unknown"}`,
          );
        }
        await this.ctx.memory.recordWrite({
            type: "chat_avatar_updated",
            at: nowIso(),
            commandId: command.id,
            avatarTarget,
            mediaUrl: media.mediaUrl,
            prompt: summary,
            personaType: "persona",
            cropZones: avatarCropSpec,
            userId: avatarUserId,
            handle: avatarHandle,
            targetConversationId: chatTarget.conversationId ?? null,
            targetChannelId: chatTarget.channelId ?? null,
        });
        return this.successOutcome(command, {
          mode: "chat_avatar_update",
          avatarTarget,
          mediaUrl: media.mediaUrl,
          prompt: summary,
          updateResult: avatarResult,
          chatDeliveryHandled,
        });
      }
      if (bannerRequest) {
        const bannerCropSpec =
          profileCropSpec?.target === "banner"
            ? profileCropSpec
            : normalizeProfileCropSpec(buildProfileCropSpec("banner"));
        const bannerResult = await this.updateBanner({
          target: bannerTarget,
          bannerUrl: media.mediaUrl,
          ...(media.mediaOriginalUrl ? { originalUrl: media.mediaOriginalUrl } : {}),
          ...(media.mediaOptimizedUrl ? { optimizedUrl: media.mediaOptimizedUrl } : {}),
          ...(media.mediaContentHash ? { contentHash: media.mediaContentHash } : {}),
          ...(media.mediaIpfsCid ? { ipfsCid: media.mediaIpfsCid } : {}),
          ...(typeof media.mediaSizeBytes === "number"
            ? { sizeBytes: media.mediaSizeBytes }
            : {}),
          ...(provenance ? { provenance } : {}),
          ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
          ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
        });
        const bannerData = isRecord(bannerResult) ? bannerResult : null;
        const bannerUser = isRecord(bannerData?.user) ? bannerData.user : null;
        const bannerHandle = asNonEmptyString(bannerUser?.handle);
        const bannerUserId = asNonEmptyString(bannerUser?.id);
        const bannerProfileHref = bannerTarget === "owner" && bannerHandle
          ? `/u/${bannerHandle.replace(/^@+/u, "")}?edit=banner&crop=1`
          : null;
        const streamPreviewForSuccess = buildStreamPreviewMetadata({
          frames: snapshotStreamFrames(),
          maxFrames: MAX_FINALIZE_STREAM_FRAMES,
          finalPreviewUrl: chatDeliveryUrl,
        });
        const streamPreviewDeltaForSuccess = buildStreamPreviewDeltaMetadata({
          frames: snapshotStreamFrames(),
          deltaBaseCount: previewStreamFrameCursor,
          maxDeltaFrames: MAX_FINALIZE_STREAM_FRAMES,
          finalPreviewUrl: chatDeliveryUrl,
        });
        const completionText =
          bannerTarget === "owner"
            ? "Done. Here is your new banner. If framing looks off, tap Crop banner and keep key details in the center safe zone."
            : "Done. Here is my new banner. If framing looks off, keep key details in the center safe zone.";
        const chatDeliveryHandled = await sendOrEditPreviewMessage({
          kind: "success",
          body: completionText,
          attachments: [
            {
              url: chatDeliveryUrl,
              mimeType,
              sizeBytes,
              metadata: {
                source: "runtime.banner",
                generatedAssetType: "banner",
                cropZones: bannerCropSpec,
              },
            },
          ],
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: "banner",
              status: "success",
              title: "Profile banner updated",
              summary,
              streamSessionId: previewClientMessageId,
              previewUrl: chatDeliveryUrl,
              href: chatDeliveryUrl,
              hrefLabel: "Open banner image",
              ...(streamPreviewForSuccess ?? {}),
              ...(streamPreviewDeltaForSuccess?.metadata ?? {}),
              cropHint: bannerCropSpec.guidance,
              cropZones: bannerCropSpec,
              ...(bannerProfileHref
                ? {
                    secondaryHref: bannerProfileHref,
                    secondaryHrefLabel: "Crop banner",
                  }
                : {}),
              bannerTarget,
              ...(bannerHandle ? { handle: bannerHandle } : {}),
              ...(bannerUserId ? { userId: bannerUserId } : {}),
            },
          },
        });
        if (!chatDeliveryHandled) {
          previewLastEditError ??= "preview_delivery_unresolved";
          throw new Error(
            `chat_preview_finalize_failed:chat_banner_update:${previewLastEditError ?? "unknown"}`,
          );
        }
        await this.ctx.memory.recordWrite({
          type: "chat_banner_updated",
          at: nowIso(),
          commandId: command.id,
          bannerTarget,
          mediaUrl: media.mediaUrl,
          prompt: summary,
          cropZones: bannerCropSpec,
          userId: bannerUserId,
          handle: bannerHandle,
          targetConversationId: chatTarget.conversationId ?? null,
          targetChannelId: chatTarget.channelId ?? null,
        });
        return this.successOutcome(command, {
          mode: "chat_banner_update",
          bannerTarget,
          mediaUrl: media.mediaUrl,
          prompt: summary,
          updateResult: bannerResult,
          chatDeliveryHandled,
        });
      }

      let generatedCustomAssetSaveResult: GeneratedCustomAssetSaveResult | null = null;
      let generatedCustomAssetSaveError: string | null = null;
      if (generatedCustomAssetSaveIntent) {
        try {
          generatedCustomAssetSaveResult = await this.saveGeneratedCustomAsset({
            command,
            payload,
            intent: generatedCustomAssetSaveIntent,
            sourcePrompt: basePrompt,
            mediaUrl: media.mediaUrl,
            mimeType,
            chatTarget,
          });
        } catch (error: unknown) {
          generatedCustomAssetSaveError =
            error instanceof Error ? error.message : String(error);
        }
      }
      const customAssetScopeLabel =
        generatedCustomAssetSaveResult?.scope === "group"
          ? "this group"
          : generatedCustomAssetSaveResult?.scope === "server"
            ? "this server"
            : "your library";
      const successBody =
        generatedCustomAssetSaveResult
          ? `Generated ${generatedLabel} for "${summary}". Saved as ${generatedCustomAssetSaveResult.kind} \`${generatedCustomAssetSaveResult.name}\` in ${customAssetScopeLabel}.`
          : generatedCustomAssetSaveError && generatedCustomAssetSaveIntent
            ? `Generated ${generatedLabel} for "${summary}". Could not save to ${generatedCustomAssetSaveIntent.scope} ${generatedCustomAssetSaveIntent.kind}s (${truncateText(generatedCustomAssetSaveError, 120)}).`
            : `Generated ${generatedLabel} for "${summary}".`;
      const finalChatDeliveryUrl = resolveChatDeliveryUrl(
        generatedCustomAssetSaveResult?.url,
        chatDeliveryUrl,
        media.mediaUrl,
        media.mediaOriginalUrl,
        media.mediaOptimizedUrl,
      );
      if (!finalChatDeliveryUrl) {
        throw new Error("chat_delivery_media_url_invalid");
      }
      const finalMimeType = generatedCustomAssetSaveResult?.mimeType ?? mimeType;
      const streamPreviewForSuccess = buildStreamPreviewMetadata({
        frames: snapshotStreamFrames(),
        maxFrames: MAX_FINALIZE_STREAM_FRAMES,
        finalPreviewUrl: finalChatDeliveryUrl,
      });
      const streamPreviewDeltaForSuccess = buildStreamPreviewDeltaMetadata({
        frames: snapshotStreamFrames(),
        deltaBaseCount: previewStreamFrameCursor,
        maxDeltaFrames: MAX_FINALIZE_STREAM_FRAMES,
        finalPreviewUrl: finalChatDeliveryUrl,
      });
      const chatDeliveryHandled = await sendOrEditPreviewMessage({
        kind: "success",
        body: successBody,
        attachments: [
          {
            url: finalChatDeliveryUrl,
            mimeType: finalMimeType,
            sizeBytes,
            metadata: {
              source: "runtime.generate",
              generatedAssetType,
            },
          },
        ],
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: generatedAssetType,
            status: "success",
            title: `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} generated`,
            summary,
            streamSessionId: previewClientMessageId,
            previewUrl: finalChatDeliveryUrl,
            href: finalChatDeliveryUrl,
            hrefLabel: `Open ${generatedLabel}`,
            ...(generatedCustomAssetSaveResult
              ? {
                  customAsset: {
                    kind: generatedCustomAssetSaveResult.kind,
                    scope: generatedCustomAssetSaveResult.scope,
                    name: generatedCustomAssetSaveResult.name,
                    id: generatedCustomAssetSaveResult.id,
                  },
                }
              : generatedCustomAssetSaveError && generatedCustomAssetSaveIntent
                ? {
                    customAssetSaveError: truncateText(
                      generatedCustomAssetSaveError,
                      180,
                    ),
                  }
                : {}),
            ...(streamPreviewForSuccess ?? {}),
            ...(streamPreviewDeltaForSuccess?.metadata ?? {}),
          },
        },
      });
      if (!chatDeliveryHandled) {
        previewLastEditError ??= "preview_delivery_unresolved";
        throw new Error(
          `chat_preview_finalize_failed:chat_literal_generate:${previewLastEditError ?? "unknown"}`,
        );
      }
      await this.ctx.memory.recordWrite({
        type: "chat_literal_generate_sent",
        at: nowIso(),
        commandId: command.id,
        generatedAssetType,
        mediaUrl: finalChatDeliveryUrl,
        prompt: summary,
        customAssetKind: generatedCustomAssetSaveResult?.kind ?? null,
        customAssetScope: generatedCustomAssetSaveResult?.scope ?? null,
        customAssetName: generatedCustomAssetSaveResult?.name ?? null,
        customAssetId: generatedCustomAssetSaveResult?.id ?? null,
        customAssetSaveError: generatedCustomAssetSaveError,
        targetConversationId: chatTarget.conversationId ?? null,
        targetChannelId: chatTarget.channelId ?? null,
      });
      return this.successOutcome(command, {
        generatedAssetType,
        mediaUrl: finalChatDeliveryUrl,
        prompt: summary,
        ...(generatedCustomAssetSaveResult
          ? { customAsset: generatedCustomAssetSaveResult }
          : {}),
        ...(generatedCustomAssetSaveError && generatedCustomAssetSaveIntent
          ? { customAssetSaveError: generatedCustomAssetSaveError }
          : {}),
        mode: "chat_literal_generate",
        chatDeliveryHandled,
      });
    } catch (error: unknown) {
      if (error instanceof RequeueCommandError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const isPromptCurationFailure = /prompt_curation_/iu.test(message);
      const isChatDeliveryFailure = /chat_preview_finalize_failed:/iu.test(message);
      const deferred = this.classifyMediaGenerationDeferral({
        error,
        hasPrompt: true,
      });
      const isImageGenerationSetupFailure = deferred.imageGeneratorSetupRequired;
      const imageGenerationSetupHint = isImageGenerationSetupFailure
        ? IMAGE_GENERATION_SETUP_HINT
        : "";
      const isPersonaReferenceSetupFailure = deferred.reasonCode === "persona_reference_setup_required";
      const personaReferenceSetupSlug = deferred.personaSlug;
      const failureStreamFrames = snapshotStreamFrames();
      const streamPreviewForFailure = failureStreamFrames.length > 0
        ? buildStreamPreviewDeltaMetadata({
            frames: failureStreamFrames,
            deltaBaseCount: previewStreamFrameCursor,
            maxDeltaFrames: MAX_FINALIZE_STREAM_FRAMES,
          })
        : null;
      const failureStage: CommandLifecycleCheckpointStage = isChatDeliveryFailure
        ? "chat_delivery"
        : uploadCompleted
          ? "uploaded"
          : generationCompleted
            ? "generated"
            : "generated";
      if (deferred.shouldRequeue && deferred.reason) {
        const deferredBody = avatarRequest
          ? "Avatar prerequisites are still in progress. I queued this request and will retry automatically."
          : bannerRequest
            ? "Banner prerequisites are still in progress. I queued this request and will retry automatically."
            : isPersonaReferenceSetupFailure
              ? `Persona setup for ${personaReferenceSetupSlug ? `\`${personaReferenceSetupSlug}\`` : "that persona"} is incomplete (need selfie, midshot, fullbody). I queued this request and will retry automatically.`
              : isImageGenerationSetupFailure
                ? `Image generation setup is still unavailable. I queued this request and will retry automatically once setup is ready.${imageGenerationSetupHint}`
                : "I did not receive a final media asset yet. I queued this request and will retry automatically.";
        const previewDeferredDelivered = await sendOrEditPreviewMessage({
          kind: "processing",
          body: deferredBody,
          metadata: {
            automated: true,
            sourceContext: "CHAT",
            actionPreview: {
              type: avatarRequest ? "persona" : bannerRequest ? "banner" : generatedAssetType,
              status: "processing",
              streamSessionId: previewClientMessageId,
              title:
                avatarRequest
                  ? "Avatar update queued"
                  : bannerRequest
                    ? "Banner update queued"
                    : `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} queued`,
              summary,
              deferred: true,
              deferredReason: deferred.reason,
              personaSetupRequired: isPersonaReferenceSetupFailure,
              imageGenerationSetupRequired: isImageGenerationSetupFailure,
              ...(streamPreviewForFailure?.metadata ?? {}),
            },
          },
        }).catch(() => false);
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: failureStage,
          status: "failed",
          message,
          metadata: {
            generatedAssetType,
            avatarRequest,
            bannerRequest,
            requeued: true,
            requeueReason: deferred.reason,
            requeueReasonCode: deferred.reasonCode,
            requeuePersonaSlug: deferred.personaSlug,
            previewDeferredDelivered,
          },
        });
        await this.ctx.memory.recordWrite({
          type: "chat_literal_generate_deferred",
          at: nowIso(),
          commandId: command.id,
          generatedAssetType,
          avatarRequest,
          bannerRequest,
          reason: deferred.reason,
          reasonCode: deferred.reasonCode,
          personaSlug: deferred.personaSlug,
          error: message,
        });
        throw new RequeueCommandError(deferred.reason);
      }
      const previewFailureDelivered = await sendOrEditPreviewMessage({
        kind: "failed",
        body: avatarRequest
          ? "I could not update that avatar right now. Please retry in a moment."
          : bannerRequest
            ? "I could not update that banner right now. Please retry in a moment."
            : isPersonaReferenceSetupFailure
              ? `I couldn't prepare persona references for ${personaReferenceSetupSlug ? `\`${personaReferenceSetupSlug}\`` : "that persona"} yet. I need three photorealistic baseline frames (selfie, midshot, fullbody) before generating with persona continuity.${imageGenerationSetupHint}`
            : isChatDeliveryFailure
              ? `I generated that ${generatedLabel}, but failed to finalize delivery in chat. Please retry.`
            : isPromptCurationFailure
              ? `I could not prepare a generation prompt for that ${generatedLabel} right now. Please retry in a moment.`
              : `I could not generate that ${generatedLabel} right now. Please retry in a moment.${imageGenerationSetupHint}`,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: avatarRequest ? "persona" : bannerRequest ? "banner" : generatedAssetType,
            status: "failed",
            streamSessionId: previewClientMessageId,
            title:
              avatarRequest
                ? "Avatar update failed"
                : bannerRequest
                  ? "Banner update failed"
                  : isChatDeliveryFailure
                    ? "Delivery failed"
                  : isPromptCurationFailure
                    ? "Prompt curation failed"
                    : `${generatedLabel.charAt(0).toUpperCase()}${generatedLabel.slice(1)} generation failed`,
            error: truncateText(message, 240),
            imageGenerationSetupRequired: isImageGenerationSetupFailure,
            ...(streamPreviewForFailure?.metadata ?? {}),
          },
        },
      }).catch(() => false);
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: failureStage,
        status:
          failureStage === "chat_delivery" && previewFailureDelivered
            ? "ok"
            : "failed",
        message:
          failureStage === "chat_delivery" && previewFailureDelivered
            ? null
            : message,
        metadata: {
          generatedAssetType,
          avatarRequest,
          bannerRequest,
          ...(failureStage === "chat_delivery"
            ? { recoveredWithFailureMessage: previewFailureDelivered }
            : {}),
        },
      });
      await this.ctx.memory.recordWrite({
        type: "chat_literal_generate_failed",
        at: nowIso(),
        commandId: command.id,
        generatedAssetType,
        avatarRequest,
        bannerRequest,
        error: message,
      });
      const failed = this.failedOutcome(
        command,
        avatarRequest
          ? `Avatar update failed: ${message}`
          : bannerRequest
            ? `Banner update failed: ${message}`
          : isPersonaReferenceSetupFailure
            ? `Persona reference setup failed: ${message}`
          : isChatDeliveryFailure
            ? `Literal generate delivery failed: ${message}`
          : `Literal generate failed: ${message}`,
        avatarRequest
          ? "avatar_update_failed"
          : bannerRequest
            ? "banner_update_failed"
            : isChatDeliveryFailure
              ? "chat_delivery_failed"
            : "literal_generate_failed",
      );
      return {
        ...failed,
        data: {
          mode: "chat_literal_generate",
          generatedAssetType,
          chatDeliveryHandled: previewFailureDelivered,
          chatDeliveryCheckpointRecorded: failureStage === "chat_delivery",
          chatPreviewDeliveryError: previewLastEditError,
        },
      };
    }
  }

  private async executeCommandFromMappedDraft(command: Command): Promise<CommandOutcome> {
    const kind = command.kind.trim().toLowerCase();
    if (kind === "write.createpost") return this.executeWriteCreatePost(command);
    if (kind === "write.createstory") return this.executeWriteCreateStory(command);
    if (kind === "write.updateavatar") return this.executeWriteUpdateAvatar(command);
    if (kind === "write.updatebanner") return this.executeWriteUpdateBanner(command);
    if (kind === "write.commentpost" || kind === "write.comment") {
      return this.executeWriteComment(command);
    }
    if (kind === "write.votepost" || kind === "write.like") {
      return this.executeWriteVote(command);
    }
    if (kind === "write.repostpost" || kind === "write.repost") {
      return this.executeWriteRepost(command);
    }
    return this.failedOutcome(command, `Unsupported generated draft command kind: ${command.kind}`);
  }

  private buildGenerateInput(
    payload: Record<string, unknown>,
    command: Command,
  ): Record<string, unknown> {
    const isChatOrigin = this.isChatOriginCommand(command, payload);
    const context = isRecord(payload.context) ? payload.context : null;
    const goal =
      asNonEmptyString(payload.goal)?.toLowerCase() ??
      asNonEmptyString(payload.kind)?.toLowerCase() ??
      (isChatOrigin ? "media" : "story");
    const mappedKind = this.mapGoalToGenerateKind(goal);
    const requestedKinds = this.resolveRequestedGenerateKinds(payload, mappedKind);
    const scopedKinds = this.resolveDirectiveScopeGenerateKinds(payload);
    const mergedKinds = [...requestedKinds];
    for (const scopedKind of scopedKinds) {
      if (!mergedKinds.includes(scopedKind)) {
        mergedKinds.push(scopedKind);
      }
    }
    const personaMediaLock = this.isPersonaMediaLockEnabled(payload);
    const resolvedKindsBase = isChatOrigin
      ? mergedKinds.filter((kind) => kind !== "story")
      : mergedKinds;
    const resolvedKinds = personaMediaLock ? ["media"] : resolvedKindsBase;
    if (resolvedKinds.length === 0) {
      resolvedKinds.push(isChatOrigin ? "media" : mappedKind);
    }
    const primaryKind = resolvedKinds[0] ?? (isChatOrigin ? "media" : mappedKind);
    const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
    const scopedTarget = scope && isRecord(scope.target) ? scope.target : null;
    const postId =
      asPositiveInt(payload.postId) ??
      asPositiveInt(payload.targetPostId) ??
      (scope
        ? asPositiveInt(scope.targetPostId) ??
          (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
        : null);
    const commentId =
      asPositiveInt(payload.commentId) ??
      asPositiveInt(payload.targetCommentId) ??
      (scope
        ? asPositiveInt(scope.targetCommentId) ??
          (scopedTarget ? asPositiveInt(scopedTarget.commentId) : null)
        : null);
    const count = asPositiveInt(payload.count);
    const topic =
      asNonEmptyString(payload.topic) ??
      asNonEmptyString(context?.topic) ??
      asNonEmptyString(payload.requestText) ??
      asNonEmptyString(payload.prompt) ??
      null;
    const mood =
      asNonEmptyString(payload.mood) ??
      asNonEmptyString(context?.mood);
    const collectStringArray = (
      value: unknown,
      max: number,
    ): string[] => {
      if (!Array.isArray(value)) return [];
      const out: string[] = [];
      for (const entry of value) {
        const normalized = asNonEmptyString(entry);
        if (!normalized) continue;
        out.push(normalized);
        if (out.length >= max) break;
      }
      return out;
    };
    const collectHandleArray = (
      value: unknown,
      max: number,
    ): string[] => {
      if (!Array.isArray(value)) return [];
      const out: string[] = [];
      for (const entry of value) {
        if (typeof entry === "string") {
          const normalized = entry.trim().replace(/^@+/u, "").toLowerCase();
          if (!normalized.length) continue;
          out.push(normalized);
          if (out.length >= max) break;
          continue;
        }
        if (!isRecord(entry)) continue;
        const handle = asNonEmptyString(entry.handle);
        if (!handle) continue;
        out.push(handle.replace(/^@+/u, "").toLowerCase());
        if (out.length >= max) break;
      }
      return out;
    };
    const tags = Array.from(
      new Set(
        [
          ...collectStringArray(payload.tags, 24),
          ...collectStringArray(payload.mediaLabels, 24),
          ...collectStringArray(payload.labels, 24),
          ...collectStringArray(context?.tags, 24),
          ...collectStringArray(context?.mediaLabels, 24),
          ...collectStringArray(context?.labels, 24),
        ].map((entry) => entry.trim()),
      ),
    )
      .filter((entry) => entry.length > 0)
      .slice(0, 24);
    const taggedHandles = Array.from(
      new Set(
        [
          ...collectHandleArray(payload.taggedHandles, 24),
          ...collectHandleArray(payload.taggedUsers, 24),
          ...collectHandleArray(context?.taggedHandles, 24),
          ...collectHandleArray(context?.taggedUsers, 24),
        ],
      ),
    ).slice(0, 24);
    const mediaReferenceUrls = this.collectMediaReferenceInputs(payload).slice(0, 12);
    const mediaMode =
      asNonEmptyString(payload.mediaMode)?.toLowerCase() ??
      asNonEmptyString(context?.mediaMode)?.toLowerCase() ??
      null;
    const mediaPersona =
      asNonEmptyString(payload.mediaPersona) ??
      asNonEmptyString(payload.persona) ??
      asNonEmptyString(payload.personaName) ??
      asNonEmptyString(context?.mediaPersona) ??
      asNonEmptyString(context?.persona) ??
      asNonEmptyString(context?.personaName) ??
      null;
    const mediaPersonaStyleHint =
      asNonEmptyString(payload.mediaPersonaStyleHint) ??
      asNonEmptyString(payload.personaStyleHint) ??
      asNonEmptyString(context?.mediaPersonaStyleHint) ??
      asNonEmptyString(context?.personaStyleHint) ??
      null;
    const explicitVariationSeed = asNonEmptyString(payload.variationSeed);
    const directiveActionNonceSeed =
      asNonEmptyString(payload.sourceDirectiveActionNonce) ??
      command.actionNonce ??
      null;
    const variationSeed =
      explicitVariationSeed ??
      (directiveActionNonceSeed
        ? `${directiveActionNonceSeed}:${Date.now().toString(36)}:${crypto
            .randomUUID()
            .replaceAll("-", "")
            .slice(0, 8)}`
        : `${Date.now().toString(36)}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`);
    const provenance = normalizeAgentProvenanceValue(payload.provenance);
    const sourceDirectiveId =
      this.resolveCommandSourceDirectiveId({ command, payload });
    const sourceDirectiveActionNonce =
      this.resolveCommandSourceDirectiveActionNonce({ command, payload });
    return {
      kind: primaryKind,
      ...(resolvedKinds.length > 0 ? { kinds: resolvedKinds } : {}),
      ...(count ? { count } : {}),
      ...(topic ? { topic } : {}),
      ...(mood ? { mood } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(mediaMode ? { mediaMode } : {}),
      ...(mediaPersona ? { mediaPersona } : {}),
      ...(mediaPersonaStyleHint ? { mediaPersonaStyleHint } : {}),
      ...(personaMediaLock ? { mediaPersonaLock: true } : {}),
      ...(taggedHandles.length > 0 ? { taggedHandles } : {}),
      ...(mediaReferenceUrls.length > 0 ? { mediaReferenceUrls } : {}),
      ...(variationSeed ? { variationSeed } : {}),
      ...(postId ? { postId } : {}),
      ...(commentId ? { commentId } : {}),
      ...(provenance ? { provenance } : {}),
      ...(sourceDirectiveId ? { sourceDirectiveId } : {}),
      ...(sourceDirectiveActionNonce ? { sourceDirectiveActionNonce } : {}),
      ...(command.grantId ? { grantId: command.grantId } : {}),
    };
  }

  private collectBridgeRecordItems(value: unknown): Record<string, unknown>[] {
    const collected: Record<string, unknown>[] = [];
    const seen = new Set<Record<string, unknown>>();
    const push = (entry: unknown): void => {
      if (!isRecord(entry) || seen.has(entry)) return;
      seen.add(entry);
      collected.push(entry);
    };
    if (Array.isArray(value)) {
      for (const entry of value) push(entry);
      return collected;
    }
    if (!isRecord(value)) return collected;
    for (const key of ["items", "results", "posts", "comments", "data"] as const) {
      const nested = value[key];
      if (Array.isArray(nested)) {
        for (const entry of nested) push(entry);
      } else {
        push(nested);
      }
    }
    push(value.post);
    push(value.comment);
    if (collected.length === 0) push(value);
    return collected;
  }

  private asNonNegativeInt(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed.length) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.floor(parsed);
  }

  private computePostSnapshotHash(input: {
    postId: number;
    commentId: number | null;
    postRecord: Record<string, unknown>;
  }): string | null {
    const providedHash =
      asNonEmptyString(input.postRecord.postSnapshotHash) ??
      asNonEmptyString(input.postRecord.snapshotHash);
    if (providedHash) return providedHash;
    const metrics = isRecord(input.postRecord.metrics) ? input.postRecord.metrics : null;
    const mediaItems = Array.isArray(input.postRecord.mediaItems)
      ? input.postRecord.mediaItems.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    const mediaFingerprints = mediaItems
      .slice(0, 4)
      .map((item) => {
        const mediaType = asNonEmptyString(item.mediaType)?.toLowerCase() ?? "image";
        const id = asPositiveInt(item.id);
        const fingerprint =
          asNonEmptyString(item.contentHash) ??
          asNonEmptyString(item.hash) ??
          asNonEmptyString(item.optimizedUrl) ??
          asNonEmptyString(item.originalUrl) ??
          asNonEmptyString(item.url) ??
          null;
        if (!fingerprint) return null;
        return `${mediaType}:${id ?? 0}:${truncateText(fingerprint, 80)}`;
      })
      .filter((entry): entry is string => Boolean(entry));
    const textSource =
      asNonEmptyString(input.postRecord.textBody) ??
      asNonEmptyString(input.postRecord.body) ??
      asNonEmptyString(input.postRecord.caption) ??
      null;
    const normalizedText = textSource ? truncateText(normalizeCommentText(textSource), 280) : null;
    const stablePayload = {
      postId: input.postId,
      commentId: input.commentId ?? null,
      updatedAt:
        asNonEmptyString(input.postRecord.updatedAt) ??
        asNonEmptyString(input.postRecord.updated_at) ??
        asNonEmptyString(input.postRecord.lastInteractionAt) ??
        asNonEmptyString(input.postRecord.last_interaction_at) ??
        null,
      createdAt:
        asNonEmptyString(input.postRecord.createdAt) ??
        asNonEmptyString(input.postRecord.created_at) ??
        null,
      text: normalizedText,
      mediaCount: mediaItems.length,
      media: mediaFingerprints,
      commentCount:
        this.asNonNegativeInt(input.postRecord.commentCount) ??
        this.asNonNegativeInt(input.postRecord.commentsCount) ??
        this.asNonNegativeInt(input.postRecord.replyCount) ??
        this.asNonNegativeInt(metrics?.commentCount) ??
        null,
      likeCount:
        this.asNonNegativeInt(input.postRecord.likeCount) ??
        this.asNonNegativeInt(input.postRecord.likesCount) ??
        this.asNonNegativeInt(metrics?.likeCount) ??
        null,
      repostCount:
        this.asNonNegativeInt(input.postRecord.repostCount) ??
        this.asNonNegativeInt(input.postRecord.repostsCount) ??
        this.asNonNegativeInt(metrics?.repostCount) ??
        null,
      viewCount:
        this.asNonNegativeInt(input.postRecord.viewCount) ??
        this.asNonNegativeInt(input.postRecord.viewsCount) ??
        this.asNonNegativeInt(metrics?.viewCount) ??
        null,
    };
    const encoded = JSON.stringify(stablePayload);
    if (!encoded.length) return null;
    return crypto.createHash("sha1").update(encoded).digest("hex");
  }

  private async resolvePostSnapshotHashForPostId(input: {
    postId: number;
    commentId: number | null;
  }): Promise<string | null> {
    if (!this.ctx.callAgentChatBridge) return null;
    try {
      const lookup = await this.callAgentBridgeLookupCached({
        action: "find_post",
        postId: input.postId,
      });
      const postRecord = this.extractPostRecordForCommentCuration(lookup.value, input.postId);
      if (!postRecord) return null;
      return this.computePostSnapshotHash({
        postId: input.postId,
        commentId: input.commentId,
        postRecord,
      });
    } catch {
      return null;
    }
  }

  private extractEngagementTargetCandidateFromRecord(
    record: Record<string, unknown>,
    source: string,
  ): EngagementTargetCandidate | null {
    const parseFrom = (entry: Record<string, unknown>): EngagementTargetCandidate | null => {
      const looksLikeCommentRecord =
        asPositiveInt(entry.commentId) !== null ||
        asPositiveInt(entry.parentId) !== null ||
        (asPositiveInt(entry.postId) !== null &&
          (asNonEmptyString(entry.body) !== null ||
            asNonEmptyString(entry.textBody) !== null));
      const postId =
        asPositiveInt(entry.postId) ??
        asPositiveInt(entry.targetPostId) ??
        (looksLikeCommentRecord ? null : asPositiveInt(entry.id));
      if (!postId) return null;
      const commentId =
        asPositiveInt(entry.commentId) ??
        asPositiveInt(entry.parentId) ??
        asPositiveInt(entry.targetCommentId) ??
        null;
      const author = isRecord(entry.author) ? entry.author : null;
      const authorId =
        asNonEmptyString(entry.authorId) ??
        asNonEmptyString(author?.mainUserId) ??
        asNonEmptyString(author?.id) ??
        null;
      const postSnapshotHash = this.computePostSnapshotHash({
        postId,
        commentId,
        postRecord: entry,
      });
      return {
        postId,
        commentId,
        authorId,
        source,
        postSnapshotHash,
      };
    };
    const direct = parseFrom(record);
    if (direct) return direct;
    for (const key of ["target", "post", "comment", "data"] as const) {
      const nested = isRecord(record[key]) ? record[key] : null;
      if (!nested) continue;
      const parsed = parseFrom(nested);
      if (parsed) return parsed;
    }
    return null;
  }

  private isOwnEngagementCandidate(
    candidate: EngagementTargetCandidate,
    agentMainUserId: string | null,
  ): boolean {
    if (agentMainUserId && candidate.authorId === agentMainUserId) {
      return true;
    }
    return candidate.source === "own_latest" || candidate.source.startsWith("own_latest+");
  }

  private shouldIncludeOwnLatestCommentLookup(input: {
    rawQuery: string;
    explicitPostId: number | null;
    explicitCommentId: number | null;
  }): boolean {
    if (input.explicitPostId || input.explicitCommentId) return true;
    const query = input.rawQuery.trim();
    if (!query.length) return false;
    return SELF_COMMENT_OWN_TARGET_QUERY_PATTERN.test(query);
  }

  private shouldAllowRareTopLevelSelfComment(input: {
    commandId: string;
    postId: number;
    rawQuery: string;
  }): { allow: boolean; reason: string; gateRoll: number } {
    const normalizedQuery = input.rawQuery.trim().toLowerCase();
    if (!normalizedQuery.length) {
      return {
        allow: false,
        reason: "empty_query",
        gateRoll: 100,
      };
    }
    if (!SELF_COMMENT_CLARIFICATION_INTENT_PATTERN.test(normalizedQuery)) {
      return {
        allow: false,
        reason: "no_clarification_intent",
        gateRoll: 100,
      };
    }
    const gateRoll = this.pickDeterministicIndex(
      `self_top_level_comment:${input.commandId}:${input.postId}:${normalizedQuery}`,
      100,
    );
    if (gateRoll < SELF_TOP_LEVEL_COMMENT_RARE_PERCENT) {
      return {
        allow: true,
        reason: "clarification_intent_rare_allow",
        gateRoll,
      };
    }
    return {
      allow: false,
      reason: "clarification_intent_gate_blocked",
      gateRoll,
    };
  }

  private async resolveEngagementTargetForDirective(input: {
    payload: Record<string, unknown>;
    action: "comment" | "like" | "repost";
    commandId: string;
  }): Promise<EngagementTargetCandidate | null> {
    const scopedDirective = isRecord(input.payload.directiveScope)
      ? input.payload.directiveScope
      : null;
    const scopedTarget = scopedDirective && isRecord(scopedDirective.target)
      ? scopedDirective.target
      : null;
    const explicitPostId =
      asPositiveInt(input.payload.postId) ??
      asPositiveInt(input.payload.targetPostId) ??
      (scopedDirective
        ? asPositiveInt(scopedDirective.targetPostId) ??
          (scopedTarget ? asPositiveInt(scopedTarget.postId) : null)
        : null);
    const explicitCommentId =
      asPositiveInt(input.payload.parentId) ??
      asPositiveInt(input.payload.commentId) ??
      asPositiveInt(input.payload.targetCommentId) ??
      (scopedDirective
        ? asPositiveInt(scopedDirective.targetCommentId) ??
          (scopedTarget ? asPositiveInt(scopedTarget.commentId) : null)
        : null);
    if (explicitPostId) {
      const explicitResolvedCommentId =
        input.action === "comment" ? (explicitCommentId ?? null) : null;
      const postSnapshotHash = await this.resolvePostSnapshotHashForPostId({
        postId: explicitPostId,
        commentId: explicitResolvedCommentId,
      });
      return {
        postId: explicitPostId,
        commentId: explicitResolvedCommentId,
        authorId: null,
        source: "directive_payload",
        postSnapshotHash,
      };
    }

    const hints = this.extractEngagementLookupHints(input.payload);
    const hintedPostId = hints.postId;
    const hintedCommentId = hints.commentId;
    if (hintedPostId) {
      const hintedResolvedCommentId = input.action === "comment" ? hintedCommentId : null;
      const postSnapshotHash = await this.resolvePostSnapshotHashForPostId({
        postId: hintedPostId,
        commentId: hintedResolvedCommentId,
      });
      return {
        postId: hintedPostId,
        commentId: hintedResolvedCommentId,
        authorId: null,
        source: "payload_hint",
        postSnapshotHash,
      };
    }

    const hasBridge = Boolean(this.ctx.callAgentChatBridge);
    let bridgeQuerySuccessCount = 0;
    let bridgeQueryFailureCount = 0;

    const cacheKey = this.buildEngagementTargetCacheKey({
      action: input.action,
      payload: input.payload,
      hints,
    });
    const recentCommentUsage =
      input.action === "comment" ? this.listRecentCommentTargetUsage() : [];
    const nowMs = Date.now();
    this.pruneEngagementTargetCache(nowMs);
    const cachedResolution = this.engagementTargetCache.get(cacheKey);
    if (cachedResolution && cachedResolution.expiresAtMs > nowMs) {
      if (input.action === "comment") {
        const reuseDecision = this.decideCommentTargetReuse({
          commandId: input.commandId,
          postId: cachedResolution.candidate.postId,
          commentId: cachedResolution.candidate.commentId ?? null,
          postSnapshotHash: cachedResolution.candidate.postSnapshotHash ?? null,
          source: cachedResolution.candidate.source,
          recentUsage: recentCommentUsage,
        });
        if (!reuseDecision.allow) {
          this.engagementTargetCache.delete(cacheKey);
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_cache_skipped_recent_comment_target",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              postId: cachedResolution.candidate.postId,
              commentId: cachedResolution.candidate.commentId ?? null,
              source: cachedResolution.candidate.source,
              postSnapshotHash: cachedResolution.candidate.postSnapshotHash ?? null,
              reason: reuseDecision.reason,
              recentCommandId: reuseDecision.recentMatch?.commandId ?? null,
              recentPostId: reuseDecision.recentMatch?.postId ?? null,
              recentCommentId: reuseDecision.recentMatch?.commentId ?? null,
              recentPostSnapshotHash: reuseDecision.recentMatch?.postSnapshotHash ?? null,
            })
            .catch(() => undefined);
        } else {
          return {
            ...cachedResolution.candidate,
            commentId: cachedResolution.candidate.commentId ?? null,
          };
        }
      } else {
        return {
          ...cachedResolution.candidate,
          commentId: null,
        };
      }
    }

    type LookupPlan = {
      source: string;
      request: Record<string, unknown>;
      parser?: (value: unknown) => EngagementTargetCandidate[];
    };
    const trace: EngagementResolutionTrace[] = [];
    const candidates: EngagementTargetCandidate[] = [];
    const candidateByTargetKey = new Map<string, EngagementTargetCandidate>();
    const pushCandidate = (candidate: EngagementTargetCandidate | null): boolean => {
      if (!candidate) return false;
      if (!candidate.postId || candidate.postId <= 0) return false;
      const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
      const existing = candidateByTargetKey.get(key);
      if (existing) {
        const nextAuthorId = existing.authorId ?? candidate.authorId ?? null;
        if (nextAuthorId !== existing.authorId) {
          existing.authorId = nextAuthorId;
        }
        const nextSnapshotHash =
          candidate.postSnapshotHash ??
          existing.postSnapshotHash ??
          null;
        if (nextSnapshotHash !== existing.postSnapshotHash) {
          existing.postSnapshotHash = nextSnapshotHash;
        }
        if (
          existing.source.startsWith("own_latest") &&
          !candidate.source.startsWith("own_latest")
        ) {
          existing.source = candidate.source;
        }
        return false;
      }
      candidateByTargetKey.set(key, candidate);
      candidates.push(candidate);
      return true;
    };
    const addCandidatesFrom = (value: unknown, source: string): number => {
      let added = 0;
      for (const item of this.collectBridgeRecordItems(value)) {
        const parsed = this.extractEngagementTargetCandidateFromRecord(item, source);
        if (!parsed) continue;
        if (pushCandidate(parsed)) added += 1;
      }
      return added;
    };
    const runLookupStep = async (
      step: string,
      plans: LookupPlan[],
    ): Promise<void> => {
      if (!hasBridge || plans.length === 0) return;
      let queryCount = 0;
      let cacheHits = 0;
      let addedCandidates = 0;
      for (const plan of plans) {
        try {
          const result = await this.callAgentBridgeLookupCached(plan.request);
          bridgeQuerySuccessCount += 1;
          queryCount += 1;
          if (result.cacheHit) cacheHits += 1;
          if (typeof plan.parser === "function") {
            for (const candidate of plan.parser(result.value)) {
              if (pushCandidate(candidate)) addedCandidates += 1;
            }
          } else {
            addedCandidates += addCandidatesFrom(result.value, plan.source);
          }
        } catch (error: unknown) {
          bridgeQueryFailureCount += 1;
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_lookup_failed",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              step,
              source: plan.source,
              lookupAction: asNonEmptyString(plan.request.action) ?? "unknown",
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
      }
      trace.push({
        step,
        queryCount,
        cacheHits,
        addedCandidates,
        totalCandidates: candidates.length,
      });
    };

    let agentMainUserId: string | null = null;
    let agentHandle: string | null = null;
    let agentPreferenceTags: string[] = [];
    if (hasBridge) {
      const profileResult = await this.callAgentBridgeLookupCached({
        action: "agent_profile",
      }).catch((error: unknown) => {
        bridgeQueryFailureCount += 1;
        void this.ctx.memory
          .recordWrite({
            type: "engagement_target_lookup_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            step: "agent_profile",
            source: "agent_profile",
            lookupAction: "agent_profile",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
        return null;
      });
      if (profileResult) {
        bridgeQuerySuccessCount += 1;
        const profileRecord = isRecord(profileResult.value) ? profileResult.value : null;
        if (profileRecord && isRecord(profileRecord.agent)) {
          const agentRecord = profileRecord.agent;
          agentMainUserId = asNonEmptyString(agentRecord.mainUserId) ?? null;
          agentHandle =
            asNonEmptyString(agentRecord.handle)?.replace(/^@+/u, "").toLowerCase() ??
            null;
          const agentPreferredTags = Array.isArray(agentRecord.preferredTags)
            ? (agentRecord.preferredTags as unknown[])
            : [];
          const profilePreferredTags = Array.isArray(profileRecord.preferredTags)
            ? (profileRecord.preferredTags as unknown[])
            : [];
          const configPreferredTags =
            isRecord(profileRecord.config) && Array.isArray(profileRecord.config.preferredTags)
              ? (profileRecord.config.preferredTags as unknown[])
              : [];
          agentPreferenceTags = Array.from(
            new Set(
              [
                ...agentPreferredTags,
                ...profilePreferredTags,
                ...configPreferredTags,
              ]
                .map((value) => normalizeInterestTagToken(value))
                .filter((value): value is string => Boolean(value)),
            ),
          ).slice(0, 8);
        }
        trace.push({
          step: "agent_profile",
          queryCount: 1,
          cacheHits: profileResult.cacheHit ? 1 : 0,
          addedCandidates: 0,
          totalCandidates: 0,
        });
      }
    }

    const parseNotificationTargets = (
      value: unknown,
      source: string,
    ): EngagementTargetCandidate[] => {
      const resolved: EngagementTargetCandidate[] = [];
      const seen = new Set<string>();
      const push = (candidate: EngagementTargetCandidate | null): void => {
        if (!candidate) return;
        if (!candidate.postId || candidate.postId <= 0) return;
        const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
        if (seen.has(key)) return;
        seen.add(key);
        resolved.push(candidate);
      };
      for (const row of this.collectBridgeRecordItems(value)) {
        push(this.extractEngagementTargetCandidateFromRecord(row, source));

        const entityType =
          asNonEmptyString(row.entityType)?.toLowerCase() ??
          asNonEmptyString(row.targetType)?.toLowerCase() ??
          null;
        const entityId =
          asPositiveInt(row.entityId) ??
          asPositiveInt(row.targetId) ??
          null;
        const postIdFromFields =
          asPositiveInt(row.postId) ??
          asPositiveInt(row.targetPostId) ??
          (isRecord(row.post) ? asPositiveInt(row.post.id) : null) ??
          (isRecord(row.target)
            ? asPositiveInt(row.target.postId) ??
              (isRecord(row.target.post) ? asPositiveInt(row.target.post.id) : null)
            : null);
        const commentIdFromFields =
          asPositiveInt(row.commentId) ??
          asPositiveInt(row.targetCommentId) ??
          asPositiveInt(row.parentId) ??
          (isRecord(row.comment) ? asPositiveInt(row.comment.id) : null) ??
          (isRecord(row.target)
            ? asPositiveInt(row.target.commentId) ??
              (isRecord(row.target.comment) ? asPositiveInt(row.target.comment.id) : null)
            : null);
        const postId =
          postIdFromFields ??
          (entityType === "post" ? entityId : null) ??
          null;
        const commentId =
          commentIdFromFields ??
          (entityType === "comment" ? entityId : null) ??
          null;
        if (!postId) continue;
        const postSnapshotHash = this.computePostSnapshotHash({
          postId,
          commentId: input.action === "comment" ? commentId : null,
          postRecord: row,
        });
        push({
          postId,
          commentId: input.action === "comment" ? commentId : null,
          authorId: null,
          source,
          postSnapshotHash,
        });
      }
      return resolved;
    };
    if (hasBridge) {
      await runLookupStep("notifications_priority", [
        {
          source: "notifications_unread",
          request: {
            action: "browse_notifications",
            unreadOnly: true,
            limit: 24,
          },
          parser: (value: unknown): EngagementTargetCandidate[] =>
            parseNotificationTargets(value, "notifications_unread"),
        },
        {
          source: "notifications_recent",
          request: {
            action: "browse_notifications",
            unreadOnly: false,
            limit: 24,
          },
          parser: (value: unknown): EngagementTargetCandidate[] =>
            parseNotificationTargets(value, "notifications_recent"),
        },
      ]);
    }

    if (typeof this.ctx.memory.buildContext === "function") {
      try {
        const request: ContextRequest = {
          mode: "engagement",
          audience: "runtime_write",
          maxRecentEvents: 80,
          maxArchiveEvents: 40,
          includeKeywordRetrieval: true,
          retrievalIntent: "engagement",
          retrievalMaxItems: 12,
          retrievalQuery: [
            input.action,
            hints.rawQuery,
            "target resolution",
          ]
            .filter((entry) => entry.trim().length > 0)
            .join(" · "),
        };
        const bundle = await this.ctx.memory.buildContext(request);
        const before = candidates.length;
        const envelopes = [
          ...(Array.isArray(bundle.target?.events) ? bundle.target.events : []),
          ...(Array.isArray(bundle.recent) ? bundle.recent : []),
          ...(Array.isArray(bundle.archive) ? bundle.archive : []),
        ];
        for (const envelope of envelopes) {
          if (!isRecord(envelope) || !isRecord(envelope.payload)) continue;
          pushCandidate(
            this.extractEngagementTargetCandidateFromRecord(
              envelope.payload,
              "memory_event",
            ),
          );
        }
        if (isRecord(bundle.retrieval) && Array.isArray(bundle.retrieval.lines)) {
          for (const line of bundle.retrieval.lines) {
            if (typeof line !== "string") continue;
            const parsedIds = this.parseTargetIdsFromTextLine(line);
            if (!parsedIds.postId) continue;
            pushCandidate({
              postId: parsedIds.postId,
              commentId: input.action === "comment" ? (parsedIds.commentId ?? null) : null,
              authorId: null,
              source: "memory_retrieval",
              postSnapshotHash: null,
            });
          }
        }
        if (
          isRecord(bundle.retrieval) &&
          Array.isArray(bundle.retrieval.lookupPlans)
        ) {
          for (const plan of bundle.retrieval.lookupPlans) {
            if (!isRecord(plan)) continue;
            const args = isRecord(plan.args) ? plan.args : null;
            if (!args) continue;
            const postId = asPositiveInt(args.postId);
            const commentId = asPositiveInt(args.commentId) ?? null;
            if (!postId) continue;
            pushCandidate({
              postId,
              commentId:
                input.action === "comment" ? (commentId ?? null) : null,
              authorId: null,
              source: "memory_lookup_plan",
              postSnapshotHash: null,
            });
          }
        }
        trace.push({
          step: "memory_context",
          queryCount: 1,
          cacheHits: 0,
          addedCandidates: candidates.length - before,
          totalCandidates: candidates.length,
        });
      } catch (error: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_target_lookup_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            step: "memory_context",
            source: "memory",
            lookupAction: "buildContext",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
      }
    }

    const hintPlans: LookupPlan[] = [];
    if (hintedPostId) {
      hintPlans.push({
        source: "hint_post_lookup",
        request: { action: "find_post", postId: hintedPostId },
      });
    }
    for (const handle of hints.handles.slice(0, 4)) {
      hintPlans.push({
        source: "hint_handle_latest",
        request: {
          action: "find_post",
          authorHandle: `@${handle}`,
          latest: true,
        },
      });
    }
    await runLookupStep("payload_hints", hintPlans);

    const mentionParser = (value: unknown): EngagementTargetCandidate[] => {
      const resolved: EngagementTargetCandidate[] = [];
      for (const row of this.collectBridgeRecordItems(value)) {
        const targetType = asNonEmptyString(row.targetType)?.toLowerCase() ?? "";
        if (targetType !== "post") continue;
        const targetId = asPositiveInt(row.targetId);
        if (!targetId) continue;
        const targetCommentId = asPositiveInt(row.targetCommentId) ?? null;
        const postSnapshotHash = this.computePostSnapshotHash({
          postId: targetId,
          commentId: input.action === "comment" ? targetCommentId : null,
          postRecord: row,
        });
        resolved.push({
          postId: targetId,
          commentId: input.action === "comment" ? targetCommentId : null,
          authorId: null,
          source: "unanswered_mention",
          postSnapshotHash,
        });
      }
      return resolved;
    };
    const discoveryTags = Array.from(
      new Set([...hints.interestTags, ...agentPreferenceTags]),
    ).slice(0, 8);
    const allowOwnLatestCommentLookup = this.shouldIncludeOwnLatestCommentLookup({
      rawQuery: hints.rawQuery,
      explicitPostId,
      explicitCommentId,
    });
    const ownCommentPlans: LookupPlan[] = [];
    if (input.action === "comment" && agentHandle && allowOwnLatestCommentLookup) {
      ownCommentPlans.push({
        source: "own_latest",
        request: {
          action: "find_post",
          authorHandle: `@${agentHandle}`,
          latest: true,
        },
      });
    }
    ownCommentPlans.push({
      source: "unanswered_mention",
      request: {
        action: "browse_unanswered_mentions",
        limit: 24,
        sinceHours: 24 * 14,
      },
      parser: mentionParser,
    });
    await runLookupStep("high_signal", ownCommentPlans);

    const interestLookupPlans: LookupPlan[] = [];
    if (discoveryTags.length > 0) {
      interestLookupPlans.push(
        {
          source: "interest_trending",
          request: {
            action: "browse_trending",
            limit: 24,
            tags: discoveryTags.slice(0, 8),
          },
        },
        {
          source: "interest_explore",
          request: {
            action: "browse_posts",
            limit: 24,
            tags: discoveryTags.slice(0, 8),
          },
        },
      );
      const interestSearchQuery = truncateText(
        [hints.rawQuery, ...discoveryTags.slice(0, 4)]
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .join(" "),
        220,
      );
      if (interestSearchQuery.length > 2) {
        interestLookupPlans.push({
          source: "interest_search",
          request: {
            action: "search_global",
            query: interestSearchQuery,
            limit: 24,
            includePeople: false,
          },
        });
      }
    }
    await runLookupStep("interest_discovery", interestLookupPlans);

    let topEngagerHandles: string[] = [];
    if (hasBridge) {
      const topEngagerResult = await this.callAgentBridgeLookupCached({
        action: "browse_top_engagers",
        limit: 10,
        windowHours: 24 * 14,
      }).catch((error: unknown) => {
        bridgeQueryFailureCount += 1;
        void this.ctx.memory
          .recordWrite({
            type: "engagement_target_lookup_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            step: "browse_top_engagers",
            source: "browse_top_engagers",
            lookupAction: "browse_top_engagers",
            error: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);
        return null;
      });
      if (topEngagerResult) {
        bridgeQuerySuccessCount += 1;
        topEngagerHandles = this.collectBridgeRecordItems(topEngagerResult.value)
          .map((row) => {
            const user = isRecord(row.user) ? row.user : null;
            return asNonEmptyString(user?.handle) ?? asNonEmptyString(row.handle) ?? null;
          })
          .filter((entry): entry is string => Boolean(entry))
          .map((entry) => entry.replace(/^@+/u, "").toLowerCase())
          .slice(0, 4);
        trace.push({
          step: "browse_top_engagers",
          queryCount: 1,
          cacheHits: topEngagerResult.cacheHit ? 1 : 0,
          addedCandidates: 0,
          totalCandidates: candidates.length,
        });
      }
    }
    const topEngagerPlans: LookupPlan[] = topEngagerHandles.map((handle) => ({
      source: "top_engager_latest",
      request: {
        action: "find_post",
        authorHandle: `@${handle}`,
        latest: true,
      },
    }));
    topEngagerPlans.push({
      source: "recent_actions",
      request: {
        action: "browse_recent_actions",
        limit: 18,
      },
    });
    await runLookupStep("engagement_network", topEngagerPlans);

    const hasConfidentCandidate = (): boolean =>
      candidates.some((candidate) => {
        if (input.action === "comment") {
          return (
            candidate.source === "notifications_unread" ||
            candidate.source === "notifications_recent" ||
            candidate.source === "interest_trending" ||
            candidate.source === "interest_explore" ||
            candidate.source === "interest_search" ||
            candidate.source === "unanswered_mention"
          );
        }
        return (
          candidate.source === "notifications_unread" ||
          candidate.source === "notifications_recent" ||
          candidate.source === "interest_trending" ||
          candidate.source === "interest_explore" ||
          candidate.source === "interest_search" ||
          candidate.source === "unanswered_mention" ||
          candidate.source === "top_engager_latest" ||
          candidate.source === "recent_actions"
        );
      });

    if (!hasConfidentCandidate()) {
      await runLookupStep("broad_feed", [
        {
          source: "home_feed",
          request: { action: "browse_home_feed", limit: 24 },
        },
        {
          source: "trending",
          request: { action: "browse_trending", limit: 24 },
        },
        {
          source: "explore",
          request: { action: "browse_posts", limit: 24 },
        },
      ]);
    }

    if (!hasConfidentCandidate() && hints.rawQuery.trim().length > 2) {
      await runLookupStep("search_global", [
        {
          source: "search_global",
          request: {
            action: "search_global",
            query: truncateText(hints.rawQuery, 220),
            limit: 24,
          },
        },
      ]);
    }

    if (candidates.length === 0) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_target_resolution_failed",
          at: nowIso(),
          commandId: input.commandId,
          action: input.action,
          reason:
            bridgeQuerySuccessCount > 0
              ? "no_candidates_discovery_exhausted"
              : bridgeQueryFailureCount > 0
                ? "lookup_transient_failure"
                : hasBridge
                  ? "no_candidates_unknown"
                  : "bridge_unavailable",
          query: hints.rawQuery,
          bridgeQuerySuccessCount,
          bridgeQueryFailureCount,
          trace,
        })
        .catch(() => undefined);
      if (bridgeQuerySuccessCount > 0) {
        throw new Error("engagement_target_unavailable:no_targets_discovered");
      }
      return null;
    }

    const byTargetKey = new Map<string, EngagementTargetCandidate>();
    for (const candidate of candidates) {
      const key = `${candidate.postId}:${candidate.commentId ?? 0}`;
      byTargetKey.set(key, candidate);
    }
    const hydrationPool = [...byTargetKey.values()].slice(0, 10);
    await runLookupStep(
      "candidate_hydration",
      hydrationPool.map((candidate) => ({
        source: "hydrate_find_post",
        request: {
          action: "find_post",
          postId: candidate.postId,
        },
        parser: (value: unknown): EngagementTargetCandidate[] => {
          const postRecord = this.extractPostRecordForCommentCuration(value, candidate.postId);
          if (!postRecord) return [];
          const author = isRecord(postRecord.author) ? postRecord.author : null;
          const authorId =
            asNonEmptyString(author?.mainUserId) ??
            asNonEmptyString(author?.id) ??
            asNonEmptyString(postRecord.authorId) ??
            candidate.authorId;
          const postSnapshotHash = this.computePostSnapshotHash({
            postId: candidate.postId,
            commentId: candidate.commentId,
            postRecord,
          });
          return [
            {
              ...candidate,
              authorId,
              source: candidate.source,
              postSnapshotHash: postSnapshotHash ?? candidate.postSnapshotHash ?? null,
            },
          ];
        },
      })),
    );

    const preferredSourceOrderComment = new Map<string, number>([
      ["notifications_unread", 0],
      ["notifications_recent", 1],
      ["payload_hint", 2],
      ["memory_lookup_plan", 2],
      ["memory_retrieval", 2],
      ["unanswered_mention", 3],
      ["interest_trending", 4],
      ["interest_explore", 5],
      ["interest_search", 6],
      ["top_engager_latest", 7],
      ["recent_actions", 8],
      ["home_feed", 9],
      ["trending", 10],
      ["search_global", 11],
      ["explore", 12],
      ["memory_event", 13],
      ["own_latest", 14],
      ["directive_payload", 15],
    ]);
    const preferredSourceOrderEngagement = new Map<string, number>([
      ["notifications_unread", 0],
      ["notifications_recent", 1],
      ["payload_hint", 2],
      ["memory_lookup_plan", 2],
      ["unanswered_mention", 2],
      ["interest_trending", 3],
      ["interest_explore", 4],
      ["interest_search", 5],
      ["top_engager_latest", 6],
      ["recent_actions", 7],
      ["home_feed", 8],
      ["trending", 9],
      ["search_global", 10],
      ["explore", 11],
      ["memory_retrieval", 12],
      ["memory_event", 13],
      ["own_latest", 14],
      ["directive_payload", 15],
    ]);

    let candidatePool = [...candidates];
    if (input.action !== "comment") {
      const nonOwnCandidates = candidatePool.filter(
        (candidate) => !this.isOwnEngagementCandidate(candidate, agentMainUserId),
      );
      if (nonOwnCandidates.length === 0) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_target_resolution_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            reason: "self_candidates_only",
            query: hints.rawQuery,
            bridgeQuerySuccessCount,
            bridgeQueryFailureCount,
            trace,
          })
          .catch(() => undefined);
        throw new Error("engagement_target_unavailable:no_targets_discovered:self_candidates_only");
      }
      candidatePool = nonOwnCandidates;
    }
    if (input.action === "comment") {
      const allowedCandidates: EngagementTargetCandidate[] = [];
      const filteredRecent: Array<{
        postId: number;
        commentId: number | null;
        source: string;
        reason: string;
        postSnapshotHash: string | null;
        recentPostSnapshotHash: string | null;
      }> = [];
      for (const candidate of candidatePool) {
        const reuseDecision = this.decideCommentTargetReuse({
          commandId: input.commandId,
          postId: candidate.postId,
          commentId: candidate.commentId ?? null,
          postSnapshotHash: candidate.postSnapshotHash ?? null,
          source: candidate.source,
          recentUsage: recentCommentUsage,
        });
        if (reuseDecision.allow) {
          allowedCandidates.push(candidate);
          continue;
        }
        filteredRecent.push({
          postId: candidate.postId,
          commentId: candidate.commentId ?? null,
          source: candidate.source,
          reason: reuseDecision.reason,
          postSnapshotHash: candidate.postSnapshotHash ?? null,
          recentPostSnapshotHash: reuseDecision.recentMatch?.postSnapshotHash ?? null,
        });
      }
      if (allowedCandidates.length === 0) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_target_resolution_failed",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            reason: "recent_comment_target_reuse_blocked",
            query: hints.rawQuery,
            bridgeQuerySuccessCount,
            bridgeQueryFailureCount,
            filteredRecentTargets: filteredRecent.slice(0, 8),
            trace,
          })
          .catch(() => undefined);
        throw new Error(
          "engagement_target_unavailable:no_targets_discovered:recent_comment_target_reuse_blocked",
        );
      }
      if (filteredRecent.length > 0) {
        await this.ctx.memory
          .recordWrite({
            type: "engagement_target_filtered_recent_comment_target",
            at: nowIso(),
            commandId: input.commandId,
            action: input.action,
            filteredCount: filteredRecent.length,
            keptCount: allowedCandidates.length,
            filtered: filteredRecent.slice(0, 8),
            query: hints.rawQuery,
          })
          .catch(() => undefined);
      }
      candidatePool = allowedCandidates;
    }

    const rankTable =
      input.action === "comment"
        ? preferredSourceOrderComment
        : preferredSourceOrderEngagement;
    const hasNonOwnCandidate =
      input.action === "comment"
        ? candidatePool.some(
            (candidate) =>
              !this.isOwnEngagementCandidate(candidate, agentMainUserId),
          )
        : false;
    const scoreCandidate = (candidate: EngagementTargetCandidate): number => {
      const sourceRank = rankTable.get(candidate.source) ?? 999;
      const isOwn = this.isOwnEngagementCandidate(candidate, agentMainUserId);
      const ownBias =
        input.action === "comment"
          ? isOwn
            ? candidate.commentId
              ? 8
              : hasNonOwnCandidate
                ? -420
                : -260
            : 36
          : isOwn
            ? -140
            : 40;
      const commentBias =
        input.action === "comment" && candidate.commentId ? 26 : 0;
      return 10_000 - sourceRank * 120 + ownBias + commentBias + (candidate.postId % 17);
    };
    candidatePool.sort((a, b) => {
      const delta = scoreCandidate(b) - scoreCandidate(a);
      if (delta !== 0) return delta;
      if (a.postId !== b.postId) return b.postId - a.postId;
      const aComment = a.commentId ?? 0;
      const bComment = b.commentId ?? 0;
      return bComment - aComment;
    });
    let selected = candidatePool[0] ?? null;
    if (!selected) return null;

    if (input.action === "comment" && !selected.commentId) {
      const selectedPostId = selected.postId;
      try {
        const commentLookup = await this.callAgentBridgeLookupCached({
          action: "browse_comments",
          postId: selectedPostId,
          limit: 12,
        });
        const commentRecords = this.collectBridgeRecordItems(commentLookup.value)
          .map((entry) => {
            const postId = asPositiveInt(entry.postId);
            const commentId = asPositiveInt(entry.commentId) ?? asPositiveInt(entry.id);
            if (!postId || postId !== selectedPostId || !commentId) return null;
            const author = isRecord(entry.author) ? entry.author : null;
            const authorId =
              asNonEmptyString(author?.mainUserId) ??
              asNonEmptyString(author?.id) ??
              asNonEmptyString(entry.authorId) ??
              null;
            const createdAtRaw =
              asNonEmptyString(entry.createdAt) ??
              asNonEmptyString(entry.created_at);
            const createdAtMs = createdAtRaw ? Date.parse(createdAtRaw) : NaN;
            return {
              commentId,
              authorId,
              createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : -1,
            };
          })
          .filter(
            (
              value,
            ): value is { commentId: number; authorId: string | null; createdAtMs: number } =>
              Boolean(value),
          )
          .filter((value) => !agentMainUserId || value.authorId !== agentMainUserId)
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        if (commentRecords.length > 0) {
          selected = {
            ...selected,
            commentId: commentRecords[0]?.commentId ?? null,
            source: `${selected.source}+comment_thread`,
          };
        }
      } catch {
        // best-effort parent comment enrichment only
      }
    }

    if (input.action === "comment") {
      const commentAuthorById = new Map<number, string | null>();
      const isAllowedOwnReplyCandidate = async (
        candidate: EngagementTargetCandidate,
      ): Promise<boolean> => {
        if (!agentMainUserId) return true;
        if (!this.isOwnEngagementCandidate(candidate, agentMainUserId)) return true;
        if (!candidate.commentId) return true;
        const cached = commentAuthorById.get(candidate.commentId);
        if (cached !== undefined) {
          return cached !== agentMainUserId;
        }
        const resolvedAuthorId = await this.resolveCommentAuthorIdForTarget({
          postId: candidate.postId,
          commentId: candidate.commentId,
        });
        commentAuthorById.set(candidate.commentId, resolvedAuthorId);
        return resolvedAuthorId !== agentMainUserId;
      };
      if (
        agentMainUserId &&
        this.isOwnEngagementCandidate(selected, agentMainUserId) &&
        typeof selected.commentId === "number" &&
        selected.commentId > 0
      ) {
        const selectedAllowed = await isAllowedOwnReplyCandidate(selected);
        if (!selectedAllowed) {
          let fallback: EngagementTargetCandidate | null = null;
          for (const candidate of candidatePool) {
            if (
              candidate.postId === selected.postId &&
              candidate.commentId === selected.commentId
            ) {
              continue;
            }
            if (!(await isAllowedOwnReplyCandidate(candidate))) continue;
            fallback = candidate;
            break;
          }
          if (fallback) {
            await this.ctx.memory
              .recordWrite({
                type: "engagement_target_filtered_self_own_comment_reply",
                at: nowIso(),
                commandId: input.commandId,
                action: input.action,
                postId: selected.postId,
                commentId: selected.commentId,
                source: selected.source,
                reason: "fallback_to_non_self_parent",
                fallbackPostId: fallback.postId,
                fallbackCommentId: fallback.commentId,
                fallbackSource: fallback.source,
                query: hints.rawQuery,
              })
              .catch(() => undefined);
            selected = fallback;
          } else {
            await this.ctx.memory
              .recordWrite({
                type: "engagement_target_filtered_self_own_comment_reply",
                at: nowIso(),
                commandId: input.commandId,
                action: input.action,
                postId: selected.postId,
                commentId: selected.commentId,
                source: selected.source,
                reason: "no_fallback",
                query: hints.rawQuery,
              })
              .catch(() => undefined);
            throw new Error(
              "engagement_target_unavailable:no_targets_discovered:self_own_comment_reply_filtered",
            );
          }
        }
      }
      const selectedIsOwn = this.isOwnEngagementCandidate(selected, agentMainUserId);
      if (selectedIsOwn && !selected.commentId) {
        const selectedPostId = selected.postId;
        const selectedCommentId = selected.commentId;
        const rareAllowance = this.shouldAllowRareTopLevelSelfComment({
          commandId: input.commandId,
          postId: selectedPostId,
          rawQuery: hints.rawQuery,
        });
        const fallback = candidatePool.find((candidate) => {
          if (candidate.postId === selectedPostId && candidate.commentId === selectedCommentId) {
            return false;
          }
          const candidateIsOwn = this.isOwnEngagementCandidate(
            candidate,
            agentMainUserId,
          );
          if (candidateIsOwn && !candidate.commentId) return false;
          return true;
        });
        if (fallback) {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_filtered_self_root_comment",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              postId: selected.postId,
              source: selected.source,
              reason: "fallback_to_non_self_or_thread",
              gateRoll: rareAllowance.gateRoll,
              fallbackPostId: fallback.postId,
              fallbackCommentId: fallback.commentId,
              fallbackSource: fallback.source,
              query: hints.rawQuery,
            })
            .catch(() => undefined);
          selected = fallback;
        } else if (!rareAllowance.allow) {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_filtered_self_root_comment",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              postId: selected.postId,
              source: selected.source,
              reason: rareAllowance.reason,
              gateRoll: rareAllowance.gateRoll,
              query: hints.rawQuery,
            })
            .catch(() => undefined);
          throw new Error(
            "engagement_target_unavailable:no_targets_discovered:self_root_comment_filtered",
          );
        } else if (rareAllowance.allow) {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_allowed_self_root_comment",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              postId: selected.postId,
              source: selected.source,
              reason: rareAllowance.reason,
              gateRoll: rareAllowance.gateRoll,
              query: hints.rawQuery,
            })
            .catch(() => undefined);
        }
      }
    }

    if (input.action === "comment") {
      const selectedTarget = selected;
      if (!selectedTarget) return null;
      const selectedReuseDecision = this.decideCommentTargetReuse({
        commandId: input.commandId,
        postId: selectedTarget.postId,
        commentId: selectedTarget.commentId ?? null,
        postSnapshotHash: selectedTarget.postSnapshotHash ?? null,
        source: selectedTarget.source,
        recentUsage: recentCommentUsage,
      });
      if (!selectedReuseDecision.allow) {
        const fallback = candidatePool.find((candidate) => {
          if (candidate.postId === selectedTarget.postId) return false;
          if (
            agentMainUserId &&
            this.isOwnEngagementCandidate(candidate, agentMainUserId) &&
            !candidate.commentId
          ) {
            return false;
          }
          const reuseDecision = this.decideCommentTargetReuse({
            commandId: input.commandId,
            postId: candidate.postId,
            commentId: candidate.commentId ?? null,
            postSnapshotHash: candidate.postSnapshotHash ?? null,
            source: candidate.source,
            recentUsage: recentCommentUsage,
          });
          return reuseDecision.allow;
        });
        if (fallback) {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_filtered_recent_comment_target",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              filteredCount: 1,
              keptCount: 1,
              filtered: [
                {
                  postId: selectedTarget.postId,
                  commentId: selectedTarget.commentId ?? null,
                  source: selectedTarget.source,
                  reason: selectedReuseDecision.reason,
                  postSnapshotHash: selectedTarget.postSnapshotHash ?? null,
                  recentPostSnapshotHash:
                    selectedReuseDecision.recentMatch?.postSnapshotHash ?? null,
                },
              ],
              fallbackPostId: fallback.postId,
              fallbackCommentId: fallback.commentId ?? null,
              fallbackSource: fallback.source,
              query: hints.rawQuery,
            })
            .catch(() => undefined);
          selected = fallback;
        } else {
          await this.ctx.memory
            .recordWrite({
              type: "engagement_target_resolution_failed",
              at: nowIso(),
              commandId: input.commandId,
              action: input.action,
              reason: "recent_comment_target_reuse_blocked_after_thread_resolution",
              query: hints.rawQuery,
              bridgeQuerySuccessCount,
              bridgeQueryFailureCount,
              selectedPostId: selectedTarget.postId,
              selectedCommentId: selectedTarget.commentId ?? null,
              selectedSource: selectedTarget.source,
              selectedPostSnapshotHash: selectedTarget.postSnapshotHash ?? null,
              selectedReason: selectedReuseDecision.reason,
              recentPostSnapshotHash:
                selectedReuseDecision.recentMatch?.postSnapshotHash ?? null,
              trace,
            })
            .catch(() => undefined);
          throw new Error(
            "engagement_target_unavailable:no_targets_discovered:recent_comment_target_reuse_blocked",
          );
        }
      }
    }

    const resolved = {
      ...selected,
      commentId: input.action === "comment" ? (selected.commentId ?? null) : null,
    };
    this.engagementTargetCache.set(cacheKey, {
      expiresAtMs: Date.now() + ENGAGEMENT_TARGET_CACHE_TTL_MS,
      candidate: resolved,
    });
    this.pruneEngagementTargetCache(Date.now());
    await this.ctx.memory
      .recordWrite({
        type: "engagement_target_resolved",
        at: nowIso(),
        commandId: input.commandId,
        action: input.action,
        postId: resolved.postId,
        commentId: resolved.commentId,
        source: resolved.source,
        postSnapshotHash: resolved.postSnapshotHash ?? null,
        query: hints.rawQuery,
        candidatesConsidered: candidatePool.length,
        trace,
      })
      .catch(() => undefined);
    return resolved;
  }

  private mapAllowedWriteKindToGenerateKind(commandKind: string): string | null {
    const normalized = commandKind.trim().toLowerCase();
    if (normalized === "write.commentpost") return "comment";
    if (normalized === "write.votepost") return "like";
    if (normalized === "write.repostpost") return "repost";
    if (normalized === "write.createstory") return "story";
    if (normalized === "write.createpost") return "thread";
    return null;
  }

  private resolveDirectiveScopeGenerateKinds(payload: Record<string, unknown>): string[] {
    const scope = isRecord(payload.directiveScope) ? payload.directiveScope : null;
    if (!scope || !Array.isArray(scope.allowedCommandKinds)) return [];
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const value of scope.allowedCommandKinds) {
      if (typeof value !== "string") continue;
      const mapped = this.mapAllowedWriteKindToGenerateKind(value);
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      resolved.push(mapped);
    }
    return resolved;
  }

  private async buildGenerateInputWithRuntimeContext(
    payload: Record<string, unknown>,
    command: Command,
  ): Promise<Record<string, unknown>> {
    const base = this.buildGenerateInput(payload, command);
    const postId = asPositiveInt(base.postId);
    const commentId = asPositiveInt(base.commentId);
    const payloadHint = this.extractCommentPayloadHint(payload);
    const contextLines: string[] = [];

    if (postId && this.ctx.callAgentChatBridge) {
      try {
        const postResponse = await this.ctx.callAgentChatBridge({
          action: "find_post",
          postId,
        });
        const postRecord = this.extractPostRecordForCommentCuration(postResponse, postId);
        if (postRecord) {
          const postText =
            asNonEmptyString(postRecord.textBody) ??
            asNonEmptyString(postRecord.caption) ??
            asNonEmptyString(postRecord.body);
          if (postText) contextLines.push(`targetPostText: ${truncateText(postText, 260)}`);
          const mediaSummary = this.summarizePostMediaForComment(postRecord);
          if (mediaSummary) contextLines.push(`targetMedia: ${mediaSummary}`);
        }
      } catch {
        // best effort context enrichment only
      }
    }

    if (postId && commentId && this.ctx.callAgentChatBridge) {
      try {
        const commentResponse = await this.ctx.callAgentChatBridge({
          action: "find_comment",
          postId,
          commentId,
        });
        const commentRecord = this.extractCommentRecordForCommentCuration(commentResponse);
        if (commentRecord) {
          const body =
            asNonEmptyString(commentRecord.body) ??
            asNonEmptyString(commentRecord.textBody);
          if (body) contextLines.push(`targetComment: ${truncateText(body, 220)}`);
        }
      } catch {
        // best effort context enrichment only
      }
    }

    if (typeof this.ctx.memory.buildContext === "function") {
      try {
        const bundle = await this.ctx.memory.buildContext({
          mode: "directive",
          audience: "runtime_generate",
          ...(postId ? { postId } : {}),
          ...(commentId ? { commentId } : {}),
          maxRecentEvents: 120,
          maxArchiveEvents: 40,
          includeViewState: true,
          viewStateMaxItems: 10,
          includeKeywordRetrieval: true,
          retrievalIntent: "directive",
          retrievalMaxItems: 10,
          retrievalQuery: [
            payloadHint ?? "",
            postId ? `post ${postId}` : "",
            commentId ? `comment ${commentId}` : "",
          ]
            .filter((value) => value.length > 0)
            .join(" · "),
        });
        const memorySummary = this.buildCompactEngagementMemorySummary(bundle);
        if (memorySummary) {
          contextLines.push(`memory: ${truncateText(memorySummary, 900)}`);
        }
      } catch {
        // best effort context enrichment only
      }
    }

    const contextHint = truncateText(
      [
        payloadHint ? `directiveHint: ${payloadHint}` : "",
        ...contextLines,
      ]
        .filter((value) => value.length > 0)
        .join("\n"),
      2200,
    );

    const topic =
      asNonEmptyString(base.topic) ??
      payloadHint ??
      (contextLines.length > 0 ? truncateText(contextLines.join(" | "), 120) : null);

    const fallbackReferenceInputs = Array.isArray(base.mediaReferenceUrls)
      ? base.mediaReferenceUrls
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .slice(0, MAX_MEDIA_REFERENCE_INPUTS)
      : [];
    const personaReferences = await this.resolvePersonaFrameReferences({
      payload,
      command,
      fallbackReferenceInputs,
    });
    if (
      personaReferences.personaSlug !== null &&
      personaReferences.frameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT
    ) {
      throw new Error(
        `persona_reference_setup_required:${personaReferences.personaSlug}`,
      );
    }
    const mediaReferenceUrls =
      personaReferences.personaSlug !== null
        ? personaReferences.frameReferences
        : fallbackReferenceInputs;

    return {
      ...base,
      ...(topic ? { topic: truncateText(topic, 120) } : {}),
      ...(contextHint.length > 0 ? { contextHint } : {}),
      ...(mediaReferenceUrls.length > 0 ? { mediaReferenceUrls } : {}),
    };
  }

  private normalizeRequestedGenerateKind(value: unknown): string | null {
    const raw = asNonEmptyString(value)?.toLowerCase();
    if (!raw) return null;
    const normalized = raw.replace(/[\s-]+/gu, "_");
    if (
      normalized === "story" ||
      normalized === "thread" ||
      normalized === "comment" ||
      normalized === "like" ||
      normalized === "repost" ||
      normalized === "media" ||
      normalized === "multi_media"
    ) {
      return normalized;
    }
    if (normalized === "stories") return "story";
    if (normalized === "reply") return "comment";
    if (normalized === "engagement") return "like";
    if (normalized === "boost") return "repost";
    if (
      normalized === "post" ||
      normalized === "image" ||
      normalized === "avatar" ||
      normalized === "banner"
    ) {
      return "media";
    }
    if (normalized === "carousel") return "multi_media";
    return null;
  }

  private resolveRequestedGenerateKinds(
    payload: Record<string, unknown>,
    fallbackKind: string,
  ): string[] {
    const kinds: string[] = [];
    const seen = new Set<string>();
    const pushKind = (value: unknown): void => {
      const normalized = this.normalizeRequestedGenerateKind(value);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      kinds.push(normalized);
    };
    const pushArray = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        pushKind(entry);
      }
    };
    const pushCsvLike = (value: unknown): void => {
      const text = asNonEmptyString(value);
      if (!text) return;
      for (const token of text.split(/[,|]/u)) {
        pushKind(token);
      }
    };

    pushArray(payload.kinds);
    pushArray(payload.generateKinds);
    if (!Array.isArray(payload.kinds)) {
      pushCsvLike(payload.kinds);
    }
    if (!Array.isArray(payload.generateKinds)) {
      pushCsvLike(payload.generateKinds);
    }
    if (Array.isArray(payload.generateKind)) {
      pushArray(payload.generateKind);
    } else {
      pushKind(payload.generateKind);
    }

    if (kinds.length === 0) pushKind(payload.goal);
    if (kinds.length === 0) pushKind(payload.kind);
    if (kinds.length === 0) pushKind(fallbackKind);
    return kinds.slice(0, 6);
  }

  private isExplicitMultiMediaRequest(payload: Record<string, unknown>): boolean {
    const context = isRecord(payload.context) ? payload.context : null;
    const isTruthy = (value: unknown): boolean =>
      value === true || value === "true";
    if (
      isTruthy(payload.multiMedia) ||
      isTruthy(payload.carousel) ||
      isTruthy(payload.mediaSlides) ||
      isTruthy(payload.enableSlides) ||
      isTruthy(context?.multiMedia) ||
      isTruthy(context?.carousel) ||
      isTruthy(context?.mediaSlides) ||
      isTruthy(context?.enableSlides)
    ) {
      return true;
    }
    const directItems = Array.isArray(payload.mediaItems) ? payload.mediaItems : [];
    const contextItems = Array.isArray(context?.mediaItems) ? context.mediaItems : [];
    if (directItems.length > 1 || contextItems.length > 1) return true;
    const goal = asNonEmptyString(payload.goal)?.toLowerCase() ?? "";
    if (goal === "multi_media" || goal === "carousel") return true;
    const mode =
      asNonEmptyString(payload.mode)?.toLowerCase() ??
      asNonEmptyString(payload.postMode)?.toLowerCase() ??
      "";
    if (mode === "multi_media" || mode === "carousel" || mode === "slides") {
      return true;
    }
    const requestedKinds = this.resolveRequestedGenerateKinds(payload, "media");
    return requestedKinds.includes("multi_media");
  }

  private parsePermissionCanState(permissionState: unknown): {
    hasHints: boolean;
    can: {
      postMedia: boolean;
      postText: boolean;
      story: boolean;
      comment: boolean;
      like: boolean;
      repost: boolean;
      imageGenerate: boolean;
      textGenerate: boolean;
    };
  } {
    const canState = isRecord(permissionState)
      ? (isRecord(permissionState.can) ? permissionState.can : permissionState)
      : null;
    const readBoolean = (key: string): boolean | null => {
      if (!canState || typeof canState[key] !== "boolean") return null;
      return canState[key] === true;
    };
    const readBooleanAlias = (keys: string[]): boolean | null => {
      for (const key of keys) {
        const value = readBoolean(key);
        if (typeof value === "boolean") return value;
      }
      return null;
    };
    const values = {
      postMedia: readBoolean("postMedia"),
      postText: readBoolean("postText"),
      story: readBoolean("story"),
      comment: readBoolean("comment"),
      like: readBoolean("like"),
      repost: readBoolean("repost"),
      imageGenerate: readBooleanAlias([
        "imageGenerate",
        "generateImage",
        "image_generate",
        "generate_image",
      ]),
      textGenerate: readBooleanAlias([
        "textGenerate",
        "generateText",
        "text_generate",
        "generate_text",
      ]),
    };

    // --- Derive capabilities from activeWindows grants ---
    // The `can` booleans may not be populated even when valid grants exist
    // in activeWindows. Scan grant action keys to fill in missing capabilities.
    const grantCandidates = parseGrantCandidatesFromPermissionState(permissionState);
    const nowMs = Date.now();
    const hasActiveGrant = (actionKeys: readonly string[]): boolean => {
      for (const candidate of grantCandidates) {
        if (candidate.expiresAtMs <= nowMs) continue;
        for (const key of actionKeys) {
          const action = candidate.actions.get(key);
          if (action && action.remainingCount > 0) return true;
        }
      }
      return false;
    };

    if (values.postMedia !== true) {
      if (hasActiveGrant(["post:post:media", "post:thread:media"])) {
        values.postMedia = true;
      }
    }
    if (values.postText !== true) {
      if (hasActiveGrant(["post:post:text", "post:thread:text"])) {
        values.postText = true;
      }
    }
    if (values.story !== true) {
      if (hasActiveGrant(["story", "write.createStory"])) {
        values.story = true;
      }
    }
    if (values.comment !== true) {
      if (hasActiveGrant(["comment", "write.commentPost"])) {
        values.comment = true;
      }
    }
    if (values.like !== true) {
      if (hasActiveGrant(["like", "write.votePost"])) {
        values.like = true;
      }
    }
    if (values.repost !== true) {
      if (hasActiveGrant(["repost", "write.repostPost"])) {
        values.repost = true;
      }
    }
    if (values.imageGenerate !== true) {
      if (
        hasActiveGrant([
          "post:post:media",
          "post:thread:media",
          "story",
          "write.createStory",
          "image_generate",
          "generate_image",
        ]) ||
        values.postMedia === true ||
        values.story === true
      ) {
        values.imageGenerate = true;
      }
    }
    if (values.textGenerate !== true) {
      if (
        hasActiveGrant([
          "post:post:text",
          "post:thread:text",
          "comment",
          "write.commentPost",
          "like",
          "write.votePost",
          "repost",
          "write.repostPost",
          "text_generate",
          "generate_text",
        ]) ||
        values.postText === true ||
        values.comment === true ||
        values.like === true ||
        values.repost === true
      ) {
        values.textGenerate = true;
      }
    }

    const hasAnyHints =
      grantCandidates.length > 0 ||
      Object.values(values).some((value) => typeof value === "boolean");

    return {
      hasHints: hasAnyHints,
      can: {
        postMedia: values.postMedia === true,
        postText: values.postText === true,
        story: values.story === true,
        comment: values.comment === true,
        like: values.like === true,
        repost: values.repost === true,
        imageGenerate: values.imageGenerate !== false,
        textGenerate: values.textGenerate !== false,
      },
    };
  }

  private constrainGenerateKindsByPermissionState(
    kinds: string[],
    permissionState: unknown,
  ): string[] {
    const permission = this.parsePermissionCanState(permissionState);
    if (!permission.hasHints || kinds.length === 0) return kinds;
    const allowed = new Set<string>();
    if (permission.can.postMedia || permission.can.postText) {
      if (permission.can.textGenerate) {
        allowed.add("thread");
      }
      if (permission.can.imageGenerate) {
        allowed.add("media");
        allowed.add("multi_media");
      }
    }
    if (permission.can.story && permission.can.imageGenerate) allowed.add("story");
    if (permission.can.comment && permission.can.textGenerate) allowed.add("comment");
    if (permission.can.like && permission.can.textGenerate) allowed.add("like");
    if (permission.can.repost) allowed.add("repost");
    if (allowed.size === 0) return [];

    const filtered = kinds.filter((kind) => allowed.has(kind));
    if (filtered.length > 0) return filtered.slice(0, 6);

    const fallbackOrder = [
      "comment",
      "like",
      "repost",
      "thread",
      "media",
      "multi_media",
      "story",
    ] as const;
    const fallback = fallbackOrder
      .filter((kind) => allowed.has(kind))
      .slice(0, 6);
    return fallback.length > 0 ? fallback : kinds;
  }

  private applyPermissionGenerateInputConstraints(
    generateInput: Record<string, unknown>,
    permissionState: unknown,
  ): Record<string, unknown> {
    const normalizedKinds: string[] = [];
    const seen = new Set<string>();
    const push = (value: unknown): void => {
      const normalized = this.normalizeRequestedGenerateKind(value);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      normalizedKinds.push(normalized);
    };
    if (Array.isArray(generateInput.kinds)) {
      for (const value of generateInput.kinds) push(value);
    }
    push(generateInput.kind);
    if (normalizedKinds.length === 0) return generateInput;
    const constrained = this.constrainGenerateKindsByPermissionState(
      normalizedKinds,
      permissionState,
    );
    if (
      constrained.length === normalizedKinds.length &&
      constrained.every((value, index) => value === normalizedKinds[index])
    ) {
      return generateInput;
    }
    return {
      ...generateInput,
      kind: constrained[0] ?? generateInput.kind,
      kinds: constrained,
    };
  }

  private isGeneratedDraftAllowedByPermissionState(
    draft: GeneratedDraft,
    permissionState: unknown,
  ): boolean {
    const permission = this.parsePermissionCanState(permissionState);
    if (!permission.hasHints) return true;
    const action = draft.action.trim().toLowerCase();
    if (action === "comment") return permission.can.comment;
    if (action === "like") return permission.can.like;
    if (action === "repost") return permission.can.repost;
    if (action === "story") return permission.can.story;
    if (action === "post") {
      const payload = isRecord(draft.payload) ? draft.payload : null;
      const postType = asNonEmptyString(payload?.postType)?.toLowerCase() ?? "";
      if (postType === "text") return permission.can.postText;
      if (postType === "media") return permission.can.postMedia;
      return permission.can.postMedia || permission.can.postText;
    }
    return true;
  }

  private mapGoalToGenerateKind(goal: string): string {
    if (goal === "avatar") return "media";
    if (goal === "banner") return "media";
    if (goal === "chat" || goal === "conversation") return "media";
    if (goal === "settings" || goal === "moderation") return "media";
    if (goal === "story") return "story";
    if (goal === "thread") return "thread";
    if (goal === "comment" || goal === "reply") return "comment";
    if (goal === "like" || goal === "engagement") return "like";
    if (goal === "repost" || goal === "boost") return "repost";
    if (goal === "multi_media" || goal === "carousel") return "multi_media";
    if (goal === "media" || goal === "image" || goal === "post") return "media";
    return "media";
  }

  private resolveEnforcedDraftAction(
    payload: Record<string, unknown>,
  ): "comment" | "like" | "repost" | null {
    const normalizedKinds = this.resolveRequestedGenerateKinds(payload, "story");
    const goal = asNonEmptyString(payload.goal)?.toLowerCase() ?? "";
    if (goal === "comment" || goal === "like" || goal === "repost") {
      if (
        normalizedKinds.length <= 1 ||
        normalizedKinds.every((kind) => kind === goal)
      ) {
        return goal;
      }
    }

    if (normalizedKinds.length === 1) {
      const onlyKind = normalizedKinds[0];
      if (onlyKind === "comment" || onlyKind === "like" || onlyKind === "repost") {
        return onlyKind;
      }
    }
    return null;
  }

  private extractInlineDrafts(payload: Record<string, unknown>): GeneratedDraft[] {
    const drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
    return drafts
      .map((entry) => {
        if (!isRecord(entry) || !isRecord(entry.payload)) return null;
        const action = asNonEmptyString(entry.action);
        if (!action) return null;
        return {
          action,
          payload: entry.payload,
        } satisfies GeneratedDraft;
      })
      .filter((entry): entry is GeneratedDraft => Boolean(entry));
  }

  private extractGeneratedDrafts(generatedResult: unknown): GeneratedDraft[] {
    if (!isRecord(generatedResult) || !Array.isArray(generatedResult.items)) return [];
    const drafts: GeneratedDraft[] = [];
    for (const item of generatedResult.items) {
      if (!isRecord(item) || !Array.isArray(item.drafts)) continue;
      for (const draft of item.drafts) {
        if (!isRecord(draft) || !isRecord(draft.payload)) continue;
        const action = asNonEmptyString(draft.action);
        if (!action) continue;
        drafts.push({
          action,
          payload: draft.payload,
        });
      }
    }
    return drafts;
  }

  private isPersonaMediaCompatibleDraft(draft: GeneratedDraft): boolean {
    const action = draft.action.trim().toLowerCase();
    if (action === "story" || action === "avatar" || action === "banner") return true;
    if (action !== "post") return false;
    const payload = isRecord(draft.payload) ? draft.payload : null;
    const postType = asNonEmptyString(payload?.postType)?.toLowerCase() ?? "";
    if (postType.length > 0) {
      if (
        postType === "media" ||
        postType === "image" ||
        postType === "gif" ||
        postType === "video" ||
        postType === "photo" ||
        postType === "sticker"
      ) {
        return true;
      }
      if (postType === "text" || postType === "thread") return false;
    }
    const generatedAssetType =
      asNonEmptyString(payload?.generatedAssetType)?.toLowerCase() ?? "";
    if (
      generatedAssetType === "image" ||
      generatedAssetType === "gif" ||
      generatedAssetType === "video"
    ) {
      return true;
    }
    const mediaPrompt =
      asNonEmptyString(payload?.mediaPrompt) ??
      asNonEmptyString(payload?.imagePrompt);
    if (mediaPrompt) return true;
    if (asNonEmptyString(payload?.mediaUrl)) return true;
    const mediaItemsRaw = payload?.mediaItems;
    const mediaItems = Array.isArray(mediaItemsRaw) ? mediaItemsRaw : [];
    return mediaItems.some((entry) => {
      if (!isRecord(entry)) return false;
      return Boolean(asNonEmptyString(entry.mediaUrl));
    });
  }

  private buildPersonaLockedMediaFallbackDraft(input: {
    payload: Record<string, unknown>;
    drafts: GeneratedDraft[];
  }): GeneratedDraft | null {
    const sourceDraft = input.drafts.find(
      (draft) => draft.action.trim().toLowerCase() === "post",
    );
    const sourcePayload = sourceDraft && isRecord(sourceDraft.payload)
      ? sourceDraft.payload
      : null;
    const mediaPrompt =
      asNonEmptyString(sourcePayload?.mediaPrompt) ??
      asNonEmptyString(sourcePayload?.imagePrompt) ??
      asNonEmptyString(sourcePayload?.prompt) ??
      asNonEmptyString(sourcePayload?.textBody) ??
      asNonEmptyString(sourcePayload?.caption) ??
      asNonEmptyString(input.payload.mediaPrompt) ??
      asNonEmptyString(input.payload.imagePrompt) ??
      asNonEmptyString(input.payload.prompt) ??
      asNonEmptyString(input.payload.topic) ??
      "Photorealistic selfie of yourself with strong identity continuity.";
    const caption =
      asNonEmptyString(sourcePayload?.caption) ??
      asNonEmptyString(input.payload.caption);
    const mediaMode =
      asNonEmptyString(input.payload.mediaMode) ??
      asNonEmptyString(sourcePayload?.mediaMode) ??
      "selfie";
    const nextPayload: Record<string, unknown> = {
      ...(sourcePayload ?? {}),
      ...input.payload,
      postType: "media",
      generatedAssetType: "image",
      mediaPrompt,
      imagePrompt: mediaPrompt,
      prompt: mediaPrompt,
      mediaMode,
      mediaPersonaLock: true,
    };
    if (caption) {
      nextPayload.caption = caption;
    }
    return {
      action: "post",
      payload: nextPayload,
    };
  }

  private mapDraftToWriteCommand(input: {
    draft: GeneratedDraft;
    command: Command;
    sourceDirectiveId: string | null;
    sourceDirectiveActionNonce: string | null;
    provenance: string | null;
  }): Command | null {
    const draft = input.draft;
    const action = draft.action.trim().toLowerCase();
    const inheritedPayload = inheritChatContextIntoPayload({
      payload: draft.payload,
      sourcePayload: input.command.payload,
    });
    const payload = isRecord(inheritedPayload) ? inheritedPayload : null;
    if (!payload) return null;

    const basePayload: Record<string, unknown> = {
      ...payload,
      ...(input.provenance ? { provenance: input.provenance } : {}),
      sourceDirectiveId: input.sourceDirectiveId,
      ...(input.sourceDirectiveActionNonce
        ? { sourceDirectiveActionNonce: input.sourceDirectiveActionNonce }
        : {}),
    };

    const id = `draft_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const createdAt = nowIso();

    const mappedKind =
      action === "story"
        ? "write.createStory"
        : action === "comment"
          ? "write.commentPost"
          : action === "repost"
            ? "write.repostPost"
          : action === "avatar"
            ? "write.updateAvatar"
            : action === "banner"
              ? "write.updateBanner"
            : action === "like"
              ? "write.votePost"
              : action === "post"
              ? "write.createPost"
              : null;
    if (!mappedKind) return null;

    const sourcePayload = isRecord(input.command.payload) ? input.command.payload : null;
    const sourcePostId = sourcePayload
      ? asPositiveInt(sourcePayload.postId) ??
        asPositiveInt(sourcePayload.targetPostId)
      : null;
    const sourceCommentId = sourcePayload
      ? asPositiveInt(sourcePayload.parentId) ??
        asPositiveInt(sourcePayload.commentId) ??
        asPositiveInt(sourcePayload.targetCommentId)
      : null;

    if (mappedKind === "write.votePost") {
      basePayload.vote = 1;
    }
    if (
      mappedKind === "write.commentPost" ||
      mappedKind === "write.votePost" ||
      mappedKind === "write.repostPost"
    ) {
      const lockedPostId = sourcePostId ?? asPositiveInt(basePayload.postId);
      const lockedCommentId =
        mappedKind === "write.commentPost"
          ? sourceCommentId ?? asPositiveInt(basePayload.parentId)
          : null;
      if (lockedPostId) {
        basePayload.postId = lockedPostId;
        if (mappedKind === "write.commentPost" && lockedCommentId) {
          basePayload.parentId = lockedCommentId;
          basePayload.commentId = lockedCommentId;
        }
        applyTargetLock(basePayload, {
          postId: lockedPostId,
          commentId: lockedCommentId ?? null,
        });
      }
    }
    if (mappedKind === "write.createPost") {
      const postTypeRaw = asNonEmptyString(basePayload.postType)?.toLowerCase();
      if (!postTypeRaw) {
        if (asNonEmptyString(basePayload.textBody)) {
          basePayload.postType = "text";
        } else {
          basePayload.postType = "media";
        }
      }
    }

    const command: Command = {
      id,
      createdAt,
      kind: mappedKind,
      grantId: input.command.grantId,
      payload: basePayload,
      sig: null,
      sourceDirectiveId: input.sourceDirectiveId,
      pendingDirectiveId: input.command.pendingDirectiveId,
      actionNonce: input.sourceDirectiveActionNonce,
      challenge: null,
      forceNow: input.command.forceNow,
      runtimeSessionId: null,
      runtimeOrigin: null,
      runtimeSig: null,
    };
    if (this.ctx.controlKey) {
      command.sig = computeCommandSignature(this.ctx.controlKey, command);
    }
    return command;
  }

  private collectMediaReferenceInputs(
    payload: Record<string, unknown>,
    options?: {
      includeRecentGeneratedAsset?: boolean;
    },
  ): string[] {
    const context = isRecord(payload.context) ? payload.context : null;
    const includeRecentGeneratedAsset = options?.includeRecentGeneratedAsset !== false;
    const collected: string[] = [];
    const pushMaybe = (value: unknown): void => {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      if (!trimmed.length) return;
      collected.push(trimmed);
    };
    const pushMaybeArray = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        if (typeof entry === "string") {
          pushMaybe(entry);
          continue;
        }
        if (!isRecord(entry)) continue;
        pushMaybe(entry.mediaRef);
        pushMaybe(entry.uploadedUrl);
        pushMaybe(entry.mediaUrl);
        pushMaybe(entry.url);
        pushMaybe(entry.image);
        pushMaybe(entry.imageUrl);
        pushMaybe(entry.originalUrl);
        pushMaybe(entry.mediaOptimizedUrl);
        pushMaybe(entry.optimizedUrl);
        pushMaybe(entry.file);
        pushMaybe(entry.path);
        pushMaybe(entry.href);
      }
    };

    [
      payload.mediaReferenceUrls,
      payload.mediaReferenceFiles,
      payload.mediaReferenceMedia,
      payload.referenceMedia,
      payload.referenceImages,
      payload.taggedUsers,
      payload.mediaItems,
      context?.mediaReferenceUrls,
      context?.mediaReferenceFiles,
      context?.mediaReferenceMedia,
      context?.referenceMedia,
      context?.referenceImages,
      context?.taggedUsers,
      context?.mediaItems,
    ].forEach((value) => pushMaybeArray(value));
    [
      payload.mediaReferenceUrl,
      payload.mediaReferenceFile,
      payload.referenceImage,
      payload.referenceMediaUrl,
      context?.mediaReferenceUrl,
      context?.mediaReferenceFile,
      context?.referenceImage,
      context?.referenceMediaUrl,
      payload.mediaOptimizedUrl,
      payload.optimizedUrl,
      context?.mediaOptimizedUrl,
      context?.optimizedUrl,
    ].forEach((value) => pushMaybe(value));

    if (includeRecentGeneratedAsset) {
      const recentGeneratedAsset = isRecord(payload.recentGeneratedAsset)
        ? payload.recentGeneratedAsset
        : null;
      pushMaybe(recentGeneratedAsset?.href);
      pushMaybe(recentGeneratedAsset?.url);
      pushMaybe(recentGeneratedAsset?.imageUrl);
      pushMaybe(recentGeneratedAsset?.mediaUrl);
      pushMaybe(recentGeneratedAsset?.originalUrl);
      pushMaybe(recentGeneratedAsset?.optimizedUrl);
      pushMaybe(recentGeneratedAsset?.mediaOptimizedUrl);
    }

    return Array.from(new Set(collected)).slice(0, MAX_COLLECTED_REFERENCE_INPUTS);
  }

  private async resolveLocalReferencePath(reference: string): Promise<string | null> {
    const trimmed = reference.trim();
    if (!trimmed.length) return null;

    if (isFileUrl(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        let candidatePath = decodeURIComponent(parsed.pathname);
        if (process.platform === "win32" && /^\/[a-zA-Z]:/u.test(candidatePath)) {
          candidatePath = candidatePath.slice(1);
        }
        const absolutePath = path.resolve(candidatePath);
        await fs.access(absolutePath);
        return absolutePath;
      } catch {
        return null;
      }
    }

    if (isHttpUrl(trimmed) || isDataUri(trimmed)) return null;
    const absolutePath = path.resolve(trimmed);
    const fileStat = await fs.stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile()) return null;
    return absolutePath;
  }

  private async materializeMediaReferenceFiles(input: {
    requestDir: string;
    referenceInputs: string[];
    maxReferenceInputs?: number;
  }): Promise<string[]> {
    const maxReferenceInputsRaw =
      typeof input.maxReferenceInputs === "number" &&
      Number.isFinite(input.maxReferenceInputs)
        ? Math.floor(input.maxReferenceInputs)
        : MAX_MEDIA_REFERENCE_INPUTS;
    const maxReferenceInputs = Math.max(
      0,
      Math.min(MAX_MEDIA_REFERENCE_INPUTS, maxReferenceInputsRaw),
    );
    if (maxReferenceInputs === 0 || input.referenceInputs.length === 0) return [];
    const refsDir = path.join(input.requestDir, "refs");
    await ensureDir(refsDir);
    const resolved: string[] = [];
    const seen = new Set<string>();

    const pushResolved = (value: string): void => {
      if (resolved.length >= maxReferenceInputs) return;
      const normalized = path.resolve(value);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      resolved.push(normalized);
    };

    for (const rawReference of input.referenceInputs) {
      if (resolved.length >= maxReferenceInputs) break;
      const reference = rawReference.trim();
      if (!reference.length) continue;

      const localPath = await this.resolveLocalReferencePath(reference);
      if (localPath) {
        pushResolved(localPath);
        continue;
      }

      if (isDataUri(reference)) {
        const parsed = parseDataUriPayload(reference);
        if (!parsed) continue;
        const targetPath = path.join(
          refsDir,
          `data-${resolved.length + 1}.${mimeToExt(parsed.mime)}`,
        );
        await fs
          .writeFile(targetPath, Buffer.from(parsed.data, "base64"))
          .then(() => pushResolved(targetPath))
          .catch(() => undefined);
        continue;
      }

      if (isHttpUrl(reference)) {
        try {
          const response = await fetch(reference);
          if (!response.ok) continue;
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.byteLength) continue;
          const contentType =
            response.headers.get("content-type") ??
            inferMimeTypeFromUrl(reference) ??
            "application/octet-stream";
          const targetPath = path.join(
            refsDir,
            `remote-${resolved.length + 1}.${mimeToExt(contentType)}`,
          );
          await fs.writeFile(targetPath, bytes);
          pushResolved(targetPath);
        } catch {
          // best effort only for reference enrichment
        }
      }
    }

    return resolved;
  }

  private async resolveMediaUpload(input: {
    payload: Record<string, unknown>;
    keepOriginal?: boolean;
    promptFallbacks: Array<string | null>;
    command?: Command;
    skipPromptCuration?: boolean;
  }): Promise<ResolvedMediaUpload> {
    const isRecoverableMediaSourceFailure = (error: unknown): boolean => {
      if (!(error instanceof Error)) return false;
      const message = error.message.trim().toLowerCase();
      return (
        message.includes("only image and video uploads are supported") ||
        message.includes("unsupported_media_payload_mime:") ||
        message.includes("invalid data uri") ||
        message.includes("invalid_data_uri") ||
        message.includes("empty media data") ||
        message.includes("media_source_empty") ||
        message.includes("no_media_url")
      );
    };
    const tryUploadSource = async (
      source: string,
      sourceKey: string,
    ): Promise<ResolvedMediaUpload | null> => {
      try {
        return await this.uploadResolvedMediaSource(source, { keepOriginal });
      } catch (error: unknown) {
        if (!isRecoverableMediaSourceFailure(error)) {
          throw error;
        }
        if (input.command) {
          await this.ctx.memory
            .recordWrite({
              type: "media_source_skipped",
              at: nowIso(),
              commandId: input.command.id,
              source: sourceKey,
              error: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined);
        }
        return null;
      }
    };
    const payload = input.payload;
    const keepOriginal = input.keepOriginal === true;
    const skipPromptCuration =
      input.skipPromptCuration === true ||
      (input.command ? this.isDirectiveContextLinkedCommand(input.command) : false);
    const markUploaded = async (
      result: ResolvedMediaUpload,
      source: string,
    ): Promise<ResolvedMediaUpload> => {
      if (input.command) {
        await this.recordCommandLifecycleCheckpoint({
          command: input.command,
          stage: "uploaded",
          status: "ok",
          metadata: {
            source,
            mediaUrl: result.mediaUrl,
            mediaType: result.mediaType ?? null,
          },
        });
      }
      return result;
    };
    const existingMediaUrl = asNonEmptyString(payload.mediaUrl);
    if (existingMediaUrl) {
      const resolved = await tryUploadSource(existingMediaUrl, "payload.mediaUrl");
      if (resolved) return markUploaded(resolved, "payload.mediaUrl");
    }

    const mediaItems = Array.isArray(payload.mediaItems) ? payload.mediaItems : [];
    for (let index = 0; index < mediaItems.length; index += 1) {
      const mediaItem = mediaItems[index];
      if (!isRecord(mediaItem)) continue;
      const mediaUrl = asNonEmptyString(mediaItem.mediaUrl);
      if (mediaUrl) {
        const resolved = await tryUploadSource(
          mediaUrl,
          `payload.mediaItems[${index}].mediaUrl`,
        );
        if (resolved) return markUploaded(resolved, "payload.mediaItems");
      }
    }

    const prompt =
      input.promptFallbacks.find((entry) => typeof entry === "string" && entry.trim().length > 0) ??
      null;
    if (!prompt) {
      throw new Error("missing_media_input");
    }
    const fallbackReferenceInputs = this.collectMediaReferenceInputs(payload);
    try {
      let referenceInputs = fallbackReferenceInputs;
      if (input.command) {
        const personaReferences = await this.resolvePersonaFrameReferences({
          payload,
          command: input.command,
          fallbackReferenceInputs,
        });
        if (
          personaReferences.personaSlug !== null &&
          personaReferences.frameReferences.length < REQUIRED_PERSONA_REFERENCE_FRAME_COUNT
        ) {
          throw new Error(
            `persona_reference_setup_required:${personaReferences.personaSlug}`,
          );
        }
        referenceInputs =
          personaReferences.personaSlug !== null
            ? personaReferences.frameReferences
            : fallbackReferenceInputs;
      }
      const requestedGeneratedAssetType = this.resolveGeneratedAssetType(
        payload.generatedAssetType,
      );
      const generatedAssetType =
        requestedGeneratedAssetType === "gif" ? "gif" : "image";
      const generated = await this.generateAndUploadMediaFromPrompt(prompt, {
        generatedAssetType,
        mode: "write_media_generate",
        referenceInputs,
        keepOriginal,
        commandId: input.command?.id ?? null,
        skipPromptCuration,
      });
      return markUploaded(generated, "generated_prompt");
    } catch (error: unknown) {
      if (input.command) {
        const deferred = this.classifyMediaGenerationDeferral({
          error,
          hasPrompt: true,
        });
        if (deferred.shouldRequeue && deferred.reason) {
          const message = error instanceof Error ? error.message : String(error);
          await this.recordCommandLifecycleCheckpoint({
            command: input.command,
            stage: "generated",
            status: "failed",
            message,
            metadata: {
              requeued: true,
              reason: deferred.reason,
              reasonCode: deferred.reasonCode,
              personaSlug: deferred.personaSlug,
              source: "resolve_media_upload",
            },
          });
          await this.ctx.memory
            .recordWrite({
              type: "media_generation_deferred_for_setup",
              at: nowIso(),
              commandId: input.command.id,
              reason: deferred.reason,
              reasonCode: deferred.reasonCode,
              personaSlug: deferred.personaSlug,
              error: message,
            })
            .catch(() => undefined);
          throw new RequeueCommandError(deferred.reason);
        }
      }
      throw error;
    }
  }

  private async uploadResolvedMediaSource(
    source: string,
    options?: { keepOriginal?: boolean },
  ): Promise<ResolvedMediaUpload> {
    const keepOriginal = options?.keepOriginal === true;
    const trimmed = source.trim();
    if (isDataUri(trimmed)) {
      const parsed = parseDataUriPayload(trimmed);
      if (!parsed) {
        throw new Error("invalid_data_uri");
      }
      const bytes = Buffer.from(parsed.data, "base64");
      if (!bytes.byteLength) {
        throw new Error("media_source_empty");
      }
      const parsedMime = parsed.mime.trim().toLowerCase();
      const sniffedMime = sniffMimeTypeFromBytes(bytes);
      const resolvedMime =
        this.isUploadableMediaMimeType(parsedMime)
          ? parsedMime
          : this.isUploadableMediaMimeType(sniffedMime)
            ? sniffedMime!
            : parsedMime;
      if (!this.isUploadableMediaMimeType(resolvedMime)) {
        throw new Error(`unsupported_media_payload_mime:${parsedMime}`);
      }
      const normalizedDataUri =
        resolvedMime === parsedMime
          ? trimmed
          : `data:${resolvedMime};base64,${bytes.toString("base64")}`;
      const uploadedByChunk = await this.uploadBytesViaChunkRoute({
        bytes,
        mimeType: resolvedMime,
        filename: `upload-${Date.now()}.${mimeToExt(resolvedMime)}`,
        keepOriginal,
      });
      if (uploadedByChunk) return uploadedByChunk;
      const uploaded = await this.agent().uploadDataUri.mutate({
        dataUri: normalizedDataUri,
        keepOriginal,
      });
      return this.mapUploadResult(uploaded);
    }
    if (isHttpUrl(trimmed)) {
      const inferredMime = inferMimeTypeFromUrl(trimmed);
      if (
        inferredMime &&
        inferredMime !== "application/octet-stream" &&
        !this.isUploadableMediaMimeType(inferredMime)
      ) {
        throw new Error(`unsupported_media_payload_mime:${inferredMime}`);
      }
      try {
        const uploaded = await this.agent().uploadRemote.mutate({
          url: trimmed,
          keepOriginal,
        });
        return this.mapUploadResult(uploaded);
      } catch (remoteError: unknown) {
        await this.ctx.memory
          .recordWrite({
            type: "remote_upload_failed",
            at: nowIso(),
            url: trimmed,
            keepOriginal,
            error: remoteError instanceof Error ? remoteError.message : String(remoteError),
          })
          .catch(() => undefined);
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 20_000);
          const response = await fetch(trimmed, {
            signal: controller.signal,
            headers: {
              accept: "image/*,video/*;q=0.9,*/*;q=0.1",
              "user-agent": "MoltgramMediaFetcher/1.0",
            },
          }).finally(() => {
            clearTimeout(timeout);
          });
          if (response.ok) {
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.byteLength > 0) {
              const headerMime = response.headers.get("content-type");
              const mimeRaw =
                headerMime && headerMime.trim().length > 0
                  ? headerMime
                  : inferMimeTypeFromUrl(trimmed) ?? "application/octet-stream";
              const mime = mimeRaw.split(";", 1)[0]?.trim() ?? "application/octet-stream";
              if (!this.isUploadableMediaMimeType(mime)) {
                throw new Error(`unsupported_media_payload_mime:${mime}`);
              }
              const parsedUrl = new URL(trimmed);
              const baseName = path.basename(parsedUrl.pathname).trim();
              const filename =
                baseName.length > 0
                  ? baseName
                  : `upload-${Date.now()}.${mimeToExt(mime)}`;
              const uploadedByChunk = await this.uploadBytesViaChunkRoute({
                bytes,
                mimeType: mime,
                filename,
                keepOriginal,
              });
              if (uploadedByChunk) {
                await this.ctx.memory
                  .recordWrite({
                    type: "remote_upload_fallback_succeeded",
                    at: nowIso(),
                    url: trimmed,
                    keepOriginal,
                    fallback: "chunk",
                  })
                  .catch(() => undefined);
                return uploadedByChunk;
              }
              const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
              const uploaded = await this.agent().uploadDataUri.mutate({
                dataUri,
                keepOriginal,
              });
              await this.ctx.memory
                .recordWrite({
                  type: "remote_upload_fallback_succeeded",
                  at: nowIso(),
                  url: trimmed,
                  keepOriginal,
                  fallback: "data_uri",
                })
                .catch(() => undefined);
              return this.mapUploadResult(uploaded);
            }
          }
        } catch (fallbackError: unknown) {
          await this.ctx.memory
            .recordWrite({
              type: "remote_upload_fallback_failed",
              at: nowIso(),
              url: trimmed,
              keepOriginal,
              error:
                fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            })
            .catch(() => undefined);
        }
        throw remoteError;
      }
    }
    const localPath = path.resolve(trimmed);
    const bytes = await fs.readFile(localPath);
    if (!bytes.byteLength) {
      throw new Error("media_source_empty");
    }
    const mimeByExt = extToMime(localPath);
    const mime =
      mimeByExt === "application/octet-stream"
        ? sniffMimeTypeFromBytes(bytes) ?? mimeByExt
        : mimeByExt;
    if (!this.isUploadableMediaMimeType(mime)) {
      throw new Error(`unsupported_media_payload_mime:${mime}`);
    }
    const uploadedByChunk = await this.uploadBytesViaChunkRoute({
      bytes,
      mimeType: mime,
      filename: path.basename(localPath) || `upload-${Date.now()}.${mimeToExt(mime)}`,
      keepOriginal,
    });
    if (uploadedByChunk) return uploadedByChunk;
    const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
    const uploaded = await this.agent().uploadDataUri.mutate({
      dataUri,
      keepOriginal,
    });
    return this.mapUploadResult(uploaded);
  }

  private async uploadBytesViaChunkRoute(input: {
    bytes: Buffer;
    mimeType: string;
    filename: string;
    keepOriginal?: boolean;
  }): Promise<ResolvedMediaUpload | null> {
    const callAgentUploadChunk = this.ctx.callAgentUploadChunk;
    if (!callAgentUploadChunk) return null;
    const totalBytes = input.bytes.byteLength;
    if (!totalBytes) return null;
    let uploadId: string | null = null;
    try {
      const started = await callAgentUploadChunk({
        op: "start",
        filename: input.filename,
        mimeType: input.mimeType,
        totalBytes,
        keepOriginal: input.keepOriginal === true,
      });
      if (!isRecord(started) || typeof started.uploadId !== "string") {
        throw new Error("chunk_upload_start_invalid");
      }
      uploadId = started.uploadId.trim();
      if (!uploadId.length) {
        throw new Error("chunk_upload_start_missing_id");
      }
      const chunkMaxBytes =
        typeof started.chunkMaxBytes === "number" &&
        Number.isFinite(started.chunkMaxBytes)
          ? Math.max(64 * 1024, Math.floor(started.chunkMaxBytes))
          : 256 * 1024;
      let chunkIndex = 0;
      for (let offset = 0; offset < totalBytes; offset += chunkMaxBytes) {
        const end = Math.min(totalBytes, offset + chunkMaxBytes);
        const chunk = input.bytes.subarray(offset, end);
        await callAgentUploadChunk({
          op: "append",
          uploadId,
          chunkIndex,
          chunkBase64: chunk.toString("base64"),
        });
        chunkIndex += 1;
      }
      const completed = await callAgentUploadChunk({
        op: "complete",
        uploadId,
      });
      return this.mapUploadResult(completed);
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "chunk_upload_failed",
          at: nowIso(),
          filename: input.filename,
          sizeBytes: totalBytes,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      if (uploadId) {
        await callAgentUploadChunk({
          op: "abort",
          uploadId,
        })
          .catch(() => undefined);
      }
      return null;
    }
  }

  private isTransientMediaArtifactFileName(value: string | null | undefined): boolean {
    const normalized = asNonEmptyString(value);
    if (!normalized) return false;
    const fileName = path.basename(normalized.trim());
    if (!fileName.length) return false;
    return (
      STREAM_PART_ARTIFACT_PATTERN.test(fileName) ||
      TRANSIENT_MEDIA_ARTIFACT_FILENAME_PATTERN.test(fileName)
    );
  }

  private isStreamPartArtifactReference(value: string | null | undefined): boolean {
    const normalized = asNonEmptyString(value);
    if (!normalized) return false;
    if (this.isTransientMediaArtifactFileName(normalized)) return true;
    if (!isHttpUrl(normalized)) {
      return STREAM_PART_ARTIFACT_PATTERN.test(normalized);
    }
    try {
      const parsed = new URL(normalized);
      const decodedPath = decodeURIComponent(parsed.pathname);
      if (this.isTransientMediaArtifactFileName(path.posix.basename(decodedPath))) {
        return true;
      }
      for (const [key, rawValue] of parsed.searchParams.entries()) {
        if (/^(?:part|frame|chunk|tmp|temp|temporary|intermediate)$/iu.test(key)) {
          return true;
        }
        if (
          this.isTransientMediaArtifactFileName(rawValue) ||
          STREAM_PART_ARTIFACT_PATTERN.test(rawValue)
        ) {
          return true;
        }
      }
      return false;
    } catch {
      return this.isTransientMediaArtifactFileName(normalized);
    }
  }

  private resolvePreferredMediaUrl(
    ...values: Array<string | null | undefined>
  ): string | null {
    let fallback: string | null = null;
    for (const value of values) {
      const normalized = asNonEmptyString(value);
      if (!normalized) continue;
      fallback ??= normalized;
      if (!this.isStreamPartArtifactReference(normalized)) {
        return normalized;
      }
    }
    return fallback;
  }

  private mapUploadResult(uploaded: unknown): ResolvedMediaUpload {
    const data = isRecord(uploaded) ? uploaded : null;
    const mediaUrl = this.resolvePreferredMediaUrl(
      asNonEmptyString(data?.url),
      asNonEmptyString(data?.mediaUrl),
      asNonEmptyString(data?.originalUrl),
      asNonEmptyString(data?.optimizedUrl),
    );
    if (!mediaUrl) {
      throw new Error("no_media_url");
    }
    const mediaTypeRaw = asNonEmptyString(data?.mediaType)?.toLowerCase();
    const mediaType =
      mediaTypeRaw === "video"
        ? ("video" as const)
        : mediaTypeRaw === "image"
          ? ("image" as const)
          : undefined;
    const originalUrl =
      this.resolvePreferredMediaUrl(
        asNonEmptyString(data?.originalUrl),
        asNonEmptyString(data?.url),
        asNonEmptyString(data?.mediaUrl),
        asNonEmptyString(data?.optimizedUrl),
      ) ?? mediaUrl;
    const optimizedUrl =
      this.resolvePreferredMediaUrl(
        asNonEmptyString(data?.optimizedUrl),
        asNonEmptyString(data?.url),
        asNonEmptyString(data?.mediaUrl),
        asNonEmptyString(data?.originalUrl),
      ) ?? mediaUrl;
    const result: ResolvedMediaUpload = {
      mediaUrl,
      mediaOriginalUrl: originalUrl,
      mediaOptimizedUrl: optimizedUrl,
    };
    const contentHash = asNonEmptyString(data?.contentHash);
    const ipfsCid = asNonEmptyString(data?.ipfsCid);
    if (contentHash) result.mediaContentHash = contentHash;
    if (ipfsCid) result.mediaIpfsCid = ipfsCid;
    if (typeof data?.sizeBytes === "number" && Number.isFinite(data.sizeBytes)) {
      result.mediaSizeBytes = Math.max(1, Math.floor(data.sizeBytes));
    }
    if (mediaType) result.mediaType = mediaType;
    return result;
  }

  private normalizeCuratedMediaPrompt(value: string): string {
    const unfenced = value
      .replace(/^```(?:json|text|markdown)?\s*/iu, "")
      .replace(/```$/u, "")
      .trim();
    const unquoted = unfenced.replace(/^["'`]|["'`]$/gu, "").trim();
    const withoutLabel = unquoted.replace(
      /^(?:prompt|image prompt|media prompt)\s*:\s*/iu,
      "",
    );
    const withoutGenerationVerb = withoutLabel.replace(
      /^(?:please\s+)?(?:generate|create|make|draw|render)\s+(?:an?\s+)?(?:image|gif|avatar|file|video|audio|pdf|csv|code|markdown|md|txt)\s*(?:of|for)?\s*:?\s*/iu,
      "",
    );
    return stripEmDashCharacters(withoutGenerationVerb).trim();
  }

  private extractCuratedMediaPromptFromUnknown(value: unknown): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed.length) return null;
      const parsed = parseJsonFromMixedText(trimmed);
      if (parsed !== null && parsed !== value) {
        const fromParsed = this.extractCuratedMediaPromptFromUnknown(parsed);
        if (fromParsed) return fromParsed;
      }
      const normalized = this.normalizeCuratedMediaPrompt(trimmed);
      return normalized.length > 0 ? normalized : null;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const extracted = this.extractCuratedMediaPromptFromUnknown(entry);
        if (extracted) return extracted;
      }
      return null;
    }
    if (!isRecord(value)) return null;

    const directPromptKeys = [
      "prompt",
      "mediaPrompt",
      "imagePrompt",
      "filePrompt",
      "text",
      "output",
      "result",
      "content",
    ] as const;
    for (const key of directPromptKeys) {
      const extracted = this.extractCuratedMediaPromptFromUnknown(value[key]);
      if (extracted) return extracted;
    }
    return null;
  }

  private buildMediaPromptCurationRequest(input: {
    sourcePrompt: string;
    generatedAssetType: GeneratedAssetType;
    mode: string;
  }): string {
    const assetLabel =
      input.generatedAssetType === "gif"
        ? "animated GIF"
        : input.generatedAssetType === "pdf"
          ? "PDF file"
          : input.generatedAssetType === "csv"
            ? "CSV file"
            : input.generatedAssetType === "code"
              ? "code file"
              : input.generatedAssetType === "md"
                ? "markdown file"
                : input.generatedAssetType === "txt"
                  ? "text file"
                  : input.generatedAssetType === "file"
                    ? "file"
                    : "image";
    const rules = [
      "- Do not include wrappers like \"Generate an image of\".",
      "- Do not mention social-app internals, APIs, tools, or instructions.",
      "- Keep it concrete, visual/technical, and production-ready.",
      "- Preserve user intent and style.",
    ];
    if (input.generatedAssetType === "gif") {
      rules.push(
        "- For GIF output include explicit animation direction and motion beats.",
        "- Include exact output size 256x256 and keep the main subject centered.",
        "- Favor a seamless loop and avoid tiny unreadable details.",
      );
    }
    return [
      "You are Clawdbot prompt-crafter for media/file generation.",
      `Target output type: ${assetLabel}.`,
      `Execution mode: ${input.mode}.`,
      "Rewrite the user request into one high-quality generator prompt.",
      "Return strict JSON only with exactly this shape: {\"prompt\":\"...\"}.",
      "Rules:",
      ...rules,
      `User request: ${input.sourcePrompt}`,
    ].join("\n");
  }

  private async curateMediaPromptWithOpenClaw(input: {
    sourcePrompt: string;
    generatedAssetType: GeneratedAssetType;
    mode: string;
  }): Promise<string> {
    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) {
      throw new Error("prompt_curation_unavailable");
    }
    const curationPrompt = this.buildMediaPromptCurationRequest(input);
    const result = await runOpenClawPrompt({
      prompt: curationPrompt,
      purpose: "media_prompt_curation",
    });
    const curatedPrompt =
      (result
        ? this.extractCuratedMediaPromptFromUnknown(result.parsed) ??
          this.extractCuratedMediaPromptFromUnknown(result.payloadText) ??
          this.extractCuratedMediaPromptFromUnknown(result.raw)
        : null) ?? null;
    if (!curatedPrompt || curatedPrompt.trim().length < 8) {
      await this.ctx.memory
        .recordWrite({
          type: "media_prompt_curation_failed",
          at: nowIso(),
          mode: input.mode,
          generatedAssetType: input.generatedAssetType,
          sourcePrompt: truncateText(input.sourcePrompt, 220),
          reason: "openclaw_no_usable_prompt",
        })
        .catch(() => undefined);
      throw new Error("prompt_curation_failed");
    }
    await this.ctx.memory
      .recordWrite({
        type: "media_prompt_curated",
        at: nowIso(),
        mode: input.mode,
        generatedAssetType: input.generatedAssetType,
        sourcePrompt: truncateText(input.sourcePrompt, 220),
        curatedPrompt: truncateText(curatedPrompt, 360),
      })
      .catch(() => undefined);
    return curatedPrompt;
  }

  private resolveMediaGeneratorBaseUrl(): string | null {
    const explicit = asNonEmptyString(process.env.MG_AGENT_MEDIA_GENERATOR_BASE_URL);
    if (explicit) {
      return explicit.replace(/\/+$/u, "");
    }
    const portRaw = asNonEmptyString(process.env.PW_PORT);
    if (portRaw) {
      const port = Number.parseInt(portRaw, 10);
      if (Number.isFinite(port) && port > 0 && port <= 65535) {
        return `http://127.0.0.1:${port}`;
      }
    }
    return MEDIA_GENERATOR_DEFAULT_BASE_URL;
  }

  private extractMediaGeneratorContextId(payload: unknown): string | null {
    if (!isRecord(payload)) return null;
    const direct = asNonEmptyString(payload.contextId);
    if (direct) return direct;
    const context = isRecord(payload.context) ? payload.context : null;
    if (!context) return null;
    return asNonEmptyString(context.id);
  }

  private extractMediaGeneratorContextRecord(payload: unknown): Record<string, unknown> | null {
    if (!isRecord(payload)) return null;
    const nested = isRecord(payload.context) ? payload.context : null;
    if (nested) return nested;
    const hasContextShape =
      payload.status !== undefined ||
      payload.streamEvents !== undefined ||
      payload.savedFiles !== undefined ||
      payload.observedOutputFiles !== undefined;
    return hasContextShape ? payload : null;
  }

  private isTerminalMediaGeneratorStatus(status: string | null): boolean {
    if (!status) return false;
    const normalized = status.trim().toLowerCase();
    return (
      normalized === "done" ||
      normalized === "completed" ||
      normalized === "complete" ||
      normalized === "success" ||
      normalized === "failed" ||
      normalized === "error" ||
      normalized === "cancelled" ||
      normalized === "canceled"
    );
  }

  private parseMediaGenerationProgress(
    payload: unknown,
    timedOut: boolean,
  ): MediaGenerationProgress {
    const context = this.extractMediaGeneratorContextRecord(payload);
    const contextId =
      this.extractMediaGeneratorContextId(payload) ??
      (context ? asNonEmptyString(context.id) : null);
    const contextStatus = context ? asNonEmptyString(context.status) : null;
    const streamEvents = context ? toUnknownArray(context.streamEvents) : [];
    const streamFrames: MediaGeneratorStreamFrame[] = [];
    let latestPreviewUrl: string | null = null;

    for (const rawEntry of streamEvents) {
      if (!isRecord(rawEntry)) continue;
      const sourceFileName =
        asNonEmptyString(rawEntry.sourceFileName) ??
        asNonEmptyString(rawEntry.file_name);
      const streamPartIndexFromName =
        sourceFileName && STREAM_PART_INDEX_PATTERN.test(sourceFileName)
          ? Number.parseInt(
              STREAM_PART_INDEX_PATTERN.exec(sourceFileName)?.[1] ?? "",
              10,
            )
          : null;
      const streamPartIndexRaw =
        typeof rawEntry.streamPartIndex === "number" &&
        Number.isFinite(rawEntry.streamPartIndex)
          ? Math.max(0, Math.floor(rawEntry.streamPartIndex))
          : streamPartIndexFromName !== null && Number.isFinite(streamPartIndexFromName)
            ? Math.max(0, Math.floor(streamPartIndexFromName))
            : null;
      const isStreamPartFromName =
        sourceFileName !== null && this.isStreamPartArtifactReference(sourceFileName);
      const isStreamPart =
        rawEntry.isStreamPart === true ||
        (typeof streamPartIndexRaw === "number" && Number.isFinite(streamPartIndexRaw)) ||
        isStreamPartFromName;
      const isFinalStreamFrame =
        rawEntry.isFinalStreamFrame === true ||
        rawEntry.streamIsFinalFrame === true ||
        (sourceFileName !== null && !isStreamPartFromName);
      const previewCandidate =
        asNonEmptyString(rawEntry.previewUrl) ??
        asNonEmptyString(rawEntry.url) ??
        asNonEmptyString(rawEntry.resolvedUrl) ??
        asNonEmptyString(rawEntry.fileUrl) ??
        asNonEmptyString(rawEntry.mediaUrl) ??
        asNonEmptyString(rawEntry.outputUrl) ??
        asNonEmptyString(rawEntry.downloadUrl) ??
        asNonEmptyString(rawEntry.dataUri);
      const previewUrl =
        previewCandidate &&
        (isHttpUrl(previewCandidate) || isDataUri(previewCandidate))
          ? previewCandidate
          : null;
      if (previewUrl) {
        latestPreviewUrl = previewUrl;
      }
      const outputPath =
        asNonEmptyString(rawEntry.outputPath) ??
        asNonEmptyString(rawEntry.savedOutputPath) ??
        asNonEmptyString(rawEntry.path);
      const metadataId = asNonEmptyString(rawEntry.metadataId);
      const source = asNonEmptyString(rawEntry.source);
      if (!previewUrl && !sourceFileName && !outputPath && !isStreamPart && !isFinalStreamFrame) {
        continue;
      }
      streamFrames.push({
        sourceFileName,
        isStreamPart,
        streamPartIndex:
          typeof streamPartIndexRaw === "number" && Number.isFinite(streamPartIndexRaw)
            ? streamPartIndexRaw
            : null,
        isFinalStreamFrame,
        previewUrl,
        outputPath,
        metadataId,
        source,
      });
    }

    const latestFromFinalFrame =
      [...streamFrames]
        .reverse()
        .find((entry) => entry.isFinalStreamFrame && typeof entry.previewUrl === "string")
        ?.previewUrl ?? null;
    const latestFromAnyFrame =
      [...streamFrames]
        .reverse()
        .map((entry) => entry.previewUrl)
        .find((entry): entry is string => typeof entry === "string" && entry.length > 0) ?? null;
    const latestPreview =
      latestFromFinalFrame ??
      latestFromAnyFrame ??
      latestPreviewUrl ??
      (context
        ? asNonEmptyString(context.latestPreviewUrl) ??
          asNonEmptyString(context.previewUrl)
        : null);
    const streamFrameCount = streamFrames.length;
    const hasFinalStreamFrame = streamFrames.some((entry) => entry.isFinalStreamFrame);
    const latestStreamFrameIndex = streamFrameCount > 0 ? streamFrameCount - 1 : null;
    const revealBase = 1 - Math.exp(-streamFrameCount * 0.45);
    const streamRevealProgress = hasFinalStreamFrame
      ? 1
      : Math.min(0.92, Number(revealBase.toFixed(3)));
    return {
      contextId,
      contextStatus,
      latestPreviewUrl: latestPreview,
      streamFrameCount,
      latestStreamFrameIndex,
      hasFinalStreamFrame,
      streamRevealProgress,
      streamFrames,
      timedOut,
    };
  }

  private mediaGenerationProgressFingerprint(progress: MediaGenerationProgress): string {
    return [
      progress.contextId ?? "",
      progress.contextStatus ?? "",
      progress.latestPreviewUrl ?? "",
      progress.streamFrameCount,
      progress.latestStreamFrameIndex ?? "",
      progress.hasFinalStreamFrame ? "1" : "0",
      progress.streamRevealProgress,
      progress.timedOut ? "1" : "0",
    ].join("|");
  }

  private async runMediaGeneratorViaHttp(input: {
    prompt: string;
    generatedAssetType: GeneratedAssetType;
    requestDir: string;
    referenceFiles: string[];
    timeoutMs: number;
    stream: boolean;
    onProgress?: ((progress: MediaGenerationProgress) => Promise<void> | void) | undefined;
  }): Promise<{ payload: unknown; timedOut: boolean } | null> {
    const baseUrl = this.resolveMediaGeneratorBaseUrl();
    if (!baseUrl) return null;
    const useFileGenerator = input.generatedAssetType !== "image";
    const streamEnabled = !useFileGenerator && input.stream === true;
    const requiresFinalStreamFrame = streamEnabled;
    const requestBody: Record<string, unknown> = {
      prompt: input.prompt,
      command: useFileGenerator ? "generateFile" : "generateImage",
      mode: useFileGenerator ? "file" : "image",
      stream: streamEnabled,
      sync: false,
      count: 1,
      dir: input.requestDir,
    };
    if (input.referenceFiles.length > 0) {
      requestBody.files = input.referenceFiles;
    }
    if (useFileGenerator) {
      requestBody.type = input.generatedAssetType === "gif" ? "gif" : "file";
    }

    const hasFinalArtifactInList = (value: unknown): boolean => {
      const items = toUnknownArray(value);
      for (const item of items) {
        const direct =
          asNonEmptyString(item) ??
          (isRecord(item)
            ? asNonEmptyString(item.outputPath) ??
              asNonEmptyString(item.savedOutputPath) ??
              asNonEmptyString(item.path) ??
              asNonEmptyString(item.fileUrl) ??
              asNonEmptyString(item.mediaUrl) ??
              asNonEmptyString(item.outputUrl) ??
              asNonEmptyString(item.downloadUrl) ??
              asNonEmptyString(item.url)
            : null);
        if (!direct) continue;
        if (!this.isStreamPartArtifactReference(direct)) return true;
      }
      return false;
    };

    const controller = new AbortController();
    const openTimeout = setTimeout(
      () => controller.abort(),
      Math.max(5_000, Math.min(MEDIA_GENERATOR_OPEN_TIMEOUT_MS, input.timeoutMs)),
    );
    let payload: unknown = null;
    try {
      const response = await fetch(`${baseUrl}/open`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const text = await response.text();
      payload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
      if (!response.ok) {
        await this.ctx.memory
          .recordWrite({
            type: "media_generation_service_http_failed",
            at: nowIso(),
            status: response.status,
            generatedAssetType: input.generatedAssetType,
          })
          .catch(() => undefined);
        return null;
      }
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "media_generation_service_unavailable",
          at: nowIso(),
          generatedAssetType: input.generatedAssetType,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return null;
    } finally {
      clearTimeout(openTimeout);
    }

    const emitProgress = async (
      progressPayload: unknown,
      timedOut: boolean,
      previousFingerprint: string | null,
    ): Promise<string | null> => {
      if (!input.onProgress) return previousFingerprint;
      const progress = this.parseMediaGenerationProgress(progressPayload, timedOut);
      const fingerprint = this.mediaGenerationProgressFingerprint(progress);
      if (fingerprint === previousFingerprint) return previousFingerprint;
      try {
        await input.onProgress(progress);
      } catch {
        // Ignore progress callback failures.
      }
      return fingerprint;
    };

    let latestPayload: unknown = payload;
    let latestFingerprint: string | null = await emitProgress(
      latestPayload,
      false,
      null,
    );
    const contextId = this.extractMediaGeneratorContextId(payload);
    if (!contextId) {
      return { payload: latestPayload, timedOut: false };
    }

    const deadlineMs = Date.now() + Math.max(5_000, input.timeoutMs);
    while (Date.now() <= deadlineMs) {
      try {
        const response = await fetch(
          `${baseUrl}/context?id=${encodeURIComponent(contextId)}`,
        );
        const text = await response.text();
        const contextPayload = text.length > 0 ? (JSON.parse(text) as unknown) : null;
        if (!response.ok) {
          await sleep(MEDIA_GENERATOR_POLL_MS);
          continue;
        }
        latestPayload = contextPayload;
        const progress = this.parseMediaGenerationProgress(contextPayload, false);
        latestFingerprint = await emitProgress(latestPayload, false, latestFingerprint);
        const context = this.extractMediaGeneratorContextRecord(contextPayload);
        const status = context ? asNonEmptyString(context.status) : null;
        const savedFiles = toUnknownArray(context?.savedFiles);
        const observedOutputFiles = toUnknownArray(context?.observedOutputFiles);
        const savedFilesCount = savedFiles.length;
        const observedOutputFilesCount = observedOutputFiles.length;
        const hasArtifacts = savedFilesCount > 0 || observedOutputFilesCount > 0;
        const hasFinalStreamFrame = progress.hasFinalStreamFrame;
        const hasFinalStreamArtifact = progress.streamFrames.some(
          (frame) =>
            frame.isFinalStreamFrame &&
            typeof frame.outputPath === "string" &&
            frame.outputPath.trim().length > 0,
        );
        const hasFinalArtifactFile =
          hasFinalArtifactInList(savedFiles) || hasFinalArtifactInList(observedOutputFiles);
        const resolvedCandidate =
          this.extractMediaSourceFromParsedOutput(contextPayload, input.requestDir, {
            requireFinalStreamFrame: requiresFinalStreamFrame,
          }) ?? null;
        const hasTerminalStatus = this.isTerminalMediaGeneratorStatus(status);
        const generationReady = requiresFinalStreamFrame
          ? hasFinalStreamFrame ||
            hasFinalStreamArtifact ||
            hasFinalArtifactFile ||
            Boolean(resolvedCandidate) ||
            hasTerminalStatus
          : useFileGenerator
            ? hasArtifacts || hasTerminalStatus
            : Boolean(resolvedCandidate);
        if (generationReady) {
          return { payload: latestPayload, timedOut: false };
        }
      } catch {
        // keep polling until timeout
      }
      await sleep(MEDIA_GENERATOR_POLL_MS);
    }

    latestFingerprint = await emitProgress(latestPayload, true, latestFingerprint);
    return {
      payload: latestPayload,
      timedOut: true,
    };
  }

  private async generateAndUploadMediaFromPrompt(
    prompt: string,
    opts?: {
      generatedAssetType?: GeneratedAssetType;
      mode?: string;
      referenceInputs?: string[];
      maxReferenceInputs?: number;
      keepOriginal?: boolean;
      commandId?: string | null;
      skipPromptCuration?: boolean;
      onProgress?: ((progress: MediaGenerationProgress) => Promise<void> | void) | undefined;
    },
  ): Promise<ResolvedMediaUpload> {
    const sourcePrompt = prompt.trim();
    if (!sourcePrompt.length) {
      throw new Error("missing_prompt");
    }
    const generatedAssetType = opts?.generatedAssetType ?? "image";
    const mode = opts?.mode ?? "media_generation";
    const streamEnabled =
      generatedAssetType === "image" && /^chat_/iu.test(mode);
    const commandId = asNonEmptyString(opts?.commandId) ?? null;
    const skipPromptCuration = opts?.skipPromptCuration === true;
    this.pruneCuratedPromptCaches();
    let curatedPromptBase: string;
    if (skipPromptCuration) {
      curatedPromptBase = sourcePrompt;
    } else {
      const cacheKey = commandId
        ? this.buildCuratedMediaPromptCacheKey({
            commandId,
            sourcePrompt,
            generatedAssetType,
            mode,
          })
        : null;
      const cached = cacheKey ? this.curatedMediaPromptCache.get(cacheKey) : null;
      if (cached) {
        curatedPromptBase = cached.prompt;
      } else {
        curatedPromptBase = await this.curateMediaPromptWithOpenClaw({
          sourcePrompt,
          generatedAssetType,
          mode,
        });
        if (cacheKey) {
          this.curatedMediaPromptCache.set(cacheKey, {
            prompt: curatedPromptBase,
            cachedAtMs: Date.now(),
          });
        }
      }
    }
    const curatedPrompt =
      generatedAssetType === "gif"
        ? constrainGifPromptTo256(curatedPromptBase)
        : curatedPromptBase;
    const useFileGenerator = generatedAssetType !== "image";
    const template = useFileGenerator
      ? this.ctx.config.fileGenerateCmd
      : this.ctx.config.imageGenerateCmd;
    if (!template?.trim().length) {
      throw new Error(
        useFileGenerator
          ? "file_generator_unconfigured"
          : "image_generator_unconfigured",
      );
    }
    const requestDir = path.join(
      this.ctx.ipcPaths.generatedDir,
      `generate-${Date.now()}-${crypto.randomUUID()}`,
    );
    await ensureDir(requestDir);

    const promptFilePath = path.join(requestDir, "prompt.txt");
    const outputPath = path.join(
      requestDir,
      `output.${outputExtensionForGeneratedAssetType(generatedAssetType)}`,
    );
    await fs.writeFile(promptFilePath, `${curatedPrompt}\n`, "utf8").catch(() => undefined);
    const referenceInputs = Array.isArray(opts?.referenceInputs)
      ? opts.referenceInputs.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
      : [];
    const referenceFiles = await this.materializeMediaReferenceFiles({
      requestDir,
      referenceInputs,
      ...(typeof opts?.maxReferenceInputs === "number"
        ? { maxReferenceInputs: opts.maxReferenceInputs }
        : {}),
    });

    const refs =
      process.platform === "win32"
        ? {
            prompt: "%MG_IMAGE_PROMPT%",
            dir: "%MG_IMAGE_PROMPT_DIR%",
            output: "%MG_IMAGE_OUTPUT%",
            promptFile: "%MG_IMAGE_PROMPT_FILE%",
            files: "%MG_IMAGE_FILES%",
            type: "%MG_IMAGE_TYPE%",
          }
        : {
            prompt: "$MG_IMAGE_PROMPT",
            dir: "$MG_IMAGE_PROMPT_DIR",
            output: "$MG_IMAGE_OUTPUT",
            promptFile: "$MG_IMAGE_PROMPT_FILE",
            files: "$MG_IMAGE_FILES",
            type: "$MG_IMAGE_TYPE",
          };
    let command = template
      .replaceAll("{prompt}", refs.prompt)
      .replaceAll("{dir}", refs.dir)
      .replaceAll("{output}", refs.output)
      .replaceAll("{prompt_file}", refs.promptFile)
      .replaceAll("{files}", refs.files)
      .replaceAll("{type}", refs.type)
      .trim();
    if (referenceFiles.length === 0) {
      command = stripEmptyFilesFlag(command, refs.files);
    }
    if (!command.includes(refs.prompt)) {
      command = `${command} "${refs.prompt}"`.trim();
    }

    await this.ctx.memory.recordWrite({
      type: "image_generation_invoked",
      at: nowIso(),
      provider: "command",
      mode,
      generatedAssetType,
      sourcePromptChars: sourcePrompt.length,
      promptChars: curatedPrompt.length,
      referenceInputCount: referenceInputs.length,
      referenceFileCount: referenceFiles.length,
      commandPreview: command.slice(0, 240),
    }).catch(() => undefined);

    const serviceRun = await this.runMediaGeneratorViaHttp({
      prompt: curatedPrompt,
      generatedAssetType,
      requestDir,
      referenceFiles,
      timeoutMs: this.ctx.config.imageGenerateTimeoutMs,
      stream: streamEnabled,
      onProgress: streamEnabled ? opts?.onProgress : undefined,
    });
    const execResult = serviceRun
      ? {
          ok: true,
          stdout: JSON.stringify(serviceRun.payload),
          stderr: "",
          error: null,
          timedOut: serviceRun.timedOut,
        }
      : await this.runShellCommand(command, {
          MG_IMAGE_PROMPT: curatedPrompt,
          MG_IMAGE_PROMPT_DIR: requestDir,
          MG_IMAGE_OUTPUT: outputPath,
          MG_IMAGE_PROMPT_FILE: promptFilePath,
          MG_IMAGE_FILES: referenceFiles.join(","),
          MG_IMAGE_TYPE: generatedAssetType,
        });
    if (!execResult.ok) {
      const reason = execResult.timedOut
        ? `image_generation_timeout_after_${this.ctx.config.imageGenerateTimeoutMs}ms`
        : execResult.error ?? execResult.stderr ?? "image_generation_failed";
      await this.ctx.memory.recordWrite({
        type: "image_generation_failed",
        at: nowIso(),
        provider: "command",
        reason: String(reason).slice(0, 600),
      }).catch(() => undefined);
      throw new Error(String(reason));
    }

    const parsedGeneratorOutput = parseJsonFromMixedText(execResult.stdout);
    const hadGenerationActivity = this.didMediaGenerationProduceActivity(parsedGeneratorOutput);
    const resolvedSource = await this.resolveGeneratedMediaSourceWithRetry({
      requestDir,
      outputPath,
      stdout: execResult.stdout,
      maxWaitMs: Math.min(
        30_000,
        Math.max(3_000, Math.floor(this.ctx.config.imageGenerateTimeoutMs / 10)),
      ),
      requireFinalStreamFrame: generatedAssetType === "image" && streamEnabled,
    });
    if (!resolvedSource) {
      if (!hadGenerationActivity) {
        throw new Error("no_media_url_without_generation_activity");
      }
      throw new Error("no_media_url");
    }
    try {
      return await this.uploadResolvedMediaSource(resolvedSource, {
        keepOriginal: opts?.keepOriginal === true,
      });
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      await this.ctx.memory
        .recordWrite({
          type: "image_generation_source_missing_retrying",
          at: nowIso(),
          mode,
          generatedAssetType,
          sourcePreview: truncateText(resolvedSource, 260),
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      const retrySource = await this.resolveGeneratedMediaSourceWithRetry({
        requestDir,
        outputPath,
        stdout: execResult.stdout,
        maxWaitMs: 12_000,
        requireFinalStreamFrame: generatedAssetType === "image" && streamEnabled,
      });
      if (!retrySource) {
        throw error;
      }
      return this.uploadResolvedMediaSource(retrySource, {
        keepOriginal: opts?.keepOriginal === true,
      });
    }
  }

  private async resolveGeneratedMediaSourceWithRetry(input: {
    requestDir: string;
    outputPath: string;
    stdout: string;
    maxWaitMs: number;
    requireFinalStreamFrame?: boolean;
  }): Promise<string | null> {
    const deadlineMs = Date.now() + Math.max(0, Math.floor(input.maxWaitMs));
    let lastMissingStableCandidate: string | null = null;
    do {
      const candidate = await this.resolveGeneratedMediaSource({
        requestDir: input.requestDir,
        outputPath: input.outputPath,
        stdout: input.stdout,
        requireFinalStreamFrame: input.requireFinalStreamFrame === true,
      });
      if (candidate) {
        if (isHttpUrl(candidate) || isDataUri(candidate)) {
          if (!this.isStreamPartArtifactReference(candidate)) {
            return candidate;
          }
        } else {
          const absolute = path.isAbsolute(candidate)
            ? candidate
            : path.resolve(input.requestDir, candidate);
          if (!this.isStreamPartArtifactReference(absolute)) {
            const exists = await fs
              .access(absolute)
              .then(() => true)
              .catch(() => false);
            if (exists) {
              return absolute;
            }
            lastMissingStableCandidate = absolute;
          }
        }
      }
      if (Date.now() >= deadlineMs) {
        return lastMissingStableCandidate;
      }
      await sleep(300);
    } while (true);
  }

  private async resolveGeneratedMediaSource(input: {
    requestDir: string;
    outputPath: string;
    stdout: string;
    requireFinalStreamFrame: boolean;
  }): Promise<string | null> {
    const outputExists = await fs
      .access(input.outputPath)
      .then(() => true)
      .catch(() => false);
    if (outputExists) return input.outputPath;

    const parsed = parseJsonFromMixedText(input.stdout);
    const fromParsed = this.extractMediaSourceFromParsedOutput(
      parsed,
      input.requestDir,
      {
        requireFinalStreamFrame: input.requireFinalStreamFrame,
      },
    );
    if (fromParsed) return fromParsed;

    const discovered = await this.findFirstMediaFile(input.requestDir, 3);
    if (discovered) return discovered;
    return null;
  }

  private isFinalStreamFrameEntry(entry: Record<string, unknown>): boolean {
    const sourceFileName =
      asNonEmptyString(entry.sourceFileName) ??
      asNonEmptyString(entry.file_name);
    const isStreamPartFromName =
      sourceFileName !== null && this.isStreamPartArtifactReference(sourceFileName);
    return (
      entry.isFinalStreamFrame === true ||
      entry.streamIsFinalFrame === true ||
      (sourceFileName !== null && !isStreamPartFromName)
    );
  }

  private summarizeStreamEventsFinality(value: unknown): {
    hasEvents: boolean;
    hasFinalStreamFrame: boolean;
  } {
    const events = toUnknownArray(value);
    if (events.length === 0) {
      return {
        hasEvents: false,
        hasFinalStreamFrame: false,
      };
    }
    let hasFinalStreamFrame = false;
    for (const rawEntry of events) {
      if (!isRecord(rawEntry)) continue;
      if (this.isFinalStreamFrameEntry(rawEntry)) {
        hasFinalStreamFrame = true;
        break;
      }
    }
    return {
      hasEvents: true,
      hasFinalStreamFrame,
    };
  }

  private extractMediaSourceFromParsedOutput(
    parsed: unknown,
    requestDir: string,
    options?: {
      requireFinalStreamFrame?: boolean;
    },
  ): string | null {
    const requireFinalStreamFrame = options?.requireFinalStreamFrame === true;
    const resolveCandidate = (
      value: unknown,
      opts?: {
        allowStreamPart?: boolean;
      },
    ): string | null => {
      const candidate = asNonEmptyString(value);
      if (!candidate) return null;
      const allowStreamPart = opts?.allowStreamPart === true;
      if (!allowStreamPart && this.isStreamPartArtifactReference(candidate)) return null;
      if (isDataUri(candidate)) {
        const parsed = parseDataUriPayload(candidate);
        if (!parsed || !this.isUploadableMediaMimeType(parsed.mime)) {
          return null;
        }
        return candidate;
      }
      if (isHttpUrl(candidate)) {
        const inferredMime = inferMimeTypeFromUrl(candidate);
        if (
          inferredMime &&
          inferredMime !== "application/octet-stream" &&
          !this.isUploadableMediaMimeType(inferredMime)
        ) {
          return null;
        }
        return candidate;
      }
      const absolute = path.isAbsolute(candidate)
        ? candidate
        : path.resolve(requestDir, candidate);
      const inferredMime = extToMime(absolute);
      if (
        inferredMime !== "application/octet-stream" &&
        !this.isUploadableMediaMimeType(inferredMime)
      ) {
        return null;
      }
      if (!allowStreamPart && this.isStreamPartArtifactReference(absolute)) return null;
      return absolute;
    };
    const scanArtifactArray = (value: unknown): string | null => {
      const items = toUnknownArray(value);
      if (items.length === 0) return null;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const entry = items[i];
        const direct = resolveCandidate(entry);
        if (direct) return direct;
        if (!isRecord(entry)) continue;
        const resolved = resolveCandidate(
          asNonEmptyString(entry.outputPath) ??
            asNonEmptyString(entry.savedOutputPath) ??
            asNonEmptyString(entry.path) ??
            asNonEmptyString(entry.lastOutputPath) ??
            asNonEmptyString(entry.lastOutputFile) ??
            asNonEmptyString(entry.latestOutputPath) ??
            asNonEmptyString(entry.latestOutputFile) ??
            asNonEmptyString(entry.fileUrl) ??
            asNonEmptyString(entry.mediaUrl) ??
            asNonEmptyString(entry.outputUrl) ??
            asNonEmptyString(entry.downloadUrl) ??
            asNonEmptyString(entry.resolvedUrl) ??
            asNonEmptyString(entry.url),
        );
        if (resolved) return resolved;
      }
      return null;
    };
    const arrayKeys = [
      "savedFiles",
      "observedOutputFiles",
      "files",
      "outputFiles",
    ];
    const hasStableArtifactArrays = (value: Record<string, unknown>): boolean => {
      for (const key of arrayKeys) {
        if (scanArtifactArray(value[key])) {
          return true;
        }
      }
      return false;
    };

    const hasTerminalStatus = (value: unknown): boolean =>
      isRecord(value) &&
      this.isTerminalMediaGeneratorStatus(asNonEmptyString(value.status));

    const resolveFromStreamEvents = (
      value: unknown,
    ): {
      resolved: string | null;
      hasEvents: boolean;
      hasFinalStreamFrame: boolean;
    } => {
      const events = toUnknownArray(value);
      if (events.length === 0) {
        return {
          resolved: null,
          hasEvents: false,
          hasFinalStreamFrame: false,
        };
      }
      const resolveFromEntry = (
        entry: Record<string, unknown>,
      ): {
        resolved: string | null;
        finalFramePreview: string | null;
        finalFrameRelaxed: string | null;
        isFinalStreamFrame: boolean;
      } => {
        const sourceFileName =
          asNonEmptyString(entry.sourceFileName) ??
          asNonEmptyString(entry.file_name);
        const isStreamPartFromName =
          sourceFileName !== null && this.isStreamPartArtifactReference(sourceFileName);
        const hasExplicitFinalStreamFrameFlag =
          entry.isFinalStreamFrame === true || entry.streamIsFinalFrame === true;
        const isFinalStreamFrame =
          hasExplicitFinalStreamFrameFlag ||
          (sourceFileName !== null && !isStreamPartFromName);
        const artifactCandidates: unknown[] = [
          entry.outputPath,
          entry.savedOutputPath,
          entry.path,
          entry.lastOutputPath,
          entry.lastOutputFile,
          entry.fileUrl,
          entry.mediaUrl,
          entry.outputUrl,
          entry.downloadUrl,
        ];
        for (const candidate of artifactCandidates) {
          const resolved = resolveCandidate(candidate);
          if (resolved) {
            return {
              resolved,
              finalFramePreview: null,
              finalFrameRelaxed: null,
              isFinalStreamFrame,
            };
          }
        }
        const finalFramePreviewCandidates: unknown[] =
          isFinalStreamFrame
            ? [
                entry.previewUrl,
                entry.resolvedUrl,
                entry.url,
                entry.dataUri,
              ]
            : [];
        for (const candidate of finalFramePreviewCandidates) {
          const resolved = resolveCandidate(candidate);
          if (resolved) {
            return {
              resolved: null,
              finalFramePreview: resolved,
              finalFrameRelaxed: null,
              isFinalStreamFrame,
            };
          }
        }
        if (requireFinalStreamFrame && hasExplicitFinalStreamFrameFlag) {
          for (const candidate of artifactCandidates) {
            const resolved = resolveCandidate(candidate, { allowStreamPart: true });
            if (resolved) {
              return {
                resolved: null,
                finalFramePreview: null,
                finalFrameRelaxed: resolved,
                isFinalStreamFrame,
              };
            }
          }
          for (const candidate of finalFramePreviewCandidates) {
            const resolved = resolveCandidate(candidate, { allowStreamPart: true });
            if (resolved) {
              return {
                resolved: null,
                finalFramePreview: null,
                finalFrameRelaxed: resolved,
                isFinalStreamFrame,
              };
            }
          }
        }
        return {
          resolved: null,
          finalFramePreview: null,
          finalFrameRelaxed: null,
          isFinalStreamFrame,
        };
      };
      let hasFinalStreamFrame = false;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const entry = events[i];
        if (!isRecord(entry)) continue;
        const resolved = resolveFromEntry(entry);
        if (resolved.isFinalStreamFrame) {
          hasFinalStreamFrame = true;
        }
        if (resolved.isFinalStreamFrame && resolved.resolved) {
          return {
            resolved: resolved.resolved,
            hasEvents: true,
            hasFinalStreamFrame,
          };
        }
        if (resolved.isFinalStreamFrame && resolved.finalFramePreview) {
          return {
            resolved: resolved.finalFramePreview,
            hasEvents: true,
            hasFinalStreamFrame,
          };
        }
        if (resolved.isFinalStreamFrame && resolved.finalFrameRelaxed) {
          return {
            resolved: resolved.finalFrameRelaxed,
            hasEvents: true,
            hasFinalStreamFrame,
          };
        }
      }
      if (requireFinalStreamFrame) {
        return {
          resolved: null,
          hasEvents: true,
          hasFinalStreamFrame,
        };
      }
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const entry = events[i];
        if (!isRecord(entry)) continue;
        const resolved = resolveFromEntry(entry);
        if (resolved.isFinalStreamFrame) {
          hasFinalStreamFrame = true;
        }
        if (resolved.resolved) {
          if (!resolved.isFinalStreamFrame && isHttpUrl(resolved.resolved)) {
            continue;
          }
          return {
            resolved: resolved.resolved,
            hasEvents: true,
            hasFinalStreamFrame,
          };
        }
      }
      return {
        resolved: null,
        hasEvents: true,
        hasFinalStreamFrame,
      };
    };

    if (!isRecord(parsed)) return null;
    const streamResolved = resolveFromStreamEvents(parsed.streamEvents);
    if (streamResolved.resolved) return streamResolved.resolved;
    const rootTerminalStatus = hasTerminalStatus(parsed);
    const parsedContext = isRecord(parsed.context) ? parsed.context : null;
    const hasStableRootArtifactArrays = hasStableArtifactArrays(parsed);
    const allowTopLevelFallback =
      !requireFinalStreamFrame ||
      !streamResolved.hasEvents ||
      streamResolved.hasFinalStreamFrame ||
      rootTerminalStatus ||
      hasTerminalStatus(parsedContext) ||
      hasStableRootArtifactArrays;
    const urlKeys = [
      "lastOutputPath",
      "latestOutputPath",
      "lastOutputFile",
      "latestOutputFile",
      "finalOutputPath",
      "finalOutputFile",
      "outputPath",
      "savedOutputPath",
      "savedPath",
      "url",
      "resolvedUrl",
      "mediaUrl",
      "outputUrl",
      "fileUrl",
      "downloadUrl",
      "imageUrl",
    ];
    if (allowTopLevelFallback) {
      for (const key of arrayKeys) {
        const resolved = scanArtifactArray(parsed[key]);
        if (resolved) return resolved;
      }
      for (const key of urlKeys) {
        const resolved = resolveCandidate(parsed[key]);
        if (resolved) return resolved;
      }
    }

    const context = parsedContext;
    if (context) {
      const contextStreamResolved = resolveFromStreamEvents(context.streamEvents);
      if (contextStreamResolved.resolved) return contextStreamResolved.resolved;
      const contextTerminalStatus = hasTerminalStatus(context);
      const hasStableContextArtifactArrays = hasStableArtifactArrays(context);
      const allowContextFallback =
        !requireFinalStreamFrame ||
        !contextStreamResolved.hasEvents ||
        contextStreamResolved.hasFinalStreamFrame ||
        contextTerminalStatus ||
        hasStableContextArtifactArrays;
      if (allowContextFallback) {
        for (const key of arrayKeys) {
          const resolved = scanArtifactArray(context[key]);
          if (resolved) return resolved;
        }
      }
      const keepAlive =
        allowContextFallback && isRecord(context.keepAlive) ? context.keepAlive : null;
      if (allowContextFallback && keepAlive) {
        for (const key of urlKeys) {
          const resolved = resolveCandidate(keepAlive[key]);
          if (resolved) return resolved;
        }
      }
      if (allowContextFallback) {
        for (const key of urlKeys) {
          const resolved = resolveCandidate(context[key]);
          if (resolved) return resolved;
        }
      }
    }

    if (Array.isArray(parsed.runs)) {
      for (const run of parsed.runs) {
        if (!isRecord(run)) continue;
        const runStreamResolved = resolveFromStreamEvents(run.streamEvents);
        if (runStreamResolved.resolved) return runStreamResolved.resolved;
        const runTerminalStatus = hasTerminalStatus(run);
        const hasStableRunArtifactArrays = hasStableArtifactArrays(run);
        const allowRunFallback =
          !requireFinalStreamFrame ||
          !runStreamResolved.hasEvents ||
          runStreamResolved.hasFinalStreamFrame ||
          runTerminalStatus ||
          hasStableRunArtifactArrays;
        if (allowRunFallback) {
          for (const key of arrayKeys) {
            const resolved = scanArtifactArray(run[key]);
            if (resolved) return resolved;
          }
          for (const key of urlKeys) {
            const resolved = resolveCandidate(run[key]);
            if (resolved) return resolved;
          }
        }
        const runContext = isRecord(run.context) ? run.context : null;
        if (runContext) {
          const runContextStreamResolved = resolveFromStreamEvents(runContext.streamEvents);
          if (runContextStreamResolved.resolved) return runContextStreamResolved.resolved;
          const runContextTerminalStatus = hasTerminalStatus(runContext);
          const hasStableRunContextArtifactArrays = hasStableArtifactArrays(runContext);
          const allowRunContextFallback =
            !requireFinalStreamFrame ||
            !runContextStreamResolved.hasEvents ||
            runContextStreamResolved.hasFinalStreamFrame ||
            runContextTerminalStatus ||
            hasStableRunContextArtifactArrays;
          if (allowRunContextFallback) {
            for (const key of arrayKeys) {
              const resolved = scanArtifactArray(runContext[key]);
              if (resolved) return resolved;
            }
          }
          const runKeepAlive = isRecord(runContext.keepAlive)
            ? runContext.keepAlive
            : null;
          if (allowRunContextFallback && runKeepAlive) {
            for (const key of urlKeys) {
              const resolved = resolveCandidate(runKeepAlive[key]);
              if (resolved) return resolved;
            }
          }
          if (allowRunContextFallback) {
            for (const key of urlKeys) {
              const resolved = resolveCandidate(runContext[key]);
              if (resolved) return resolved;
            }
          }
        }
      }
    }
    return null;
  }

  private async findFirstMediaFile(dirPath: string, maxDepth: number): Promise<string | null> {
    const walk = async (currentPath: string, depth: number): Promise<string | null> => {
      if (depth < 0) return null;
      const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
      const fileEntries = entries.filter(
        (entry) => entry.isFile() && MEDIA_FILE_RE.test(entry.name),
      );
      const stableCandidates = fileEntries.filter(
        (entry) => !this.isStreamPartArtifactReference(entry.name),
      );
      const pickNewestPath = async (candidates: typeof fileEntries): Promise<string | null> => {
        if (candidates.length === 0) return null;
        const withMtime = await Promise.all(
          candidates.map(async (entry) => {
            const filePath = path.join(currentPath, entry.name);
            const stat = await fs.stat(filePath).catch(() => null);
            return {
              filePath,
              mtimeMs:
                stat && Number.isFinite(stat.mtimeMs)
                  ? stat.mtimeMs
                  : Number.NEGATIVE_INFINITY,
            };
          }),
        );
        withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return withMtime[0]?.filePath ?? null;
      };
      const stablePath = await pickNewestPath(stableCandidates);
      if (stablePath) return stablePath;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nested = await walk(path.join(currentPath, entry.name), depth - 1);
        if (nested) return nested;
      }
      return null;
    };
    return walk(dirPath, maxDepth);
  }

  private async runShellCommand(
    command: string,
    extraEnv: Record<string, string>,
  ): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    error: string | null;
    timedOut: boolean;
  }> {
    return await new Promise((resolve) => {
      const child = spawn(command, {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...extraEnv,
        },
      });
      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 5_000);
      }, this.ctx.config.imageGenerateTimeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutParts.push(String(chunk));
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrParts.push(String(chunk));
      });
      child.on("error", (error: unknown) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const message = error instanceof Error ? error.message : String(error);
        resolve({
          ok: false,
          stdout: stdoutParts.join(""),
          stderr: stderrParts.join(""),
          error: message,
          timedOut,
        });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        resolve({
          ok: code === 0 && !timedOut,
          stdout: stdoutParts.join(""),
          stderr: stderrParts.join(""),
          error: null,
          timedOut,
        });
      });
    });
  }

  private buildDeterministicChatClientMessageId(input: {
    prefix: string;
    stableKey: string;
  }): string {
    const normalizedPrefix = input.prefix
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/gu, "_")
      .slice(0, 32);
    const fallbackPrefix = normalizedPrefix.length > 0 ? normalizedPrefix : "runtime_chat";
    const digest = crypto
      .createHash("sha256")
      .update(input.stableKey)
      .digest("hex")
      .slice(0, 32);
    return `${fallbackPrefix}_${digest}`;
  }

  private resolveChatProcessingClientMessageId(command: Command): string | null {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return null;
    const sourceContext = asNonEmptyString(payload.sourceContext)?.toLowerCase() ?? "";
    const chatContext = isRecord(payload.chatContext) ? payload.chatContext : null;
    if (sourceContext !== "chat" && !chatContext) return null;
    const chatCommandName = this.resolveChatCommandName(payload);
    if ((chatCommandName?.trim().toLowerCase() ?? "") === "agent-decide") {
      return null;
    }
    if (payload.chatLiteralGenerate === true || payload.chatLiteralGenerate === "true") {
      return null;
    }
    if (payload.requireDraftOnly === true || payload.requireDraftOnly === "true") {
      return null;
    }
    return this.buildDeterministicChatClientMessageId({
      prefix: "runtime_chat_progress",
      stableKey: command.id,
    });
  }

  private buildChatProcessingIndicator(command: Command): {
    body: string;
    metadata: Record<string, unknown>;
  } | null {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) return null;
    const commandName = this.resolveChatCommandName(payload) ?? command.kind;
    const normalizedName = commandName.trim().toLowerCase();
    const shortName = normalizedName.startsWith("write.")
      ? normalizedName.slice("write.".length)
      : normalizedName.startsWith("brain.")
        ? normalizedName.slice("brain.".length)
        : normalizedName;
    const previewType =
      shortName.includes("follow")
        ? "follow"
        : shortName.includes("repost")
          ? "repost"
          : shortName.includes("vote") || shortName.includes("like")
            ? "like"
            : "command";
    const summary =
      shortName.length > 0
        ? `Running ${shortName.replace(/[_-]+/gu, " ")}.`
        : "Running your request.";
    return {
      body: "Working on that now.",
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        actionPreview: {
          type: previewType,
          status: "processing",
          title: "In progress",
          summary,
          commandId: command.id,
          commandName,
        },
      },
    };
  }

  private async emitChatProcessingIndicator(command: Command): Promise<boolean> {
    const callAgentChatBridge = this.ctx.callAgentChatBridge;
    if (!callAgentChatBridge) return false;
    const chatTarget = resolveChatTargetFromPayload(command.payload);
    if (!chatTarget) return false;
    const processingClientMessageId = this.resolveChatProcessingClientMessageId(command);
    if (!processingClientMessageId) return false;
    const processingIndicator = this.buildChatProcessingIndicator(command);
    if (!processingIndicator) return false;
    const route = chatTarget.conversationId
      ? { conversationId: chatTarget.conversationId }
      : { channelId: chatTarget.channelId };
    try {
      await callAgentChatBridge({
        action: "send_message",
        clientMessageId: processingClientMessageId,
        ...route,
        body: clampPublishText(processingIndicator.body, 1200),
        format: "markdown",
        metadata: processingIndicator.metadata,
      });
      await this.ctx.memory
        .recordWrite({
          type: "chat_command_processing_sent",
          at: nowIso(),
          commandId: command.id,
          kind: command.kind,
          targetConversationId: chatTarget.conversationId ?? null,
          targetChannelId: chatTarget.channelId ?? null,
        })
        .catch(() => undefined);
      return true;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "chat_command_processing_send_failed",
          at: nowIso(),
          commandId: command.id,
          kind: command.kind,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return false;
    }
  }

  private sanitizeUserFacingCommandErrorMessage(input: {
    errorMessage: string;
  }): string {
    const raw = input.errorMessage.trim();
    if (!raw.length) return "";
    const lowered = raw.toLowerCase();

    if (
      lowered.includes("no_media_url") ||
      lowered.includes("media_generation_waiting_for_output")
    ) {
      return "I did not receive a final media asset yet.";
    }
    if (
      lowered.includes("prompt_curation_failed") ||
      lowered.includes("prompt_curation_unavailable") ||
      lowered.includes("openclaw_no_usable_prompt") ||
      lowered.includes("invalid json") ||
      lowered.includes("json parse")
    ) {
      return "I could not produce a valid generation draft for that request.";
    }
    if (lowered.includes("persona_reference_setup_required")) {
      return "Persona reference setup is incomplete (selfie, midshot, fullbody).";
    }
    if (
      lowered.includes("image_generation_setup_required") ||
      lowered.includes("image_generator_unconfigured") ||
      lowered.includes("file_generator_unconfigured")
    ) {
      return "Image generation is not ready yet.";
    }
    if (
      lowered.includes("owner capability denied") ||
      lowered.includes("permission denied") ||
      lowered.includes("not_granted") ||
      lowered.includes("no_grant")
    ) {
      return "I do not currently have permission for that action.";
    }
    if (
      lowered.includes("only image and video uploads are supported") ||
      lowered.includes("unsupported_media_payload_mime")
    ) {
      return "The generated media format was not uploadable.";
    }
    if (
      /\b(runtime|bridge|directive|queue|openclaw|edenai|playwright|chatgpt|api|session token|agent key)\b/iu.test(
        raw,
      )
    ) {
      return "I hit an internal processing issue while handling that request.";
    }
    return raw;
  }

  private buildNonWriteChatCompletion(input: {
    command: Command;
    outcome: CommandOutcome;
  }): { body: string; metadata: Record<string, unknown> } | null {
    const payload = isRecord(input.command.payload) ? input.command.payload : null;
    const commandName = payload ? this.resolveChatCommandName(payload) ?? input.command.kind : input.command.kind;
    const suppressCommandActionPreview =
      commandName.trim().toLowerCase() === "agent-decide";
    const data = isRecord(input.outcome.data) ? input.outcome.data : null;
    const explicitCompletion = data && isRecord(data.chatCompletion)
      ? data.chatCompletion
      : null;
    const explicitBody = asNonEmptyString(explicitCompletion?.body);
    if (explicitBody) {
      const explicitMetadata = isRecord(explicitCompletion?.metadata)
        ? explicitCompletion.metadata
        : null;
      const sanitizedExplicitMetadata =
        suppressCommandActionPreview && explicitMetadata
          ? (() => {
              const { actionPreview: _ignoredActionPreview, ...rest } = explicitMetadata;
              return rest;
            })()
          : explicitMetadata;
      return {
        body: explicitBody,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          ...(sanitizedExplicitMetadata ?? {}),
        },
      };
    }

    if (!payload) return null;
    const errorMessageRaw = input.outcome.error?.message?.trim() ?? "";
    const errorMessage = this.sanitizeUserFacingCommandErrorMessage({
      errorMessage: errorMessageRaw,
    });
    if (!input.outcome.ok) {
      return {
        body: errorMessage.length > 0
          ? `I couldn't complete that ${commandName} request: ${errorMessage}`
          : `I couldn't complete that ${commandName} request.`,
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          ...(suppressCommandActionPreview
            ? {}
            : {
                actionPreview: {
                  type: "command",
                  status: "failed",
                  title: "Command failed",
                  summary: commandName,
                  ...(errorMessage.length > 0
                    ? { error: truncateText(errorMessage, 240) }
                    : {}),
                },
              }),
        },
      };
    }

    const executedAll = Array.isArray(data?.executed) ? data.executed : [];
    const executedApplied = executedAll.filter((entry) => {
      if (!isRecord(entry)) return true;
      return entry.skipped !== true;
    });
    const skippedExecutionEntries = executedAll.filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.skipped === true,
    );
    const skippedDraftEntries = Array.isArray(data?.skippedDrafts)
      ? data.skippedDrafts.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    const failedDraftEntries = Array.isArray(data?.failedDrafts)
      ? data.failedDrafts.filter((entry): entry is Record<string, unknown> => isRecord(entry))
      : [];
    const executedCount = executedApplied.length;
    const skippedCount = skippedExecutionEntries.length + skippedDraftEntries.length;
    const failedCount = failedDraftEntries.length;
    const skippedDecisionReasons = Array.from(
      new Set(
        skippedExecutionEntries
          .map((entry) => asNonEmptyString(entry.decision)?.toLowerCase() ?? null)
          .filter((entry): entry is string => Boolean(entry)),
      ),
    ).slice(0, 4);
    const skippedReasonSuffix =
      skippedDecisionReasons.length > 0
        ? ` (${skippedDecisionReasons.join(", ")})`
        : " due to unavailable grant budget or action constraints";
    const readHandleList = (value: unknown): string[] =>
      Array.from(
        new Set(
          (Array.isArray(value) ? value : [])
            .map((entry) =>
              asNonEmptyString(entry)
                ?.replace(/^@+/u, "")
                .toLowerCase() ?? null,
            )
            .filter((entry): entry is string => Boolean(entry)),
        ),
      );
    const followedHandles = readHandleList(data?.followedHandles);
    const alreadyFollowedHandles = readHandleList(data?.alreadyFollowedHandles);
    const failedHandles = readHandleList(data?.failedHandles);
    const normalizeKindForSummary = (value: string): string => {
      const normalized = value.trim().toLowerCase();
      if (normalized.startsWith("write.")) {
        return normalized.slice("write.".length);
      }
      if (normalized.startsWith("brain.")) {
        return normalized.slice("brain.".length);
      }
      return normalized;
    };
    const executedKinds = Array.from(
      new Set(
        executedApplied
          .map((entry) =>
            isRecord(entry) ? asNonEmptyString(entry.kind) : null,
          )
          .filter((entry): entry is string => Boolean(entry))
          .map((entry) => normalizeKindForSummary(entry)),
      ),
    );
    const resolveActionLabel = (entry: Record<string, unknown>): string | null => {
      const explicit = asNonEmptyString(entry.action)?.trim().toLowerCase() ?? null;
      if (explicit) return explicit;
      const kind = asNonEmptyString(entry.kind);
      if (!kind) return null;
      const normalizedKind = normalizeKindForSummary(kind);
      if (normalizedKind.includes("comment")) return "comment";
      if (normalizedKind.includes("vote") || normalizedKind === "like") return "like";
      if (normalizedKind.includes("repost")) return "repost";
      return normalizedKind;
    };
    const executedTargetDetails = executedApplied
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const action = resolveActionLabel(entry);
        if (!action) return null;
        const postId = asPositiveInt(entry.postId);
        const commentId =
          asPositiveInt(entry.commentId) ??
          asPositiveInt(entry.parentId) ??
          null;
        return {
          action,
          postId,
          commentId,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          action: string;
          postId: number | null;
          commentId: number | null;
        } => Boolean(entry),
      );
    const summarizeExecutedTargets = (
      action: "comment" | "like" | "repost",
      label: string,
    ): string | null => {
      const matches = executedTargetDetails.filter(
        (entry) => entry.action === action && entry.postId !== null,
      );
      if (matches.length === 0) return null;
      if (action === "comment") {
        const formatted = matches.slice(0, 5).map((entry) => {
          const postRef = `#${entry.postId}`;
          if (entry.commentId && entry.commentId > 0) {
            return `${postRef} (reply #${entry.commentId})`;
          }
          return postRef;
        });
        return `${label}: ${formatted.join(", ")}${matches.length > 5 ? ` (+${matches.length - 5} more)` : ""}.`;
      }
      const uniquePostIds = Array.from(
        new Set(matches.map((entry) => entry.postId).filter((id): id is number => id !== null)),
      );
      if (uniquePostIds.length === 0) return null;
      return `${label}: ${uniquePostIds
        .slice(0, 6)
        .map((id) => `#${id}`)
        .join(", ")}${uniquePostIds.length > 6 ? ` (+${uniquePostIds.length - 6} more)` : ""}.`;
    };
    const executedTargetSummaries = [
      summarizeExecutedTargets("like", "Likes"),
      summarizeExecutedTargets("comment", "Comments"),
      summarizeExecutedTargets("repost", "Reposts"),
    ].filter((entry): entry is string => entry !== null);
    let summary = "Done.";
    if (
      followedHandles.length > 0 ||
      alreadyFollowedHandles.length > 0 ||
      failedHandles.length > 0
    ) {
      const parts: string[] = [];
      if (followedHandles.length > 0) {
        parts.push(
          `Followed: ${followedHandles
            .slice(0, 8)
            .map((entry) => `@${entry}`)
            .join(", ")}${followedHandles.length > 8 ? ` (+${followedHandles.length - 8} more)` : ""}.`,
        );
      }
      if (alreadyFollowedHandles.length > 0) {
        parts.push(
          `Already followed: ${alreadyFollowedHandles
            .slice(0, 8)
            .map((entry) => `@${entry}`)
            .join(", ")}${alreadyFollowedHandles.length > 8 ? ` (+${alreadyFollowedHandles.length - 8} more)` : ""}.`,
        );
      }
      if (failedHandles.length > 0) {
        parts.push(
          `Could not follow: ${failedHandles
            .slice(0, 8)
            .map((entry) => `@${entry}`)
            .join(", ")}${failedHandles.length > 8 ? ` (+${failedHandles.length - 8} more)` : ""}.`,
        );
      }
      summary = parts.length > 0 ? parts.join(" ") : summary;
    } else if (executedCount > 0 && executedKinds.length > 0) {
      summary =
        `Done. Executed ${executedCount} action${executedCount === 1 ? "" : "s"}: ${executedKinds.slice(0, 4).join(", ")}${executedKinds.length > 4 ? ` (+${executedKinds.length - 4} more)` : ""}.`;
      if (skippedCount > 0) {
        summary += ` Skipped ${skippedCount}${skippedReasonSuffix}.`;
      }
      if (failedCount > 0) {
        summary += ` Failed ${failedCount} action${failedCount === 1 ? "" : "s"} during execution.`;
      }
      if (executedTargetSummaries.length > 0) {
        summary += ` ${executedTargetSummaries.join(" ")}`;
      }
    } else if (executedCount > 0) {
      summary = `Done. Executed ${executedCount} action${executedCount === 1 ? "" : "s"}.`;
      if (skippedCount > 0) {
        summary += ` Skipped ${skippedCount}${skippedReasonSuffix}.`;
      }
      if (failedCount > 0) {
        summary += ` Failed ${failedCount} action${failedCount === 1 ? "" : "s"} during execution.`;
      }
      if (executedTargetSummaries.length > 0) {
        summary += ` ${executedTargetSummaries.join(" ")}`;
      }
    } else if (skippedCount > 0 && failedCount > 0) {
      summary =
        `No actions were executed. Skipped ${skippedCount} and failed ${failedCount} during execution.`;
    } else if (skippedCount > 0) {
      summary =
        `No actions were executed. Skipped ${skippedCount}${skippedReasonSuffix}.`;
    } else if (failedCount > 0) {
      summary =
        `No actions were executed. Failed ${failedCount} action${failedCount === 1 ? "" : "s"} during execution.`;
    }
    return {
      body: summary,
      metadata: {
        automated: true,
        sourceContext: "CHAT",
        ...(suppressCommandActionPreview
          ? {}
          : {
              actionPreview: {
                type: "command",
                status: "success",
                title: "Command completed",
                summary: commandName,
                detail: summary,
                executedCount,
                skippedCount,
                failedCount,
                ...(executedKinds.length > 0 ? { executedKinds } : {}),
                ...(executedTargetDetails.length > 0
                  ? { executedTargets: executedTargetDetails.slice(0, 16) }
                  : {}),
                ...(followedHandles.length > 0 ? { followedHandles } : {}),
                ...(alreadyFollowedHandles.length > 0
                  ? { alreadyFollowedHandles }
                  : {}),
                ...(failedHandles.length > 0 ? { failedHandles } : {}),
                ...(failedDraftEntries.length > 0
                  ? {
                      failedDrafts: failedDraftEntries
                        .map((entry) => ({
                          kind: asNonEmptyString(entry.kind),
                          reason: asNonEmptyString(entry.reason),
                          code: asNonEmptyString(entry.code),
                        }))
                        .filter(
                          (entry): entry is {
                            kind: string | null;
                            reason: string | null;
                            code: string | null;
                          } => entry.reason !== null,
                        )
                        .slice(0, 12),
                    }
                  : {}),
              },
            }),
      },
    };
  }

  private async sendNonWriteChatCompletion(input: {
    command: Command;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<boolean> {
    if (!this.ctx.callAgentChatBridge) return false;
    const chatTarget = resolveChatTargetFromPayload(input.command.payload);
    if (!chatTarget) return false;
    const route = chatTarget.conversationId
      ? { conversationId: chatTarget.conversationId }
      : { channelId: chatTarget.channelId };
    const processingClientMessageId = this.resolveChatProcessingClientMessageId(input.command);
    if (processingClientMessageId) {
      try {
        await this.ctx.callAgentChatBridge({
          action: "edit_message",
          clientMessageId: processingClientMessageId,
          ...route,
          body: clampPublishText(input.body, 1200),
          metadata: input.metadata,
        });
        await this.ctx.memory
          .recordWrite({
            type: "chat_command_result_edited",
            at: nowIso(),
            commandId: input.command.id,
            kind: input.command.kind,
            ok: true,
            targetConversationId: chatTarget.conversationId ?? null,
            targetChannelId: chatTarget.channelId ?? null,
          })
          .catch(() => undefined);
        return true;
      } catch {
        // Fallback to sending a dedicated terminal message when progress message edit is unavailable.
      }
    }
    const clientMessageId = this.buildDeterministicChatClientMessageId({
      prefix: "runtime_chat_result",
      stableKey: input.command.id,
    });
    try {
      await this.ctx.callAgentChatBridge({
        action: "send_message",
        clientMessageId,
        ...route,
        body: clampPublishText(input.body, 1200),
        format: "markdown",
        metadata: input.metadata,
      });
      await this.ctx.memory
        .recordWrite({
          type: "chat_command_result_sent",
          at: nowIso(),
          commandId: input.command.id,
          kind: input.command.kind,
          ok: true,
          targetConversationId: chatTarget.conversationId ?? null,
          targetChannelId: chatTarget.channelId ?? null,
        })
        .catch(() => undefined);
      return true;
    } catch (error: unknown) {
      await this.ctx.memory
        .recordWrite({
          type: "chat_command_result_send_failed",
          at: nowIso(),
          commandId: input.command.id,
          kind: input.command.kind,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      return false;
    }
  }

  private async emitChatOutcome(command: Command, outcome: CommandOutcome): Promise<boolean> {
    const payload = isRecord(command.payload) ? command.payload : null;
    const chatTarget = resolveChatTargetFromPayload(payload ?? null);
    if (!chatTarget) {
      const sourceContext = asNonEmptyString(payload?.sourceContext)?.toLowerCase() ?? "";
      if (sourceContext === "chat" || isRecord(payload?.chatContext)) {
        await this.recordCommandLifecycleCheckpoint({
          command,
          stage: "chat_delivery",
          status: "failed",
          message: "chat_target_missing",
          metadata: {
            mode: "terminal_delivery",
          },
        });
      }
      return false;
    }
    const route = chatTarget.conversationId
      ? { conversationId: chatTarget.conversationId }
      : { channelId: chatTarget.channelId };
    const outcomeData = isRecord(outcome.data) ? outcome.data : null;
    const chatDeliveryHandled = outcomeData?.chatDeliveryHandled === true;
    const outcomeMode = asNonEmptyString(outcomeData?.mode)?.toLowerCase() ?? "";
    const outcomeErrorMessage = asNonEmptyString(outcome.error?.message) ?? "";
    const literalGenerateDeliveryOwned =
      payload?.chatLiteralGenerate === true ||
      payload?.chatLiteralGenerate === "true" ||
      outcomeMode === "chat_literal_generate" ||
      /literal generate delivery failed:/iu.test(outcomeErrorMessage);

    if (literalGenerateDeliveryOwned) {
      if (outcomeData?.chatDeliveryCheckpointRecorded === true) {
        return chatDeliveryHandled;
      }
      let delivered = chatDeliveryHandled;
      let fallbackUsed = false;
      if (!delivered) {
        // Try editing the existing preview card first to avoid a stuck "processing" card
        // alongside a separate terminal message.  The preview card clientMessageId is
        // deterministic: `runtime_generate_${command.id}`.
        const chatContext = isRecord(payload?.chatContext) ? payload.chatContext : null;
        const previewClientMessageId =
          asNonEmptyString(chatContext?.processingClientMessageId) ??
          asNonEmptyString(chatContext?.previewClientMessageId) ??
          `runtime_generate_${command.id}`;
        const completion = this.buildNonWriteChatCompletion({ command, outcome });
        if (completion && this.ctx.callAgentChatBridge) {
          try {
            await this.ctx.callAgentChatBridge({
              action: "edit_message",
              clientMessageId: previewClientMessageId,
              ...route,
              body: clampPublishText(completion.body, 1200),
              metadata: completion.metadata,
            });
            delivered = true;
          } catch {
            // Preview card edit failed; fall through to fresh message fallback.
          }
        }
        if (!delivered && completion) {
          fallbackUsed = true;
          delivered = await this.sendNonWriteChatCompletion({
            command,
            body: completion.body,
            metadata: completion.metadata,
          });
        }
      }
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "chat_delivery",
        status: delivered ? "ok" : "failed",
        message: delivered ? null : "chat_preview_delivery_failed",
        metadata: {
          mode: "chat_literal_generate_preview",
          outcomeOk: outcome.ok,
          usedFallback: fallbackUsed,
        },
      });
      return delivered;
    }

    if (payload?.requireDraftOnly === true && chatDeliveryHandled) {
      if (outcomeData?.chatDeliveryCheckpointRecorded === true) {
        return true;
      }
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "chat_delivery",
        status: "ok",
        metadata: {
          mode: "draft_preview",
          outcomeOk: outcome.ok,
        },
      });
      return true;
    }

    const kind = command.kind.trim().toLowerCase();
    if (kind.startsWith("write.")) {
      let fallbackUsed = false;
      const callAgentChatBridge = this.ctx.callAgentChatBridge;
      let delivered = await sendChatResultMessageFromOutcome({
        command,
        outcome,
        chatTarget,
        deps: {
          callAgentChatBridge:
            callAgentChatBridge ??
            (async () => {
              throw new Error("chat_bridge_unavailable");
            }),
          memory: this.ctx.memory,
        },
      });
      if (!delivered) {
        const fallbackCompletion = this.buildNonWriteChatCompletion({ command, outcome });
        if (fallbackCompletion) {
          fallbackUsed = true;
          delivered = await this.sendNonWriteChatCompletion({
            command,
            body: fallbackCompletion.body,
            metadata: fallbackCompletion.metadata,
          });
        }
      }
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "chat_delivery",
        status: delivered ? "ok" : "failed",
        message: delivered ? null : "chat_result_send_failed",
        metadata: {
          mode: "write_outcome",
          usedFallback: fallbackUsed,
        },
      });
      return delivered;
    }

    const completion = this.buildNonWriteChatCompletion({ command, outcome });
    if (!completion) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "chat_delivery",
        status: "failed",
        message: "chat_completion_unavailable",
        metadata: {
          mode: "non_write_terminal",
        },
      });
      return false;
    }
    const delivered = await this.sendNonWriteChatCompletion({
      command,
      body: completion.body,
      metadata: completion.metadata,
    });
    await this.recordCommandLifecycleCheckpoint({
      command,
      stage: "chat_delivery",
      status: delivered ? "ok" : "failed",
      message: delivered ? null : "chat_result_send_failed",
      metadata: {
        mode: "non_write_terminal",
      },
    });
    return delivered;
  }

  private buildDraftPreviewPayload(drafts: GeneratedDraft[]): DraftPreviewPayload | null {
    const previewParts: string[] = [];
    let firstPostKind: "post" | "thread" = "post";
    let mode: "thread" | "carousel" = "thread";
    let slideCount = 1;

    const resolveMediaUrlFromDraft = (draftPayload: Record<string, unknown>): string | null => {
      const direct = asNonEmptyString(draftPayload.mediaUrl);
      if (direct) return direct;
      const mediaItems = Array.isArray(draftPayload.mediaItems) ? draftPayload.mediaItems : [];
      for (const item of mediaItems) {
        if (!isRecord(item)) continue;
        const itemUrl = asNonEmptyString(item.mediaUrl) ?? asNonEmptyString(item.url);
        if (itemUrl) return itemUrl;
      }
      return null;
    };

    const resolveMediaItemCount = (draftPayload: Record<string, unknown>): number => {
      const mediaItems = Array.isArray(draftPayload.mediaItems) ? draftPayload.mediaItems : [];
      return mediaItems.filter((entry) => isRecord(entry)).length;
    };

    const addPreviewPart = (value: string | null): void => {
      if (!value) return;
      const normalized = stripEmDashCharacters(value).trim();
      if (!normalized.length) return;
      previewParts.push(normalized);
    };

    for (const draft of drafts.slice(0, 5)) {
      const action = draft.action.trim().toLowerCase();
      if (action === "post") {
        const postType = asNonEmptyString(draft.payload.postType)?.toLowerCase();
        const textBody =
          asNonEmptyString(draft.payload.textBody) ??
          asNonEmptyString(draft.payload.body) ??
          asNonEmptyString(draft.payload.text);
        const caption =
          asNonEmptyString(draft.payload.caption) ??
          asNonEmptyString(draft.payload.title);
        const imagePrompt =
          asNonEmptyString(draft.payload.imagePrompt) ??
          asNonEmptyString(draft.payload.mediaPrompt) ??
          asNonEmptyString(draft.payload.prompt);
        const mediaUrl = resolveMediaUrlFromDraft(draft.payload);
        const mediaItemCount = resolveMediaItemCount(draft.payload);
        if (postType === "text" && textBody) {
          addPreviewPart(textBody);
          firstPostKind = "post";
          continue;
        }

        if (textBody || caption || imagePrompt || mediaUrl) {
          const composed = [textBody, caption, imagePrompt ? `Image prompt: ${imagePrompt}` : null]
            .filter((entry): entry is string => Boolean(entry))
            .join("\n");
          addPreviewPart(
            composed.length > 0
              ? composed
              : mediaUrl
                ? "Post draft with attached media is ready for review."
                : "Post draft is ready for review.",
          );
          firstPostKind = "post";
          if (postType === "media" || imagePrompt || mediaUrl || mediaItemCount > 0) {
            mode = "carousel";
            slideCount = Math.max(slideCount, mediaItemCount > 1 ? mediaItemCount : 2);
          }
          continue;
        }
      }
      if (action === "story") {
        const caption = asNonEmptyString(draft.payload.caption);
        const imagePrompt =
          asNonEmptyString(draft.payload.imagePrompt) ??
          asNonEmptyString(draft.payload.mediaPrompt) ??
          asNonEmptyString(draft.payload.prompt);
        const mediaUrl = resolveMediaUrlFromDraft(draft.payload);
        const composed = [caption, imagePrompt ? `Image prompt: ${imagePrompt}` : null]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n");
        addPreviewPart(
          composed.length > 0
            ? composed
            : mediaUrl
              ? "Story draft with media is ready for review."
              : "Story draft is ready for review.",
        );
        firstPostKind = "post";
        if (imagePrompt || mediaUrl) {
          mode = "carousel";
          slideCount = Math.max(slideCount, 2);
        }
        continue;
      }
      if (action === "comment") {
        const body =
          asNonEmptyString(draft.payload.body) ??
          asNonEmptyString(draft.payload.text) ??
          asNonEmptyString(draft.payload.caption);
        addPreviewPart(body ?? "Comment draft is ready for review.");
        firstPostKind = "thread";
        continue;
      }
      if (action === "like") {
        const reason = asNonEmptyString(draft.payload.reason);
        addPreviewPart(reason ? `Like draft: ${reason}` : "Like action draft is ready.");
      }
    }

    if (previewParts.length === 0) {
      const actionSummary = drafts
        .slice(0, 3)
        .map((entry) => entry.action.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
        .join(", ");
      if (!actionSummary.length) return null;
      previewParts.push(`Draft ready for review (${actionSummary}).`);
    }
    const draftPreviewText = previewParts.join("\n\n").slice(0, 2500);
    const summary = clampPublishText(draftPreviewText, 220);
    return {
      body: `Draft ready for review:\n\n${draftPreviewText}`,
      summary,
      draftPreviewText,
      draftPostKind: firstPostKind,
      draftMode: mode,
      draftSlideCount: slideCount,
    };
  }

  private async sendDraftPreviewMessage(input: {
    payload: Record<string, unknown>;
    preview: DraftPreviewPayload;
  }): Promise<boolean> {
    if (!this.ctx.callAgentChatBridge) return false;
    const chatTarget = resolveChatTargetFromPayload(input.payload);
    if (!chatTarget) return false;
    try {
      await this.ctx.callAgentChatBridge({
        action: "send_message",
        clientMessageId: `runtime_draft_result_${Date.now().toString(36)}_${crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 10)}`,
        ...(chatTarget.conversationId
          ? { conversationId: chatTarget.conversationId }
          : { channelId: chatTarget.channelId }),
        body: input.preview.body,
        format: "markdown",
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          draftPreviewText: input.preview.draftPreviewText,
          draftPostKind: input.preview.draftPostKind,
          draftMode: input.preview.draftMode,
          draftSlideCount: input.preview.draftSlideCount,
          actionPreview: {
            type: "draft",
            status: "success",
            title: "Draft ready",
            summary: input.preview.summary,
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async sendDraftFailureMessage(input: {
    payload: Record<string, unknown>;
    message: string;
  }): Promise<boolean> {
    if (!this.ctx.callAgentChatBridge) return false;
    const chatTarget = resolveChatTargetFromPayload(input.payload);
    if (!chatTarget) return false;
    try {
      await this.ctx.callAgentChatBridge({
        action: "send_message",
        clientMessageId: `runtime_draft_error_${Date.now().toString(36)}_${crypto
          .randomUUID()
          .replaceAll("-", "")
          .slice(0, 10)}`,
        ...(chatTarget.conversationId
          ? { conversationId: chatTarget.conversationId }
          : { channelId: chatTarget.channelId }),
        body: input.message,
        format: "markdown",
        metadata: {
          automated: true,
          sourceContext: "CHAT",
          actionPreview: {
            type: "draft",
            status: "failed",
            title: "Draft failed",
            error: input.message,
          },
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async updateAvatar(
    input: Record<string, unknown> & { target: string; imageUrl: string },
  ): Promise<unknown> {
    return await this.agent().updateAvatar.mutate(input);
  }

  private async updateBanner(
    input: Record<string, unknown> & { target: string; bannerUrl: string },
  ): Promise<unknown> {
    return await this.agent().updateBanner.mutate(input);
  }

  // ---------------------------------------------------------------------------
  // Review command – content moderation review via LLM
  // ---------------------------------------------------------------------------

  private async executeReview(command: Command): Promise<CommandOutcome> {
    const payload = isRecord(command.payload) ? command.payload : null;
    if (!payload) {
      return this.failedOutcome(command, "Invalid payload for review command.");
    }

    const requestId =
      typeof payload.requestId === "string" ? payload.requestId : null;
    const reviewType =
      typeof payload.reviewType === "string" ? payload.reviewType : null;
    const moderationGuidelines =
      typeof payload.moderationGuidelines === "string"
        ? payload.moderationGuidelines
        : null;

    if (!requestId || !reviewType) {
      return this.failedOutcome(
        command,
        "Review payload missing requestId or reviewType.",
        "review_invalid_payload",
      );
    }

    // Build the text to review from the payload
    const textParts: string[] = [];
    if (typeof payload.newHandle === "string") {
      textParts.push(`Username/handle: @${payload.newHandle}`);
    }
    if (typeof payload.newDisplayName === "string") {
      textParts.push(`Display name: ${payload.newDisplayName}`);
    }
    const textToReview = textParts.join("\n") || "No text provided";

    // Build the LLM prompt using the moderation guidelines from the server
    const systemPrompt = moderationGuidelines ?? [
      "You are a content moderation reviewer.",
      "Evaluate the text for appropriateness. PG-13 acceptable. No racism, profanity, hate speech, or sexually explicit content.",
      'Respond ONLY with JSON: { "verdict": "approve" | "reject", "reason": "brief explanation", "confidence": 0.0-1.0 }',
    ].join("\n");

    const fullPrompt = [
      systemPrompt,
      "",
      "---",
      `Review type: ${reviewType}`,
      `Text to review:`,
      textToReview,
      "---",
      "",
      "Respond with ONLY a JSON object, no other text:",
    ].join("\n");

    // Call the LLM via OpenClaw
    const runOpenClawPrompt = this.ctx.runOpenClawPrompt;
    if (!runOpenClawPrompt) {
      return this.failedOutcome(
        command,
        "OpenClaw prompt runner not available.",
        "review_no_llm",
      );
    }

    try {
      const result = await runOpenClawPrompt({
        prompt: fullPrompt,
        purpose: "content_review",
      });

      if (!result) {
        return this.failedOutcome(
          command,
          "LLM returned no result for review.",
          "review_llm_empty",
        );
      }

      // Parse the verdict from the LLM response
      let verdict: "approve" | "reject" | "abstain" = "abstain";
      let reason = "Could not parse LLM response.";
      let confidence = 0.5;

      const parsed = isRecord(result.parsed) ? result.parsed : null;
      const rawText = result.raw ?? "";

      if (parsed) {
        if (parsed.verdict === "approve" || parsed.verdict === "reject") {
          verdict = parsed.verdict;
        }
        if (typeof parsed.reason === "string") {
          reason = parsed.reason;
        }
        if (typeof parsed.confidence === "number") {
          confidence = Math.max(0, Math.min(1, parsed.confidence));
        }
      } else {
        // Try to extract JSON from the raw text
        const jsonMatch = rawText.match(/\{[^}]*"verdict"\s*:\s*"(approve|reject)"[^}]*\}/);
        if (jsonMatch) {
          try {
            const extracted = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
            if (extracted.verdict === "approve" || extracted.verdict === "reject") {
              verdict = extracted.verdict;
            }
            if (typeof extracted.reason === "string") {
              reason = extracted.reason;
            }
            if (typeof extracted.confidence === "number") {
              confidence = Math.max(0, Math.min(1, extracted.confidence));
            }
          } catch {
            // Fall through with abstain
          }
        }
      }

      // Submit the review verdict to the server
      const serverResult = await this.agent().submitReview.mutate({
        requestId,
        verdict,
        reason,
        confidence,
      });

      await this.ctx.memory
        .recordWrite({
          type: "review_submitted",
          at: nowIso(),
          commandId: command.id,
          requestId,
          reviewType,
          verdict,
          confidence,
        })
        .catch(() => undefined);

      return this.successOutcome(command, {
        requestId,
        verdict,
        reason,
        confidence,
        serverResult,
      });
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.ctx.memory
        .recordWrite({
          type: "review_failed",
          at: nowIso(),
          commandId: command.id,
          requestId,
          reviewType,
          error: errorMessage,
        })
        .catch(() => undefined);

      return this.failedOutcome(
        command,
        `Review execution failed: ${errorMessage}`,
        "review_execution_failed",
      );
    }
  }

  private successOutcome(command: Command, data: unknown): CommandOutcome {
    return {
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: true,
      data,
    };
  }

  private failedOutcome(
    command: Command,
    message: string,
    code?: string,
  ): CommandOutcome {
    return {
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
      grantId: command.grantId,
      ok: false,
      error: {
        message,
        ...(code ? { code } : {}),
      },
    };
  }

  private async finalizeCommandOutcome(input: {
    command: Command;
    outcome: CommandOutcome;
  }): Promise<void> {
    await this.writeOutcome(input.outcome);
    await this.emitChatOutcome(input.command, input.outcome).catch(async (error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.recordCommandLifecycleCheckpoint({
        command: input.command,
        stage: "chat_delivery",
        status: "failed",
        message: errorMessage,
        metadata: {
          mode: "emit_exception",
        },
      });
      const fallbackCompletion = this.buildNonWriteChatCompletion({
        command: input.command,
        outcome: input.outcome,
      });
      if (!fallbackCompletion) return;
      const recovered = await this.sendNonWriteChatCompletion({
        command: input.command,
        body: fallbackCompletion.body,
        metadata: fallbackCompletion.metadata,
      }).catch(() => false);
      await this.recordCommandLifecycleCheckpoint({
        command: input.command,
        stage: "chat_delivery",
        status: recovered ? "ok" : "failed",
        message: recovered ? null : errorMessage,
        metadata: {
          mode: "emit_exception_fallback",
          recovered,
        },
      });
    });
    await this.ackDirectiveForOutcome(input.command, input.outcome).catch(() => undefined);
  }

  private async ackDirectiveForOutcome(
    command: Command,
    outcome: CommandOutcome,
  ): Promise<void> {
    const directiveId =
      this.resolveCommandSourceDirectiveId({
        command,
        payload: isRecord(command.payload) ? command.payload : null,
      }) ??
      asNonEmptyString(command.pendingDirectiveId);
    if (!directiveId?.trim().length) return;
    const executionDigest = buildExecutionDigest(
      command,
      outcome.ok,
      outcome.ok ? null : outcome.error?.message ?? "failed",
    );
    try {
      await this.directiveAckMutator().mutate({
        directiveId,
        status: outcome.ok ? "executed" : "failed",
        kind: command.kind,
        ...(outcome.ok ? {} : { error: outcome.error?.message ?? "Directive failed." }),
        ...(command.actionNonce ? { actionNonce: command.actionNonce } : {}),
        executionDigest,
      });
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "ack_terminal",
        status: "ok",
        metadata: {
          directiveId,
          outcomeOk: outcome.ok,
        },
      });
    } catch (error: unknown) {
      await this.recordCommandLifecycleCheckpoint({
        command,
        stage: "ack_terminal",
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        metadata: {
          directiveId,
          outcomeOk: outcome.ok,
        },
      });
      throw error;
    }
  }

  private async writeOutcome(outcome: CommandOutcome): Promise<void> {
    await appendJsonLine(this.ctx.ipcPaths.resultsPath, outcome).catch(() => undefined);
  }

  private async markQueueItemNotReadyByInbox(
    inboxFile: string,
    reason: string,
  ): Promise<void> {
    const normalizedInboxFile = inboxFile.trim();
    if (!normalizedInboxFile.length) return;
    const normalizedReason = reason.trim().length > 0 ? reason.trim() : "not_ready";

    this.ctx.queue.queueStateMutation = this.ctx.queue.queueStateMutation
      .then(async () => {
        const raw = await readJsonFile(this.ctx.ipcPaths.queueStatePath);
        const state = normalizeQueueState(raw);
        const updatedItems = state.items.map((item) => {
          if (item.inboxFile !== normalizedInboxFile) return item;
          return {
            ...item,
            lastError: normalizedReason,
          };
        });
        const next: QueueState = {
          ...state,
          updatedAt: nowIso(),
          items: updatedItems,
        };
        await writeJsonFile(this.ctx.ipcPaths.queueStatePath, next);
      })
      .catch(() => undefined);

    await this.ctx.queue.queueStateMutation;
  }

  private resolveEngagementActionForCommand(command: Command): "comment" | "like" | "repost" | null {
    const kind = command.kind.trim().toLowerCase();
    if (kind === "write.commentpost" || kind === "write.comment") return "comment";
    if (kind === "write.votepost" || kind === "write.like") return "like";
    if (kind === "write.repostpost" || kind === "write.repost") return "repost";
    if (kind === "brain.generateandqueue" || kind === "brain.plan") {
      const payload = isRecord(command.payload) ? command.payload : null;
      if (!payload) return null;
      const enforced = this.resolveEnforcedDraftAction(payload);
      return enforced ?? null;
    }
    return null;
  }

  private async primeCommandContextForRequeue(
    command: Command,
    reason: string,
  ): Promise<void> {
    const action = this.resolveEngagementActionForCommand(command);
    if (!action) return;
    if (!this.ctx.callAgentChatBridge) return;
    const loweredReason = reason.toLowerCase();
    const shouldPrime =
      loweredReason.includes("no_target") ||
      loweredReason.includes("waiting_for_context") ||
      loweredReason.includes("missing_target_post_context");
    if (!shouldPrime) return;

    const payload = isRecord(command.payload) ? command.payload : {};
    const hints = this.extractEngagementLookupHints(payload);
    const bridgeRequests: Record<string, unknown>[] = [
      { action: "browse_notifications", unreadOnly: true, limit: 24 },
      { action: "browse_notifications", unreadOnly: false, limit: 24 },
      { action: "browse_unanswered_mentions", limit: 24, sinceHours: 24 * 14 },
      { action: "browse_recent_actions", limit: 24 },
      { action: "browse_top_engagers", limit: 12, windowHours: 24 * 14 },
      { action: "browse_home_feed", limit: 24 },
      { action: "browse_trending", limit: 24 },
      { action: "browse_posts", limit: 24 },
    ];
    if (hints.interestTags.length > 0) {
      const tags = hints.interestTags.slice(0, 8);
      bridgeRequests.push(
        { action: "browse_trending", limit: 24, tags },
        { action: "browse_posts", limit: 24, tags },
      );
    }
    if (hints.rawQuery.trim().length > 2) {
      bridgeRequests.push({
        action: "search_global",
        query: truncateText(hints.rawQuery, 220),
        limit: 24,
      });
    }
    if (hints.interestTags.length > 0) {
      const tagQuery = truncateText(hints.interestTags.slice(0, 4).join(" "), 220);
      if (tagQuery.length > 2) {
        bridgeRequests.push({
          action: "search_global",
          query: tagQuery,
          limit: 24,
          includePeople: false,
        });
      }
    }
    if (hints.postId) {
      bridgeRequests.unshift({
        action: "find_post",
        postId: hints.postId,
      });
    }

    const discovered: EngagementTargetCandidate[] = [];
    const seenTargets = new Set<string>();
    for (const request of bridgeRequests) {
      let result: { value: unknown; cacheHit: boolean } | null = null;
      try {
        result = await this.callAgentBridgeLookupCached(request, 5_000);
      } catch {
        result = null;
      }
      if (!result) continue;
      for (const row of this.collectBridgeRecordItems(result.value)) {
        const parsedDirect = this.extractEngagementTargetCandidateFromRecord(
          row,
          "requeue_prime",
        );
        const entityType =
          asNonEmptyString(row.entityType)?.toLowerCase() ??
          asNonEmptyString(row.targetType)?.toLowerCase() ??
          null;
        const entityId =
          asPositiveInt(row.entityId) ??
          asPositiveInt(row.targetId) ??
          null;
        const parsedFallback =
          parsedDirect ??
          (() => {
            const postId =
              asPositiveInt(row.postId) ??
              asPositiveInt(row.targetPostId) ??
              (entityType === "post" ? entityId : null);
            if (!postId) return null;
            const commentId =
              asPositiveInt(row.commentId) ??
              asPositiveInt(row.targetCommentId) ??
              asPositiveInt(row.parentId) ??
              (entityType === "comment" ? entityId : null);
            return {
              postId,
              commentId: action === "comment" ? commentId : null,
              authorId: null,
              source: "requeue_prime",
            } satisfies EngagementTargetCandidate;
          })();
        const parsed = parsedFallback;
        if (!parsed) continue;
        const key = `${parsed.postId}:${parsed.commentId ?? 0}`;
        if (seenTargets.has(key)) continue;
        seenTargets.add(key);
        discovered.push(parsed);
        if (discovered.length >= 24) break;
      }
      if (discovered.length >= 24) break;
    }

    if (!discovered.length) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_context_prime_empty",
          at: nowIso(),
          commandId: command.id,
          action,
          reason,
          query: hints.rawQuery,
        })
        .catch(() => undefined);
      return;
    }

    for (const candidate of discovered.slice(0, 12)) {
      await this.ctx.memory
        .recordWrite({
          type: "engagement_context_seed",
          at: nowIso(),
          commandId: command.id,
          action,
          postId: candidate.postId,
          commentId: candidate.commentId,
          authorId: candidate.authorId,
          source: candidate.source,
          query: hints.rawQuery,
        })
        .catch(() => undefined);
    }

    const cacheSeed = discovered[0] ?? null;
    if (cacheSeed) {
      const cacheKey = this.buildEngagementTargetCacheKey({
        action,
        payload,
        hints,
      });
      this.engagementTargetCache.set(cacheKey, {
        expiresAtMs: Date.now() + ENGAGEMENT_TARGET_CACHE_TTL_MS,
        candidate: {
          ...cacheSeed,
          commentId: action === "comment" ? cacheSeed.commentId : null,
        },
      });
      this.pruneEngagementTargetCache(Date.now());
    }

    await this.ctx.memory
      .recordWrite({
        type: "engagement_context_prime_completed",
        at: nowIso(),
        commandId: command.id,
        action,
        reason,
        discoveredCount: discovered.length,
        query: hints.rawQuery,
      })
      .catch(() => undefined);
  }

  private async markQueueItemCompletedByInbox(
    inboxFile: string,
    status: "done" | "failed" | "missing",
    error: string | null,
  ): Promise<void> {
    const normalizedInboxFile = inboxFile.trim();
    if (!normalizedInboxFile.length) return;

    this.ctx.queue.queueStateMutation = this.ctx.queue.queueStateMutation
      .then(async () => {
        const raw = await readJsonFile(this.ctx.ipcPaths.queueStatePath);
        const state = normalizeQueueState(raw);
        const updatedItems = state.items.map((item) => {
          if (item.inboxFile !== normalizedInboxFile) return item;
          return {
            ...item,
            status,
            completedAt: nowIso(),
            lastError:
              typeof error === "string" && error.trim().length > 0
                ? error.trim()
                : null,
          };
        });
        const next: QueueState = {
          ...state,
          updatedAt: nowIso(),
          items: updatedItems,
        };
        await writeJsonFile(this.ctx.ipcPaths.queueStatePath, next);
      })
      .catch(() => undefined);

    await this.ctx.queue.queueStateMutation;
  }

  private async moveInboxFileToProcessed(
    filePath: string,
    statusSuffix: "done" | "failed" | "invalid" | "rejected",
  ): Promise<void> {
    const base = path.basename(filePath);
    const targetName = `${new Date().toISOString().replaceAll(":", "-")}__${statusSuffix}__${base}`;
    const targetPath = path.join(this.ctx.ipcPaths.processedDir, targetName);
    await ensureDir(this.ctx.ipcPaths.processedDir);
    await fs.rename(filePath, targetPath).catch(async () => {
      const bytes = await fs.readFile(filePath).catch(() => null);
      if (!bytes) return;
      await fs.writeFile(targetPath, bytes).catch(() => undefined);
      await fs.unlink(filePath).catch(() => undefined);
    });
  }
}
