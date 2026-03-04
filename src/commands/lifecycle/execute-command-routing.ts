import { nowIso } from "../../lib/text.js";
import type {
  Command,
  CommandOutcome,
  ExecuteResult,
} from "../types.js";

export type ExecuteCommandRoutingRuntime = {
  ctx: {
    memory: {
      recordWrite(entry: unknown): Promise<void>;
    };
  };
  executeWriteCreatePost: (command: Command) => Promise<CommandOutcome>;
  executeWriteCreateStory: (command: Command) => Promise<CommandOutcome>;
  executeWriteUpdateAvatar: (command: Command) => Promise<CommandOutcome>;
  executeWriteUpdateBanner: (command: Command) => Promise<CommandOutcome>;
  executeWriteComment: (command: Command) => Promise<CommandOutcome>;
  executeWriteVote: (command: Command) => Promise<CommandOutcome>;
  executeWriteRepost: (command: Command) => Promise<CommandOutcome>;
  executeRetryPending: (command: Command) => Promise<CommandOutcome>;
  executeGenerateAndQueue: (command: Command) => Promise<CommandOutcome>;
  executeReview: (command: Command) => Promise<CommandOutcome>;
  failedOutcome: (command: Command, message: string, code?: string) => CommandOutcome;
};

export async function executeCommand(
  this: ExecuteCommandRoutingRuntime,
  command: Command,
): Promise<ExecuteResult> {
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
  await this.ctx.memory
    .recordWrite({
      type: "command_execution_unsupported",
      at: nowIso(),
      commandId: command.id,
      kind: command.kind,
    })
    .catch(() => undefined);
  return { processed: true, outcome };
}

export async function executeCommandFromMappedDraft(
  this: ExecuteCommandRoutingRuntime,
  command: Command,
): Promise<CommandOutcome> {
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
  return this.failedOutcome(
    command,
    `Unsupported generated draft command kind: ${command.kind}`,
  );
}
