# The oversized-result trigger defaults to a fixed token threshold, not a share of the window

Status: accepted

The oversized-result trigger is stated in one of two forms and defaults to the absolute one — the **fixed token threshold** — rather than to a fraction of the route's context window (the **result share**). A share has no denominator while capacity is unknown, so the rule could say nothing at all on a route that advertises no context window, and a share rescales with a window the operator does not control: the same configured tenth means 38,400 tokens on this deployment's 384,000-token route and 100,000 on a 1,000,000-token one. The absolute form is route-independent, needs nothing but a price the meter already produces, and lets the reminder state one number instead of one number plus its denominator. The share survives as the alternative form, selected explicitly; it is never substituted silently, and the form that is not in force is refused at load rather than ignored.

## Considered options

- **Share only** (the previous behaviour). Rejected: silent on an unknown capacity, and its threshold moves with the window.
- **Both forms in force at once, whichever is exceeded first.** Rejected: the reminder would have to explain two thresholds, and the stricter of the two silently masks the other's meaning.
- **A fixed count of bytes or characters instead of tokens.** Rejected: it could not be compared with capacity, with a ratio or with a tier, all of which are token figures, so the reminder could no longer say how much of the window one result took.
- **An exact tokenizer.** Unavailable: every text price in DeepSeek Harness is the token meter's fixed four-characters-per-token heuristic and no provider token-count call is made anywhere in the tree, so "exact tokens" was never on the table.
- **At most one notice per step** instead of one per oversized result. Rejected: the notice's value is arriving attached to the result that produced it, and any per-step dedupe is order-dependent — an earlier small result would silence a later larger one. The threshold itself is the volume lever.

## Consequences

- The default deliberately speaks **before** the harness's own hard limit on tool output: `dsh-spill-policy` replaces a result above its default 50,000 inline bytes, and this plugin's default threshold prices at about 32,000 bytes, so the plugin is the soft signal and the harness is the hard one. Many reported results are therefore ones the model still receives whole.
- The price is an estimate, not a count: it underprices CJK text and JSON schemas. An operator choosing a number is choosing a heuristic budget, and the reminder says so.
- A configuration that set `share` and relied on the old default now fails at plugin load instead of silently keeping a window fraction its operator never re-chose.
- The fixed form can report a result while capacity is unknown, so the reminder body has a shape that omits the share-of-window clause. That shape is the reason this form exists.
