# Security policy

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull
request, log, or test fixture.

Use GitHub's private vulnerability reporting flow for this repository:

1. Open the repository's **Security** tab.
2. Select **Advisories** and **Report a vulnerability**.
3. Include the affected commit or release, deployment mode, reproduction steps,
   impact, and a minimal redacted proof of concept.
4. Remove Joomla tokens, OAuth tokens, approval secrets, passwords, private URLs,
   user data, and production content.

If private vulnerability reporting is unavailable, open a public issue that
asks a maintainer for a private reporting channel without including security
details.

Maintainers will acknowledge the report through the private channel, validate
its scope, coordinate a fix and release, and credit the reporter if requested.
Do not test against a Joomla installation you do not own or have explicit
permission to assess.

## Supported code

Until stable versioned releases are published, security fixes target the latest
`main` branch. After versioned releases begin, the repository release notes will
identify supported release lines. Unsupported snapshots should be upgraded
before reporting behavior already corrected on `main`.

## Deployment responsibility

This project is not yet production-certified. Operators are responsible for
keeping privileged toolsets disabled until the relevant live and recovery gates
in [docs/COVERAGE.md](docs/COVERAGE.md) pass in their environment. Follow the
[security model](docs/SECURITY.md), use dedicated least-privilege Joomla actors,
and keep the Node listener and companion process off untrusted networks.
