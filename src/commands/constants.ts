/**
 * Constants for the command executor — regex patterns, Sets, limits, theme data.
 */

import type { CommandLifecycleState } from "../state/sqlite-state.js";
import type { PostVarietyMode, TextStyleTheme } from "./types.js";
import { PERSONA_REFERENCE_FRAME_ROLES } from "./types.js";

// ---------------------------------------------------------------------------
// Media & file patterns
// ---------------------------------------------------------------------------

export const MEDIA_FILE_RE = /\.(png|jpe?g|webp|gif|svg|mp4|mov|webm|avif)$/iu;
export const MAX_MEDIA_REFERENCE_INPUTS = 8;
export const MAX_COLLECTED_REFERENCE_INPUTS = 12;

// ---------------------------------------------------------------------------
// Persona constants
// ---------------------------------------------------------------------------

export const REQUIRED_PERSONA_REFERENCE_FRAME_COUNT = PERSONA_REFERENCE_FRAME_ROLES.length;
export const PERSONA_REFERENCE_MAX_SIDE = 640;
export const PERSONA_REFERENCE_JPEG_QUALITY = 62;
export const DEFAULT_MAIN_PERSONA_SLUG = "realistic_core";
export const GENERIC_PERSONA_SLUGS = new Set([
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
export const PERSONA_SELF_REFERENCE_PROMPT_PATTERN =
  /\b(selfie|self[-\s]?portrait|portrait of (?:me|myself)|of me|my face|myself|as me|look like me|my appearance)\b/iu;
export const PERSONA_REQUEST_PROMPT_PATTERN =
  /\b(persona|avatar|identity|character look|appearance)\b/iu;
export const PERSONA_CREATION_REQUEST_PROMPT_PATTERN =
  /\b(?:(?:create|make|build|craft|define|setup|set up|start)\s+(?:a\s+)?(?:new\s+)?(?:persona|avatar|identity|character)|(?:new|another|fresh)\s+(?:persona|avatar|identity|character))\b/iu;
export const PERSONA_VARIANT_PATTERNS: ReadonlyArray<{ key: string; pattern: RegExp }> = [
  { key: "cartoon", pattern: /\b(cartoon|toon|comic)\b/iu },
  { key: "anime", pattern: /\b(anime|manga)\b/iu },
  { key: "meme", pattern: /\b(meme|shitpost)\b/iu },
  { key: "pixel", pattern: /\b(pixel(?:\s*art)?|8[-\s]?bit)\b/iu },
  { key: "clay", pattern: /\b(clay|claymation|stop[-\s]?motion)\b/iu },
  { key: "cinematic", pattern: /\b(cinematic|film(?:ic)?|movie[-\s]?still)\b/iu },
  { key: "cyberpunk", pattern: /\b(cyberpunk|neon[-\s]?noir)\b/iu },
  { key: "vaporwave", pattern: /\b(vaporwave|synthwave)\b/iu },
];

// ---------------------------------------------------------------------------
// Comment patterns
// ---------------------------------------------------------------------------

export const COMMENT_ECHO_PREFIX_PATTERN = /^frame\s*\d+\s*[:.-]/iu;
export const COMMENT_PROMPT_WRAPPER_PATTERN =
  /^(?:generate|create|make|draw|render)\s+(?:an?\s+)?(?:image|gif|avatar|banner|file)\b/iu;
export const COMMENT_TOKEN_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "frame",
  "from", "in", "is", "it", "of", "on", "or", "style", "that",
  "the", "this", "to", "with",
]);

// ---------------------------------------------------------------------------
// Media stream patterns
// ---------------------------------------------------------------------------

export const STREAM_PART_ARTIFACT_PATTERN = /(?:^|[./_-])part(?:[_-]?(?:\d+|x))(?:\D|$)/iu;
export const STREAM_PART_INDEX_PATTERN = /(?:^|[._-])part[_-]?(\d+)(?:\D|$)/iu;
export const TRANSIENT_MEDIA_ARTIFACT_FILENAME_PATTERN =
  /(?:^|[._-])(?:tmp|temp|temporary|intermediate|working|partial|draft|frame[_-]?\d+|chunk[_-]?\d+)(?:[._-]|\d|$)|\.tmp$/iu;
