# Testing

`bun run check` currently runs formatting, lint, TypeScript, and the remaining
unit, simulation, persistence, content, and focused integration tests.

The former multiplayer matrix, link shaper, prediction/interpolation tests,
delivery scheduler tests, network trace tests, and networking-dependent browser
smokes were removed with the failed networking design. `bun run test:network`
and `bun run test:browser` are explicit stubs so they cannot be mistaken for
evidence.

Any replacement networking design must arrive with focused wire, transport,
latency, loss, recovery, reconnect, epoch-reset, and real-browser coverage before
either stub is restored. No network quality profiles or latency budgets are
currently selected.
