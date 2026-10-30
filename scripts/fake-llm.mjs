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

/**
 * A longer text for the scrolled textarea (Step 15): twelve lines, with a mistake in the fourth,
 * the sixth and the tenth, so that a box of five lines scrolled halfway shows one of them.
 */
export const LONG_TEXT = [
  "Last week my family and I went on a trip to the mountains.",
  "We packed the car early and drove for almost four hours.",
  "The road was long, but the views were beautiful.",
  "My sister seen a deer near the lake, and she was very happy.",
  "In the evening we cooked dinner together by the fire.",
  "My father tell us old stories about his childhood.",
  "Everyone laughed until it was very late at night.",
  "On Sunday we walked to a small waterfall above the village.",
  "The water was cold, so we only stayed for a few minutes.",
  "My brother make a photo of the whole group there.",
  "Then we ate lunch and started the long drive back home.",
  "I hope we can visit the mountains again next summer.",
].join("\n");

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

// The same page with no blinking caret, for the popover's screenshots (the box keeps the focus
// while the popover is open, and a caret that blinks would make the picture differ between runs).
PAGES["textarea-still.html"] = PAGES["textarea.html"]
  .replace("<title>A message form</title>", "<title>A message form with a still caret</title>")
  .replace("</style>", "textarea { caret-color: transparent; }\n    </style>");

// A dark page: the underlines use their dark colours on it (SPEC section 4.11).
PAGES["textarea-dark.html"] =
  pageHead(
    "A dark message form",
    `body { background: #14161a; color: #e6e8eb; }
      p.note { color: #9aa1ac; }
      textarea { background: #1e2127; color: #e6e8eb; border-color: #4a505a; }`,
  ) +
  `  <body>
    <h1>Write to us</h1>
    <p class="note">A plain text box on a dark page.</p>
    <label for="box">Your message</label>
    <textarea id="box">${PAGE_MODE_TEXT}</textarea>
    <p class="note" id="below">Below the text box.</p>
  </body>
</html>
`;
// A long text in a box of five lines, to scroll.
PAGES["textarea-long.html"] =
  pageHead("A long message", "textarea { height: 140px; caret-color: transparent; }") +
  `  <body>
    <h1>Write to us</h1>
    <p class="note">A text box with more text than it shows.</p>
    <label for="box">Your message</label>
    <textarea id="box">${LONG_TEXT}</textarea>
    <p class="note" id="below">Below the text box.</p>
  </body>
</html>
`;
// The text box is at the bottom of the window, so that the popover goes above the underline.
PAGES["textarea-bottom.html"] =
  pageHead(
    "A message form at the bottom",
    ".spacer { height: 470px; } textarea { caret-color: transparent; }",
  ) +
  `  <body>
    <h1>Write to us</h1>
    <p class="note">The text box is at the bottom of the window.</p>
    <div class="spacer"></div>
    <label for="box">Your message</label>
    <textarea id="box">${PAGE_MODE_TEXT}</textarea>
  </body>
</html>
`;

// Step 18: editors as real sites build them (SPEC section 4.11, "Which text boxes"). Each one is
// made by the page's own script after load, as a single-page app does.

/** The text of the editors, as paragraphs. */
const PARAGRAPHS = [
  "Yesterday I seen my friend at the market.",
  "He go to school every day, and he make a photo of everything.",
];

