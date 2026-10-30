# English Tutor for Firefox: Specification

Status: draft v0.1

## 1. Purpose

A Firefox extension for practising written English. It does in the browser what the desktop application [English Tutor](https://github.com/rm4n0s/english-tutor) does on Linux. The user writes a sentence or an essay in the extension's editor page. An LLM finds grammar, vocabulary and syntax errors, and the editor underlines them, with a different colour and line style for each category. When the user selects an error, a side panel explains why it is wrong and shows better alternatives, rendered from the LLM's markdown. The extension counts how often the user makes each kind of mistake, so the user can see what to work on.

The extension also checks what the user writes in text boxes on web pages, if the user turns that on (page mode, section 4.11): it underlines the errors inside the text box, shows the number of errors on a badge, and shows the LLM's explanation of an error in a dialog or when the user clicks the underline. And it adds entries to the right-click menu of web pages, so text selected on any page can be checked in the editor page.

## 2. Goals and non-goals

**Goals**
- Write English text in a plain editor page, with LLM-detected errors underlined and coloured by category.
- Learn from each error: a markdown explanation and better alternatives, next to the editor.
- Ask for other ways to write a selected word, sentence or paragraph, from the editor's right-click menu (sections 4.6 and 5.10).
- Send text selected on any web page to the editor page and check it there (section 4.1).
- Check text boxes on web pages in place, with underlines, an error-count badge, an issues dialog and an explanation popover (page mode, section 4.11).
- Choose which LLM is used from a selector above the editor, and manage the LLM list on the options page.
- Open and download text files, and keep documents in a library inside the extension.
- Count mistakes by error type, so the user sees which mistakes they repeat.
- Behave like the desktop application wherever a browser allows it. Section 2.2 lists every place where it differs.

**Non-goals (v1)**
- Page mode (section 4.11) never changes the text of a web page: it does not apply corrections or alternatives inside a text box. The Alternatives panel exists only in the tutor page.
- No checking of rich editors that draw their own text without a text box or `contenteditable` (for example canvas-based editors such as Google Docs).
- No rich text formatting; the editor is plain text.
- No offline or rule-based checker; every error comes from the LLM.
- No language other than English as the text being checked. Explanations are in English.
- No accounts, no sync (`storage.sync` is not used), and no cloud storage of the extension's own.
- No browser other than Firefox for desktop. No Firefox for Android, no Chrome build.
- No lessons, exercises or grades. Progress tracking is limited to the per-error-type counts (section 5.7).
- No equivalent of the desktop application's web server, system tray, single-instance lock or desktop entry.
- No private browsing: the extension sets `"incognito": "not_allowed"`, so it does not run in private windows.

### 2.1 Reference implementation

The desktop application is the reference for everything this spec says is "as in the desktop app": prompts, reply parsing, locating, chunking, the error taxonomy and its labels, fingerprints, and the statistics rules. The port follows tag `v0.1.3` (commit `92467a068d8876085482775adc90df5e6657b541`) of `github.com/rm4n0s/english-tutor`. Its `docs/SPEC.md` is called *desktop SPEC* below.

The prompts (check, retry reminder, explanation, alternatives, Test connection) are copied word for word from `internal/analysis` at that commit, so that a model behaves the same in both applications. A later change to the desktop prompts is ported on purpose, as its own change, and this section is updated to the new commit.

### 2.2 Desktop features and their browser equivalents

| Desktop application | Extension |
|---|---|
| Main window | **Tutor page** (`tutor.html`), an extension page in a normal tab. Several tutor tabs can be open; each has its own text (section 4.2) |
| Preferences dialog | **Options page** (`options.html`, `options_ui` with `open_in_tab`), opened from the Preferences button or from `about:addons` (section 4.7) |
| Statistics and Library dialogs | Modal `<dialog>` elements in the tutor page (sections 4.8 and 8) |
| Alternatives window | A floating, non-modal panel in the tutor page (section 4.6) |
| Editor right-click menu | The browser's context menu, extended with `menus.overrideContext` (section 4.3) |
| System tray, "Open" | Toolbar button and a keyboard command that focus a tutor tab (section 4.1) |
| "Check finished" desktop message | A `notifications` message when the tutor tab is in the background (section 4.10) |
| Open file, Save, Save As | File chooser (`<input type="file">`) to open, the `downloads` API to save (section 8) |
| `file:<path>` mistake source | None: a browser gives no file path, so an opened file starts a new `session:` source (section 5.7) |
| SQLite through gorm | IndexedDB, with numbered migrations (section 9) |
| langchaingo | Small `fetch` clients written for the three wire formats (section 6) |
| Log file | The browser console of the extension, with the same privacy rules (section 9.1) |
| Web server, single instance, `-setup-desktop` | Not applicable |
| (none) | **Page mode**: underlines, an error badge, an issues dialog and an explanation popover inside text boxes on web pages (section 4.11) |

## 3. Technology

| Concern | Choice |
|---|---|
| Platform | Firefox WebExtension, Manifest V3, Firefox 140 or newer (`strict_min_version` "140.0", the 140 ESR) |
| Language | TypeScript, `strict` mode |
| Bundler | esbuild (one bundle per entry point: background, tutor, options) |
| LLM access | `fetch` with streaming response bodies, no SDK (section 6) |
| Storage | IndexedDB through a small in-house promise wrapper (no `idb` library) |
| Markdown | A small in-house renderer that builds DOM nodes (section 5.9) |
| Tests | vitest. `fake-indexeddb` for the store and `happy-dom` for DOM components |
| Lint and format | eslint with typescript-eslint, prettier, and `web-ext lint` |
| Run and package | `web-ext` (`run`, `lint`, `build`) |
| Node.js | 24 LTS or newer, for development only |

### 3.1 Dependencies

No runtime dependencies: the shipped extension contains only this project's code.

These development dependencies are approved: `typescript`, `esbuild`, `vitest`, `happy-dom`, `fake-indexeddb`, `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`, `web-ext`, `@types/firefox-webext-browser` (the type definitions of the `browser` namespace), and `selenium-webdriver` (the screenshot harness drives a headless Firefox with it; its Selenium Manager downloads geckodriver). Anything else needs the user's approval before it is added (CLAUDE.md).

### 3.2 Manifest and permissions

- `browser_specific_settings.gecko.id`: `english-tutor@rm4n0s.dev`. `strict_min_version` is `140.0`. `gecko.data_collection_permissions` is `{"required": ["websiteContent"]}`: the text the user checks (typed, or selected on a web page) is sent to the LLM server the user configures. `web-ext lint` and AMO require the key, and it needs Firefox 140 or newer on desktop. `gecko_android.strict_min_version` is `142.0` only because `web-ext lint` demands it once `data_collection_permissions` is set; Firefox for Android is still not supported (section 2).
- `background.scripts`: one bundled script (an event page; Firefox MV3 has no service worker requirement).
- `action`: toolbar button with the extension's icon and the title "English Tutor".
- `options_ui`: `options.html`, `open_in_tab: true`.
- `commands`: `open-tutor`, suggested key `Alt+Shift+E`. The user can change it in `about:addons`.
- `content_security_policy.extension_pages`: the MV3 default (`script-src 'self'`), plus `style-src 'self'`. No inline script, no `eval`, no remote code.
- `incognito`: `not_allowed`.
- `permissions`: `storage` (`storage.session` for the hand-off, section 4.1), `menus`, `notifications`, `downloads`, `scripting` (to register the page-mode content script only while page mode is on, section 4.11).
- `optional_host_permissions`: `http://*/*`, `https://*/*`, `<all_urls>`. Nothing is granted at install. The options page asks for the origin of one LLM's base URL when that LLM is saved or tested (section 4.7), and for `<all_urls>` only when the user turns page mode on (section 4.11); turning page mode off removes it.
- `web_accessible_resources`: `[{ "resources": ["page-ui.html", "page-ui.js", "page-ui.css"], "matches": ["<all_urls>"] }]`, so the content script can load the page-mode frame (section 4.11). Firefox gives every install its own random `moz-extension://` address, so the address does not identify the extension across users.
- No static `content_scripts`, no `tabs`, no `activeTab`, and no `host_permissions`. Adding a permission is a change to this section.

## 4. User interface

### 4.1 Entry points

- **Toolbar button** and the **`open-tutor` command**: bring the most recently focused tutor tab to the front (its tab and its window). If no tutor tab is open, open one in the current window. The button's context menu (`menus` context `action`) adds **New tutor tab** and **Preferences**.
- **Web page context menu**: when text is selected on a page (`menus` context `selection`), two entries in an "English Tutor" submenu:
  - **Check with English Tutor**: opens a new tutor tab with the selection as a new text (a new `session:` source) and starts a manual check of the whole text.
  - **Alternatives with English Tutor**: opens a new tutor tab with the selection as a new text, selects all of it, and opens the Alternatives panel for it (section 4.6). Only offered when the selection has at most 600 words.
- **Hand-off.** The background script never puts the text in a URL (that would put it in the history). It stores `{ text, action }` in `storage.session` under a random key and opens `tutor.html#handoff=<key>`. The tutor page reads the entry, deletes it, and clears the fragment with `history.replaceState`. An entry that is missing (for example after a browser restart) shows `HandoffExpired` in the banner and opens an empty text. Entries older than 5 minutes are deleted by the background script when it next runs.
- The selection comes from `info.selectionText` of the menu click. Firefox can shorten very long selections there. This is accepted in v1 (section 13).
- **Finding tutor tabs** without the `tabs` permission: each tutor page learns its own tab id with `tabs.getCurrent()`, records the time it was last focused, and answers a `runtime` message `{ type: "tutor-ping" }` with `{ tabId, windowId, focusedAt, dirty }`. The background script asks all tutor pages and focuses the one with the latest `focusedAt` (`tabs.update(tabId, { active: true })` and `windows.update(windowId, { focused: true })`).

### 4.2 Tutor page

```
+----------------------------------------------------------------------+
| LLM: [ Claude Sonnet v ]  [Check]  [ ] Auto-check  [Stats] [Prefs]   |
| [New] [Open] [Save] [Save As] [Save to library] [Library]            |
| Legend:  ~~ grammar   -- vocabulary   .. syntax        [Clear][Copy] |
+----------------------------------------+-----------------------------+
| ! banner (failures, dismissible)       | Issues (3)                  |
|                                        | [G] He go to school         |
|  Text editor                           | [V] make a photo            |
|  (errors underlined by category)       | [S] I very like it          |
|                                        |-----------------------------|
|                                        | Subject-verb agreement      |
|                                        | Markdown explanation of     |
|                                        | the selected issue          |
+----------------------------------------------------------------------+
| 3 issues | 142 words | last: 812 in / 164 out · session: 5.2k / 1.1k  |
+----------------------------------------------------------------------+
```

- The editor and the right column are separated by a draggable divider; the right column has a second divider between the issues list and the explanation panel. Both positions are remembered (`pane_sizes`, section 9). Below 800 CSS pixels of width the right column moves under the editor.
- **Toolbar, row 1:** LLM selector (`<select>`), Check button (Cancel while a check runs, section 5.1; disabled while no LLM is selected or the text is empty or only white space), Auto-check checkbox (off by default; Check always works; it shows and saves the `auto_check` setting, announces the change with `settings-changed`, and follows a change made on the options page or in another tab. The pause is `auto_check_delay_s`, section 4.7), Statistics, Preferences (opens the options page).
- **Toolbar, row 2:** New, Open, Save, Save As, Save to library, Library (section 8).
- **Legend row:** three category samples (click to hide or show a category, section 4.3), then **Clear** (same as New) and **Copy** (puts the whole text on the clipboard; disabled while the text is empty; the status bar says "Copied").
- **Keyboard:** `Ctrl+Enter` presses Check (or Cancel), `Ctrl+S` and `Ctrl+Shift+S` press Save and Save As, and `F7` / `Shift+F7` move between issues. `Ctrl+N` and `Ctrl+O` stay with the browser. Button tooltips name their shortcut.
- The LLM selector lists the configured LLMs by name, and the last selection is remembered (`selected_llm_id`). When no LLM is selected, or the selected one no longer exists, but some LLMs exist, the page selects the first by name and stores that choice (this is what selects the first LLM that is added on the options page). The page reloads the list on `configs-changed` and the selection on `settings-changed`. With no LLM configured, the selector and Check are disabled, and the explanation panel shows a hint with a link that opens the options page: "No LLM is configured. Add one in Preferences to start checking."
- The status bar shows the check state (`Ready`, `Checking...`, `Check cancelled`, `Check failed`, `N issues` (`1 issue`) / `No errors found`, plus ` · N issues could not be placed`), the word count (`142 words`, `1 word`), and the tokens of the last request and of this tab's session (section 5.8), for example `last: 812 in / 164 out · session: 5.2k in / 1.1k out`, or `last: none · session: 0 in / 0 out` before the first request. `N` counts all issues, hidden categories included. The state goes back to `Ready` when an edit leaves the check with no issue (section 5.5).
- **Tab title**: the text's name and a `*` for unsaved changes, then " – English Tutor". A text without a name shows "Untitled".
- **Theme**: light or dark follows `prefers-color-scheme`.
- **Per-tab state.** Each tutor tab has its own text, source, issues, selection, explanation and session token totals. The text, the source key, the name, the library document id, the line ending and the dirty flag are kept in the tab's `sessionStorage`, so reloading the tab, or restoring a closed tab, gives the text back. Issues are not kept: the text has to be checked again, which counts nothing twice (section 5.7).
- **Closing the tab** with unsaved changes asks the browser's own question (`beforeunload`).
- **Shared data.** The LLM list, the selected LLM, the general settings, the library and the statistics are shared by all tutor tabs and the options page. A page that changes one of them posts a message on the `BroadcastChannel` named `english-tutor` (`configs-changed`, `settings-changed`, `library-changed`, `stats-changed`), and the other pages reload what changed.

### 4.3 Text editor

- A `<textarea>` with a proportional font and word wrap. Underlines are drawn on a mirror layer behind the textarea. The mirror has the same font, padding, width, wrapping and scroll position, and holds the text in transparent colour with the issue ranges wrapped in `<span>`s. The textarea's background is transparent, so the underlines show through. This is how the desktop app's own web version draws them.
- Underline colour and style by category (Okabe-Ito colours; fixed in v1):

  | Category | Colour (light / dark) | CSS `text-decoration-style` |
  |---|---|---|
  | grammar | `#D55E00` / `#FF8A4C` | `wavy` |
  | vocabulary | `#0072B2` / `#56B4E9` | `dashed` |
  | syntax | `#009E73` / `#2FD3A2` | `dotted` |

  `text-decoration-skip-ink: none`, so descenders do not break the line. The mirror never changes the text or the textarea's undo history. The mirror takes the width the textarea's text really has (the room of a scroll bar is taken off), follows its scroll position and size, and ends with a zero-width space so that a text ending in a line break has the same last, empty line. An issue that does not fit the text any more (past its end, empty, overlapping an earlier one) gets no span. The textarea and the mirror share one CSS class for font, padding and wrapping (`src/ui/components.css`).
- The selected issue also has a background of its category colour at about 20% opacity.
- **Selecting an issue from the text.** When the caret moves into an issue's range (click or keys), that issue is selected (section 4.4). The caret is not moved. When the caret moves outside all issues, the selection is cleared and the explanation panel goes idle. The range is half-open: the caret is in an issue from its first character up to, but not including, the position after its last character, so a caret right after a word is outside it, a caret at the start of an issue is inside it (this is where `F7` and a row put the caret), and at the boundary of two touching issues the later one wins. The caret is read from `selectionStart` on `selectionchange`, `keyup`, `mouseup`, `focus` and `select`; only issues of shown categories can be selected. Moving the caret outside also clears a selection that was made from the list.
- **Tooltip.** Hovering an underline shows `<error type label> · <Category>` and, on a second line, the issue's message (for example "Subject-verb agreement · Grammar" / "Use goes."). The character under the mouse is found from the mirror's span rectangles (`getClientRects`; an issue that wraps has one rectangle per line). A hidden category has no tooltip. There is one tooltip element in the page (`role="tooltip"`, not a `title` attribute), shown at once below and to the right of the pointer, moved inside the window when it would not fit, and hidden when the pointer leaves the text or no longer is over an underline, and on a mouse press, a key, the wheel, scrolling, typing, or a change of the issues. While it shows, the textarea's `aria-describedby` names it.
- **Legend.** Clicking a category in the legend hides or shows its underlines and its rows in the list.
- **`F7` / `Shift+F7`** go to the next / previous issue: from the selected issue, or, with none selected, from the caret (next is the first shown issue that starts after the caret, previous the last one that starts before it). They wrap around at the ends and skip hidden categories. The caret goes to the start of the issue, the editor scrolls to it and its row is selected; the keyboard focus stays where it was. The browser's own `F7` (caret browsing) is suppressed on the tutor page.
- Editing moves or removes issues (section 5.5).
- **Right-click menu.** A `contextmenu` listener on the textarea calls `menus.overrideContext({ showDefaults: true })`, so the browser's own entries (Cut, Copy, Paste, Select All, spell check) stay. When text is selected, two entries follow them: **Alternative** and, under it, **Check**. They are hidden when nothing is selected, or only white space or line breaks are selected. Check is disabled while no LLM is configured. The entries are created with `documentUrlPatterns` matching `tutor.html`, and the page sets their visibility in `menus.onShown` before calling `menus.refresh()`. A click is handled only by the tutor page whose tab id matches `menus.onClicked`'s `tab.id`. The selection is read from `selectionStart` / `selectionEnd` when the entry is chosen.
- **Clipboard.** Copy and Cut put only plain text on the clipboard; a `<textarea>` does this already.
- **Loading screen.** While a manual check runs (Check, `Ctrl+Enter`, the Check menu entry, or a check from a web page), a translucent layer covers the editor with "Checking..." and a busy indicator. The textarea is `readOnly` and the right-click entries are hidden. After 10 seconds the line "We will notify you when the results are ready." appears under the indicator. The layer goes when the check ends in any way, or when a new text is loaded. The Cancel button and the rest of the page stay usable. An auto-check does not show the layer.

### 4.4 Issues list

- A list (`role="listbox"`) at the top of the right column, one row per placed issue, in text order.
- Each row has a category marker in the category colour with a letter (**G**, **V**, **S**). It shows the wrong snippet (cut to about 40 characters) and, on a second line, the error type label and a count badge (`x7`: how often the user made that error type, section 5.7). There is no badge for issues of an auto-check.
- The header reads "Issues (N)", or "Issues (3 of 5 shown)" when hidden categories have issues. The legend is the only filter. Hiding a category also deselects the selected issue if it belongs to it.
- **One shared selection.** The editor and the list select the same issue through one state object (`src/core/issues`). Neither one talks to the other directly.
  - Clicking a row, or Up / Down in the list, selects the issue. The editor scrolls to it (centred when it is out of view), highlights it and puts the caret at its start, without moving keyboard focus out of the list.
  - Selecting an issue in the editor, or with `F7`, selects its row and scrolls it into view (just far enough, without scrolling the page).
  - Selecting an issue from either place starts its explanation (section 5.4).
- Double-clicking a row (or `Enter` on it) moves focus to the editor, with the caret at the start of the issue.
- **Keyboard and ARIA.** The list is one tab stop (`tabindex="0"`, outlined while focused) and keeps the focus; the selected row is its `aria-activedescendant`, and every row has a unique id, `role="option"` and `aria-selected`. Down and Up select the next and previous shown issue (from no selection, Down selects the first and Up the last; they stop at the ends), Home and End the first and last, Enter activates the selected one. Keys with Ctrl, Alt or Meta are left to the browser.
- A row's context menu (through `menus.overrideContext`) has **Not an error** and **Regenerate explanation**.
- Empty states, as one grey line: "Press Check to find errors" (before the first check, and after a first check that failed or was cancelled), "Checking...", "No errors found", and "All categories are hidden" (issues exist but every category is hidden). During a re-check the old rows stay until the result arrives, unless there were none.
- Rows go as soon as an edit removes their issue (section 5.5). Issues the locator could not place are not listed; the status bar counts them.

### 4.5 Explanation panel

- States, as in the desktop app:
  - **Idle:** "Select an error in the list or an underlined error in the text to learn more".
  - **Loading:** the snippet and category, a progress indicator and **Cancel**. Cancel shows "Explanation cancelled." and a **Regenerate** button.
  - **Ready:** the rendered markdown (section 5.9). While it streams, it is re-rendered at most every 100 ms (the first chunk at once). The view follows the end of the text unless the user has scrolled up.
  - **Failed:** the error's message and **Retry**.
- Header line: "Subject-verb agreement: you have made this mistake 7 times (2 in the last 7 days)". For an issue of an auto-check it ends with "This one is not counted: only the Check button counts.". With no recorded mistake of the type it reads "<label>: no mistake of this type recorded yet".
- **Not an error** is shown in every state except idle (section 5.7). **Regenerate** shows when the explanation is ready or cancelled, **Retry** when it failed.
- An explanation is requested only when an issue is selected. Explanations are cached in memory per issue for the lifetime of the check result. Selecting nothing, removing the selected issue, or a new check result cancels a running explanation. A late result is ignored. A new check result clears the cache.
- If no LLM is configured any more when an issue is selected, the panel shows the failed state with that message.
- **Links.** Only `http:` and `https:` links with a host are links. Clicking one shows an in-page confirmation with the full address. On confirmation the address opens in a new tab (`tabs.create`, which needs no permission), next to the tutor tab. Every other scheme is plain text. The options link exists only in the idle hint for a missing LLM, never inside an explanation.

### 4.6 Alternatives panel

As the desktop app's Alternatives window (desktop SPEC §4.2), drawn as a floating, non-modal panel inside the tutor page:

- It shows the selected text (cut to 400 characters), a state line, and one row per alternative in the model's order. States: *loading* ("Looking for alternatives..." with a busy indicator), *ready* ("3 alternatives", first row selected, or "No alternatives found."), *failed* (the error's message in red, "Could not get alternatives." and **Retry**).
- **Double-click on a row** (or `Enter`) uses it. The panel re-selects the original range and replaces it with `document.execCommand("insertText", false, alternative)`, so the replacement is one step of the textarea's undo history (`Ctrl+Z` brings the old text back). The caret goes after it, the panel closes and the editor gets focus. The text is replaced only if the characters at the original range are still the selected ones. Otherwise nothing changes, and the panel says so under the list and keeps the alternatives. The replacement is an edit like typing (section 5.5).
- **Copy** puts the current row on the clipboard. **Close** (or `Escape`) closes the panel. Closing it in any way cancels a running request, and that is not an error.
- One panel at a time: asking again replaces it, and the earlier request is cancelled.
- Alternatives are untrusted text and are shown with `textContent` only. The panel never changes the statistics.

