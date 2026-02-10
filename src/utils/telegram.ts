export const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;
export const TELEGRAM_PARSE_MODE = "MarkdownV2" as const;
const TELEGRAM_MD_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!]/g;

export function splitTelegramChunks(message: string): string[] {
  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", TELEGRAM_MAX_MESSAGE_LENGTH);
    if (splitIndex === -1) splitIndex = TELEGRAM_MAX_MESSAGE_LENGTH;

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

export function normalizeMarkdownForTelegram(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/gs, "*$1*");
}

export function escapeMarkdownV2(text: string): string {
  return text.replace(TELEGRAM_MD_V2_SPECIAL_CHARS, "\\$&");
}

function shouldAttemptMarkdownV2(text: string): boolean {
  // Only opt into MarkdownV2 when the message appears to intentionally use markdown formatting.
  return /\*\*[^*]+\*\*/.test(text);
}

export async function sendTelegramWithFallback(
  text: string,
  sender: (text: string, parseMode?: typeof TELEGRAM_PARSE_MODE) => Promise<boolean>
): Promise<boolean> {
  if (!shouldAttemptMarkdownV2(text)) {
    return sender(text);
  }

  const normalized = normalizeMarkdownForTelegram(text);
  if (await sender(normalized, TELEGRAM_PARSE_MODE)) {
    return true;
  }

  const escaped = escapeMarkdownV2(normalized);
  if (escaped.length <= TELEGRAM_MAX_MESSAGE_LENGTH && (await sender(escaped, TELEGRAM_PARSE_MODE))) {
    return true;
  }

  return sender(text);
}

export async function sendChunkedTelegramWithFallback(
  message: string,
  sender: (text: string, parseMode?: typeof TELEGRAM_PARSE_MODE) => Promise<boolean>
): Promise<boolean> {
  for (const chunk of splitTelegramChunks(message)) {
    const sent = await sendTelegramWithFallback(chunk, sender);
    if (!sent) return false;
  }
  return true;
}
