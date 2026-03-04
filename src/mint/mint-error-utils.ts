import { isRecord } from "../lib/guards.js";

export const errCode = (error: unknown): string | null => {
  if (!isRecord(error)) return null;
  const data = isRecord(error.data) ? error.data : null;
  if (data && typeof data.code === "string") return data.code as string;
  const shape = isRecord(error.shape) ? error.shape : null;
  const shapeData = shape && isRecord(shape.data) ? shape.data : null;
  return shapeData && typeof shapeData.code === "string"
    ? (shapeData.code as string)
    : null;
};

export const errMsg = (error: unknown): string => {
  const baseMessage =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : typeof error === "string" && error.trim().length > 0
        ? error.trim()
        : "";
  const shape = isRecord(error) && isRecord(error.shape) ? error.shape : null;
  const shapeMessage =
    shape && typeof shape.message === "string" && shape.message.trim().length > 0
      ? shape.message.trim()
      : "";
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : null;
  const causeMessage =
    cause && typeof cause.message === "string" && cause.message.trim().length > 0
      ? cause.message.trim()
      : "";
  const data = isRecord(error) && isRecord(error.data) ? error.data : null;
  const dataCode =
    data && typeof data.code === "string" && data.code.trim().length > 0
      ? data.code.trim()
      : "";
  const httpStatus =
    data && typeof data.httpStatus === "number" && Number.isFinite(data.httpStatus)
      ? Math.floor(data.httpStatus)
      : null;

  const bestMessage =
    (baseMessage && baseMessage.toLowerCase() !== "unknown error"
      ? baseMessage
      : "") ||
    shapeMessage ||
    causeMessage ||
    baseMessage;
  if (!bestMessage.length) return "unknown error";

  const suffixParts: string[] = [];
  if (dataCode.length > 0) suffixParts.push(`code=${dataCode}`);
  if (httpStatus !== null) suffixParts.push(`httpStatus=${httpStatus}`);
  if (suffixParts.length === 0) return bestMessage;
  return `${bestMessage} (${suffixParts.join(", ")})`;
};
