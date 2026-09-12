import {
  runClaudeSdkTurn,
  type SdkMessageLike,
} from "../src/providers/claude-sdk-engine.js";
import type { AgentProviderEvent } from "../src/providers/types.js";

/**
 * Parked drain: a finished query stays alive briefly and forwards whatever the
 * CLI still emits, instead of being torn down at the turn boundary. The CLI
 * buffers background <task-notification>s and resume rescues in its own pending
 * queue; killing the process at the answer turned each queued item into a dead
 * turn and a lost answer.
 */

async function collect(iterable: AsyncIterable<AgentProviderEvent>): Promise<AgentProviderEvent[]> {
  const events: AgentProviderEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() <= deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function controlledQuery() {
  const resolvers: Array<(result: IteratorResult<SdkMessageLike>) => void> = [];
  const queued: SdkMessageLike[] = [];
  let ended = false;
  let closed = false;

  const next = (): Promise<IteratorResult<SdkMessageLike>> =>
    new Promise((resolve) => {
      if (queued.length > 0) {
        resolve({ value: queued.shift()!, done: false });
        return;
      }
      if (ended) {
        resolve({ value: undefined, done: true });
        return;
      }
      resolvers.push(resolve);
    });

  const releaseAll = (): void => {
    for (const resolve of resolvers.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  };

  const stream: AsyncIterable<SdkMessageLike> & { close?: () => void } = {
    [Symbol.asyncIterator]() {
      return { next };
    },
    close: () => {
      closed = true;
      ended = true;
      releaseAll();
    },
  };

  const seen: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const queryFn = (input: { prompt: unknown; options: Record<string, unknown> }) => {
    seen.push(input);
    return stream;
  };

  return {
    queryFn,
    seen,
    isClosed: () => closed,
    push: (message: SdkMessageLike): void => {
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ value: message, done: false });
      } else {
        queued.push(message);
      }
    },
    end: (): void => {
      ended = true;
      releaseAll();
    },
  };
}

const baseOptions = {
  sessionId: "claude-provider-park",
  jobId: "park-job",
  promptText: "do the thing",
  cwd: "C:\\workspace",
  claudeBin: "C:\\claude.exe",
  model: "claude-sonnet-5",
  permissionMode: "bypassPermissions" as const,
};

const initMessage: SdkMessageLike = { type: "system", subtype: "init", session_id: "park-session" };

function textMessage(text: string): SdkMessageLike {
  return { type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "text", text }] } };
}

function successResult(result: string): SdkMessageLike {
  return {
    type: "result",
    subtype: "success",
    result,
    usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 },
  };
}

describe("parked sdk queries", () => {
  const parkOptions = {
    ...baseOptions,
    parkIdleMs: 300,
    parkHardCapMs: 5_000,
  };

  it("keeps the query alive after the answer and delivers late text via onParkedEvent", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkedEvents: AgentProviderEvent[] = [];
    const parkStates: boolean[] = [];
    const events = await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    // The turn itself completes normally...
    expect(events.some((event) => event.type === "assistant_message_complete" && event.text === "ANSWER")).toBe(true);
    expect(parkStates).toEqual([true]);

    // ...and the query is still open afterwards.
    expect(controlled.isClosed()).toBe(false);

    controlled.push(textMessage("LATE"));
    controlled.push(successResult(""));
    await waitUntil(() =>
      parkedEvents.some((event) => event.type === "assistant_message_complete" && event.text === "LATE"),
    );

    // The park then idles out and releases the query.
    await waitUntil(() => parkStates.includes(false));
    await waitUntil(() => controlled.isClosed());
  });

  it("does not park when parkIdleMs is 0 (legacy teardown at the answer)", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkStates: boolean[] = [];
    const events = await collect(
      runClaudeSdkTurn({
        ...baseOptions,
        parkIdleMs: 0,
        queryFn: controlled.queryFn,
        onParkedEvent: () => {},
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    expect(events.some((event) => event.type === "assistant_message_complete")).toBe(true);
    expect(parkStates).toEqual([]);
    expect(controlled.isClosed()).toBe(true);
  });

  it("does not park when no onParkedEvent handler is installed", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const events = await collect(
      runClaudeSdkTurn({
        ...baseOptions,
        parkIdleMs: 300,
        queryFn: controlled.queryFn,
      }),
    );

    expect(events.some((event) => event.type === "assistant_message_complete")).toBe(true);
    expect(controlled.isClosed()).toBe(true);
  });

  it("ignores an injected turn's silent result during the park and still delivers later text", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("FIRST"));
    controlled.push(successResult("FIRST"));

    const parkedEvents: AgentProviderEvent[] = [];
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: () => {},
      }),
    );

    controlled.push(successResult(""));
    controlled.push(textMessage("SECOND"));
    controlled.push(successResult(""));

    await waitUntil(() =>
      parkedEvents.some((event) => event.type === "assistant_message_complete" && event.text === "SECOND"),
    );
    const completions = parkedEvents.filter((event) => event.type === "assistant_message_complete");
    expect(completions).toHaveLength(1);
  });

  it("delivers a parked result's text once, without repeating the assistant blocks", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkedEvents: AgentProviderEvent[] = [];
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: () => {},
      }),
    );

    controlled.push(textMessage("TAIL"));
    controlled.push(successResult("TAIL"));

    await waitUntil(() => parkedEvents.length > 0);
    await waitUntil(() => controlled.isClosed());
    const completions = parkedEvents.filter((event) => event.type === "assistant_message_complete");
    expect(completions).toHaveLength(1);
    expect((completions[0] as { text: string }).text).toBe("TAIL");
  });

  it("flushes buffered text blocks when the park idles out without a result", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkedEvents: AgentProviderEvent[] = [];
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: (event) => parkedEvents.push(event),
        onParkStateChanged: () => {},
      }),
    );

    controlled.push(textMessage("NO RESULT FOLLOWS"));
    await waitUntil(() =>
      parkedEvents.some((event) => event.type === "assistant_message_complete" && event.text === "NO RESULT FOLLOWS"),
    );
  });

  it("keeps the drain failure contained when onParkedEvent throws", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkStates: boolean[] = [];
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: () => {
          throw new Error("consumer exploded");
        },
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    controlled.push(textMessage("BOOM"));
    controlled.push(successResult(""));

    await waitUntil(() => parkStates.includes(false));
    await waitUntil(() => controlled.isClosed());
  });

  it("ends the park promptly when the query stream finishes", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push(successResult("ANSWER"));

    const parkStates: boolean[] = [];
    await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        parkIdleMs: 60_000,
        queryFn: controlled.queryFn,
        onParkedEvent: () => {},
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    expect(parkStates).toEqual([true]);
    controlled.end();

    await waitUntil(() => parkStates.includes(false));
    await waitUntil(() => controlled.isClosed());
  });

  it("maps an error result to no park at all", async () => {
    const controlled = controlledQuery();
    controlled.push(initMessage);
    controlled.push(textMessage("ANSWER"));
    controlled.push({ type: "result", subtype: "error_during_execution", errors: ["boom"] });

    const parkStates: boolean[] = [];
    const events = await collect(
      runClaudeSdkTurn({
        ...parkOptions,
        queryFn: controlled.queryFn,
        onParkedEvent: () => {},
        onParkStateChanged: (parked) => parkStates.push(parked),
      }),
    );

    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(parkStates).toEqual([]);
    expect(controlled.isClosed()).toBe(true);
  });
});