### 4.7 Options page (Preferences)

Opened from the Preferences button (`runtime.openOptionsPage()`), from the toolbar button's menu, or from `about:addons`. Changes are saved at once (no OK button) and announced on the `BroadcastChannel`.

**LLMs section.** A list of configured LLMs with Add, Edit, Delete and Test connection. The form fields are the same as in the desktop app (desktop SPEC §4.5):

| Field | Notes |
|---|---|
| Name | Unique, shown in the selector |
| Provider | `ollama`, `openai-compatible`, `anthropic`. A new LLM starts with `openai-compatible` and an empty Base URL |
| Model | Free text, for example `llama3.1`, `gpt-4o`, `claude-sonnet-5-5` |
| Base URL | Required for `ollama` (filled with `http://localhost:11434` when chosen and empty, and cleared again when switching away) and `openai-compatible` (including `/v1`); optional for `anthropic` (default `https://api.anthropic.com`). Must be `http://` or `https://` with a host |
| API key | Required for `anthropic` and usually for `openai-compatible`; disabled and not stored for `ollama`. A password field with Show / Hide, masked when the form opens |
| Temperature | Optional, 0 to 2. Empty (`null`) means the default 0.2, which is always sent |
| Timeout | Optional, seconds, 10 to 3600. Empty or 0 uses the defaults (15 minutes for a check chunk, 120 s for an explanation or alternatives). Test connection ignores it and uses 60 s |
| No thinking | Ticked by default for a new LLM. For `ollama` and `openai-compatible` only (section 6.4); disabled and never stored for `anthropic` |
| Parallel requests | A whole number from 1 to 16, default 1 (section 5.2) |

