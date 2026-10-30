// A fake OpenAI-compatible LLM server for the screenshot harness (SPEC section 6, IMPLEMENTATION.md
// "Screenshot harness"). It listens on 127.0.0.1 and answers `POST /v1/chat/completions`, streaming
// or not, from replies that a scenario chooses. It never talks to the network.
import { createServer } from "node:http";
import canned from "../src/core/llm/testing/canned.json" with { type: "json" };

/**
 * What the server answers when a scenario has not chosen anything: a valid check reply (SPEC 5.2).
 * The values are shared with the unit tests' fake fetch (src/core/llm/testing/canned.json).
 */
export const DEFAULT_REPLY = {
  content: JSON.stringify(canned.checkReply),
  usage: { prompt_tokens: canned.usage.input, completion_tokens: canned.usage.output },
};

/** The reply of Test connection (SPEC 4.7). */
export const OK_REPLY = {
  content: canned.testReply,
  usage: { prompt_tokens: 12, completion_tokens: 1 },
};

/**
 * Test pages the harness opens in normal tabs (`GET /pages/<name>`), served from the same fixed
 * address as the LLM so that they are web pages like any other. `selection.html` has text to
 * select for the web page menu (SPEC section 4.1).
 */
export const PAGES = {
  "selection.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>A test article</title>
    <style>
      body { font: 18px/1.6 sans-serif; max-width: 40em; margin: 3em auto; color: #1d2024; background: #fff; }
    </style>
  </head>
  <body>
    <h1>A test article</h1>
    <p id="selected">Yesterday I seen my friend at the market. He go to school every day, and he make a photo of everything.</p>
    <p>My sentence sounds odd: <span id="phrase">make a photo</span> of everything. Which words are better?</p>
    <p>This page only holds some text to select.</p>
  </body>
</html>
`,
};

/**
 * A reply is `{ content, usage?, status?, delayMs?, wordDelayMs?, stallAfterWords? }`. A streamed
 * reply sends one word at a time, `wordDelayMs` apart; with `stallAfterWords` it sends that many
 * words and then holds the connection open until the client goes away, so that a screenshot can
 * catch a stream half way, always at the same word. A reply chooser is a function
 * `(request) => reply`, where `request` is `{ path, body }` with the parsed JSON body.
 */
export class FakeLLMServer {
  #server = createServer((req, res) => {
    this.#handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    });
  });
  #choose = () => DEFAULT_REPLY;
  #requests = [];

  /** Chooses the replies of the next requests: a reply, or a function from request to reply. */
  setReplies(replies) {
    this.#choose = typeof replies === "function" ? replies : () => replies;
  }

  /** Back to the default canned reply. */
  reset() {
    this.#choose = () => DEFAULT_REPLY;
    this.#requests = [];
  }

  /** The requests received since the last reset (path and parsed body). */
  get requests() {
    return [...this.#requests];
  }

  /**
   * Starts listening on 127.0.0.1. A fixed port keeps the address that the screenshots show the
   * same on every run; `port` 0 picks a free one. If the port is busy it fails at once, saying so.
   */
  async start(port = 0) {
    await new Promise((resolve, reject) => {
      this.#server.once("error", (err) => {
        reject(
          err.code === "EADDRINUSE"
            ? new Error(
                `port ${port} on 127.0.0.1 is busy. Stop what uses it, or choose another port with FAKE_LLM_PORT.`,
              )
            : err,
        );
      });
      this.#server.listen(port, "127.0.0.1", resolve);
    });
    return this.baseUrl;
  }

  get baseUrl() {
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("server is not listening");
    return `http://127.0.0.1:${address.port}/v1`;
  }

  /** The address of a test page (`PAGES`). */
  pageUrl(name) {
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("server is not listening");
    return `http://127.0.0.1:${address.port}/pages/${name}`;
  }

  async stop() {
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  async #handle(req, res) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      return;
    }
    const page = url.pathname.startsWith("/pages/") ? PAGES[url.pathname.slice(7)] : undefined;
    if (req.method === "GET" && page !== undefined) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      res.writeHead(404, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    this.#requests.push({ path: url.pathname, body });

    const reply = this.#choose({ path: url.pathname, body });
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    const status = reply.status ?? 200;
    if (status !== 200) {
      res.writeHead(status, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: reply.content ?? "error" } }));
      return;
    }

    const usage = reply.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
    if (body.stream === true) {
      res.writeHead(200, {
        ...cors,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const words = reply.content.match(/\S+\s*/g) ?? [];
      for (const [index, word] of words.entries()) {
        if (reply.stallAfterWords !== undefined && index >= reply.stallAfterWords) {
          if (!res.closed) await new Promise((resolve) => res.on("close", resolve));
          return;
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: word } }] })}\n\n`,
        );
        if (reply.wordDelayMs)
          await new Promise((resolve) => setTimeout(resolve, reply.wordDelayMs));
      }
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        model: body.model ?? "fake-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: reply.content },
            finish_reason: "stop",
          },
        ],
        usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
      }),
    );
  }
}
