// Offline OpenAI provider for the streaming demo: no credentials, no
// billable requests. `OFFLINE_AI_SETTINGS` is plain data. `seedAISettings`,
// `seedMissingAISettings`, `openAIStreamMock`, and `pendingOpenAIMock` are
// page init scripts:
// register them with `page.addInitScript(fn, arg)` before the page
// navigates. Playwright serializes each init script on its own, so they
// cannot call each other. `fulfillOpenAI` (with its `sseBody`) runs in Node and
// answer `page.route` requests.

/** Provider settings the demo reads to talk to the (mocked) Responses API. */
export const OFFLINE_AI_SETTINGS = {
  provider: "openai",
  apiKey: "offline-test",
  model: "gpt-5-mini",
};

/** Seed the demo's AI settings, e.g. with `OFFLINE_AI_SETTINGS`. */
export function seedAISettings(settings) {
  localStorage.setItem("virtual-list:ai-settings", JSON.stringify(settings));
}

/**
 * Seed the demo's AI settings only when none are stored, so settings the
 * page changed survive a reload.
 */
export function seedMissingAISettings(settings) {
  if (!localStorage.getItem("virtual-list:ai-settings"))
    localStorage.setItem("virtual-list:ai-settings", JSON.stringify(settings));
}

/** A Server-Sent Events body that streams `events` in order. */
function sseBody(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** Answer a routed Responses API request with `events` as an SSE stream. */
export function fulfillOpenAI(route, events) {
  return route.fulfill({
    contentType: "text/event-stream",
    body: sseBody(events),
  });
}

/**
 * Seed `settings` (usually `OFFLINE_AI_SETTINGS`) and answer every request
 * to the OpenAI API with a Server-Sent Events stream the test drives through
 * window hooks:
 *
 * - `emitText`: name of a `window` hook that streams one
 *   `response.output_text.delta` with its `delta` argument.
 * - `emitEvent`: name of a `window` hook that streams a raw event object.
 * - `finish`: name of a `window` hook that ends the stream, after a
 *   `response.completed` event when `responseId` is set.
 * - `initialText`: a delta streamed as soon as the response starts.
 *
 * Aborting the request errors the stream with an AbortError.
 */
export function openAIStreamMock({
  settings,
  emitText,
  emitEvent,
  finish,
  responseId,
  initialText,
}) {
  localStorage.setItem("virtual-list:ai-settings", JSON.stringify(settings));
  const original = window.fetch;
  window.fetch = (input, init) => {
    if (!String(input).startsWith("https://api.openai.com/"))
      return original(input, init);
    const encoder = new TextEncoder();
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            const send = (event) =>
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            const sendText = (delta) =>
              send({ type: "response.output_text.delta", delta });
            if (emitText) window[emitText] = sendText;
            if (emitEvent) window[emitEvent] = send;
            if (finish)
              window[finish] = () => {
                if (responseId)
                  send({
                    type: "response.completed",
                    response: {
                      id: responseId,
                      status: "completed",
                      output: [],
                    },
                  });
                controller.close();
              };
            if (initialText) sendText(initialText);
            init.signal.addEventListener(
              "abort",
              () =>
                controller.error(new DOMException("Cancelled", "AbortError")),
              { once: true },
            );
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
  };
}

/**
 * Hold every request to the OpenAI API open without answering it; other
 * requests pass through. Records requests in `window` properties:
 *
 * - `counter`: name of a property that counts requests, starting at 0.
 * - `body`: name of a property that holds the latest parsed request body.
 * - `started`: name of a flag set to `true` on the first request.
 * - `aborted`: name of a flag set to `true` when a request is aborted.
 * - `finishers`: when set, requests ignore their abort signal. The first
 *   request's rejection is exposed as `window.finishOldRequest`, later ones
 *   as `window.finishNewRequest`.
 *
 * Without `finishers`, aborting a request rejects it with an AbortError.
 */
export function pendingOpenAIMock({
  counter,
  body,
  started,
  aborted,
  finishers = false,
} = {}) {
  const original = window.fetch;
  if (counter) window[counter] = 0;
  window.fetch = (input, init) => {
    if (!String(input).startsWith("https://api.openai.com/"))
      return original(input, init);
    if (counter) window[counter]++;
    if (body) window[body] = JSON.parse(init.body);
    if (started) window[started] = true;
    return new Promise((_resolve, reject) => {
      const cancel = () => reject(new DOMException("Cancelled", "AbortError"));
      if (finishers) {
        if (!window.finishOldRequest) window.finishOldRequest = cancel;
        else window.finishNewRequest = cancel;
        return;
      }
      init.signal.addEventListener(
        "abort",
        () => {
          if (aborted) window[aborted] = true;
          cancel();
        },
        { once: true },
      );
    });
  };
}