- **Layout.** The list has the buttons Add, Edit, Delete and Test connection above it; Edit, Delete and Test connection apply to the highlighted row (click, arrow keys; double-click or Enter edits). The LLM used by the editor (`selected_llm_id`) is marked "in use". The form opens below the list, one at a time. Delete asks in an in-page confirmation, not a browser dialog. Validation messages are shown under the field they are about (the first problem takes the focus), and `LLMConfigNameTaken` under Name. Values that fail the form's checks are not sent to the store, and no permission is requested for them.
- **Host permission.** Saving an LLM, or pressing Test connection (in the form or for a row), first calls `permissions.request({ origins: ["<scheme>://<host>[:<port>]/*"] })` for its base URL (the default Anthropic URL for `anthropic` without one). The call is made synchronously in the click handler, before any `await`, because Firefox accepts it only during a user gesture. If the user refuses, the LLM is still saved, and the form stays open (now editing the saved LLM) with a warning that requests to it will fail with `HostPermissionDenied`; pressing Save or Test connection again asks again. The request is made only when the values pass the form's checks. Deleting the last LLM that uses an origin removes that origin's permission (`permissions.remove`).
- **Test connection** sends the desktop app's test prompt ("Reply with the single word: ok") with the typed values (no name needed). It reports success with the time taken, or the failure. The tokens are not counted. A result that arrives after the form was closed is dropped.
- **Privacy note** in the form, as in the desktop app: "the text you write is sent to <server> when you check it, ask for an explanation or ask for alternatives", unless the host is `localhost`, `127.x.x.x` or `[::1]`. For `anthropic` without a base URL it names Anthropic's server. Next to the API key: "API keys are stored unencrypted in your Firefox profile."
- **Ollama note**: Ollama refuses requests from origins it does not allow. A 403 from an `ollama` server gets the message "Ollama refused the request from the extension. Allow it by starting Ollama with OLLAMA_ORIGINS=moz-extension://*." (section 6.5).
- API keys are never shown back in the list, only "key stored". An empty key field in the Edit form keeps the stored key, and a "Remove key" box removes it.
- Deleting the selected LLM selects the first remaining one by name, or none.

