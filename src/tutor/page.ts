import {
  Analyzer,
  CATEGORIES,
  Explainer,
  modelFromConfig,
  type AnalysisModel,
  type UsageRecorder,
} from "../core/analysis";
import { AppError } from "../core/errors";
import {
  adjacentIssueId,
  AutoCheck,
  CheckController,
  ExplanationController,
  IssueState,
  TokenTally,
  TrackedText,
  type CheckOutcome,
} from "../core/issues";
import { effectiveBaseUrl } from "../core/llm";
import { StoreUsageRecorder, type LLMConfig } from "../core/store";
import { Banner } from "../ui/banner";
import { EditorSelection } from "../ui/editor-selection";
import { ExplanationPanel } from "../ui/explanation-panel";
import { IssuesList } from "../ui/issues-list";
import { LinkConfirm } from "../ui/link-confirm";
import { LoadingLayer } from "../ui/loading-layer";
import { EditorMirror } from "../ui/mirror";
import { IssueTooltip } from "../ui/tooltip";
import type { TutorDeps } from "./deps";
import { LLMSelector } from "./llm-selector";
import { StatusBar } from "./status-bar";

export interface TutorPage {
  /** Resolves when the LLM list has been read from the store. */
  ready: Promise<void>;
  /** The issue state of the tab's text. */
  state: IssueState;
  tally: TokenTally;
  destroy(): void;
}

function requireElement<T extends HTMLElement>(doc: Document, id: string, type: new () => T): T {
  const found = doc.getElementById(id);
  if (!(found instanceof type)) throw new TypeError(`tutor.html has no #${id} of the right kind`);
  return found;
}

/**
 * Wires the tutor page (SPEC section 4.2) that `tutor.html` describes: the LLM selector, Check and
 * Cancel, the editor with its mirror and loading layer, the legend, the issues list, the
 * explanation panel, the banner and the status bar. Other buttons come in later steps.
 */