// A Quill editor (LinkedIn's post composer is built with Quill) in a modal that the page inserts
// after load and focuses by script, while the modal is still growing into place. The modal has
// `spellcheck="false"`, as sites set it on a whole form, and the editor has `data-gramm="false"`.
PAGES["quill.html"] =
  pageHead(
    "A Quill editor in a modal",
    `.backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); }
      .modal { position: fixed; left: 160px; top: 90px; width: 640px; background: #fff; border-radius: 8px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35); padding: 18px 20px 22px; transform: scale(0.04);
        transition: transform 0.3s ease-out; transform-origin: top left; }
      .modal.shown { transform: scale(1); }
      .modal h2 { margin: 0 0 12px; font-size: 18px; }
      .ql-container { font: 16px/1.42 sans-serif; }
      .ql-editor { box-sizing: border-box; min-height: 180px; padding: 12px 15px; outline: none; caret-color: transparent; }
      .ql-editor p { margin: 0; }
      .ql-editor.ql-blank::before { content: attr(data-placeholder); color: #888; position: absolute; }`,
  ) +
  `  <body>
    <h1>Your feed</h1>
    <p class="note">A page whose post composer opens in a modal.</p>
    <script>
      setTimeout(() => {
        const backdrop = document.createElement("div");
        backdrop.className = "backdrop";
        const modal = document.createElement("div");
        modal.className = "modal";
        modal.setAttribute("role", "dialog");
        modal.setAttribute("spellcheck", "false");
        const title = document.createElement("h2");
        title.textContent = "Create a post";
        const container = document.createElement("div");
        container.className = "ql-container";
        const editor = document.createElement("div");
        editor.id = "box";
        editor.className = "ql-editor";
        editor.setAttribute("contenteditable", "true");
        editor.setAttribute("role", "textbox");
        editor.setAttribute("aria-multiline", "true");
        editor.setAttribute("aria-label", "Text editor for creating content");
        editor.setAttribute("data-gramm", "false");
        editor.setAttribute("data-placeholder", "What do you want to talk about?");
        for (const text of ${JSON.stringify(PARAGRAPHS)}) {
          const p = document.createElement("p");
          p.textContent = text;
          editor.append(p);
        }
        container.append(editor);
        modal.append(title, container);
        document.body.append(backdrop, modal);
        // Focused by script right after it is inserted, while it is still growing.
        editor.focus();
        requestAnimationFrame(() => modal.classList.add("shown"));
      }, 400);
    </script>
  </body>
</html>
`;

// A message box like the one in LinkedIn's messaging: a form that a single-page app adds later,
// with a `contenteditable` div whose empty state is `<p><br></p>`, inside `spellcheck="false"`.
PAGES["spa-message.html"] =
  pageHead(
    "A message box added by a single-page app",
    `.msg { width: 560px; border: 1px solid #8a919c; border-radius: 6px; padding: 0; }
      .msg-form__contenteditable { box-sizing: border-box; min-height: 120px; padding: 10px 12px; outline: none; font: 16px/1.5 sans-serif; }
      .msg-form__contenteditable p { margin: 0; }
      .msg-form__contenteditable p:only-child:has(> br:only-child)::before { content: "Write a message..."; color: #888; position: absolute; }
      .msg-footer { display: flex; justify-content: flex-end; padding: 6px 10px; border-top: 1px solid #d5d9df; }
      .msg-footer button { font: 600 14px sans-serif; padding: 4px 14px; }`,
  ) +
  `  <body>
    <h1>Messaging</h1>
    <p class="note">The form is not in the page when it loads.</p>
    <div id="app"></div>
    <script>
      setTimeout(() => {
        const form = document.createElement("form");
        form.className = "msg";
        form.setAttribute("spellcheck", "false");
        const box = document.createElement("div");
        box.id = "box";
        box.className = "msg-form__contenteditable";
        box.setAttribute("contenteditable", "true");
        box.setAttribute("role", "textbox");
        box.setAttribute("aria-multiline", "true");
        box.setAttribute("aria-label", "Write a message...");
        const p = document.createElement("p");
        p.append(document.createElement("br"));
        box.append(p);
        const footer = document.createElement("div");
        footer.className = "msg-footer";
        const send = document.createElement("button");
        send.type = "button";
        send.textContent = "Send";
        footer.append(send);
        form.append(box, footer);
        document.getElementById("app").append(form);
      }, 500);
    </script>
  </body>
</html>
`;

// Step 20: a page that changes the text of its own boxes from its script, as sites do after a
// message is sent, when a form is reset or when a framework renders again. None of these changes
// fires an `input` event. Every button is clicked by the harness (SPEC section 4.11, "Checking").
// The boxes have no blinking caret, so that a picture is the same on every run.
const REPLACED_TEXT =
  "Yesterday I saw my friend at the park. He go to school every day, and he make a photo of everything.";
