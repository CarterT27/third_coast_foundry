// Layout for one step of the page: locked (grayed title), active (open), or
// done (grayed one-line summary with an Edit/Close toggle). Scrolls into view when it
// becomes active. A done step's open state is controlled by the parent so it can
// collapse or reopen steps when the user jumps between them.
import { Collapsible } from "@base-ui/react/collapsible";
import { useEffect, useRef, type ReactNode } from "react";

export type StepState = "locked" | "active" | "done";

type Props = {
  number: number;
  title: string;
  state: StepState;
  summary?: string;
  open?: boolean; // done steps only: whether the edit panel is expanded
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
};

export function Step({ number, title, state, summary, open = false, onOpenChange, children }: Props) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (state === "active" && number > 1) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [state, number]);

  const heading = (
    <h2 className="step__title">
      <span className="step__number">{number}</span> {title}
    </h2>
  );

  if (state === "done") {
    return (
      <Collapsible.Root render={<section ref={ref} id={`step-${number}`} className="step step--done" />}
        open={open}
        onOpenChange={(next) => onOpenChange?.(next)}
      >
        <div className="step__header">
          {heading}
          {summary && <span className="step__summary">{summary}</span>}
          <Collapsible.Trigger className="button button--ghost">{open ? "Close" : "Edit"}</Collapsible.Trigger>
        </div>
        <Collapsible.Panel className="step__body">{children}</Collapsible.Panel>
      </Collapsible.Root>
    );
  }

  return (
    <section ref={ref} id={`step-${number}`} className={`step step--${state}`} aria-disabled={state === "locked"}>
      <div className="step__header">{heading}</div>
      {state === "active" && <div className="step__body">{children}</div>}
    </section>
  );
}
