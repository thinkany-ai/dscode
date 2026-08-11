import { randomUUID } from "node:crypto";
import type {
  AgentSessionEvent,
  ExtensionError,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

export type HttpUiRequest =
  | {
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
    };

export type HttpUiResponse =
  | { requestId: string; confirmed: boolean }
  | { requestId: string; value: string }
  | { requestId: string; cancelled: true };

export type HttpUiResponseErrorCode = "not_found" | "invalid_response";

export class HttpUiResponseError extends Error {
  readonly code: HttpUiResponseErrorCode;

  constructor(code: HttpUiResponseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpUiResponseError";
    this.code = code;
  }
}

export type HttpUiEvent =
  | { method: "notify"; message: string; level?: "info" | "warning" | "error" }
  | { method: "status"; key: string; text?: string }
  | { method: "title"; title: string }
  | {
      method: "widget";
      key: string;
      lines?: string[];
      placement?: "aboveEditor" | "belowEditor";
    }
  | { method: "working_message"; message?: string }
  | { method: "working_visible"; visible: boolean }
  | { method: "working_indicator"; options?: WorkingIndicatorOptions }
  | { method: "hidden_thinking_label"; label?: string }
  | { method: "editor_text"; text: string; paste: boolean };

export type HttpUiBrokerEvent =
  | { type: "session"; event: AgentSessionEvent }
  | { type: "extension_error"; error: ExtensionError }
  | { type: "ui_request"; request: HttpUiRequest }
  | { type: "ui_event"; event: HttpUiEvent };

export type HttpUiBrokerListener = (event: HttpUiBrokerEvent) => void;

export interface HttpUiBroker {
  readonly uiContext: ExtensionUIContext;
  attachBaseContext(context: ExtensionUIContext): void;
  publishSessionEvent(event: AgentSessionEvent): void;
  publishExtensionError(error: ExtensionError): void;
  subscribe(listener: HttpUiBrokerListener): () => void;
  respond(response: HttpUiResponse): void;
  cancelPending(): void;
  dispose(): void;
}

interface PendingRequest {
  request: HttpUiRequest;
  resolve(response: HttpUiResponse): void;
  cancel(): void;
}

type WidgetFactory = Exclude<
  Parameters<ExtensionUIContext["setWidget"]>[1],
  undefined
>;

function retainedEventKey(event: HttpUiEvent): string | undefined {
  if (event.method === "notify") return undefined;
  if (event.method === "status" || event.method === "widget") {
    return `${event.method}:${event.key}`;
  }
  return event.method;
}

export function createHttpUiBroker(): HttpUiBroker {
  const listeners = new Set<HttpUiBrokerListener>();
  const pending = new Map<string, PendingRequest>();
  const retainedUiEvents = new Map<string, HttpUiEvent>();
  let baseContext: ExtensionUIContext | undefined;
  let disposed = false;
  let editorText = "";

  const emit = (event: HttpUiBrokerEvent): void => {
    if (disposed) return;
    if (event.type === "ui_event") {
      const key = retainedEventKey(event.event);
      if (key !== undefined) retainedUiEvents.set(key, event.event);
    }
    for (const listener of listeners) listener(event);
  };

  const requireBaseContext = (): ExtensionUIContext => {
    if (!baseContext) {
      throw new Error("HTTP UI broker is not attached to an extension UI context");
    }
    return baseContext;
  };

  const request = <T>(
    value: HttpUiRequest,
    options: ExtensionUIDialogOptions | undefined,
    parse: (response: HttpUiResponse) => T,
    fallback: T,
  ): Promise<T> => {
    if (disposed || options?.signal?.aborted) return Promise.resolve(fallback);

    return new Promise<T>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", cancel);
        pending.delete(value.id);
      };
      const finish = (result: T): void => {
        cleanup();
        resolve(result);
      };
      const cancel = (): void => finish(fallback);

      pending.set(value.id, {
        request: value,
        resolve: (response) => finish(parse(response)),
        cancel,
      });
      options?.signal?.addEventListener("abort", cancel, { once: true });
      if (options?.timeout !== undefined) {
        timeout = setTimeout(cancel, options.timeout);
      }
      try {
        emit({ type: "ui_request", request: value });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  };

  const confirm = (
    title: string,
    message: string,
    options?: ExtensionUIDialogOptions,
  ): Promise<boolean> => {
    const value: HttpUiRequest = {
      id: randomUUID(),
      method: "confirm",
      title,
      message,
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    };
    return request(
      value,
      options,
      (response) => {
        if ("cancelled" in response) return false;
        if ("confirmed" in response) return response.confirmed;
        throw new Error(`UI request ${value.id} requires a confirmation response`);
      },
      false,
    );
  };

  const select = (
    title: string,
    values: string[],
    options?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> => {
    const value: HttpUiRequest = {
      id: randomUUID(),
      method: "select",
      title,
      options: [...values],
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    };
    return request(
      value,
      options,
      (response) => {
        if ("cancelled" in response) return undefined;
        if (!("value" in response)) {
          throw new Error(`UI request ${value.id} requires a value response`);
        }
        if (!values.includes(response.value)) {
          throw new Error(`UI response is not an option for request ${value.id}`);
        }
        return response.value;
      },
      undefined,
    );
  };

  const input = (
    title: string,
    placeholder?: string,
    options?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> => {
    const value: HttpUiRequest = {
      id: randomUUID(),
      method: "input",
      title,
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
    };
    return request(
      value,
      options,
      (response) => {
        if ("cancelled" in response) return undefined;
        if ("value" in response) return response.value;
        throw new Error(`UI request ${value.id} requires a value response`);
      },
      undefined,
    );
  };

  const editor = (title: string, prefill?: string): Promise<string | undefined> => {
    const value: HttpUiRequest = {
      id: randomUUID(),
      method: "editor",
      title,
      ...(prefill !== undefined ? { prefill } : {}),
    };
    return request(
      value,
      undefined,
      (response) => {
        if ("cancelled" in response) return undefined;
        if ("value" in response) return response.value;
        throw new Error(`UI request ${value.id} requires a value response`);
      },
      undefined,
    );
  };

  const overrides: Partial<ExtensionUIContext> = {
    confirm,
    select,
    input,
    editor,
    notify(message, level) {
      emit({
        type: "ui_event",
        event: {
          method: "notify",
          message,
          ...(level !== undefined ? { level } : {}),
        },
      });
    },
    setStatus(key, text) {
      emit({
        type: "ui_event",
        event: { method: "status", key, ...(text !== undefined ? { text } : {}) },
      });
    },
    setTitle(title) {
      emit({ type: "ui_event", event: { method: "title", title } });
    },
    setWorkingMessage(message) {
      emit({
        type: "ui_event",
        event: { method: "working_message", ...(message !== undefined ? { message } : {}) },
      });
    },
    setWorkingVisible(visible) {
      emit({ type: "ui_event", event: { method: "working_visible", visible } });
    },
    setWorkingIndicator(options) {
      emit({
        type: "ui_event",
        event: {
          method: "working_indicator",
          ...(options !== undefined ? { options } : {}),
        },
      });
    },
    setHiddenThinkingLabel(label) {
      emit({
        type: "ui_event",
        event: {
          method: "hidden_thinking_label",
          ...(label !== undefined ? { label } : {}),
        },
      });
    },
    setEditorText(text) {
      editorText = text;
      emit({ type: "ui_event", event: { method: "editor_text", text, paste: false } });
    },
    pasteToEditor(text) {
      editorText += text;
      emit({ type: "ui_event", event: { method: "editor_text", text, paste: true } });
      retainedUiEvents.set("editor_text", {
        method: "editor_text",
        text: editorText,
        paste: false,
      });
    },
    getEditorText() {
      return editorText;
    },
  };

  const uiContext = new Proxy({} as ExtensionUIContext, {
    get(_target, property) {
      if (property === "setWidget") {
        return (
          key: string,
          content: string[] | WidgetFactory | undefined,
          options?: ExtensionWidgetOptions,
        ): void => {
          if (content === undefined || Array.isArray(content)) {
            emit({
              type: "ui_event",
              event: {
                method: "widget",
                key,
                ...(content !== undefined ? { lines: [...content] } : {}),
                ...(options?.placement !== undefined
                  ? { placement: options.placement }
                  : {}),
              },
            });
            return;
          }
          requireBaseContext().setWidget(key, content, options);
        };
      }
      if (property in overrides) {
        return Reflect.get(overrides, property, overrides);
      }
      const base = requireBaseContext();
      const resolved = Reflect.get(base, property, base) as unknown;
      return typeof resolved === "function" ? resolved.bind(base) : resolved;
    },
  });

  return {
    uiContext,
    attachBaseContext(context) {
      if (disposed) throw new Error("HTTP UI broker is disposed");
      baseContext = context;
    },
    publishSessionEvent(event) {
      emit({ type: "session", event });
    },
    publishExtensionError(error) {
      emit({ type: "extension_error", error });
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      try {
        for (const event of retainedUiEvents.values()) {
          listener({ type: "ui_event", event });
        }
        for (const entry of pending.values()) {
          listener({ type: "ui_request", request: entry.request });
        }
      } catch (error) {
        listeners.delete(listener);
        throw error;
      }
      return () => listeners.delete(listener);
    },
    respond(response) {
      if (disposed) throw new Error("HTTP UI broker is disposed");
      const entry = pending.get(response.requestId);
      if (!entry) {
        throw new HttpUiResponseError(
          "not_found",
          `Unknown UI request: ${response.requestId}`,
        );
      }
      try {
        entry.resolve(response);
      } catch (error) {
        throw new HttpUiResponseError(
          "invalid_response",
          error instanceof Error ? error.message : "Invalid UI response",
          { cause: error },
        );
      }
    },
    cancelPending() {
      // Resolve blocked dialogs with their fallbacks so an aborted run can settle.
      for (const entry of [...pending.values()]) entry.cancel();
      pending.clear();
    },
    dispose() {
      if (disposed) return;
      for (const entry of [...pending.values()]) entry.cancel();
      pending.clear();
      retainedUiEvents.clear();
      listeners.clear();
      baseContext = undefined;
      disposed = true;
    },
  };
}
