import { beforeEach, expect, test, vi } from "vite-plus/test";
const react = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  index: 0,
  effect: () => {},
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => (react.refs[react.index++] ??= { current: value }),
  useCallback: (callback: unknown) => callback,
  useLayoutEffect: (effect: () => void) => {
    react.effect = effect;
  },
}));
import { useConversationScroll } from "../src/components/claude-panel/use-conversation-scroll";

function render(anchorId: string | undefined) {
  react.index = 0;
  const result = useConversationScroll(anchorId);
  react.effect();
  return result;
}

beforeEach(() => {
  react.refs = [];
});

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
    const cleanup = render(undefined).scrollRef(scroller as unknown as HTMLDivElement);
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

test("pins a newly sent message to the top and holds it there while the reply grows", () => {
  let resize!: () => void;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "8px", paddingBottom: "20px" }));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  const contents = { offsetTop: 8, offsetHeight: 1000 };
  const sent = { offsetTop: 900 };
  const setTop = vi.fn();
  const scrollTo = vi.fn();
  const scroller = {
    firstElementChild: contents,
    scrollHeight: 1028,
    clientHeight: 400,
    get scrollTop() {
      return 0;
    },
    set scrollTop(value: number) {
      setTop(value);
    },
    querySelector: (selector: string) => (selector === '[data-message-id="u1"]' ? sent : null),
    scrollTo,
    addEventListener() {},
    removeEventListener() {},
  };
  const spacer = { style: { height: "" } };
  try {
    const { scrollRef, spacerRef } = render("u0");
    spacerRef.current = spacer as unknown as HTMLDivElement;
    scrollRef(scroller as unknown as HTMLDivElement);
    render("u0");
    expect(scrollTo).not.toHaveBeenCalled();

    render("u1");
    expect(spacer.style.height).toBe("264px");
    expect(scrollTo).toHaveBeenCalledWith({ top: 892, behavior: "auto" });

    render(undefined);
    setTop.mockClear();
    contents.offsetHeight = 1100;
    resize();
    expect(spacer.style.height).toBe("164px");
    contents.offsetHeight = 1400;
    resize();
    expect(spacer.style.height).toBe("0px");
    expect(setTop).not.toHaveBeenCalled();

    render("u1");
    expect(scrollTo).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
