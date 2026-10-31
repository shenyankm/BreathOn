# Android UI review — 2026-10-31

The existing BREATHON mobile prototype remains the visual reference. This pass follows [Impeccable](https://github.com/pbakaus/impeccable)'s audit and polish guidance, preserving the gradient background and card layout. Legacy login, library, records, visit forms and dialogs now share the prototype's cream surfaces, warm-orange primary actions, teal secondary actions and rounded controls. Headings retain the orange hue with stronger contrast. Android-only styles do not change the Web theme.

## Fixed

- Small touch targets, pale secondary text and long-content wrapping.
- Disabled recommendations incorrectly described as an empty doctor catalogue.
- Drug loading failures without a recovery action.
- Doctor refresh and script generation buttons that only displayed success messages: refresh now reloads the API; copying communication notes reports actual clipboard success or failure.
- An empty screen when opening a session route without a session, and inconsistent native Back targets.
- Raw English visit status labels.

## Emulator evidence

Pixel9_API35 / Android 15 ran an installed ARM64 APK against an authenticated, isolated backend. Screenshots came from adb, not a desktop browser. Coverage includes home, training, L1–L4, lessons, doctors and details, coach and doctor selection, account, workspace, products, audiences, policies, review queue, settings, practice records, visits and library.

Checked 320dp with system font scale 1.3, landscape, and system dark mode with the intentionally light prototype theme. No new dark theme was introduced. Doctor filter chips intentionally scroll horizontally. Emulator settings were restored afterward.

Interaction checks cover lesson planning/completion, native Back, doctor refresh/copy, product details, transcript tabs, visit creation/draft restoration/save, keyboard dismissal, logout confirmation/cancel/logout, network failure/retry, and empty-session recovery. Fixture records are isolated QA data. Impeccable's source detector reported the prototype's decorative top stripe; it was retained to honor the visual reference.

198 frontend tests, Web and Android resource builds, and ARM64 APK compilation passed. The emulator crash buffer was empty. These checks do not certify complete accessibility compliance. Paid voice/model calls, active voice-session scoring, physical-device audio, TalkBack, tablets and multi-window were not tested.

Web deployment does not update installed App resources. Install the new APK to receive these changes; the delivery build uses the production HTTPS API, while the isolated QA build uses a local test origin.
