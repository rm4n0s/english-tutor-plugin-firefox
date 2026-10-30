# English Tutor for Firefox: install guide

English Tutor lets a language model underline the grammar, vocabulary and syntax errors in your English, explains each one, suggests other ways to write it, and counts the mistakes you make most often. It uses the language model that **you** set up: [Ollama](https://ollama.com) on your own computer, any OpenAI-compatible server, or Anthropic's Claude. There is no account and no server of ours.

This page is the install guide. Each release is a signed file attached to a [release](https://github.com/rm4n0s/english-tutor-releases/releases) of this repository. The extension is not on addons.mozilla.org.

## What you need

- **Firefox 140 or newer** on Windows, macOS or Linux. Firefox for Android is not supported. The extension does not work in private windows.
- A language model to talk to (see [First steps](#first-steps)).

## Install

1. Open the [latest release](https://github.com/rm4n0s/english-tutor-releases/releases/latest) and download the file named `english-tutor-<version>.xpi` (for example `english-tutor-0.2.0.xpi`).
2. Open it in Firefox: use **File, Open File...** (`Ctrl+O`) and choose the file, or drag the file onto a Firefox window. If Firefox offers to download it instead of installing it, open the downloaded file the same way.
3. Firefox asks whether to add English Tutor. Read the list and click **Add**. The extension asks for no access to websites now.
4. A welcome page opens. The English Tutor button is in the toolbar (if it is not, open the puzzle-piece menu and pin it).

The file is signed by Mozilla, so it installs in the normal Firefox without any setting changed.

## Updates

Firefox looks for new versions by itself, about once a day, at an address written in the extension that points to this repository, and installs them without asking. To check at once, open `about:addons`, click the gear, and choose **Check for Updates**. If you turned off automatic updates for the extension, the same menu updates it by hand.

## First steps

1. Click the English Tutor button in the toolbar (or press `Alt+Shift+E`). The editor opens in a tab.
2. Press **Prefs** and, under **LLMs**, press **Add**. Choose the provider, as below, and press **Save**. Firefox asks to let English Tutor reach the server's address; allow it. **Test connection** checks that the server answers.
3. Go back to the editor, write some English with a mistake in it ("He go to school every day"), and press **Check** (`Ctrl+Enter`).

### Ollama

Ollama runs models on your own computer, so your text never leaves it.

1. Install Ollama and pull a model, for example `ollama pull llama3.1`.
2. Ollama refuses requests from browser extensions unless it is told to accept them. Start it with `OLLAMA_ORIGINS=moz-extension://*`:

   ```sh
   OLLAMA_ORIGINS="moz-extension://*" ollama serve
   ```

   If Ollama runs as a service, put the variable in the service's environment (for example `systemctl edit ollama` and add `Environment="OLLAMA_ORIGINS=moz-extension://*"`), then restart it. Without it, a check fails with "Ollama refused the request from the extension".

3. In English Tutor: provider **ollama**, the model name you pulled, and the Base URL `http://localhost:11434` (it is filled in for you). No key is needed.

### An OpenAI-compatible server

This is for OpenAI itself, and for servers such as LM Studio, llama.cpp's server, vLLM or OpenRouter.

- Provider **openai-compatible**, the model's name, and the Base URL **including `/v1`**, for example `https://api.openai.com/v1` or `http://localhost:1234/v1`.
- The API key, if the server wants one.
- A server that checks the `Origin` header may need to be told to accept `moz-extension://*`.

### Anthropic (Claude)

- Provider **anthropic**, a model such as `claude-sonnet-5-5`, and your API key. The Base URL can stay empty.

Small local models sometimes answer in a form the extension cannot read. It retries once, and then tells you. A larger model usually helps.

## Page mode

Page mode does in a web page's text boxes what the editor does: it underlines the errors in the box, shows a badge with their number, explains one when you click it, and has a dialog with the list of issues. It is **off everywhere until you turn it on**, because it sends what you type to your language model.

- Turn it on once: press **Allow** on the welcome page, or tick **Offer to check text boxes on websites** in **Prefs**. Firefox asks for access to all websites. This only lets English Tutor see which site a tab shows; it reads nothing yet.
- The first time you click into a text box on a site, a small card asks about that site: **Turn on**, **Not now** or **Never on this site**. A site you did not turn on gets nothing read and nothing sent.
- Password, payment, one-time code, search and other non-text fields, and code editors, are never read. English Tutor never writes a correction into the page: you fix the text yourself.
- Right-click the toolbar button to turn page mode off or on for the page you are on. Unticking the box in **Prefs** turns it off everywhere and gives the access back.

## Privacy

- The text you check is sent to **the language model you set up**, and only when you check it, ask for an explanation or for alternatives, or when auto-check runs. Nothing is sent anywhere else: no analytics, no accounts, no update pings of ours (Firefox itself asks this repository for `updates.json` when it looks for updates).
- Your settings, your library and your mistake statistics stay in your Firefox profile.
- **API keys are stored unencrypted** in your Firefox profile. Anyone who can read the profile can read them. Use a key with a spending limit.
- The extension asks Firefox for access to one address at a time: the server of each language model you add. Page mode is the one exception, and you turn it on yourself.
- Logs never contain your text, the model's replies or your keys.

## Uninstall

Open `about:addons`, find English Tutor, click the three dots, and choose **Remove**. This also deletes the extension's data: your LLM settings, your library and your statistics. Save the texts you want to keep as files first.
