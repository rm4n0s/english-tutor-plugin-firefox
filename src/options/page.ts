import { AppError } from "../core/errors";
import { el, setHidden, setText } from "../ui/dom";
import type { OptionsDeps } from "./deps";
import { GeneralSection } from "./general-section";
import type { PageModeSection } from "./page-mode-section";
import { LLMSection } from "./llm-section";

export interface OptionsPage {
  /** Resolves when both sections have read the store. */
  ready: Promise<void>;
  /** The page-mode box and its list of sites. */
  pageMode: PageModeSection;
  destroy(): void;
}

/**
 * Builds the options page into `doc` (SPEC section 4.7): the LLMs section and the General
 * section, and a banner for failures. It listens for changes made by other pages.
 */
export function mountOptions(doc: Document, deps: OptionsDeps): OptionsPage {
  const llmHost = requireElement(doc, "#llms .card-body");
  const generalHost = requireElement(doc, "#general .card-body");
  const banner = el(doc, "p", {
    id: "options-error",
    class: "banner",
    role: "alert",
    hidden: true,
  });
  requireElement(doc, ".page").prepend(banner);

  const report = (err: unknown) => {
    deps.log.error("options page failed", { err });
    setText(banner, err instanceof AppError ? err.message : "Something went wrong.");
    setHidden(banner, false);
  };

  // The page-mode note names the selected LLM, so the General section follows what the LLMs
  // section changes in this very page too (a page does not receive its own channel messages).
  const llmDeps: OptionsDeps = {
    ...deps,
    channel: {
      post: (type) => {
        deps.channel.post(type);
        general.load().catch(report);
      },
      subscribe: (listener) => deps.channel.subscribe(listener),
      close: () => {
        deps.channel.close();
      },
    },
  };
  const llms = new LLMSection(doc, llmHost, llmDeps, report);
  const general = new GeneralSection(doc, generalHost, deps, report);

  const unsubscribe = deps.channel.subscribe((message) => {
    // The page-mode note names the selected LLM, so it follows the list too.
    if (message.type === "configs-changed") void Promise.all([llms.load(), general.load()]);
    // The selection is a setting, and the list shows which LLM is in use.
    if (message.type === "settings-changed") void Promise.all([general.load(), llms.load()]);
  });

  return {
    ready: Promise.all([llms.load(), general.load()]).then(() => undefined),
    pageMode: general.pageMode,
    destroy: () => {
      unsubscribe();
      llms.destroy();
    },
  };
}

function requireElement(doc: Document, selector: string): HTMLElement {
  const found = doc.querySelector<HTMLElement>(selector);
  if (found === null) throw new TypeError(`options.html has no element ${selector}`);
  return found;
}
