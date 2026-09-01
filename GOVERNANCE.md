# Governance

## Project status

crux is **fully open source**, not open-core. There is no paid tier holding back
functionality described in the specification, and no plan to introduce one by
removing something that already shipped.

Licence: Apache-2.0. The patent grant is deliberate — crux targets enterprise
adoption, and a licence without one is a blocker in exactly those organisations.

## Decision making

Pre-1.0, decisions are made by the maintainers. The bar for a change is
evidence: a measured number, a reproducible benchmark, or a failing case.

Changes to any of the following require an issue with the argument written out
before the pull request, because they are hard to reverse:

- A gate threshold, or how a gate is evaluated
- The domain model in `packages/core/src/domain.ts`
- Any algorithm version constant, and what triggers a bump
- The no-telemetry commitment
- The set of categories

## The no-telemetry commitment

crux collects no telemetry. Not opt-out, not anonymous, none. This is permanent
and is not subject to the ordinary change process. A pull request adding
telemetry will be closed.

## Releases

Semantic versioning, applied independently per surface: the CLI, the schemas,
the plugin SDK, the fingerprint algorithm and the API each carry their own
version, because they change at different rates.

Every release ships an SBOM and is signed.

## Security

See [SECURITY.md](SECURITY.md).
