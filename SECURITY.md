# Security Policy

## Reporting a vulnerability

Report security issues through GitHub's private vulnerability reporting on
`cruxci/crux` ("Security" → "Report a vulnerability"). Do not open a public
issue for a security problem.

**Response time:** an acknowledgement within 3 working days, and an assessment
with a remediation plan or a reasoned rejection within 14 days.

## Scope

crux parses test results produced by CI, which runs code from pull requests.
**Every byte of input is treated as attacker-controlled.** The following are in
scope and are treated as vulnerabilities, not bugs:

- Any parser input that causes unbounded memory or CPU use rather than a bounded
  error — XML entity expansion, deeply nested structures, unbounded fields.
- Any path by which input reaches the filesystem or a shell. No value parsed
  from test results is ever used as a path or passed to a shell.
- Any external entity resolution. `DOCTYPE` is rejected outright in JUnit XML.
- Terminal escape injection through a test name, message or stack frame.
- Any case where crux transmits data off the machine in `local` mode.

## Out of scope

- Vulnerabilities in a repository whose test results crux is analysing.
- Denial of service that requires privileged access to the machine running crux.

## Supported versions

crux is pre-1.0. Only the latest release receives security fixes.
