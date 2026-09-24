# Kickoff prompt for Claude Code

Start Claude Code in the fork root with Chrome connected (`claude --chrome`), switch to plan mode, then paste:

> Read CLAUDE.md and every file it imports. Then inspect the repo enough to confirm the integration notes are still accurate at the current commit, and tell me anything that has drifted. Produce a plan for Phase 0 and Phase 1 only, as a checklist of small commits, each with how you will verify it. Do not change any files until I approve the plan.

After approval, for each phase:

> Carry out Phase N of BUILD_PLAN.md. Commit after each task. Run the gates listed in CLAUDE.md, open the app in Chrome, take screenshots at 1440 and 390 px in both themes, and report what passed, what failed and what you could not verify.

For data work:

> Run the pipeline tests, then Phase 3 for GEIPAN only. Stop after `--inspect` and show me the real CSV header before mapping anything.
