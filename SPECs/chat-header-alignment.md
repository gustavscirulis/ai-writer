# Chat header alignment

The screenshot shows Chat's title and controls below the note tabs. Align the Chat header with that row.

- Remove the Chat panel's 72px top spacer.
- Give its header the tab row's token-based height: `--chrome-control-height + 2 * --chrome-control-padding`, with the same block padding and centered title/buttons.
- Keep New chat and Close usable. End the workspace's full-width drag overlay before the visible Chat panel; let the Chat header's empty space and title provide their own native drag region. Button descendants must not be marked as drag regions.
- Preserve Chat width, resizing, content/composer flow and sidebar/tab behavior.

Verify frontend checks/build and review the shared height math and drag hit-testing boundaries. Rendered/native QA is still pending the previously dismissed browser permission.
