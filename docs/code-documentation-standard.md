# Explanatory code documentation standard

Code documentation preserves decisions that cannot be recovered reliably from names, types, and control flow alone. Its job is to explain why the implementation has its current shape and what a future change must continue to preserve.

## What deserves explanation

Document a code hotspot when a maintainer needs context about one or more of these dimensions:

- **Invariants:** truths that must hold across calls, phases, data structures, or concurrent work.
- **Algorithms:** the strategy, complexity, sentinel values, ordering rules, and rejected simpler alternatives.
- **Platform boundaries:** which browser, runtime, filesystem, network, or framework behavior is delegated to the platform and which gap remains local.
- **Performance tradeoffs:** measured costs, hot-path constraints, allocation or I/O choices, and the evidence that justified them.
- **Security boundaries:** authority, trust, sanitization, validation, and what the code deliberately does not guarantee.
- **Lifecycle:** ownership, cleanup, cancellation, reconnection, retry, and partial-failure behavior.
- **Rationale:** non-obvious compatibility constraints, historical traps, and why a tempting alternative is wrong here.

Put a short explanation beside the relevant code when it prevents a local misread. Put the durable design narrative in a checked-in document when it spans symbols, files, delivery modes, or tests. Use an `@docs <hotspot-id>` marker on the documented declaration so the source, narrative, and evidence stay connected through refactors.

## What does not help

Do not require JSDoc on every declaration. Do not paraphrase the identifier, narrate obvious syntax, repeat types, or add length merely to satisfy a metric. Delete stale comments and comments that claim behavior the implementation or tests no longer provide.

Public API documentation is a consumer contract: explain observable behavior, side effects, errors, lifecycle, and compatibility where applicable. Internal documentation is a maintainer contract: explain the hidden constraint or decision. Neither contract is improved by blanket coverage percentages or minimum word counts.

## Deterministic enforcement boundary

Automation cannot judge whether prose is insightful. Semantic quality remains a human review judgment. Foundation therefore enforces only facts it can prove without rewarding boilerplate:

1. every declared hotspot still names an existing source file and symbol;
2. its source retains the matching `@docs` marker;
3. its design-document path and Markdown heading anchor still exist;
4. the design section contains headings for every declared documentation dimension plus verification;
5. every named evidence test still exists.

Repositories declare hotspots in `threadlabs.config.json` under `documentation.hotspots`. Add a hotspot after writing and reviewing its explanation, not before. The check is a ratchet against deletion and drift; it is not a substitute for review and must not be expanded into vocabulary scoring, comment density, or mandatory JSDoc for simple code.

Run `threadlabs audit . --json` as the deterministic gate after adopting hotspot entries. CI may make that audit a separate required check. Do not call it from a package script that `threadlabs verify` invokes, because nesting Foundation verification inside itself creates recursion rather than additional evidence.

## Review questions

- Could a maintainer explain the invariant and the failure caused by violating it?
- Does the narrative distinguish platform behavior from library policy?
- Are performance claims tied to a workload or measurement rather than adjectives?
- Does lifecycle documentation cover cleanup and partial failure, not only startup?
- Do links and tests prove the current claim, and are historical details clearly labeled?
