# Reminders carry guidance, not only readings

Status: accepted

The plugin began as a describer: it reported capacity, pressure and composition and left the model to draw its own conclusion. That under-used the one moment the plugin has the model's attention — a reminder arrives while the step that provoked it is still open — so a **context reminder** now carries **context guidance** as well as its reading. The guidance stays abstract (what a pressure state calls for), never a per-tool recipe, and it lives in the standing statement, so that an unasked reminder arrives authorized rather than as an unexplained interruption. Specific, tool-shaped guidance exists in exactly one place — the **tool hint** on an oversized-result reminder — where the plugin knows which call produced the result.

## Considered options

- **Stay descriptive.** Rejected: a reading the model does not act on is pure cost. The reminder text was already the plugin's most expensive surface per unit of value, and repeating it for a model that changes nothing is the one outcome that makes the whole feature worth switching off.
- **Per-tool recipes in the standing statement.** Rejected: the statement is re-sent on every request, so naming concrete tools there prices every tool the deployment might mount, and a statement naming `read`/`grep`/`glob` is wrong the moment the composition changes.
- **No standing statement, every notice self-explaining.** Rejected: an unasked injected message with no standing authorization reads as an interruption, and the two caveats this plugin owes the model — committed history rather than the live request, and an assumed rather than measured threshold — would then have to be repeated on every notice instead of once.

## Consequences

- The statement grows to carry guidance and the reminder bodies shrink to carry only what is timely. The per-request fixed cost can stay near flat, because the tool description the statement no longer needs to duplicate pays for the growth.
- Guidance the model cannot act on must not be written. The model cannot shrink committed history and cannot trigger compaction, so guidance may only concern what it loads next and what it tells the human.
- The plugin is now prescriptive. Every measured figure stays attributed exactly as before; only the advice is new.