const REPLACED_PARAGRAPHS = [
  "Yesterday I saw my friend at the park.",
  "He go to school every day, and he make a photo of everything.",
];
PAGES["text-sync.html"] =
  pageHead(
    "A page that rewrites its own boxes",
    `textarea, input[type="text"], .editable { caret-color: transparent; }
      textarea { height: 120px; }
      .editable { min-height: 100px; }
      .row { display: flex; gap: 8px; margin: 8px 0 0; }
      .row button { font: 14px sans-serif; padding: 4px 12px; }
      #sent { margin: 6px 0 0; min-height: 24px; color: #1b7a3d; font-weight: 600; }
      label { margin: 10px 0 4px; }`,
  ) +
  `  <body>
    <h1>Rewrites its own boxes</h1>
    <form id="form">
      <label for="box">Your message</label>
      <textarea id="box"></textarea>
      <div class="row">
        <button type="button" id="send">Send</button>
        <button type="button" id="replace">Replace</button>
        <button type="button" id="reset-form">Reset the form</button>
        <button type="button" id="recreate">Render again</button>
      </div>
      <p id="sent"></p>
      <label for="line">Title</label>
      <input type="text" id="line" />
      <div class="row"><button type="button" id="line-clear">Clear the title</button></div>
    </form>
    <label id="editor-label">Post</label>
    <div class="editable" id="editor" contenteditable="true" role="textbox"></div>
    <div class="row">
      <button type="button" id="editor-clear">Clear the post</button>
      <button type="button" id="editor-replace">Replace the post</button>
      <button type="button" id="editor-text">textContent</button>
    </div>
    <script>
      const $ = (id) => document.getElementById(id);
      const TEXT = ${JSON.stringify(PAGE_MODE_TEXT)};
      const paragraphs = (editor, texts) => {
        const nodes = texts.map((text) => {
          const p = document.createElement("p");
          p.textContent = text;
          return p;
        });
        editor.replaceChildren(...nodes);
      };
      // The default values stay empty: form.reset() empties the boxes.
      $("box").value = TEXT;
      $("line").value = TEXT;
      paragraphs($("editor"), ${JSON.stringify(PARAGRAPHS)});
      $("send").addEventListener("click", () => {
        $("box").value = "";
        $("sent").textContent = "Message sent.";
      });
      $("replace").addEventListener("click", () => {
        $("box").value = ${JSON.stringify(REPLACED_TEXT)};
      });
      $("reset-form").addEventListener("click", () => $("form").reset());
      $("recreate").addEventListener("click", () => {
        // The framework renders the composer again: a new element at the same place, same text.
        const fresh = document.createElement("textarea");
        fresh.id = "box";
        fresh.value = $("box").value;
        $("box").replaceWith(fresh);
      });
      $("line-clear").addEventListener("click", () => {
        $("line").value = "";
      });
      $("editor-clear").addEventListener("click", () => {
        // What React does for an emptied Draft.js or Lexical editor: one empty paragraph.
        const p = document.createElement("p");
        p.append(document.createElement("br"));
        $("editor").replaceChildren(p);
      });
      $("editor-replace").addEventListener("click", () => {
        paragraphs($("editor"), ${JSON.stringify(REPLACED_PARAGRAPHS)});
      });
      $("editor-text").addEventListener("click", () => {
        $("editor").textContent = "";
      });
    </script>
  </body>
</html>
`;

// A web component with an open shadow root (Lit and others): the editor is inside it.
PAGES["shadow.html"] =
  pageHead(
    "A web component editor",
    "message-box { display: block; width: 560px; height: 160px; background: #f1f4f8; border-radius: 6px; }",
  ) +
  `  <body>
    <h1>Write a note</h1>
    <p class="note">The editor is inside an open shadow root.</p>
    <message-box id="box"></message-box>
    <script>
      class MessageBox extends HTMLElement {
        constructor() {
          super();
          const root = this.attachShadow({ mode: "open" });
          const style = document.createElement("style");
          style.textContent = ".editor { box-sizing: border-box; width: 100%; height: 100%; padding: 8px 10px; background: #fff; color: #1d2024; font: 16px/1.5 sans-serif; outline: none; overflow: auto; caret-color: transparent; }";
          const editor = document.createElement("div");
          editor.className = "editor";
          editor.setAttribute("contenteditable", "true");
          editor.setAttribute("role", "textbox");
          editor.setAttribute("aria-multiline", "true");
          for (const text of ${JSON.stringify(PARAGRAPHS)}) {
            const p = document.createElement("p");
            p.style.margin = "0";
            p.textContent = text;
            editor.append(p);
          }
          root.append(style, editor);
        }
      }
      customElements.define("message-box", MessageBox);
    </script>
  </body>
</html>
`;

// A text box that has the focus from the start: `autofocus` focuses it while the page loads, long
// before the content script starts at document_idle.
PAGES["autofocus.html"] = PAGES["textarea.html"]
  .replace("<title>A message form</title>", "<title>An autofocused text box</title>")
  .replace('<textarea id="box">', '<textarea id="box" autofocus>')
  .replace("</style>", "textarea { caret-color: transparent; }\n    </style>");

