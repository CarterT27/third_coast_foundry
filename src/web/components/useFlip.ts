// FLIP animations with no library: after every render, each element inside `ref` with a
// `data-flip` id glides from where it was to where it is now, and new ids fade in.
// Elements with the same id in different places (a chip, then a row, then a card)
// animate as one element moving. `ref` must be position: relative.
import { useLayoutEffect, useRef, type RefObject } from "react";

type Point = { x: number; y: number };

const MOVE_MS = 550;
const ENTER_MS = 300;
const ENTER_STAGGER_MS = 25;
const MAX_STAGGER_MS = 500;

export function useFlip(ref: RefObject<HTMLElement | null>) {
  const last = useRef<Map<string, Point> | null>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const prev = last.current;
    const next = new Map<string, Point>();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let entering = 0;

    for (const node of root.querySelectorAll<HTMLElement>("[data-flip]")) {
      const id = node.dataset.flip ?? "";
      const now = layoutPosition(node, root);
      next.set(id, now);
      if (!prev || reduce) continue;

      const was = prev.get(id);
      if (!was) {
        node.animate([{ opacity: 0, transform: "scale(0.85)" }, { opacity: 1, transform: "none" }], {
          duration: ENTER_MS,
          delay: Math.min(entering++ * ENTER_STAGGER_MS, MAX_STAGGER_MS),
          easing: "ease-out",
          fill: "backwards",
        });
        continue;
      }
      if (was.x === now.x && was.y === now.y) continue;

      // Start from where it appears now, so an interrupted move doesn't jump.
      const r = node.getBoundingClientRect();
      const dx = was.x + (r.left - origin.left - now.x) - now.x;
      const dy = was.y + (r.top - origin.top - now.y) - now.y;
      for (const a of node.getAnimations()) if (a.id === "flip-move") a.cancel();
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        id: "flip-move",
        duration: MOVE_MS,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      });
    }
    last.current = next;
  });
}

/** Position relative to `root`, ignoring transforms (offsets are pre-transform). */
function layoutPosition(node: HTMLElement, root: HTMLElement): Point {
  let x = 0;
  let y = 0;
  let el: HTMLElement | null = node;
  while (el && el !== root) {
    x += el.offsetLeft;
    y += el.offsetTop;
    el = el.offsetParent as HTMLElement | null;
  }
  return { x, y };
}
