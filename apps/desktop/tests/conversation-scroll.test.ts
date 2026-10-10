import { expect, test, vi } from "vite-plus/test";
vi.mock("react", () => ({
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
}));
import { useConversationScroll } from "../src/components/claude-panel/use-conversation-scroll";

test("follows streaming and viewport changes at the bottom, respects scrolling away and cleans up", () => {
  let resize!: () => void;
  const observed: unknown[] = [];
  const disconnected = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe(element: unknown) {
        observed.push(element);
      }
      disconnect = disconnected;
    },
  );
  const contents = {};
  let scroll!: () => void;
  let top = 0;
  const removed = vi.fn();
  const scroller = {
    firstElementChild: contents,
    scrollHeight: 500,
    clientHeight: 200,
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    },
    addEventListener: (_event: string, callback: () => void) => {
      scroll = callback;
    },
    removeEventListener: removed,
  };
  try {
    const cleanup = useConversationScroll()(scroller as unknown as HTMLDivElement);
    expect(observed).toEqual([contents, scroller]);
    resize();
    expect(scroller.scrollTop).toBe(300);
    scroller.scrollHeight = 650;
    resize();
    expect(scroller.scrollTop).toBe(450);
    scroller.clientHeight = 100;
    resize();
    expect(scroller.scrollTop).toBe(550);
    scroller.scrollTop = 50;
    scroll();
    scroller.scrollHeight = 800;
    resize();
    expect(scroller.scrollTop).toBe(50);
    scroller.clientHeight = 200;
    resize();
    expect(scroller.scrollTop).toBe(50);
    scroller.scrollTop = 600;
    scroll();
    scroller.scrollHeight = 900;
    resize();
    expect(scroller.scrollTop).toBe(700);
    cleanup?.();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith("scroll", scroll);
  } finally {
    vi.unstubAllGlobals();
  }
});