export const NON_IMAGE_REFERENCE_EXTENSION_PATTERN =
  /\.(?:bin|data|json|txt|md|csv|pdf|js|mjs|cjs|ts|tsx|mp4|mov|webm|wav|mp3|zip|tar|gz)(?:$|[?#])/iu;

// ---------------------------------------------------------------------------
// Timing & limits
// ---------------------------------------------------------------------------

export const ACTION_IDEMPOTENCY_IN_FLIGHT_WINDOW_MS = 45_000;
export const ACTION_REQUEUE_BACKOFF_MS = 15_000;
export const OWNER_CAPABILITY_COOLDOWN_MS = 60_000;
export const BRIDGE_LOOKUP_CACHE_TTL_MS = 12_000;
export const ENGAGEMENT_TARGET_CACHE_TTL_MS = 90_000;
export const ENGAGEMENT_TARGET_CACHE_MAX_ENTRIES = 240;
export const COMMENT_TARGET_REUSE_WINDOW_MS = 1000 * 60 * 60 * 6;
export const COMMENT_TARGET_HISTORY_LIMIT = 240;
export const COMMENT_RECENCY_TRACKED_STATES = new Set<CommandLifecycleState>([
  "queued",
  "context_ready",
  "llm_running",
  "action_running",
  "acked",
]);

// ---------------------------------------------------------------------------
// Post novelty & variety
// ---------------------------------------------------------------------------

export const POST_NOVELTY_HISTORY_WINDOW_MS = 1000 * 60 * 60 * 24 * 7;
export const POST_NOVELTY_HISTORY_MAX_ITEMS = 80;
export const POST_NOVELTY_MAX_AVOID_REFERENCES = 8;
export const POST_VARIETY_HISTORY_WINDOW_MS = 1000 * 60 * 60 * 24 * 7;
export const POST_VARIETY_HISTORY_MAX_ITEMS = 80;
export const POST_VARIETY_RECENT_COOLDOWN_COUNT = 2;
export const POST_DISCOVERY_SIGNAL_MAX_LINES = 8;
export const POST_DISCOVERY_SIGNAL_MAX_LENGTH = 1200;

export const ENFORCE_PERMISSION_HINT_FILTERS =
  (process.env.MG_AGENT_ENFORCE_PERMISSION_HINT_FILTERS ?? "0") === "1";

export const POST_VARIETY_HINT_PATTERNS: ReadonlyArray<{
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

// ---------------------------------------------------------------------------
// Media generator
// ---------------------------------------------------------------------------

export const MEDIA_GENERATOR_DEFAULT_BASE_URL = "http://127.0.0.1:4280";
export const MEDIA_GENERATOR_POLL_MS = 200;
export const MEDIA_GENERATOR_OPEN_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// Agent guide
// ---------------------------------------------------------------------------

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
export const AGENT_KTHX_GUIDE_LOCATION = (() => {
  const guideUrl = resolveAgentKthxGuideUrl();
  if (guideUrl) {
    return `\`${guideUrl}\` (fallback: \`${AGENT_KTHX_GUIDE_PATH}\`)`;
  }
  return `\`${AGENT_KTHX_GUIDE_PATH}\``;
})();

// ---------------------------------------------------------------------------
// Error detection patterns
// ---------------------------------------------------------------------------

export const IMAGE_GENERATION_SETUP_REQUIRED_PATTERN =
  /\b(image_generator_unconfigured|file_generator_unconfigured|generate_command_unset|service_unreachable|service_http_|image_generation_failed|image_generation_timeout_after_)\b/iu;
export const PERSONA_REFERENCE_SETUP_REQUIRED_PATTERN =
  /persona_reference_setup_required:([a-z0-9_]{1,64})/iu;
export const MEDIA_GENERATION_OUTPUT_UNAVAILABLE_PATTERN =
  /\b(no_media_url|chat_delivery_media_url_invalid|unsupported_media_payload_mime:|invalid_data_uri|media_source_empty|empty media data|only image and video uploads are supported)\b/iu;
export const IMAGE_GENERATION_SETUP_HINT =
  ` Image generation is not ready yet. Install/start the KTHX OpenAI Media Generator using ${AGENT_KTHX_GUIDE_LOCATION}, then complete its first browser OpenAI login and retry.`;

// ---------------------------------------------------------------------------
// Caption position & text styles
// ---------------------------------------------------------------------------

export const CAPTION_POSITION_KEYS = new Set([
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
]);

export const TEXT_STYLE_THEME_KEYS = new Set<string>(["warm", "cool", "night", "sunrise", "mint", "ocean", "plum", "sand"]);
export const TEXT_STYLE_ALIGN_KEYS = new Set(["left", "center", "right"]);
export const TEXT_STYLE_EMPHASIS_KEYS = new Set(["soft", "bold", "serif", "mono", "display"]);
export const TEXT_STYLE_FONT_KEYS = new Set(["sans", "serif", "mono", "display"]);
export const TEXT_STYLE_WEIGHT_KEYS = new Set(["regular", "bold"]);
export const TEXT_STYLE_SIZE_KEYS = new Set(["sm", "md", "lg", "xl", "2xl"]);
export const TEXT_STYLE_COLOR_KEYS = new Set(["ink", "paper", "cream", "sunset", "mint", "sky"]);
export const TEXT_STYLE_DEFAULT_COLOR_BY_THEME: Record<TextStyleTheme, string> = {
  warm: "ink", cool: "ink", night: "paper", sunrise: "ink",
  mint: "ink", ocean: "ink", plum: "paper", sand: "ink",
};

// ---------------------------------------------------------------------------
// Autonomous visual theming
// ---------------------------------------------------------------------------

export const AUTONOMOUS_TEXT_GRADIENTS: Record<TextStyleTheme, string[]> = {
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

export const AUTONOMOUS_THEME_KEYWORD_HINTS: Array<{
  theme: TextStyleTheme;
  keywords: string[];
}> = [
  { theme: "ocean", keywords: ["tech", "code", "build", "system", "engineer", "ai", "agent", "cloud"] },
  { theme: "cool", keywords: ["analysis", "plan", "explain", "update", "status", "report", "insight"] },
  { theme: "night", keywords: ["security", "risk", "late", "midnight", "focus", "deep", "serious"] },
  { theme: "plum", keywords: ["mystery", "cinematic", "dramatic", "moody", "noir", "intense"] },
  { theme: "sunrise", keywords: ["launch", "win", "growth", "energy", "hype", "breakthrough", "momentum"] },
  { theme: "warm", keywords: ["community", "friends", "team", "conversation", "human", "story"] },
  { theme: "mint", keywords: ["calm", "fresh", "wellness", "clean", "simple", "minimal"] },
  { theme: "sand", keywords: ["guide", "lesson", "tips", "how", "steps", "walkthrough"] },
];

export const AUTONOMOUS_PALETTE_HINTS_BY_THEME: Record<TextStyleTheme, string[]> = {
  warm: ["soft peach, rose cream, and warm gold", "apricot, dusty pink, and pale amber"],
  cool: ["powder blue, periwinkle, and mint-white", "frost blue, lilac haze, and aqua accents"],
  night: ["deep navy, indigo, and moonlit slate", "midnight blue, steel violet, and low-key shadows"],
  sunrise: ["amber, coral blush, and sunrise pink", "golden peach, salmon glow, and warm rose"],
  mint: ["mint leaf, seafoam, and pale cyan", "fresh jade, cool mint, and white glow"],
  ocean: ["ocean blue, teal mist, and bright aqua", "azure, cyan, and tropical sea tones"],
  plum: ["eggplant, violet, and magenta haze", "dark plum, royal purple, and mulberry highlights"],
  sand: ["sandstone, beige, and warm tan", "cream, dune gold, and soft caramel"],
};

export const AUTONOMOUS_CAMERA_HINTS = [
  "Wide framing with clear foreground-background depth.",
  "Medium shot with one strong focal subject.",
  "Close-up composition with layered texture and contrast.",
  "Three-quarter angle with motion and candid energy.",
  "Overhead composition with deliberate visual rhythm.",
] as const;

export const AUTONOMOUS_SEQUENCE_SIGNAL_PATTERN =
  /\b(first|second|third|fourth|next|then|finally|steps?|checklist|roadmap|before|after|vs|versus|reasons?|ways?|lessons?|takeaways?|timeline)\b/iu;

// ---------------------------------------------------------------------------
// Self-comment patterns
// ---------------------------------------------------------------------------

export const SELF_COMMENT_CLARIFICATION_INTENT_PATTERN =
  /\b(clarif(?:y|ication)|correction|follow(?:\s|-)?up|update|status|note|context|addendum|psa)\b/iu;
export const SELF_COMMENT_OWN_TARGET_QUERY_PATTERN =
  /\b(?:my|our|own)\b[\w\s-]{0,32}\b(?:post|story|thread|comment|reply|update|follow(?:\s|-)?up)\b/iu;
export const SELF_TOP_LEVEL_COMMENT_RARE_PERCENT = 3;

// ---------------------------------------------------------------------------
// Rate limit patterns
// ---------------------------------------------------------------------------

export const BRIDGE_RATE_LIMIT_MESSAGE_RE =
  /\b(?:rate[_\s-]?limit|too many requests|http\s*429|status\s*429|429)\b/iu;
export const RETRY_AFTER_MS_RE = /retry[_\s-]?after(?:_ms|ms)?\D{0,6}(\d{1,7})/iu;
export const RETRY_REMAINING_MS_RE = /(\d{1,7})\s*ms\s*remaining/iu;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const AGENT_PROVENANCE_VALUES = new Set([
  "USER_DIRECTED",
  "AGENT_AUTONOMOUS",
  "SYSTEM_DIRECTIVE",
  "RESEARCH_ASSISTED",
]);

// ---------------------------------------------------------------------------
// Cache limits (previously static class properties)
// ---------------------------------------------------------------------------

export const GENERATED_DRAFT_CACHE_MAX_ENTRIES = 50;
export const GENERATED_DRAFT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
export const CURATED_PROMPT_CACHE_MAX_ENTRIES = 200;
export const CURATED_PROMPT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
