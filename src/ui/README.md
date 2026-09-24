# Wizard structure

`FrontendApp.tsx` and `SyntheticsApp.tsx` mount the workflow, connect keyboard input, and compose terminal views. Product work belongs in the sibling `frontend/` and `synthetics/` directories.

Each product has:

- `model.ts`: step names, prompt answer types, and the state shared between steps.
- `controller.ts`: the initial state and the explicit route from each step to the next.
- Step modules such as `pickApp.ts`, `create.ts`, and `alerting.ts`: asynchronous operations and their results.
- `services.ts`: the environment boundary, with defaults that call the existing product APIs. Tests replace these services to run without authentication, network requests, file writes, or delays.
- View components: prompts and progress displays. Text fields and menus keep their editing state locally and submit typed answers to the controller.

`workflow/` contains the small shared controller, its React subscription, common CLI installation and authentication steps, and common views. Product-specific decisions stay in the product directories.

## Adding or changing a step

1. Add the step and any state or prompt answer types to the product's `model.ts`.
2. Write an async step function. Use `ctx.get()` for current state, `ctx.update()` for changes, and `ctx.ask("promptName")` for input. Return a result with a destination and telemetry properties, including an accurate `status`.
3. Register the function in the product controller and update the preceding step's destination.
4. Add its prompt view and key handling. Text input must own ordinary characters, including `b` and `q`.
5. Exercise the route with injected services. The workflow tests show how to answer prompts, defer a response, restart a step, and assert outcomes and telemetry.

The controller records each returned result once. A routing-only transition, such as leaving the next-actions menu for another discovery pass, omits properties. That menu reports completion when it actually finishes.

## Cancellation and durable results

Wrap asynchronous operations in `ctx.wait()`. Restarting a step or unmounting aborts its question and wait, and prevents stale state updates or subsequent operations. Pass `ctx.signal` to services that support cancellation, and register timer cleanup with `ctx.onCleanup()`.

Cancellation cannot undo an HTTP request or file write that has already started. Check cancellation before continuing to another side effect. When catching an error without updating state, call `ctx.signal.throwIfAborted()` before treating it as a recoverable failure.

Synthetics keeps current-pass progress in `items` and accumulated successful results in `records`. Each record keeps its exact configuration and remote ID together. Discovery can clear the current pass without losing the inputs needed for summaries or Terraform imports.

## Checks

`npm run check` covers both product workflows and the shared controller, plus the existing URL entry, telemetry, exit, and product tests. Workflow tests inject services and do not create real resources. Live OAuth and cloud integration remain separate manual checks.
