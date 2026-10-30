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
/** The text the page-mode test pages hold: five of the mistakes of the canned check reply. */
export const PAGE_MODE_TEXT =
  "Yesterday I seen my friend at the market. He go to school every day, and he make a photo of everything.";

/** The head and the plain style shared by the page-mode test pages: nothing varies between runs. */
const pageHead = (title, extraCss = "") => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font: 16px/1.5 sans-serif; margin: 0; padding: 40px 60px; color: #1d2024; background: #fff; }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p.note { margin: 0 0 16px; color: #555; }
      label { display: block; margin: 16px 0 4px; font-weight: 600; }
      textarea, input[type="text"], input[type="password"], input[type="email"], input[type="search"],
      input:not([type]), .editable {
        box-sizing: border-box; width: 560px; font: 16px/1.5 sans-serif; padding: 8px 10px;
        border: 1px solid #8a919c; border-radius: 4px; background: #fff; color: #1d2024;
      }
      textarea { height: 150px; resize: none; display: block; }
      .editable { min-height: 150px; }
      .editable p { margin: 0 0 8px; }
      ${extraCss}
    </style>
  </head>
`;

/**
 * Test pages the harness opens in normal tabs (`GET /pages/<name>`), served from the same fixed
 * address as the LLM so that they are web pages like any other. `selection.html` has text to
 * select for the web page menu (SPEC section 4.1). The others are for page mode (SPEC section
 * 4.11): each holds a text box with `PAGE_MODE_TEXT`, or the fields page mode must leave alone.
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
  "textarea.html":
    pageHead("A message form") +
    `  <body>
    <h1>Write to us</h1>
    <p class="note">A plain text box on a plain page.</p>
    <label for="box">Your message</label>
    <textarea id="box">${PAGE_MODE_TEXT}</textarea>
    <p class="note" id="below">Below the text box.</p>
  </body>
</html>
`,
  "input.html":
    pageHead("A search form") +
    `  <body>
    <h1>Write a title</h1>
    <p class="note">A one-line text box.</p>
    <label for="box">Title</label>
    <input type="text" id="box" value="${PAGE_MODE_TEXT}" />
  </body>
</html>
`,
  "contenteditable.html":
    pageHead("A rich editor") +
    `  <body>
    <h1>Write a post</h1>
    <p class="note">An editable region.</p>
    <label id="label">Post</label>
    <div class="editable" id="box" contenteditable="true"><p>Yesterday I seen my friend at the market.</p><p>He go to school every day, and he make a photo of everything.</p></div>
  </body>
</html>
`,
  // Fields page mode must never read, check or touch (SPEC section 4.11), each with enough words
  // to be checked if it were allowed, and one plain text box at the end as the control.
  "excluded.html":
    pageHead(
      "Fields that are left alone",
      ".row { margin-bottom: 6px; } textarea { height: 56px; } label { margin: 10px 0 2px; }",
    ) +
    `  <body>
    <h1>Fields that are left alone</h1>
    <label for="password">Password</label>
    <input type="password" id="password" value="${PAGE_MODE_TEXT}" />
    <label for="email">Email</label>
    <input type="email" id="email" value="${PAGE_MODE_TEXT}" />
    <label for="nospell">Code (spellcheck off)</label>
    <textarea id="nospell" spellcheck="false">${PAGE_MODE_TEXT}</textarea>
    <label for="card">Card number (autocomplete cc-number)</label>
    <input type="text" id="card" autocomplete="cc-number" value="${PAGE_MODE_TEXT}" />
    <label for="optout">Marked data-english-tutor="off"</label>
    <div data-english-tutor="off"><textarea id="optout">${PAGE_MODE_TEXT}</textarea></div>
    <label for="control">A plain text box (the control)</label>
    <textarea id="control" style="height: 56px">${PAGE_MODE_TEXT}</textarea>
  </body>
</html>
`,
};

/**
 * Headers of test pages. `strict-csp.html` has `frame-src 'none'` and still works: in Firefox 159
 * a page's `frame-src` and `Cross-Origin-Embedder-Policy` do not apply to the extension's own frame
 * that a content script adds. `blocked-frame.html` has `Content-Security-Policy: sandbox
 * allow-same-origin`: the frame inherits the page's sandbox flags, so its script does not run and
 * never answers (`PageFrameBlocked`).
 */
export const PAGE_HEADERS = {
  "strict-csp.html": { "content-security-policy": "frame-src 'none'" },
  "blocked-frame.html": { "content-security-policy": "sandbox allow-same-origin" },
};

PAGES["strict-csp.html"] = PAGES["textarea.html"].replace(
  "<title>A message form</title>",
  "<title>A strict page</title>",
);
PAGES["blocked-frame.html"] = PAGES["textarea.html"].replace(
  "<title>A message form</title>",
  "<title>A page that embeds nothing</title>",
);

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
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...(PAGE_HEADERS[url.pathname.slice(7)] ?? {}),
      });
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
