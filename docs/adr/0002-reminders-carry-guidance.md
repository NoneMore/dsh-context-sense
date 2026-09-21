# Reminders carry guidance, not only readings

Status: accepted

The plugin began as a describer: it reported capacity, pressure and composition and left the model to draw its own conclusion. That under-used the one moment the plugin has the model's attention — a reminder arrives while the step that provoked it is still open — so a **context reminder** now carries **context guidance** as well as its reading. The guidance stays abstract (what a pressure state calls for), never a per-tool recipe: the standing statement authorizes it, and the notice that observed the event carries it, so an unasked reminder arrives authorized rather than as an unexplained interruption. Specific, tool-shaped guidance exists in exactly one place — the **tool hint** on an oversized-result reminder — where the plugin knows which call produced the result.

## Considered options

- **Stay descriptive.** Rejected: a reading the model does not act on is pure cost. The reminder text was already the plugin's most expensive surface per unit of value, and repeating it for a model that changes nothing is the one outcome that makes the whole feature worth switching off.
- **Per-tool recipes in the standing statement.** Rejected: the statement is re-sent on every request, so naming concrete tools there prices every tool the deployment might mount, and a statement naming `read`/`grep`/`glob` is wrong the moment the composition changes.
- **No standing statement, every notice self-explaining.** Rejected: an unasked injected message with no standing authorization reads as an interruption.
- **One standing caveat, the notices drop theirs.** Considered, and this was the first shape: state the two caveats this plugin owes the model — committed history rather than the live request, and an assumed rather than measured threshold — once in the standing statement. Rejected once the notices were priced against it: a standing sentence is paid on every request of every session, while a local qualifier is a few words on a notice that arrives a handful of times, and the two notices describe different temporal objects, so one sentence covering both was accurate for neither. Each notice now carries only the caveat true of its own measurement.

## Consequences

- The statement carries the authorization and no event-local fact, and each notice carries only what is timely. The canonical default costs less per request than before, because the reading tool is off by default and the statement no longer explains it.
- Guidance the model cannot act on must not be written. The model cannot shrink committed history and cannot trigger compaction, so guidance may only concern what it loads next and what it tells the human.
- The plugin is now prescriptive. A figure still says whether it is usable — unknown, stale, or a number for this route — but the model-facing text no longer spells out where each figure came from, and composition and compaction leave the reading tool's contract entirely.
