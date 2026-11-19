import { userInputRequestSchema } from "@seqlane/agent-adapter";
import type { UserInputRequest } from "@seqlane/agent-adapter";
import { CodexAdapterError } from "./errors.js";
import {
  type CodexServerRequest,
  type CodexServerRequestResponse,
  type CodexRequestId,
  unsupportedCodexServerRequest,
} from "./protocol.js";
import type { CodexTransport } from "./transport.js";
import { z } from "zod";

const dynamicToolCallParamsSchema = z.strictObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  namespace: z.string().nullable(),
  tool: z.string().min(1),
  arguments: z.unknown(),
});

export interface CodexUserInputHandler {
  readonly pendingCallCount: number;
  handle(request: CodexServerRequest): boolean;
  dispose(): void;
}

export interface CodexUserInputHandlerOptions {
  readonly threadId?: string;
  readonly turnId: string;
  readonly onUserInput?: (request: UserInputRequest) => Promise<string>;
  readonly respond: CodexTransport["respond"];
  readonly signal?: AbortSignal;
  readonly fail: (cause: unknown) => void;
}

export function createCodexUserInputHandler(
  options: CodexUserInputHandlerOptions,
): CodexUserInputHandler {
  const pendingCalls = new Set<CodexRequestId>();
  let disposed = false;

  const respond = (
    id: CodexRequestId,
    response: CodexServerRequestResponse,
  ): void => options.respond(id, response);

  const failUnsupported = (request: CodexServerRequest): void => {
    respond(request.id, unsupportedCodexServerRequest(request));
    options.fail(
      new CodexAdapterError(
        "user-input.unsupported",
        "Codex requested an unsupported dynamic tool",
      ),
    );
  };

  const dispatch = async (
    requestId: CodexRequestId,
    question: UserInputRequest,
    onUserInput: NonNullable<CodexUserInputHandlerOptions["onUserInput"]>,
  ): Promise<void> => {
    let answer: string;
    try {
      answer = await onUserInput(question);
    } catch (cause) {
      pendingCalls.delete(requestId);
      if (disposed || options.signal?.aborted) return;
      try {
        respond(requestId, {
          result: {
            contentItems: [
              { type: "inputText", text: "User input is unavailable." },
            ],
            success: false,
          },
        });
      } catch (responseCause) {
        options.fail(new AggregateError([cause, responseCause]));
        return;
      }
      options.fail(cause);
      return;
    }
    pendingCalls.delete(requestId);
    if (disposed || options.signal?.aborted) return;
    try {
      respond(requestId, {
        result: {
          contentItems: [{ type: "inputText", text: answer }],
          success: true,
        },
      });
    } catch (cause) {
      // The success write may have reached Codex. Never send a fallback.
      options.fail(cause);
    }
  };

  const abort = (): void => pendingCalls.clear();
  options.signal?.addEventListener("abort", abort, { once: true });

  return {
    get pendingCallCount() {
      return pendingCalls.size;
    },
    handle(request) {
      if (request.method !== "item/tool/call") return false;
      if (disposed || options.signal?.aborted) return true;
      const params = dynamicToolCallParamsSchema.safeParse(request.params);
      if (
        !params.success ||
        params.data.tool !== "ask_user" ||
        params.data.namespace !== null ||
        params.data.turnId !== options.turnId ||
        params.data.threadId !== options.threadId ||
        options.onUserInput === undefined
      ) {
        failUnsupported(request);
        return true;
      }

      const question = userInputRequestSchema.safeParse(params.data.arguments);
      if (!question.success) {
        respond(request.id, {
          error: {
            code: -32602,
            message: "Unsupported user input question",
          },
        });
        options.fail(
          new CodexAdapterError(
            "user-input.unsupported",
            "Codex requested an unsupported user input question",
            question.error,
          ),
        );
        return true;
      }

      pendingCalls.add(request.id);
      void dispatch(request.id, question.data, options.onUserInput).catch(
        (cause: unknown) => options.fail(cause),
      );
      return true;
    },
    dispose() {
      disposed = true;
      pendingCalls.clear();
      options.signal?.removeEventListener("abort", abort);
    },
  };
}
