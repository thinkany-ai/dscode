import type { AgentSessionEvent, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  HttpUiResponseError,
  createHttpUiBroker,
  type HttpUiBrokerEvent,
} from "../src/ui-broker.js";

const fallback = {} as ExtensionUIContext;

describe("createHttpUiBroker", () => {
  it("emits and resolves interactive requests", async () => {
    const broker = createHttpUiBroker();
    broker.attachBaseContext(fallback);
    const events: HttpUiBrokerEvent[] = [];
    broker.subscribe((event) => events.push(event));

    const confirmation = broker.uiContext.confirm("Apply patch?", "src/auth.ts");
    const requestEvent = events.find((event) => event.type === "ui_request");
    expect(requestEvent?.type).toBe("ui_request");
    if (requestEvent?.type !== "ui_request") throw new Error("Missing UI request");
    expect(requestEvent.request).toMatchObject({
      method: "confirm",
      title: "Apply patch?",
      message: "src/auth.ts",
    });

    let responseError: unknown;
    try {
      broker.respond({ requestId: requestEvent.request.id, value: "yes" });
    } catch (error) {
      responseError = error;
    }
    expect(responseError).toBeInstanceOf(HttpUiResponseError);
    expect(responseError).toMatchObject({ code: "invalid_response" });
    broker.respond({ requestId: requestEvent.request.id, confirmed: true });
    await expect(confirmation).resolves.toBe(true);

    let missingError: unknown;
    try {
      broker.respond({ requestId: requestEvent.request.id, confirmed: true });
    } catch (error) {
      missingError = error;
    }
    expect(missingError).toBeInstanceOf(HttpUiResponseError);
    expect(missingError).toMatchObject({ code: "not_found" });

    broker.dispose();
  });

  it("validates selection values", async () => {
    const broker = createHttpUiBroker();
    broker.attachBaseContext(fallback);
    let requestId = "";
    broker.subscribe((event) => {
      if (event.type === "ui_request") requestId = event.request.id;
    });

    const selection = broker.uiContext.select("Database", ["SQLite", "PostgreSQL"]);
    expect(() => broker.respond({ requestId, value: "MySQL" })).toThrow(
      "is not an option",
    );
    broker.respond({ requestId, value: "PostgreSQL" });
    await expect(selection).resolves.toBe("PostgreSQL");

    broker.dispose();
  });

  it("settles pending requests on abort and disposal", async () => {
    const broker = createHttpUiBroker();
    broker.attachBaseContext(fallback);
    const controller = new AbortController();
    const input = broker.uiContext.input("Name", undefined, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(input).resolves.toBeUndefined();

    const confirmation = broker.uiContext.confirm("Continue?", "Pending work");
    broker.dispose();
    await expect(confirmation).resolves.toBe(false);
  });

  it("cancels pending requests without disposing the broker", async () => {
    const broker = createHttpUiBroker();
    broker.attachBaseContext(fallback);
    broker.uiContext.setStatus("agent", "busy");
    const requestIds: string[] = [];
    broker.subscribe((event) => {
      if (event.type === "ui_request") requestIds.push(event.request.id);
    });

    const confirmation = broker.uiContext.confirm("Run destructive command?", "rm -rf build");
    const selection = broker.uiContext.select("Database", ["SQLite", "PostgreSQL"]);
    broker.cancelPending();
    await expect(confirmation).resolves.toBe(false);
    await expect(selection).resolves.toBeUndefined();

    for (const requestId of requestIds) {
      let responseError: unknown;
      try {
        broker.respond({ requestId, cancelled: true });
      } catch (error) {
        responseError = error;
      }
      expect(responseError).toBeInstanceOf(HttpUiResponseError);
      expect(responseError).toMatchObject({ code: "not_found" });
    }

    // The broker stays operational: retained events replay and new requests resolve.
    const events: HttpUiBrokerEvent[] = [];
    broker.subscribe((event) => events.push(event));
    expect(events).toEqual([
      { type: "ui_event", event: { method: "status", key: "agent", text: "busy" } },
    ]);
    const next = broker.uiContext.confirm("Continue?", "Pending work");
    const nextEvent = events.find((event) => event.type === "ui_request");
    expect(nextEvent?.type).toBe("ui_request");
    if (nextEvent?.type !== "ui_request") throw new Error("Missing UI request");
    broker.respond({ requestId: nextEvent.request.id, confirmed: true });
    await expect(next).resolves.toBe(true);

    broker.dispose();
  });

  it("replays current UI state and pending requests to new subscribers", async () => {
    const broker = createHttpUiBroker();
    broker.attachBaseContext(fallback);
    broker.uiContext.notify("Transient");
    broker.uiContext.setStatus("agent", "idle");
    broker.uiContext.setTitle("DSCode");
    const confirmation = broker.uiContext.confirm("Continue?", "Pending work");

    const events: HttpUiBrokerEvent[] = [];
    broker.subscribe((event) => events.push(event));
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: "ui_event",
      event: { method: "status", key: "agent", text: "idle" },
    });
    expect(events[1]).toEqual({
      type: "ui_event",
      event: { method: "title", title: "DSCode" },
    });
    const request = events[2];
    if (request?.type !== "ui_request") throw new Error("Missing pending request");
    broker.respond({ requestId: request.request.id, cancelled: true });
    await expect(confirmation).resolves.toBe(false);
    broker.dispose();
  });

  it("publishes UI and session events and supports unsubscribe", () => {
    const broker = createHttpUiBroker();
    broker.attachBaseContext(fallback);
    const events: HttpUiBrokerEvent[] = [];
    const unsubscribe = broker.subscribe((event) => events.push(event));

    broker.uiContext.notify("Ready", "info");
    broker.uiContext.setStatus("agent", "idle");
    broker.uiContext.setTitle("DSCode");
    broker.uiContext.setWidget("plan", ["Step 1"], { placement: "aboveEditor" });
    broker.publishSessionEvent({ type: "agent_start" } as AgentSessionEvent);

    expect(events.map((event) => event.type)).toEqual([
      "ui_event",
      "ui_event",
      "ui_event",
      "ui_event",
      "session",
    ]);
    expect(events[3]).toEqual({
      type: "ui_event",
      event: {
        method: "widget",
        key: "plan",
        lines: ["Step 1"],
        placement: "aboveEditor",
      },
    });

    unsubscribe();
    broker.uiContext.notify("Ignored");
    expect(events).toHaveLength(5);
    broker.dispose();
  });
});
