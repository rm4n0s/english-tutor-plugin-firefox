// A fake OpenAI-compatible LLM server for the screenshot harness (SPEC section 6, IMPLEMENTATION.md
// "Screenshot harness"). It listens on 127.0.0.1 and answers `POST /v1/chat/completions`, streaming
// or not, from replies that a scenario chooses. It never talks to the network.
import { createServer } from "node:http";

/** What the server answers when a scenario has not chosen anything. A valid check reply (SPEC 5.2). */
export const DEFAULT_REPLY = {
  content: JSON.stringify({
    issues: [
      {
        text: "He go to school",
        error_type: "subject_verb_agreement",
        message: "Use goes.",
        context_before: "",
        context_after: " every day.",
      },
    ],
  }),
  usage: { prompt_tokens: 812, completion_tokens: 164 },
};

/**
 * A reply is `{ content, usage?, status?, delayMs? }`. A reply chooser is a function
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

  async start() {
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    return this.baseUrl;
  }

  get baseUrl() {
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("server is not listening");
    return `http://127.0.0.1:${address.port}/v1`;
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
      for (const word of words) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: word } }] })}\n\n`,
        );
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
