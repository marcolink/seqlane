# SDLC documentation instructions

- Read `docs/sdlc/index.md` before creating or restructuring SDLC documents.
- Use `sdlc-author` when creating or substantially revising SDLC documents.
- Use `sdlc-impact` before meaningful implementation or architecture work.
- Use `sdlc-sync` after implementation and before declaring the task complete.
- Start implementation work from the assigned task or active spec.
- Follow upstream links only as far as needed to understand intent and
  architecture constraints.
- Treat active specs as implementation contracts.
- Treat accepted RFCs and ADRs as architecture rationale, not substitutes for
  active specs.
- Never change product requirements in a task document.
- Update affected specs when an implementation contract intentionally changes.
- Preserve the stable metadata ID when renaming or moving a document.
- Use `YYYY-MM-DD-<lowercase-kebab-title>.md` for every canonical SDLC
  document. Use the document's `created` date in the filename.
- Do not put numeric document IDs in filenames or headings. The date and title
  slug provide ordering and readability, not document identity.
- Keep document identity in frontmatter with a stable, non-numeric ID, such as
  `spec.semantic-validation-gates` or `task.integration-and-documentation`.
- Store document relationships in frontmatter metadata. Use stable metadata IDs
  in `upstream` and `supersedes`; never infer relationships from filenames,
  titles, or numeric sequences.
- Add Markdown links to the related canonical documents in `Traceability`.
- Keep the filename date unchanged when `updated` changes. Update links and
  metadata references in the same change when a path changes.
- Edit the canonical document instead of creating summaries or agent-specific
  copies.
- Keep essential content valid and understandable as raw Markdown.
- Add new documents to their type index, run `pnpm docs:index`, and run
  `pnpm docs:validate`.
