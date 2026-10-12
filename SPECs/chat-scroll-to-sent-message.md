# Scroll a sent Chat message to the top

When the reader sends a message, the conversation scrolls so that message sits at the top of the Chat scroller. It stays there while the reply streams in below it, so the reader can read the reply as it arrives. Before this change, the scroller followed the bottom while the reply grew, which pushed the start of the reply out of view.

A spacer after the conversation contents makes the sent message reachable at the top even when the reply is short. The spacer's height is the viewport height minus the content from the sent message down. It shrinks as the reply grows and reaches 0 once the reply is taller than the viewport. After that the view doesn't move; the reader scrolls. The spacer sits outside the observed contents, so resizing it never feeds back into the ResizeObserver.

The anchor is set when the last message becomes a new user message. That covers Send, suggestions and queued sends. The anchor lasts until the next send, and `MessageList` remounts per note, so switching notes resets it. A thread that opens with history, including one that ends in a user message, starts at the bottom and keeps the old follow-at-bottom behaviour. The scroll is smooth, or instant under reduced motion. Positions use `offsetTop` so the `chat-enter` translate doesn't skew them.

Validation: hook unit tests cover follow-at-bottom, spacer sizing, no auto-scroll while anchored, and no anchor on mount. A WebDriver run of the built app with the real CLI checks that `scrollTop` stays fixed while a long reply streams, that a second send re-anchors, and that a reloaded thread opens at the bottom.
