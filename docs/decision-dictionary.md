# Decision Dictionary

Recurring questions and their locked answers.

## D1. TypeScript or JavaScript?
JavaScript. Plain ESM. No build step.

## D2. Express or native http?
Native node:http. Fewer deps, explicit control.

## D3. SQLite or JSON storage?
JSON files with atomic write (write to temp, rename). Single-user local tool.

## D4. React or plain HTML for panel?
Plain HTML/CSS/JS. No build pipeline for the panel.

## D5. Default port?
7000.

## D6. Default API base path?
/api/v1.

## D7. What happens when all keys are cooling down?
Return 429 to client with Retry-After header and a clear message.

## D8. What happens on 401 from upstream?
Mark key as disabled immediately. Requires manual re-enable.