// Three editors in iframes, as sites embed them: one `about:blank` document that the page writes
// (TinyMCE, CKEditor 4), one `srcdoc`, and one from another origin (the same server under the
// name `localhost`). Each has a `contenteditable` body, the way those editors do.
const IFRAME_BODY_CSS =
  "html { height: 100%; } body { box-sizing: border-box; height: 100%; margin: 0; padding: 8px 10px; font: 16px/1.5 sans-serif; color: #1d2024; background: #fff; outline: none; caret-color: transparent; } p { margin: 0; }";
const iframeDocument = (title) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${IFRAME_BODY_CSS}</style></head><body id="box" contenteditable="true">${PARAGRAPHS.map((t) => `<p>${t}</p>`).join("")}</body></html>`;
PAGES["iframe-inner.html"] = iframeDocument("An editor from another origin");
PAGES["iframes.html"] =
  pageHead(
    "Editors in iframes",
    `.frames { display: flex; gap: 14px; }
      iframe { box-sizing: border-box; width: 390px; height: 230px; border: 1px solid #8a919c; border-radius: 4px; }
      .caption { font: 600 13px sans-serif; margin: 0 0 4px; color: #333; }`,
  ).replace("padding: 40px 60px", "padding: 30px 30px") +
  `  <body>
    <h1>Editors in iframes</h1>
    <div class="frames">
      <div><p class="caption">about:blank, written by the page</p><iframe id="blank" title="about blank editor"></iframe></div>
      <div><p class="caption">srcdoc</p><iframe id="srcdoc" title="srcdoc editor"></iframe></div>
      <div><p class="caption">another origin</p><iframe id="cross" title="cross origin editor" src="{{OTHER_ORIGIN}}/pages/iframe-inner.html"></iframe></div>
    </div>
    <script>
      const html = ${JSON.stringify(iframeDocument("An editor"))};
      const blank = document.getElementById("blank").contentDocument;
      blank.open();
      blank.write(html);
      blank.close();
      document.getElementById("srcdoc").srcdoc = html;
    </script>
  </body>
</html>
`;

// Editors that say "I am code" in different ways, and prose editors that set spellcheck="false".
const field = (id, label, markup) => `<div class="row"><label>${label}</label>${markup}</div>`;
PAGES["editors.html"] =
  pageHead(
    "Which editors count",
    `.row { margin-bottom: 4px; } label { margin: 6px 0 2px; font-size: 13px; }
      textarea, .ed { box-sizing: border-box; width: 560px; height: 44px; font: 15px/1.4 sans-serif; padding: 4px 8px; border: 1px solid #8a919c; background: #fff; display: block; overflow: hidden; }`,
  ).replace("padding: 40px 60px", "padding: 16px 60px") +
  `  <body>
    <h1 style="font-size: 18px">Which editors count</h1>
    ${field("prose", "Prose editor (Quill) with spellcheck=false", `<div id="prose" class="ed ql-editor" contenteditable="true" role="textbox" spellcheck="false" data-gramm="false"><p>${PARAGRAPHS[0]}</p></div>`)}
    ${field("form", "Editable inside a form with spellcheck=false", `<form spellcheck="false"><div id="form" class="ed" contenteditable="true" role="textbox">${PARAGRAPHS[0]}</div></form>`)}
    ${field("cm6", "CodeMirror 6 (spellcheck, autocorrect, autocapitalize off)", `<div class="cm-editor"><div id="cm6" class="ed cm-content" contenteditable="true" role="textbox" spellcheck="false" autocorrect="off" autocapitalize="off">${PARAGRAPHS[0]}</div></div>`)}
    ${field("cm5", "CodeMirror 5 (hidden textarea)", `<div class="CodeMirror"><textarea id="cm5">${PARAGRAPHS[0]}</textarea></div>`)}
    ${field("monaco", "Monaco (input area)", `<div class="monaco-editor"><textarea id="monaco" class="inputarea">${PARAGRAPHS[0]}</textarea></div>`)}
    ${field("ace", "Ace (text input)", `<div class="ace_editor"><textarea id="ace" class="ace_text-input">${PARAGRAPHS[0]}</textarea></div>`)}
    ${field("native", "Plain textarea with spellcheck=false", `<textarea id="native" spellcheck="false">${PARAGRAPHS[0]}</textarea>`)}
    ${field("pre", "A pre that is editable", `<pre id="pre" class="ed" contenteditable="true" style="margin: 0">${PARAGRAPHS[0]}</pre>`)}
  </body>
</html>
`;

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
      // The same server under another name is another origin (`{{OTHER_ORIGIN}}`).
      const port = (req.headers.host ?? "").split(":")[1] ?? "80";
      res.end(page.replaceAll("{{OTHER_ORIGIN}}", `http://localhost:${port}`));
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