**General section.** Auto-check (default off) and its delay in seconds (default 3, 1 to 60; disabled while auto-check is off, unless page mode is on, which uses it too). Page mode: the box "Check text boxes on websites" with its privacy note, and the list of hosts it is turned off on (section 4.11). A font for the editor, the buttons and the results (issues list and explanation): each is a family name typed as text (at most 100 characters; empty means the page's default, a missing font falls back to it) and a size from 6 to 48 points (defaults 13, 11, 11). Family names are applied through CSS custom properties set with `style.setProperty`, never by building CSS text.

### 4.8 Statistics dialog

As desktop SPEC §4.6, as a modal `<dialog>` in the tutor page with two tabs:

- **Mistakes:** one row per error type with at least one recorded mistake. Columns: Error type, Category, Total, Last 7 days, Last 30 days, Last seen. Sorted by Total, highest first. Clicking a header sorts by that column: numbers and dates with the largest or newest first, text alphabetically. A second click reverses the order, and ties are ordered by label. A category filter and a period selector (all time, 30 days, 7 days) hide the types with no mistake in that period and drive the summary line ("24 mistakes in all time. Most frequent: Article."). Selecting a row lists its three most recent example snippets with dates. **Reset statistics** asks for confirmation, deletes all mistakes and clears the badges and header counts in every tutor tab.
- **Token usage:** one row per LLM with "input in / output out" for all time, 30 days and 7 days. `~` marks sums that include estimates. It has its own Reset button with a confirmation.
- A failed query or reset shows its message in a banner inside the dialog.

### 4.9 Banner

Failures that are not shown in a panel (a failed check, a file that cannot be opened, a save that failed, an expired hand-off) are shown in a dismissible banner above the editor. A failed check's banner is cleared when the next check starts. `HostPermissionDenied` adds a **Grant access** button to the banner. Its click is a user gesture, so it can call `permissions.request` for the LLM's origin, synchronously in the click handler. If the request is granted the banner goes; if it is refused the banner says "Access was not granted, so English Tutor cannot reach this LLM." The banner is a component (`src/ui/banner.ts`).

### 4.10 Check finished notification

When a manual check ends with a result or a failure while its tutor tab is not visible, or its window is not focused (`document.visibilityState === "hidden"` or `!document.hasFocus()`), the page shows a `notifications` message. It reads "Check finished" with the status text ("3 issues", "No errors found"), or "Check failed" with the error's message. The notification id is `check-<tabId>`. The background script handles `notifications.onClicked` and focuses that tab and its window. A check the user cancelled, a check whose result was discarded, an auto-check, and a check that ends while the tab is visible and focused do not notify.

### 4.11 Text boxes on web pages (page mode)

When page mode is on, the extension checks what the user writes in text boxes on web pages, in place, the way it checks the editor page. Underlines appear under the errors inside the text box, a badge on the text box shows how many errors it has, a click on the badge opens a dialog with the issues and their explanations, and a click on an underlined error shows that error's explanation next to it.

```
 +--------------------------------------------------------+
 | Yesterday I seen him. He go to school every day.       |
 |             ~~~~      ~~~~~                            |
 |                  +-------------------------------+     |
 |                  | Subject-verb agreement        |     |
 |                  | "He go" -> "He goes" ...      |  (3)| <- badge
 +------------------| [Not an error] [Regenerate]   |-----+
                    +-------------------------------+
                      explanation popover (click on an underline)
```

**Turning it on.**
- Page mode is **off by default**, because it sends what the user types on websites to the LLM. The options page's General section has a box "Check text boxes on websites", with the note "What you type in text boxes on websites is sent to <server of the selected LLM> to be checked." (or, for a server on this computer, "... is checked by <server>, on this computer.").
- Ticking the box calls `permissions.request({ origins: ["<all_urls>"] })` synchronously in the click handler (section 4.7). If the user refuses, the box stays off and the form says so. If it is granted, the options page stores `page_mode = true` and asks the background script to register the content script: `scripting.registerContentScripts([{ id: "page-mode", matches: ["<all_urls>"], js: ["page.js"], runAt: "document_idle", allFrames: true }])`. Unticking it unregisters the script, removes the `<all_urls>` permission, stores `page_mode = false`, and tells the open pages to remove their badges and underlines (they listen for a `page-mode-off` `runtime` message).
- The background script makes the registration match the setting and the permission each time it starts (`runtime.onStartup`, `runtime.onInstalled`) and on `permissions.onRemoved`: if the user withdrew the permission in `about:addons`, page mode is switched off.
- **Per site.** The toolbar button's context menu has **Turn off on <host>** (or **Turn on on <host>**) for the active tab's host, stored in `page_mode_off_hosts`. The options page lists those hosts with a Remove button. The content script reads the list when it starts and on `settings-changed`, and does nothing on a host in it.
- Page mode never runs on the extension's own pages, and Firefox does not run content scripts on `about:` pages, `addons.mozilla.org` and other restricted pages.

**Which text boxes.**
- A *text box* is a `<textarea>`, an `<input>` whose type is `text` or missing, or an editing host with `contenteditable="true"` or `"plaintext-only"`.
- These are never read, checked or touched: `<input>` of any other type (password, email, url, search, number, tel, ...); a field whose `autocomplete` is `current-password`, `new-password`, `one-time-code`, `username`, or starts with `cc-`; a `readonly` or `disabled` field; a field with `spellcheck="false"` (code editors and terminals set it); a field inside an element with `data-english-tutor="off"`; and a field that is not visible or is smaller than 40×16 CSS pixels.
- A text box takes part only after the user focuses it. Text boxes the user never focuses are never read.
- A text box is checked only when its text has at least 3 words. A text over 10,000 words is not checked, and its badge says so.

**Checking.**
- Checks start by themselves: when a text box gets the focus with at least 3 words in it, and after the user stops typing for the auto-check delay (`auto_check_delay_s`, section 4.7; the editor's own Auto-check box does not apply here). Only the focused text box is checked. A new check of the same box cancels the running one.
- Each text box has its own text state, as a tutor tab has (section 5): issues, revision, edit log, selection, and a `session:<uuid>` source made when the box is first focused on that page load.
- Checks that start by themselves are not recorded in the statistics, like an auto-check (section 5.7). The dialog's **Check** button runs a manual check, which is recorded under the box's source.
- Edits move and remove issues as in section 5.5: the content script compares the old and the new text of the box on each `input` event.
- With no LLM configured, the badge shows `!`, and the dialog says so with a link that opens the options page.

**Badge.** A small round button at the bottom right inside the focused text box, moving with it (scrolling, resizing, layout changes). It shows the extension icon before the first check, a spinner while checking, the number of issues (in the colour of the category with the most issues, with the count as text so colour is not the only signal), a check mark when there are none, and `!` after a failure (its tooltip has the error's message). It stays on a text box that has issues after the focus leaves it, and goes when the box's issues are gone or the box leaves the page. Clicking it opens the dialog.

**Underlines.** Drawn over the text box with the colours and styles of section 4.3, never by changing the page's DOM inside the box or its text.
- For a `<textarea>` or `<input>`, a mirror element copies the box's computed text styles (font, size, line height, letter and word spacing, padding, border widths, `white-space`, wrapping, text direction, `text-indent`, `tab-size`), its size and its scroll position, and holds the text in transparent colour with each issue in a `<span>`. Only the spans' underlines are visible.
- For a `contenteditable` box, the text is read as a string from its text nodes (block elements and `<br>` become `\n`), positions are mapped back to text nodes, and the underlines are drawn along the rectangles of a `Range` over each issue (`getClientRects`).
- The overlay has `pointer-events: none`, so typing, clicking and selecting work as if it were not there. It follows scrolling and resizing, and is redrawn at most once per animation frame. The selected issue also gets the 20% background of section 4.3.

**Explanation popover.** When the user clicks inside an underlined error (the caret lands inside an issue, or the click point is inside an issue's rectangles), a card opens just below the underline (above it when there is no room). It has the header of section 4.5 (label and counts), the streamed explanation with its states (loading, ready, failed, cancelled), and the buttons **Not an error**, **Regenerate** / **Retry** and **All issues** (opens the dialog). Moving the caret to another issue switches the card to that issue. `Escape`, a click elsewhere, or typing closes it. It never takes the focus from the text box unless the user clicks into it.

**Issues dialog.** Opened from the badge, or from All issues in the popover. A panel of about 440×520 CSS pixels next to the text box (inside the viewport), with the issues list of section 4.4 on top and the explanation panel of section 4.5 below it, for the issue selected in the list. Selecting a row highlights that issue in the text box and scrolls it into view, without moving the caret. It also has **Check** (a recorded manual check, Cancel while it runs), **Open in English Tutor** (sends the box's text to a new tutor tab with the hand-off of section 4.1; nothing is written back), and **Close** (`Escape`). The legend toggles of section 4.3 are not part of page mode.

**How it is built.**
- The content script (`src/content/`) finds text boxes, keeps their text states, and draws the badge and the underlines. Everything it adds to the page lives in one element whose closed shadow root holds the badge, the overlays and the frames, with `all: initial`, so the page's styles cannot change it and it cannot change the page. It never uses `innerHTML`, and never trusts the page: it reads only the text boxes it is about, and it ignores events the page dispatches itself (`event.isTrusted === false`).
- The popover and the dialog are one extension page, `page-ui.html` (`src/page-ui/`), loaded in an `<iframe>` inside that shadow root. It is listed in `web_accessible_resources` for `<all_urls>`. It is an extension context, so it uses the same store, LLM clients, analysis code and UI components as the tutor page. The frame is created, hidden, when the first text box is focused, and it runs the checks and the explanations of that page (one frame per page frame that has a focused text box). The page cannot read the frame, and the content script never receives API keys or makes LLM requests.
- The content script and its frame talk over a `runtime.connect` port named `page-ui:<random id>`, where the id is in the frame's address. Messages carry the box's id, the text, the revision and the edits from the content script, and the issues, the badge state and the popover or dialog requests back from the frame. Page scripts cannot use `runtime` messaging, so they cannot talk to the frame.
- If the page's Content Security Policy keeps the frame from loading (no `load` within 5 seconds), the badge shows `!` with `PageFrameBlocked` ("This site does not let English Tutor show its panel"), and its click offers only Open in English Tutor.
- **Shared UI.** The issues list (section 4.4) and the explanation panel (section 4.5) are components in `src/ui/` that both the tutor page and `page-ui.html` use.

## 5. Error analysis

The rules of this section are those of desktop SPEC §5, ported to TypeScript in `src/core/analysis` and `src/core/issues`. Positions are UTF-16 code units everywhere. JavaScript strings are UTF-16, so offsets need no conversion: the desktop app's `UTF16Map` and byte offsets have no equivalent. A character above U+FFFF is two units, as in the desktop app. No offset the analysis code returns falls inside a surrogate pair, and the limits "in characters" below count code points. The reference's rules about white space, letters and digits and lower-casing are kept on JavaScript strings: white space is Go's `unicode.IsSpace` (which includes U+0085 and U+00A0 but not U+FEFF), a word character is a Unicode letter or decimal digit, and lower-casing is done one code point at a time (so that the same snippet lower-cases the same wherever it stands; U+0130 becomes `i`).

### 5.1 Pipeline

1. The user presses Check (or auto-check fires, or a check comes from a web page).
2. The page snapshots the text and a revision counter, and sends the check prompt to the selected LLM.
3. The LLM answers with JSON issues. The page parses them (section 5.2), places each one in the snapshot (section 5.3), and drops the ones it cannot place.
4. If the text is at the same revision, the issues replace the underlines. Otherwise they are rebased across the edits made meanwhile (section 5.5).

- One check runs at a time per tutor tab. A new check cancels the previous one through its `AbortController`.
- A check started by the user (Check button, `Ctrl+Enter`, the Check menu entry, a web page's "Check with English Tutor") is *manual* and records its mistakes (section 5.7). An auto-check is not recorded.
- **Auto-check** (off by default): a debounce timer restarts on every edit and starts a check after the configured pause (`auto_check_delay_s`, read each time the timer restarts). If it fires while a check runs, it does not cancel that check: it waits for another full pause and tries again, until no check runs, so that text typed during a long check is checked afterwards. It starts nothing when auto-check is off (turning it off also stops the wait), when no LLM is selected, or when the text is blank. An auto-check is not recorded, shows no loading layer and does not make the editor read-only. Its issues keep the flag `manual: false` (`TextIssue.manual`), so that they get no count badge (section 4.4) and are not counted (section 5.7).
- **Cancel:** while a check runs, Check becomes Cancel. A cancelled check leaves the issues and the recorded mistakes as they were, discards chunks that already finished, shows "Check cancelled" without a banner, and creates no error tag. Cancelling is recognised from the `AbortSignal` before a failure is turned into an error. A timeout is not a cancel and gives `LLMCallTimeout`.
- **Checking a selection:** only the selected text is sent. `Analyzer.check` takes the selection's offset and the whole text; the placed issues' offsets are shifted back into the whole text, and each placed issue carries its fingerprint (section 5.7) computed in the whole text, so it is that of a full check. When the result arrives, issues that overlap the selection are replaced and all others stay. If an edit made during the check touched the selection, the result is discarded ("The text changed while checking"); the controller takes the selection's range for this (`check({ manual, selection })`) and the test is the one of section 5.5 applied to the range, after the edits before it have moved it. The not-placed count is the selection's.
- A failed check shows its message in the banner and keeps the old issues.
- **Check controller.** One `CheckController` per text (`src/core/issues`, no page dependencies; the tutor page has one, and page mode will have one per text box) takes the snapshot of the text and the revision, runs the check through the analyzer, tells manual from automatic, and puts the result into the text's `IssueState`. It ends as `finished`, `cancelled`, `failed`, `stale` (a newer check replaced this one, or the text changed while checking and the result cannot be applied), `busy` (an auto-check was refused because a check runs) or `no-llm`. A manual check replaces a running one; the older one ends `stale` and does not touch the state. A result applies only if its check is still the pending one. If the text was edited meanwhile, the result is rebased across the edits the state logged (section 5.5) and then applied; it is `stale` (and the state keeps the issues it had) only when the edit log overflowed, a text was loaded meanwhile, or an edit touched the range of a selection check.

### 5.2 Check prompt and reply

As desktop SPEC §5.2:

- The system prompt and the retry reminder are those of `internal/analysis/prompt.go`. They include the taxonomy ids (section 5.6) and the delimiter lines with a random per-request token. The token is 26 random base32 characters from `crypto.getRandomValues`, drawn again while the text contains it.
- Reply contract: `{"issues": [{"text", "error_type", "message", "context_before", "context_after"}]}`. The model never gives offsets.
- Parsing is tolerant about packaging and strict about content. Markdown fences and prose around the JSON are ignored, and so is text before a closing `</think>`. A bare JSON array of issues is accepted. Without an `issues` list the reply is invalid. The JSON is decoded as the desktop app's decoder does: the first value that starts at a `{` (the first 8 are tried) is read and what follows it is ignored, member names match in any case, and a field of the wrong type (a number for `text`, an entry that is not an object) makes that object invalid, while `null` counts as empty. Entries without `text` are dropped and counted. `message` is cut at 300 characters and the contexts at 200 (`context_before` keeps its end, the others their start). A snippet over 2000 characters is dropped. An empty `message` becomes the error type's label.
- An invalid reply is retried once with the reminder appended, then fails with `LLMResponseInvalid`. The error carries only the reply's length (`reply_length`) and the stop reason (`stop_reason`), never the reply. A stop reason of `length` or `max_tokens` changes the message to say the answer was cut off, and suggests a shorter text or more parallel requests.
- **Chunking** (`SplitChunks`): at most 2000 words per request, cut at paragraph boundaries where possible, then between sentences, then between words. The chunks are contiguous, and whitespace stays with the text before it. With *Parallel requests* above 1, chunks are `ceil(words / parallel)` words, at least 200 and at most 2000. At most *Parallel requests* chunks are in flight at once. The results are merged in text order, whatever order they finished in. The first chunk that fails cancels the others, and its error is reported.

### 5.3 Locating issues

As desktop SPEC §5.3, on JavaScript strings:

1. Find all occurrences of `text` (overlapping ones too). Exactly one: use it.
2. Several: prefer those that do not start or end inside a word. Then prefer the one whose neighbours best match `context_before` / `context_after` (ignoring whitespace at the contexts' edges). Then take the first one not claimed by another issue.
3. None: retry case-insensitively, treating any run of whitespace as one space and typographic quotes (`‘ ’ “ ”`) and dashes (`– — −`) as plain ones. Map the match back to offsets in the original text. Otherwise drop the issue and count it.
4. Overlapping issues: keep the earlier one, drop the later one.

The result lists the placed issues in text order, and two counts: *not placed* (issues whose snippet is not in the text, plus the entries the parser dropped; this is the count the page shows) and *overlapping* (issues dropped by step 4). A match never starts or ends inside a surrogate pair, so a snippet that is half an emoji is not placed.

### 5.4 Explanation request

As desktop SPEC §5.4: the system prompt of `internal/analysis/explain.go`, asking for markdown with **What is wrong**, **Why**, **Better ways** and **Remember**. The snippet is taken from the checked text at the issue's offsets. The context is the whole text up to 600 words, otherwise the paragraph around the issue cut to a 600-word chunk. Both are delimited as in the check prompt. The reply is streamed (section 6.2). One explanation runs at a time per tab. The cache key is the check id and the issue id. An empty answer is `LLMResponseInvalid`. The cache is in the explainer, keyed by a string the page gives (the key above) and emptied by `reset()` when a new check result replaces the old one; starting an explanation, or reading a cached one, cancels the running one. The snippet in the prompt is taken from the text at the issue's offsets, or from the model's `text` when the offsets do not fit the text.

### 5.5 Edits after a check

The textarea's `input` event gives the new text. The edit is found as the part between the common prefix and the common suffix of the old and new text: position, removed length, added length, in UTF-16 units (an edit never starts or ends inside a surrogate pair). The page applies it to the issue state before anything redraws. All of this is in `src/core/issues` (`edits.ts`, `TrackedText`), with no DOM, so that page mode uses it for each text box. Then, as desktop SPEC §5.5:

- An edit that ends strictly before an issue's start shifts the issue by the net length change.
- An edit that touches the issue removes it at once (underline and row). It touches when it ends at or after the issue's start and starts at or before its end, so typing right after a word counts.
- An edit that starts strictly after an issue's end leaves the issue alone.
- Touched issues are removed from the state, the list and the mirror in the same turn as the edit. If the removed issue was selected, the selection is cleared; a selected issue that only moved stays selected. The snippet of a kept issue stays the text that was checked (it is what the statistics use). The *not placed* count stays while issues remain.
- When an edit leaves no issue, the check no longer says anything about the text: the status goes back to `Ready` and the list to "Press Check to find errors" (also after "No errors found").
- Edits made while a check runs are logged (at most 100,000) in the order they happen; the log starts when the check starts (and so carries its revision). The result is rebased across them in order, and touched issues are dropped. If the log overflowed, or a text was loaded meanwhile (which is not an edit and cannot be rebased), the result is discarded and the old issues stay. A result of a check that is no longer the pending one is ignored.
- Loading a text (New, Open, a library document, a hand-off) is not an edit. It clears the issues, cancels a running check or explanation, and does not start an auto-check.

### 5.6 Error type taxonomy

The fixed list of `internal/analysis/taxonomy.go`, with the same ids, labels and categories:

| Category | Error types (id) |
|---|---|
| grammar | `subject_verb_agreement`, `verb_tense`, `verb_form`, `modal_verb`, `article`, `preposition`, `plural_singular`, `countable_uncountable`, `pronoun`, `comparative_superlative`, `grammar_other` |
| syntax | `word_order`, `missing_word`, `extra_word`, `sentence_fragment`, `run_on_sentence`, `conditional_structure`, `syntax_other` |
| vocabulary | `wrong_word`, `confused_words`, `collocation`, `spelling`, `vocabulary_other` |

An unknown `error_type` becomes the `_other` id of the category its wording suggests, or `grammar_other`. Punctuation and capitalisation are `syntax_other`. The database stores ids as text, so adding an id needs no migration.

### 5.7 Counting mistakes

As desktop SPEC §5.7:

- A **mistake** is a placed issue of a manual check, stored as an event: error type, category, snippet, source key, fingerprint, LLM name, time.
- **Fingerprint:** hex SHA-256 (`crypto.subtle.digest`) of `normalise(snippet) + "\u0000" + occurrence`. `normalise` lowercases the snippet and collapses every run of whitespace to one space, trimming the ends. `occurrence` is the number of non-overlapping occurrences of the lowercased snippet in the lowercased text before the snippet's start, in decimal. The function is asynchronous (`crypto.subtle`); offsets that do not fit the text are clamped into it. The pair (`source_key`, `fingerprint`) is unique, and inserting an existing pair does nothing. If a later check gives the same mistake another type, the first type stays.
- **Sources:**
  - `session:<uuid>` (`crypto.randomUUID()`) for a new text: at New, at the first load of a tab, for an opened file, for a hand-off from a web page, and for each page-mode text box when it is first focused on a page load (section 4.11);
  - `doc:<id>` for a library document.

  There is no `file:` source, because the browser gives no file path. Opening the same file twice counts its mistakes twice (section 13).
- **Moving a source:** Save to library on a text with a `session:` source moves its events to the new `doc:<id>`, dropping events whose pair would become a duplicate. Downloading a file (Save, Save As) does not change the source.
- Repeated mistakes count every time they are made, in different texts or twice in one text. Fixing a mistake does not remove its count.
- **Not an error** deletes the issue's event and adds its (source, fingerprint) to an ignore set kept in `storage.session`, shared by all tutor tabs until the browser closes, so a re-check does not record it again.
- The `store.Stats` API mirrors the desktop app's: `record` (reports inserted, duplicate and ignored), `notAnError`, `moveSource`, `typeStats` (all-time, 30-day and 7-day counts and last seen per type), `countForType`, `recentExamples`, `summarize`, `resetMistakes`. A window is "now minus 7 (or 30) days, inclusive". Time comes from the injected clock.

### 5.8 Token usage

- Every LLM request (each check chunk with its retry, each explanation, each alternatives request) records input and output tokens. Test connection is excluded. A cancelled or failed request records what it reported, and nothing if it reported nothing: a streamed explanation records the usage it had reported when it stopped, and a check chunk or alternatives request that was cancelled or failed after a first reply records that reply's usage. A check chunk and its retry are one record, as are the two requests of an alternatives retry. The analysis code hands each record (`{ llm, kind, usage }`) to an injected recorder; the store implements it in step 9, and a recorder that fails is logged and never fails the request.
- Usage is read from each wire format (section 6.3) into `{ inputTokens, outputTokens, estimated }`. If the provider reports none, or only zeros, both are estimated at about 4 characters per token and `estimated` is true. The page marks estimates with `~`.
- The status bar shows the last request (the whole check, all chunks and retries) and the tab's session totals: `last: 812 in / 164 out · session: 5.2k in / 1.1k out`. Counts from 1000 on read `1.2k` and from a million `3.4M`; an estimate has `~` before each number (`~812 in / ~164 out`). Session totals start at zero when the tab is opened. The session total adds every recorded request, whatever its outcome; the last request is the tokens of the last check that ended with a result or was cancelled (a check that failed has no tokens to show, so the previous value stays).
- Each request is stored in `llm_usage` (LLM name, kind `check` / `explain` / `alternatives`, tokens, estimated flag, time) for the Token usage tab, by `Store.recordUsage` (the `StoreUsageRecorder` is the analyzer's `UsageRecorder`). A write that fails is `UsageSaveFailed` with the route `Store.recordUsage->UsageSaveFailed`; it is logged and the request's result is still shown. No money amounts are shown.

### 5.9 Untrusted text and output

The LLMs have no tools, so text in an essay can change only the model's answer. The measures keep the answers usable and the page safe:

- The user's text is delimited with a random per-request token (section 5.2) and declared to be text to analyse, never instructions.
- Replies are validated: the JSON contract, snippets that must be found in the text, unknown types mapped to `_other`.
- **Markdown renderer** (`src/core/markdown`): a port of the desktop app's `internal/web/markdown.go` rules that produces a list of DOM nodes, never HTML text. It supports paragraphs, headings, bold, italic, inline code, fenced and indented code blocks, ordered and unordered lists, block quotes and links. Raw HTML is shown as text. An image is shown as its alt text and is never fetched. A link is made only for `http` / `https` with a host and opens through the confirmation of section 4.5. The only elements it may create are `p h1–h6 strong em code pre ul ol li blockquote a br`, and the only attribute is `href` on `a` (plus `rel` and `target`, set by the page). A randomised property test feeds it arbitrary input and checks that nothing else appears.
- Alternatives and issue messages are shown with `textContent` only.
- No page uses `innerHTML` or its relatives (CLAUDE.md), and the extension CSP forbids inline and remote scripts.

### 5.10 Alternatives

As desktop SPEC §5.10: the system prompt of `internal/analysis/alternatives.go` (3 to 5 alternatives, each a replacement for the whole selection), delimited like the check prompt, with the context rule of section 5.4. The reply is `{"alternatives": [...]}`, or a bare array of strings. Entries are trimmed. Empty entries, repeats and the selection itself (ignoring case) are dropped, at most 8 are kept, and entries over 6000 characters are dropped. An invalid reply is retried once, then fails with `LLMResponseInvalid`. An empty or white-space selection is `SelectionEmpty`, and over 600 words is `SelectionTooLong`; neither reaches the model. Not streamed. Timeout 120 s or the LLM's Timeout. One request at a time per tab. Usage is recorded with kind `alternatives`, the retry included in the same record.

## 6. LLM providers

`src/core/llm` talks to the three providers with `fetch` from the tutor and options pages, never from the background script (an event page can be stopped while a long request runs). Each client takes the page's `fetch`, so tests can replace it. All requests send `Content-Type: application/json`.

### 6.1 Requests

| Provider | Endpoint | Body | Headers |
|---|---|---|---|
| `ollama` | `POST {base}/api/chat` | `model`, `messages` (system, user), `stream`, `options.temperature` | none |
| `openai-compatible` | `POST {base}/chat/completions` | `model`, `messages`, `temperature`, `stream`, and `stream_options: {"include_usage": true}` when streaming | `Authorization: Bearer <key>` when a key is set |
| `anthropic` | `POST {base or https://api.anthropic.com}/v1/messages` | `model`, `system`, `messages` (user), `max_tokens`, `temperature`, `stream` | `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true` |

- `max_tokens` (Anthropic only, which requires it) is 8192 for a check chunk and 4096 for an explanation or alternatives.
- A trailing `/` of a base URL is removed before the path is appended.
- Checks and alternatives are sent without streaming. Explanations stream.

### 6.2 Streaming

- `ollama`: newline-delimited JSON objects; the text is `message.content`, and the last object has `done: true`.
- `openai-compatible`: Server-Sent Events, `data: {json}` lines ending with `data: [DONE]`; the text is `choices[0].delta.content`.
- `anthropic`: Server-Sent Events. The text comes from `content_block_delta` events with a `text_delta`, and the stream ends with `message_stop`. An `error` event fails the request.
- The parsers read `response.body` with a `TextDecoderStream` and handle lines split across chunks. Thinking output is never shown: Ollama's `message.thinking`, an OpenAI-compatible `reasoning_content`, and text before a closing `</think>`. While streaming, a reply that starts with `<think>` is held back up to `</think>`; a reply with only a closing tag cannot be known to be thinking until the tag arrives, so it is shown as it comes and is removed from the final text the call returns (the text of an explanation is re-rendered from that final text).

### 6.3 Usage and stop reason

| Provider | Input tokens | Output tokens | Stop reason |
|---|---|---|---|
| `ollama` | `prompt_eval_count` | `eval_count` | `done_reason` |
| `openai-compatible` | `usage.prompt_tokens` | `usage.completion_tokens` | `choices[0].finish_reason` |
| `anthropic` | `usage.input_tokens` (stream: `message_start`) | `usage.output_tokens` (stream: last `message_delta`) | `stop_reason` |

### 6.4 No thinking

As desktop SPEC §4.5: fields are added at the top level of the body, keeping any field the body already has. For `ollama` the field is `"think": false`. For `openai-compatible` there are three: `"thinking": {"type": "disabled"}`, `"enable_thinking": false` and `"chat_template_kwargs": {"enable_thinking": false}`. A server that rejects them answers with an error that is shown as it is, and the user turns the option off. Never for `anthropic`.

### 6.5 Failures and timeouts

- Before a request, the page checks `permissions.contains` for the base URL's origin. Without the permission the request is not sent (the timeout has not started), and the result is `HostPermissionDenied`.
- Each request gets `AbortSignal.any([cancelSignal, AbortSignal.timeout(ms)])`. An abort caused by the cancel signal is a cancel (no error): the call rejects with the cancel signal's reason (a `DOMException` named `AbortError` unless the caller gave another), which is never an `AppError`, as in the store; callers check `signal.aborted` (`isCancelled(err, signal)`) before treating a rejection as a failure. An abort caused by the timeout is `LLMCallTimeout`. A signal that is already aborted sends nothing.
- A network failure (`TypeError` from `fetch`), an HTTP status other than 2xx, a reply that is not JSON, an error message inside a stream, or a stream that ends before the provider says the reply is complete (`done: true`, a `finish_reason` or `[DONE]`, `message_stop`) is `LLMCallFailed`. Its metadata has the HTTP status and the provider's error message if the body has one (`error.message` or `error`), cut to 300 characters. It never has the request body. A 403 from `ollama` gets the message of section 4.7.
- Servers see the request's `Origin: moz-extension://<uuid>`. Anthropic accepts it because of the `anthropic-dangerous-direct-browser-access` header. Ollama accepts it only if `moz-extension://*` is in its allowed origins (newer versions allow it by default; otherwise `OLLAMA_ORIGINS`). An OpenAI-compatible server that checks origins needs the same.

## 7. Concurrency and lifetimes

- All work runs on the page's single thread with `async` functions. No Web Workers in v1.
- Every cancellable operation takes an `AbortSignal`. A check, an explanation, an alternatives request and a Test connection each own an `AbortController`. Starting a newer one of the same kind, loading a text, or closing the tab aborts it.
- LLM requests run in the tutor page (or the options page for Test connection, or a page-mode frame, section 4.11), so they live as long as that tab. A page-mode frame's requests end when its web page is closed or navigates away. Closing or reloading the tab ends them. A reload loses a running check, and the text is kept (section 4.2).
- The background script registers all its listeners synchronously at the top level, keeps no state in memory between events (what it needs is in `storage.session`), and does no I/O except `storage.session`, `menus`, `notifications`, `runtime` messaging and focusing tabs.
- **Updates.** An extension update closes the extension's tabs. The background script listens to `runtime.onUpdateAvailable`. It pings the tutor pages (section 4.1) and calls `runtime.reload()` only when none has unsaved changes. Otherwise the update waits for the next browser start.
- Timeouts: check chunk 15 minutes, explanation and alternatives 120 s, Test connection 60 s. The LLM's *Timeout* replaces the first three. The check timeout applies to each chunk.

## 8. Saving text

**Files**
- **New** (and Clear) starts an empty text with a new `session:` source, asking first if there are unsaved changes.
- **Open** shows the file chooser (`.txt`, `.md`, `text/plain`, `text/markdown`). The file is read before anything is replaced. A file over 10 MB, one that is not valid UTF-8 (`TextDecoder` with `fatal: true`), or one with a NUL byte is refused (`FileReadFailed` / `FileNotUTF8`) and leaves the current text alone. A leading BOM is dropped. If the file used `\r\n`, that is remembered and used on Save. The text gets the file's name (without extension) and a new `session:` source.
- **Save** downloads the text with `downloads.download({ url: blobURL, filename, saveAs: false })` under the text's name (`.txt` added when it has no extension). A text without a name behaves like Save As. The blob URL is revoked when the download ends.
- **Save As** does the same with `saveAs: true`, so Firefox shows its save dialog. The proposed name is the text's default title plus `.txt`. Cancelling the dialog is not an error. The name the user typed becomes the text's name (from `downloads.search` by download id).
- After a successful download the text is not dirty any more. A failed download is `FileWriteFailed`.

**Library**
- **Save to library** stores the text as a document (title, content, line ending, timestamps). The title defaults to the first line cut to 60 characters, and an in-page dialog lets the user edit it. A text that came from the library updates its document instead. A `session:` source moves to `doc:<id>` (section 5.7).
- The **Library** dialog lists documents by last update, with Open, Rename and Delete (with confirmation). Opening loads the document and its `doc:<id>` source. Renaming the open document updates the tab title. Deleting the open document detaches it, so the next Save to library creates a new one. Saving to a document deleted meanwhile reports `DocumentNotFound` and detaches it.
- Two tutor tabs can have the same document open. The last save wins (section 13).

**Unsaved changes.** Before New, Open, and opening a library document, a text with unsaved changes gets an in-page dialog with **Save**, **Discard** and **Cancel**. Save means Save to library for a library text, otherwise Save (a download). If it fails or is cancelled, the action is cancelled too.

Issues are not saved. A loaded text has to be checked again, and its recorded mistakes are not counted twice.

## 9. Data storage

All data stays in the user's Firefox profile and is removed when the extension is uninstalled.

**IndexedDB** database `english-tutor`. Version N is reached by running migrations 1..N in order from `onupgradeneeded` (`src/core/store/migrations.ts`). A released migration is never changed. Times are milliseconds since the epoch.

| Object store | Key | Fields | Indexes |
|---|---|---|---|
| `llm_configs` | `id` (auto) | `name`, `provider`, `model`, `base_url`, `api_key`, `temperature`, `timeout_seconds`, `max_parallel`, `no_thinking`, `created_at`, `updated_at` | `name` (unique) |
| `documents` | `id` (auto) | `title`, `content`, `line_ending`, `created_at`, `updated_at` | `updated_at` |
| `error_events` | `id` (auto) | `error_type`, `category`, `snippet`, `source_key`, `fingerprint`, `llm_name`, `created_at` | `[source_key, fingerprint]` (unique), `[error_type, created_at]`, `created_at`, `source_key` |
| `llm_usage` | `id` (auto) | `llm_name`, `kind`, `input_tokens`, `output_tokens`, `estimated`, `created_at` | `created_at` |
| `settings` | `key` | `value` | |

Migration 1 creates all five stores. An index is named after its key path fields joined by `_`, so the compound ones are `source_key_fingerprint` and `error_type_created_at`. `line_ending` is `"lf"` or `"crlf"`. Optional numbers (`temperature`, `timeout_seconds`) are `null` when not set; `base_url` and `api_key` are `""` when not set.

**Settings keys:** `selected_llm_id`, `auto_check`, `auto_check_delay_s`, `editor_font_family`, `editor_font_size`, `button_font_family`, `button_font_size`, `results_font_family`, `results_font_size`, `pane_sizes`, `page_mode`, `page_mode_off_hosts`. `pane_sizes` holds two percentages, stored as the array `[editor, issues]`: the editor's share of the width, and the issues list's share of the right column (each above 0 and below 100). A missing or invalid value gives the default: auto-check off, delay 3 (1 to 60), sizes 13 / 11 / 11 (outside 6 to 48 is invalid), default font families (a family over 100 characters is invalid), no selected LLM (anything but a positive integer is invalid), panes 65 / 40, page mode off, no hosts with page mode turned off (`page_mode_off_hosts` is a list of host names, each at most 253 characters). Reading never fails on a bad stored value; setting a setting to a value that would read back as invalid is refused with `SettingInvalid`.

**`storage.session`:** hand-off entries (section 4.1) and the Not-an-error ignore set (section 5.7). Cleared when the browser closes.

**`sessionStorage`** of each tutor tab: its text and text state (section 4.2).

**API keys** are stored as plain text in IndexedDB, inside the Firefox profile. The options page says so. Keys are never logged, put in error metadata or messages, or sent anywhere except the LLM's own server.

The `Store` class is constructed with an open `IDBDatabase` and a `Clock`, so tests use `fake-indexeddb` and a fresh database per test. The store does not check the values of an LLM configuration: the `llm` package supplies a validator (`LLMConfigInvalid`) that is passed to the store's constructor. There is no module-level database variable.

### 9.1 Logging

A small logger (`src/core/log.ts`) writes to the console of the page or background script: `debug`, `info`, `warn`, `error`, each with a message and a flat object of fields. Errors are logged with `{ err }`, and the logger expands an `AppError` into tag, route, metadata and the cause's name and message. It logs timings, token counts, sizes and status codes. It never logs the user's text, LLM replies, API keys or hand-off contents. No log is stored.

## 10. Error handling

All errors are `AppError` (CLAUDE.md). Each failure below has its own tag and a route test.

| Tag | Where | When |
|---|---|---|
| `DatabaseOpenFailed` | `store` | the IndexedDB database cannot be opened |
| `MigrationFailed` | `store` | a numbered migration fails, or the upgrade is blocked |
| `DatabaseQueryFailed` | `store` | any other request on configs, documents or settings fails |
| `LLMConfigNameTaken` | `store` | duplicate LLM name |
| `LLMConfigInvalid` | `llm` / `store` | missing name or model; missing or malformed base URL; missing key for `anthropic`; temperature outside 0 to 2; timeout outside 10 to 3600 s (empty or 0 is allowed); parallel requests not a whole number from 1 to 16 |
| `LLMConfigNotFound` | `store` | the selected LLM id does not exist |
| `SettingInvalid` | `store` | a setting is set to a value its key does not allow (for example a size outside 6 to 48) |
| `DocumentNotFound` | `store` | the library document does not exist |
| `ErrorEventSaveFailed` | `store` | recording mistakes or moving a source fails (the underlines are still shown) |
| `StatsQueryFailed` | `store` | reading counts for the header, badges or the Statistics dialog fails |
| `StatsResetFailed` | `store` | Reset statistics or Not an error fails |
| `UsageSaveFailed` | `store` | storing a request's token usage fails (the result is still shown) |
| `UsageQueryFailed` | `store` | reading the Token usage tab fails |
| `LinkOpenFailed` | `platform` | a link of an explanation cannot be opened in a new tab (`tabs.create` fails) |
| `UnknownProvider` | `llm` | the provider string is not supported |
| `HostPermissionDenied` | `llm` / `platform` | the origin of the LLM's base URL is not granted, or the user refused it |
| `LLMCallFailed` | `llm` | network failure, non-2xx status, or a broken stream |
| `LLMCallTimeout` | `llm` | the request exceeded its timeout |
| `LLMResponseInvalid` | `analysis` | the reply does not fit the contract (or has no usable alternative), even after one retry; or an empty explanation |
| `SelectionEmpty` | `analysis` | alternatives for an empty or white-space selection |
| `SelectionTooLong` | `analysis` | alternatives for a selection over 600 words |
| `FileReadFailed` | `tutor` | the file cannot be read, or is over 10 MB |
| `FileNotUTF8` | `tutor` | the file is not valid UTF-8, or contains a NUL byte |
| `FileWriteFailed` | `tutor` | a download fails |
| `HandoffExpired` | `tutor` | the hand-off entry of a web page selection is missing |
| `PageFrameBlocked` | `content` | the page-mode frame does not load in a web page within 5 seconds (usually the page's Content Security Policy) |
| `PageModePermissionDenied` | `options` | the user refused the `<all_urls>` permission when turning page mode on |

- The UI shows an error's message in the banner (or in its panel) and logs it with `{ err }`.
- Cancelling is not an error and creates no tag (section 5.1).

## 11. Testing

- vitest, table-driven tests next to the code. `src/core` tests run in Node. `src/ui`, `src/tutor` and `src/options` tests run in `happy-dom` with a fake `browser` object from `src/platform/testing`.
- **No real LLM is ever called.** `src/core/llm/testing` has a fake `fetch` that answers each wire format with canned replies, HTTP errors, delays, aborts, and streams split at awkward byte boundaries (inside a UTF-8 sequence, inside an SSE line).
- **store:** migrations from an empty database; CRUD for configs, documents and settings; the unique name and not-found tags; settings defaults for missing and invalid values.
- **llm:** the request body and headers of each provider, including No thinking and `stream_options`; usage and stop reason extraction for each provider, streamed and not; estimates when usage is missing; timeout versus cancel; `HostPermissionDenied` before any request; the Ollama 403 message.
- **analysis:** ported from the desktop tests where they exist. Prompt delimiters (random token, never one found in the text). Parsing of valid, fenced, `</think>`-prefixed, bare-array, truncated and wrong-schema replies. The locator: unique, repeated with context, word boundaries, overlapping occurrences, the normalised fallback mapped back to original offsets, emoji and accented text. Chunking, including the parallel sizes. Taxonomy completeness and `_other` mapping. Fingerprints: stable under case and whitespace, and different by occurrence. Explanation and alternatives prompts, the alternatives parser, the retry. A randomised test of the locator that checks that any input gives no exception and in-range offsets.
- **issues:** edit rebasing (before, touching, after, adjacent), the edit log and its overflow, selection checks merging results, the shared selection, category hiding, F7 order and wrapping.
- **statistics:** recording twice counts once; the same snippet in two sources counts twice; moving a session source to a document, including duplicates; 7 and 30 day windows with a fake clock; Not an error and the ignore set; resets.
- **markdown:** each supported construct, links (allowed and refused schemes), images as alt text, raw HTML as text, and the randomised property test of section 5.9.
- **UI (happy-dom):** the mirror's spans match the issues after edits; the list and editor share the selection; explanation panel states and throttling; the loading layer and read-only text; the alternatives panel states, the replacement guard and Copy; the unsaved-changes dialog; the status bar text; the options form (provider switching, Ollama default URL, key handling, validation messages).
- **page mode:** in `happy-dom`: which elements count as text boxes (the whole table of section 4.11, including every excluded type, `autocomplete` value and attribute), the `contenteditable` text model and its mapping back to text nodes, edits and rebasing per box, the badge states, the port protocol between the content script and the frame (with a fake port), ignoring untrusted events, and turning page mode on and off (registration, permission, `page-mode-off`). Positions of underlines and of the popover are checked by screenshots.
- **background:** hand-off storage and expiry, menu creation, focusing the latest tutor tab, notification clicks, and update deferral, all against the fake `browser`.
- **Screenshots** (`npm run screenshots`): the built extension is loaded into a headless Firefox, which talks to a fake OpenAI-compatible LLM server on `127.0.0.1`. Every UI function has a scenario that drives the real pages and saves a PNG under `docs/screenshots/` (docs/IMPLEMENTATION.md, "Screenshot harness"). A scenario that fails to reach its state fails the run.
- `src/core/specs.test.ts` checks that every tag in the section 10 table has a route test, and that the taxonomy table in section 5.6 matches the code.
- **Manual smoke check** in a real Firefox (`npm run start`) with a real LLM, before a release. It follows the desktop README's checklist, adapted, plus: the toolbar button and command focus the latest tutor tab; both web page menu entries; page mode on a few real sites (a plain `<textarea>`, a `contenteditable` editor, a site with a strict CSP); the host permission prompt and Grant access; a notification when the tab is in the background; Save As's dialog; reload keeps the text; light and dark; a narrow window.
- Definition of done is in CLAUDE.md: prettier, `tsc`, eslint, vitest, build, `web-ext lint`, and the screenshots.

## 12. Milestones

docs/IMPLEMENTATION.md lists the steps the extension is built in, with the spec sections and the screenshots of each. docs/IMPLEMENTED.md logs each finished step. In short: docs; skeleton and screenshot harness; store; LLM layer and options page; analysis core; tutor page and Check; selection, navigation and edits; explanation panel; statistics and usage; alternatives and selection check; saving and the library; browser integration and polish.

## 13. Risks and open points

- **LLM quality varies.** Small local models may return invalid JSON or invent errors. Mitigated by the retry, the strict locator and the user's choice of model, as in the desktop app.
- **Origins.** Ollama and some OpenAI-compatible servers check the `Origin` header and may refuse `moz-extension://`. The message names the fix for Ollama. Other servers depend on their own settings.
- **Distribution.** Firefox release builds install only signed extensions. Signing through addons.mozilla.org (listed or unlisted) is not part of v1. Until then the extension is loaded as a temporary add-on (`about:debugging`, or `web-ext run`), or unsigned in Developer Edition / Nightly.
- **Plain-text API keys** in the Firefox profile, as in the desktop app. Encrypting them with a user passphrase is a possible later change.
- **Long selections from web pages** may be shortened by Firefox in `info.selectionText`. Reading the selection with `scripting` and `activeTab` would avoid this, at the cost of two permissions.
- **Statistics do not follow files.** Without file paths, opening the same file again starts a new source and can count its mistakes again. Saving to the library is the way to keep one identity.
- **Two tabs, one document.** The last save to the library wins. There is no lock or merge in v1.
- **No data export.** Uninstalling the extension deletes the library and the statistics. Export and import (JSON) are candidates for later.
- **Page mode sends what the user types on websites to the LLM.** It is off by default, it can be turned off per site, it skips password, payment and code fields, and it reads only text boxes the user focuses. A cloud LLM still receives that text; the options page says so.
- **Page mode and complex editors.** Mirrors follow the computed styles of plain text boxes well. Sites that restyle or re-render their editors on every key (rich `contenteditable` editors) can make underlines lag or drift for a frame. Canvas-based editors are not supported. Sites whose Content Security Policy blocks the frame get `PageFrameBlocked`.
- **Not decided yet:** applying a correction inside a web page's text box, the explanation language, and whether the category colours become configurable.
