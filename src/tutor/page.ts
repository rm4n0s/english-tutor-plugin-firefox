import {
  Analyzer,
  CATEGORIES,
  modelFromConfig,
  type AnalysisModel,
  type UsageRecorder,
} from "../core/analysis";
import { AppError } from "../core/errors";
import { CheckController, IssueState, TokenTally, type CheckOutcome } from "../core/issues";
import { effectiveBaseUrl } from "../core/llm";
import { StoreUsageRecorder, type LLMConfig } from "../core/store";
import { Banner } from "../ui/banner";
import { ExplanationPanel } from "../ui/explanation-panel";
import { IssuesList } from "../ui/issues-list";
import { LoadingLayer } from "../ui/loading-layer";
import { EditorMirror } from "../ui/mirror";
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

  const state = new IssueState(deps.clock);
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
  const explanation = new ExplanationPanel(
    doc,
    requireElement(doc, "explanation", HTMLElement),
    state,
    {
      openOptions: () => {
        deps.openOptions();
      },
    },
  );
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

  const controller = new CheckController({
    state,
    runner: analyzer,
    getModel: () => {
      const config = selector.selected;
      if (config === undefined) return undefined;
      model ??= modelFromConfig(config, { fetch: deps.fetch, permissions: deps.permissions });
      return model;
    },
    getText: () => editor.value,
    onUsage: (usage) => {
      tally.setLast(usage);
    },
    log: deps.log,
  });

  const issuesList = new IssuesList(doc, requireElement(doc, "issues-pane", HTMLElement), state);
  const editorMirror = new EditorMirror(doc, editor, mirror, state);
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

  function toggleCheck(): void {
    if (state.pending !== null) {
      controller.cancel();
      return;
    }
    if (checkButton.disabled) return;
    banner.hide();
    const config = selector.selected;
    controller
      .check({ manual: true })
      .then((outcome) => {
        handleOutcome(outcome, config);
      })
      .catch(report);
  }

  checkButton.addEventListener("click", toggleCheck);
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      event.preventDefault();
      toggleCheck();
    }
  };
  doc.addEventListener("keydown", onKeydown);
  prefsButton.addEventListener("click", () => {
    deps.openOptions();
  });

  // Editing: step 7 rebases the issues across an edit. Until then an edit drops them, so that an
  // underline never sits under the wrong word.
  editor.addEventListener("input", () => {
    state.reset();
    updateCheckButton();
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
    }
  });

  const ready = selector.load().catch(report);
  updateCheckButton();

  return {
    ready,
    state,
    tally,
    destroy: () => {
      controller.cancel();
      stopChannel();
      stopState();
      stopLegend();
      doc.removeEventListener("keydown", onKeydown);
      issuesList.destroy();
      editorMirror.destroy();
      loading.destroy();
      statusBar.destroy();
    },
  };
}
