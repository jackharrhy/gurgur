# 0017: Loopback in-process development MCP

Status: accepted, 2026-07-25.

## Decision

The development server starts an MCP Streamable HTTP control plane in the same
Bun process as the host simulation. It uses the official stable
TypeScript SDK's Web Standard transport on a second listener bound strictly to
`127.0.0.1`. The production entrypoint cannot enable it.

Read tools inspect live host ticks, player and prop state, compiled prop
archetypes, and Box3D raycasts. Mutation tools create bounded ephemeral actors.
Props clone compiled physics-prop capabilities and publish ordinary runtime
lifecycle records. MCP players feed the existing newest-wins intent path at the
fixed server tick, with bounded auto-stopping movement; they do not introduce a
transform-authority or independent stepping path. All MCP-created state is
excluded from persistence and discarded on reset.

## Alternatives

Putting mutation tools on the public game HTTP listener was rejected because a
development toggle or UI affordance is not a security boundary and the MCP
transport specification explicitly calls for localhost binding for local
servers. A separate stdio sidecar was rejected because it could only observe a
copied or newly invented state interface rather than the live Box3D owner.
Driving a browser client through synthetic network packets was rejected because
it would entangle diagnostic control with gameplay transport timing.

## Evidence

The implementation uses `@modelcontextprotocol/sdk@1.29.0`, `McpServer`, and
`WebStandardStreamableHTTPServerTransport`. A real-server integration connects
the official `StreamableHTTPClientTransport`, discovers the tool surface, reads
live state, drives a player through the production fixed-tick controller,
exercises automatic stop, and creates/removes a host-owned compiled prop
clone. The listener additionally rejects browser-originated requests and remains
absent unless explicitly enabled by the development entrypoint or a test.
