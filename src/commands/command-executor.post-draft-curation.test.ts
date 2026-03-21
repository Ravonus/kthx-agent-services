import { describe, expect, it } from "vitest";

import type { PostDraftContext } from "./types.js";
import {
  buildDirectiveScopedMediaGenerationPayload,
  buildPostDraftCurationPrompt,
  buildPostDraftDecisionPrompt,
  extractPostDraftDecisionFromUnknown,
} from "./write/post-draft-curation.js";

const blankContext: PostDraftContext = {
  targetPostId: 42,
  postText: "Kael posted a photo from the library.",
  mediaSummary: null,
  commentSummary: "@iris: this looks peaceful",
  payloadHint: "post something around kael at the library",
  memorySummary: "retrieval: preset:most_recent_post post:9 :: rooftop selfie",
  platformSignals: "home: @kael: library photo",
  personaDescription: null,
  personaStyleHint: null,
};

describe("command executor post draft curation helpers", () => {
  it("builds a separate tier-1 decision prompt for directive posts", () => {
    const prompt = buildPostDraftDecisionPrompt({
      postType: "media",
      context: blankContext,
      varietyMode: "observation",
      seedHints: ["Kael at the library table"],
      avoidReferences: ["rooftop selfie with sunset"],
      taggedHandles: ["kael"],
    });

    expect(prompt).toContain("This is tier 1: choose the post focus before any draft is written.");
    expect(prompt).toContain("The directive is a nudge, not a script.");
    expect(prompt).toContain("availableTaggedHandles: @kael");
  });

  it("parses tier-1 decisions including optional tagged handles", () => {
    const decision = extractPostDraftDecisionFromUnknown({
      focus: "quiet library observation instead of another kael portrait",
      targetKind: "scene",
      useTargetContext: false,
      includeTaggedHandles: [],
      reason: "recent posts already centered kael",
    });

    expect(decision).toEqual({
      focus: "quiet library observation instead of another kael portrait",
      targetKind: "scene",
      useTargetContext: false,
      includeTaggedHandles: [],
      reason: "recent posts already centered kael",
    });
  });

  it("frames the curation prompt as natural posting instead of literal directive execution", () => {
    const prompt = buildPostDraftCurationPrompt({
      postType: "media",
      caption: "Draft caption",
      textBody: null,
      mediaPrompt: "Kael at a library table",
      context: blankContext,
      varietyMode: "observation",
      seedHints: ["Kael at the library table"],
      avoidReferences: ["rooftop selfie with sunset"],
      taggedHandles: ["kael"],
      decision: {
        focus: "quiet library observation from my own point of view",
        targetKind: "scene",
        useTargetContext: false,
        includeTaggedHandles: [],
        reason: "recent posts already centered Kael",
      },
    });

    expect(prompt).toContain("Decide what the agent would naturally post right now");
    expect(prompt).toContain("Selected decision:");
    expect(prompt).toContain("selectedTaggedHandles: (none)");
    expect(prompt).toContain("If you intentionally want a tagged handle/person");
  });

  it("strips tagged handles and direct target refs when the decision pivots away", () => {
    const payload = buildDirectiveScopedMediaGenerationPayload({
      payload: {
        postId: 42,
        commentId: 9,
        targetPostId: 42,
        targetCommentId: 9,
        taggedHandles: ["kael"],
        taggedUsers: [{ handle: "kael" }],
        directiveScope: {
          targetPostId: 42,
          targetCommentId: 9,
          target: {
            postId: 42,
            commentId: 9,
          },
        },
      },
      selectedTaggedHandles: [],
      useTargetContext: false,
    });

    expect(payload.taggedHandles).toBeUndefined();
    expect(payload.taggedUsers).toBeUndefined();
    expect(payload.postId).toBeUndefined();
    expect(payload.commentId).toBeUndefined();
    expect(payload.targetPostId).toBeUndefined();
    expect(payload.targetCommentId).toBeUndefined();
    expect((payload.directiveScope as { targetPostId?: number }).targetPostId).toBeUndefined();
  });
});
