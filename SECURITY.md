# Security

Darkroom handles people's unreleased recordings and transcripts, so privacy and security reports are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/chaotictoejam/darkroom/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a week.

## Scope

In scope: anything in this repository, including the backend API, the Electron shell, the optional CDK stacks, and any path where media or transcript text could leave the machine without the user choosing it.

Out of scope: issues in FFmpeg, faster-whisper, AWS or Anthropic themselves.
