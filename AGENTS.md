# Project instructions

- After completing a requested change in this repository, stage the files for that change, commit them, and push the commit directly to `main` without asking for separate permission.
- Do not create a feature branch or pull request unless the user explicitly asks for one.
- Before pushing, run validation appropriate to the changed areas and confirm that no secrets or unrelated generated artifacts are included.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
