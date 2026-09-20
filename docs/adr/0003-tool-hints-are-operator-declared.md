# Tool hints are declared by the deployment, not hard-coded

Status: accepted

The **tool hint** on an oversized-result reminder is operator configuration, keyed by the exact name of the tool that produced the result, rather than a table the plugin ships. A shipped table beside a generic fallback was the initial design and was rejected: the plugin cannot know which tools a deployment's model actually over-fetches with, a fallback sentence is either too vague to change behaviour or wrong for the tool it lands on, and a deployment whose oversized results come from a tool this plugin has never heard of — an MCP server, a subagent, a project-specific reader — is exactly the deployment that most needs a hint.

## Considered options

- **A shipped table keyed by tool name, with a generic fallback.** Rejected: the fallback would be doing the work in almost every case, and a sentence generic enough to be true of every tool is too weak to be worth its tokens.
- **No hints at all; the reading only.** Rejected: it is the behaviour this change exists to replace.

## Consequences

- The plugin cannot validate the keys. Tool registration follows plugin load and a deployment may add tools at runtime, so an unmatched tool name is not an error: that reminder carries its reading and no hint.
- The hint map becomes part of the deployment's configuration surface, so withdrawing it later is a breaking change. The plugin owns the frame, the trigger and the sizes; it never owns the words.
