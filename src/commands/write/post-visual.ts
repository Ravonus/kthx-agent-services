/** Autonomous visual plan, theme, style, and slide-building helpers. */

import crypto from "node:crypto";

import type {
  TextStyleTheme,
  TextPostVisualSlide,
  TextPostVisualPlan,
  PostDraftContext,
} from "../types.js";

import {
  asNonEmptyString,
  truncateText,
  stripEmDashCharacters,
  escapeRegex,
} from "../helpers.js";

import { parseJsonFromMixedText } from "../../lib/parsing.js";
import { isRecord } from "../../lib/guards.js";

import {
  CAPTION_POSITION_KEYS,
  TEXT_STYLE_THEME_KEYS,
  TEXT_STYLE_ALIGN_KEYS,
  TEXT_STYLE_EMPHASIS_KEYS,
  TEXT_STYLE_FONT_KEYS,
  TEXT_STYLE_WEIGHT_KEYS,
  TEXT_STYLE_SIZE_KEYS,
  TEXT_STYLE_COLOR_KEYS,
  TEXT_STYLE_DEFAULT_COLOR_BY_THEME,
  AUTONOMOUS_TEXT_GRADIENTS,
  AUTONOMOUS_THEME_KEYWORD_HINTS,
  AUTONOMOUS_PALETTE_HINTS_BY_THEME,
  AUTONOMOUS_CAMERA_HINTS,
  AUTONOMOUS_SEQUENCE_SIGNAL_PATTERN,
} from "../constants.js";

import { TEXT_STYLE_THEMES } from "../types.js";

// ---------------------------------------------------------------------------
// normalizeCaptionPositionValue
// ---------------------------------------------------------------------------

export function normalizeCaptionPositionValue(value: unknown): string | null {
  const raw = asNonEmptyString(value)?.toLowerCase() ?? null;
  if (!raw) return null;
  return CAPTION_POSITION_KEYS.has(raw) ? raw : null;
}

// ---------------------------------------------------------------------------
// sanitizeTextStyleValue
// ---------------------------------------------------------------------------

