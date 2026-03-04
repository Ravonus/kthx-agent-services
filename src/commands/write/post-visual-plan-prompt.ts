import type { PostDraftContext } from "../types.js";

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
