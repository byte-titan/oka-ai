export interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

export interface ParsedCodexStream {
  messages: string[];
  sessionId: string | null;
}

export function parseCodexJsonStream(
  output: string,
  options?: { includePlainText?: boolean }
): ParsedCodexStream {
  const messages: string[] = [];
  let sessionId: string | null = null;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as CodexEvent;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        sessionId = event.thread_id;
      }
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        messages.push(event.item.text.trim());
      }
    } catch {
      if (options?.includePlainText) {
        messages.push(trimmed);
      }
    }
  }

  return { messages, sessionId };
}