export function mountTutor(doc: Document, deps: TutorDeps): TutorPage {
  const editor = requireElement(doc, "editor", HTMLTextAreaElement);
  const mirror = requireElement(doc, "mirror", HTMLElement);
  const editorBox = requireElement(doc, "editor-box", HTMLElement);
  const checkButton = requireElement(doc, "check", HTMLButtonElement);
  const prefsButton = requireElement(doc, "prefs", HTMLButtonElement);
  const select = requireElement(doc, "llm-select", HTMLSelectElement);
  const autoCheckBox = requireElement(doc, "auto-check", HTMLInputElement);

  const state = new IssueState(deps.clock);
  // Edits are found and applied to the state first, before the mirror and the status bar redraw
  // on the same `input` event (SPEC section 5.5).
  const trackedText = new TrackedText(state, editor.value);
  const onInput = (): void => {
    trackedText.changed(editor.value);
    updateCheckButton();
    autoCheck.edited();
  };
  editor.addEventListener("input", onInput);
  const tally = new TokenTally();
  // Every request counts in the session first, and then goes to the store; a store failure is
  // logged by the analyzer and never fails the check.
  const storeUsage = new StoreUsageRecorder(deps.store);
  const usage: UsageRecorder = {
    record: (record) => {
      tally.record(record);
      return storeUsage.record(record);
    },
  };
  const analyzer = new Analyzer({
    random: deps.random,
    usage,
    logger: deps.log,
    clock: deps.clock,
  });
  const banner = new Banner(doc, requireElement(doc, "banner-host", HTMLElement));

  const report = (err: unknown): void => {
    deps.log.error("tutor page failed", { err });
    banner.show(err instanceof AppError ? err.message : "Something went wrong.");
  };

  let model: AnalysisModel | undefined;
  const linkConfirm = new LinkConfirm(doc, doc.body);
  const explanation = new ExplanationPanel(doc, requireElement(doc, "explanation", HTMLElement), {
    openOptions: () => {
      deps.openOptions();
    },
    // A link opens only after the user has seen the whole address and confirmed it.
    openLink: (url) => {
      linkConfirm
        .ask(url)
        .then((confirmed) => (confirmed ? deps.links.open(url) : undefined))
        .catch(report);
    },
    scheduler: deps.scheduler,
  });
  const selector = new LLMSelector(
    doc,
    select,
    { store: deps.store, channel: deps.channel, log: deps.log },
    (config) => {
      model = undefined;
      explanation.setHasLLM(config !== undefined);
      updateCheckButton();
    },
    report,
  );

  // The selected LLM as a model, made on first use and again after the selection changes.
  function currentModel(): AnalysisModel | undefined {
    const config = selector.selected;
    if (config === undefined) return undefined;
    model ??= modelFromConfig(config, { fetch: deps.fetch, permissions: deps.permissions });
    return model;
  }

  const controller = new CheckController({
    state,
    runner: analyzer,
    getModel: currentModel,
    getText: () => editor.value,
    onUsage: (usage) => {
      tally.setLast(usage);
    },
    log: deps.log,
  });

  // Selecting an issue explains it; a new check result, deselecting or an edit that removes the
  // issue cancels the explanation (SPEC section 4.5).
  const explanationController = new ExplanationController({
    state,
    explainer: new Explainer({
      random: deps.random,
      usage,
      logger: deps.log,
      clock: deps.clock,
    }),
    view: explanation,
    getModel: currentModel,
    getText: () => editor.value,
    log: deps.log,
  });

  const editorMirror = new EditorMirror(doc, editor, mirror, state);
  const editorSelection = new EditorSelection(editor, mirror, state);
  const tooltip = new IssueTooltip(doc, editor, mirror, state);
  const issuesList = new IssuesList(doc, requireElement(doc, "issues-pane", HTMLElement), state, {
    onActivate: () => {
      editorSelection.focusSelected();
    },
  });
  const loading = new LoadingLayer(doc, editorBox, editor, state, deps.scheduler);
  const statusBar = new StatusBar(
    {
      state: requireElement(doc, "status-state", HTMLElement),
      words: requireElement(doc, "status-words", HTMLElement),
      tokens: requireElement(doc, "status-tokens", HTMLElement),
    },
    state,
    tally,
    editor,
  );

  // Check and Cancel.
  function updateCheckButton(): void {
    const running = state.pending !== null;
    checkButton.textContent = running ? "Cancel" : "Check";
    checkButton.title = running ? "Cancel (Ctrl+Enter)" : "Check (Ctrl+Enter)";
    checkButton.disabled =
      !running && (selector.selected === undefined || editor.value.trim() === "");
  }

  const handleOutcome = (outcome: CheckOutcome, config: LLMConfig | undefined): void => {
    if (outcome.kind !== "failed") return;
    const { error } = outcome;
    if (error.tag === "HostPermissionDenied" && config !== undefined) {
      banner.show(error.message, {
        label: "Grant access",
        onClick: () => {
          grantAccess(config);
        },
      });
    } else {
      banner.show(error.message);
    }
  };

  // Called in the click handler: `permissions.request` needs the user gesture, so nothing may be
  // awaited before it.
  function grantAccess(config: LLMConfig): void {
    const baseUrl = effectiveBaseUrl(config.provider, config.base_url);
    deps.permissions
      .request(baseUrl)
      .then((granted) => {
        if (granted) banner.hide();
        else banner.show("Access was not granted, so English Tutor cannot reach this LLM.");
      })
      .catch(report);
  }

  function runCheck(manual: boolean): void {
    const config = selector.selected;
    controller
      .check({ manual })
      .then((outcome) => {
        handleOutcome(outcome, config);
      })
      .catch(report);
  }

  function toggleCheck(): void {
    if (state.pending !== null) {
      controller.cancel();
      return;
    }
    if (checkButton.disabled) return;
    banner.hide();
    runCheck(true);
  }

  // Auto-check (SPEC section 5.1): the setting is shared with the options page.
  let autoCheckDelay = 3;
  const autoCheck = new AutoCheck({
    scheduler: deps.scheduler,
    enabled: () => autoCheckBox.checked,
    delaySeconds: () => autoCheckDelay,
    busy: () => state.pending !== null,
    canCheck: () => selector.selected !== undefined && editor.value.trim() !== "",
    start: () => {
      runCheck(false);
    },
  });

  async function loadAutoCheck(): Promise<void> {
    const settings = await deps.store.getSettings();
    autoCheckBox.checked = settings.auto_check;
    autoCheckDelay = settings.auto_check_delay_s;
    if (!settings.auto_check) autoCheck.stop();
  }

  autoCheckBox.addEventListener("change", () => {
    const on = autoCheckBox.checked;
    if (!on) autoCheck.stop();
    deps.store
      .setSetting("auto_check", on)
      .then(() => {
        deps.channel.post("settings-changed");
      })
      .catch((err: unknown) => {
        autoCheckBox.checked = !on;
        report(err);
      });
  });

  checkButton.addEventListener("click", toggleCheck);
  // F7 and Shift+F7 go to the next and previous issue (SPEC section 4.3).
  function goToAdjacentIssue(direction: "next" | "previous"): void {
    const id = adjacentIssueId(
      state.visibleIssues,
      state.selectedId,
      editorSelection.caret,
      direction,
    );
    if (id === undefined) return;
    if (id === state.selectedId) editorSelection.reveal();
    else state.select(id);
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      event.preventDefault();
      toggleCheck();
    } else if (event.key === "F7" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      goToAdjacentIssue(event.shiftKey ? "previous" : "next");
    }
  };
  doc.addEventListener("keydown", onKeydown);
  prefsButton.addEventListener("click", () => {
    deps.openOptions();
  });

  const stopState = state.subscribe((change) => {
    if (change === "pending") updateCheckButton();
  });

  // The legend.
  const legend = new Map<string, HTMLElement>();
  for (const item of doc.querySelectorAll<HTMLElement>(".legend-item")) {
    const category = CATEGORIES.find((c) => c === item.dataset.category);
    if (category === undefined) continue;
    legend.set(category, item);
    item.addEventListener("click", () => {
      state.toggleCategory(category);
    });
  }
  const stopLegend = state.subscribe((change) => {
    if (change !== "visibility") return;
    for (const category of CATEGORIES) {
      legend.get(category)?.setAttribute("aria-pressed", String(!state.isHidden(category)));
    }
  });

  // Changes made by other pages (the options page adds the first LLM, for example).
  const stopChannel = deps.channel.subscribe((message) => {
    if (message.type === "configs-changed" || message.type === "settings-changed") {
      selector.load().catch(report);
      loadAutoCheck().catch(report);
    }
  });

  const ready = Promise.all([selector.load(), loadAutoCheck()]).then(() => undefined, report);
  updateCheckButton();

  return {
    ready,
    state,
    tally,
    destroy: () => {
      controller.cancel();
      explanationController.destroy();
      linkConfirm.destroy();
      autoCheck.stop();
      editor.removeEventListener("input", onInput);
      stopChannel();
      stopState();
      stopLegend();
      doc.removeEventListener("keydown", onKeydown);
      issuesList.destroy();
      tooltip.destroy();
      editorSelection.destroy();
      editorMirror.destroy();
      loading.destroy();
      statusBar.destroy();
    },
  };
}