export function sanitizeTextStyleValue(
  value: unknown,
): Record<string, unknown> | null {
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
  const position = normalizeCaptionPositionValue(value.position);
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

// ---------------------------------------------------------------------------
// pickDeterministicIndex
// ---------------------------------------------------------------------------

export function pickDeterministicIndex(
  seed: string,
  modulo: number,
): number {
  const boundedModulo = Math.max(1, Math.floor(modulo));
  const digest = crypto.createHash("sha256").update(seed).digest();
  const value = digest.readUInt32BE(0);
  return value % boundedModulo;
}

// ---------------------------------------------------------------------------
// resolveAutonomousTextTheme
// ---------------------------------------------------------------------------

export function resolveAutonomousTextTheme(input: {
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
    return (
      TEXT_STYLE_THEMES[
        pickDeterministicIndex(seed, TEXT_STYLE_THEMES.length)
      ] ?? "warm"
    );
  }
  return (
    candidates[pickDeterministicIndex(seed, candidates.length)] ??
    candidates[0] ??
    "warm"
  );
}

// ---------------------------------------------------------------------------
// resolveAutonomousGradientBackground
// ---------------------------------------------------------------------------

export function resolveAutonomousGradientBackground(
  theme: TextStyleTheme,
  seed: string,
): string {
  const options = AUTONOMOUS_TEXT_GRADIENTS[theme];
  if (!Array.isArray(options) || options.length === 0) {
    return "linear-gradient(140deg, #ffe4d6 0%, #ffd1da 48%, #fff1c2 100%)";
  }
  const picked = options[pickDeterministicIndex(seed, options.length)];
  return (
    picked ??
    options[0] ??
    "linear-gradient(140deg, #ffe4d6 0%, #ffd1da 48%, #fff1c2 100%)"
  );
}

// ---------------------------------------------------------------------------
// resolveAutonomousPaletteHint
// ---------------------------------------------------------------------------

export function resolveAutonomousPaletteHint(
  theme: TextStyleTheme,
  seed: string,
): string {
  const options = AUTONOMOUS_PALETTE_HINTS_BY_THEME[theme];
  if (!Array.isArray(options) || options.length === 0) {
    return "balanced natural tones";
  }
  const picked = options[pickDeterministicIndex(seed, options.length)];
  return picked ?? options[0] ?? "balanced natural tones";
}

// ---------------------------------------------------------------------------
// resolveAutonomousCameraHint
// ---------------------------------------------------------------------------

export function resolveAutonomousCameraHint(seed: string): string {
  const picked =
    AUTONOMOUS_CAMERA_HINTS[
      pickDeterministicIndex(seed, AUTONOMOUS_CAMERA_HINTS.length)
    ];
  return picked ?? AUTONOMOUS_CAMERA_HINTS[0];
}

// ---------------------------------------------------------------------------
// resolveAutonomousCaptionPosition
// ---------------------------------------------------------------------------

export function resolveAutonomousCaptionPosition(input: {
  commandId: string;
  postKind: "post" | "thread";
  seedText: string;
}): string {
  const preferred =
    input.postKind === "thread"
      ? (["top-left", "middle-left", "bottom-left", "middle-center"] as const)
      : ([
          "middle-center",
          "top-center",
          "bottom-center",
          "middle-left",
          "middle-right",
        ] as const);
  const picked =
    preferred[
      pickDeterministicIndex(
        `${input.commandId}:${input.seedText}:caption_position`,
        preferred.length,
      )
    ];
  return picked ?? "middle-center";
}

// ---------------------------------------------------------------------------
// buildAutonomousVisualPrompt
// ---------------------------------------------------------------------------

export function buildAutonomousVisualPrompt(input: {
  basePrompt: string;
  caption: string | null;
  commandId: string;
  theme: TextStyleTheme;
  mode: "slide" | "story" | "background";
  index: number;
}): string {
  const subject = stripEmDashCharacters(input.basePrompt)
    .replace(/\s+/gu, " ")
    .trim();
  if (!subject.length) return "";
  const palette = resolveAutonomousPaletteHint(
    input.theme,
    `${input.commandId}:${input.mode}:${input.index}:palette`,
  );
  const camera = resolveAutonomousCameraHint(
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

// ---------------------------------------------------------------------------
// buildAutonomousThreadSlides
// ---------------------------------------------------------------------------

export function buildAutonomousThreadSlides(input: {
  commandId: string;
  caption: string | null;
  textBody: string;
  theme: TextStyleTheme;
  postKind: "post" | "thread";
}): TextPostVisualSlide[] {
  const cleanedBody = stripEmDashCharacters(input.textBody)
    .replace(/\s+/gu, " ")
    .trim();
  if (cleanedBody.length < 24) return [];
  const seed = `${input.commandId}:${cleanedBody}:${input.theme}`;
  const wordCount = cleanedBody
    .split(/\s+/u)
    .filter((token) => token.length > 0).length;
  const parts = cleanedBody
    .split(/(?:\r?\n|[.!?;]+)\s*/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 18);
  const hasSequenceSignals =
    AUTONOMOUS_SEQUENCE_SIGNAL_PATTERN.test(cleanedBody);
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
  if (
    pickDeterministicIndex(`${seed}:slides_gate`, 100) >= threshold
  ) {
    return [];
  }
  const targetCount = Math.min(
    4,
    Math.max(2, 2 + pickDeterministicIndex(`${seed}:slides_count`, 3)),
  );
  const normalizedParts = [...parts];
  if (normalizedParts.length < 2) {
    const captionPart = input.caption
      ? stripEmDashCharacters(input.caption).trim()
      : "";
    if (captionPart.length >= 12) normalizedParts.push(captionPart);
    const snippet = truncateText(cleanedBody, 120);
    if (snippet.length >= 18) normalizedParts.push(snippet);
  }
  const selected = normalizedParts.slice(0, targetCount);
  const slides: TextPostVisualSlide[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const statement = selected[index];
    if (!statement) continue;
    const imagePrompt = buildAutonomousVisualPrompt({
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

// ---------------------------------------------------------------------------
// buildAutonomousTextBackgroundPrompt
// ---------------------------------------------------------------------------

export function buildAutonomousTextBackgroundPrompt(input: {
  commandId: string;
  caption: string | null;
  textBody: string;
  theme: TextStyleTheme;
  postKind: "post" | "thread";
}): string | null {
  const cleanedBody = stripEmDashCharacters(input.textBody)
    .replace(/\s+/gu, " ")
    .trim();
  if (cleanedBody.length < 36) return null;
  const threshold = input.postKind === "thread" ? 34 : 18;
  if (
    pickDeterministicIndex(
      `${input.commandId}:${cleanedBody}:${input.theme}:background_gate`,
      100,
    ) >= threshold
  ) {
    return null;
  }
  const basePrompt = input.caption
    ? `${stripEmDashCharacters(input.caption)}. ${cleanedBody}`
    : cleanedBody;
  const prompt = buildAutonomousVisualPrompt({
    basePrompt,
    caption: input.caption,
    commandId: input.commandId,
    theme: input.theme,
    mode: "background",
    index: 0,
  });
  return prompt.length >= 8 ? prompt : null;
}

// ---------------------------------------------------------------------------
// buildAutonomousMediaSlides
// ---------------------------------------------------------------------------

export function buildAutonomousMediaSlides(input: {
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
  const hasSequenceSignals =
    AUTONOMOUS_SEQUENCE_SIGNAL_PATTERN.test(cleanedPrompt);
  const threshold =
    input.postKind === "thread"
      ? hasSequenceSignals
        ? 92
        : 74
      : hasSequenceSignals
        ? 62
        : 44;
  if (
    pickDeterministicIndex(`${seed}:media_slides_gate`, 100) >= threshold
  ) {
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
    Math.max(
      2,
      2 + pickDeterministicIndex(`${seed}:media_slides_count`, 3),
    ),
  );
  const selected = parts.slice(0, targetCount);
  if (selected.length < 2) return [];

  const captionBase = input.caption
    ? stripEmDashCharacters(input.caption).trim()
    : "";
  const slides: TextPostVisualSlide[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const beat = selected[index];
    if (!beat) continue;
    const imagePrompt = buildAutonomousVisualPrompt({
      basePrompt: beat,
      caption: input.caption,
      commandId: input.commandId,
      theme: input.theme,
      mode: "slide",
      index,
    });
    if (imagePrompt.length < 8) continue;
    const caption = captionBase.length
      ? truncateText(
          `${captionBase} - ${truncateText(beat, 120)}`,
          2200,
        )
      : truncateText(beat, 180);
    slides.push({
      caption,
      imagePrompt,
    });
  }
  return slides.length >= 2 ? slides.slice(0, 4) : [];
}

// ---------------------------------------------------------------------------
// normalizeAgentTextStyle
// ---------------------------------------------------------------------------

export function normalizeAgentTextStyle(
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
    const raw = normalizeCaptionPositionValue(value);
    if (raw) return raw;
    return captionPosition;
  };
  const normalized: Record<string, unknown> = {};
  const applyStyle = (
    candidateStyle: Record<string, unknown> | null | undefined,
  ): void => {
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
  const themeForDefaults = asNonEmptyString(
    normalized.theme,
  ) as TextStyleTheme | null;
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

// ---------------------------------------------------------------------------
// extractTextPostVisualPlanFromUnknown
// ---------------------------------------------------------------------------

export function extractTextPostVisualPlanFromUnknown(
  value: unknown,
): TextPostVisualPlan | null {
  const fromString = (raw: string): TextPostVisualPlan | null => {
    const trimmed = raw.trim();
    if (!trimmed.length) return null;
    const parsed = parseJsonFromMixedText(trimmed);
    if (parsed !== null && parsed !== raw) {
      return extractTextPostVisualPlanFromUnknown(parsed);
    }
    return null;
  };
  if (typeof value === "string") return fromString(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = extractTextPostVisualPlanFromUnknown(entry);
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
    const nested = extractTextPostVisualPlanFromUnknown(value[key]);
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
  const captionPositionResolved =
    normalizeCaptionPositionValue(value.captionPosition) ??
    normalizeCaptionPositionValue(value.position);
  const textStyle =
    sanitizeTextStyleValue(value.textStyle) ??
    sanitizeTextStyleValue(value.style);
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
      caption: caption
        ? truncateText(stripEmDashCharacters(caption), 2200)
        : null,
      imagePrompt: truncateText(normalizedPrompt, 320),
    });
    if (slides.length >= 6) break;
  }

  if (
    renderMode === "text" &&
    captionPositionResolved === null &&
    textStyle === null &&
    backgroundImagePrompt === null &&
    slides.length === 0
  ) {
    return null;
  }
  return {
    renderMode:
      renderMode === "slides" && slides.length >= 2 ? "slides" : "text",
    captionPosition: captionPositionResolved,
    textStyle,
    backgroundImagePrompt,
    slides: slides.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// buildTextPostVisualPlanPrompt
// ---------------------------------------------------------------------------

export function buildTextPostVisualPlanPrompt(input: {
  postKind: "post" | "thread";
  caption: string | null;
  textBody: string;
  context: PostDraftContext;
}): string {
  const contextLines = [
    typeof input.context.targetPostId === "number"
      ? `targetPostId: ${input.context.targetPostId}`
      : null,
    input.context.postText
      ? `targetPostText: ${input.context.postText}`
      : null,
    input.context.mediaSummary
      ? `targetMedia: ${input.context.mediaSummary}`
      : null,
    input.context.commentSummary
      ? `targetComments: ${input.context.commentSummary}`
      : null,
    input.context.payloadHint
      ? `directiveHint: ${input.context.payloadHint}`
      : null,
    input.context.memorySummary
      ? `memoryContext: ${input.context.memorySummary}`
      : null,
    input.context.platformSignals
      ? `platformSignals: ${input.context.platformSignals}`
      : null,
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
