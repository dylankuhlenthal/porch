# Documentation standards

How we structure, write, and maintain technical documentation. These standards apply identically to every repo; this file is the repo's canonical copy of them. The `maintain-docs` skill is the procedure for applying them (filing, updating alongside changes, migrating an unmigrated repo) and defers to this file.

## The core rule: file by lifetime, not by topic

Documentation goes out of date because content with different lifetimes gets stored together. Before writing or filing anything, ask one question: **when does this stop being true?**

| Lifetime | Content | Home |
| --- | --- | --- |
| **Ephemeral** (dies when the change ships) | Plans, specs, proposals, migration write-ups, status summaries, "refactoring complete" notes | **Outside the repo** (the project tracker), never committed |
| **Durable** (true until the system itself changes) | Architecture, flows, data model, patterns, runbooks, decisions | **`docs/`** |
| **Instructional** (how to operate inside this repo) | Commands, gates, conventions an agent or new dev must follow | **`CLAUDE.md`** |

This rule is self-enforcing: a file with a date in its name is ephemeral by definition and does not belong in the repo.

### Harvest before you delete

A landed plan or spec usually contains one or two paragraphs describing how the system now works. Lift those into the architecture or domain doc, then delete the plan outright. Git history is the archive; nothing else needs to exist for the deleted work.

**Reuse the topics, and rewrite the text.** Old text is out of date in exactly the ways that matter: file names, props, event names. Treat the old doc as a list of what to cover, then write every claim that is still true fresh from the code it names (rule 6, every doc names the files it describes, is what makes this possible). Copying old paragraphs across carries their errors into a doc that now looks current.

Do not archive. An `archive/` folder is a slower delete that still costs search noise and reader confusion.

## The standard tree

Identical top-level shape in every repo:

```
README.md              # what it is, how to run it, links into docs/. Nothing else.
AGENTS.md              # the operational entrypoint. Links into docs/, never restates them.
CLAUDE.md              # symlink to AGENTS.md, for harness compatibility.
docs/
  architecture.md      # the system overview: boundaries, flows, data model, integrations.
  domains/             # bounded contexts: grading.md, sequences.md, users.md, lti.md
  patterns/            # conventions with a canonical example: pagination.md, sorting.md
  operations/          # runbooks: deploy.md, environments.md, migrations.md, ci.md
  decisions/           # 0001-slug.md, append-only, never edited after merge
  reference/           # mechanical or generated: terminology.md, env-vars.md
```

Small repos collapse this to a single `docs/architecture.md`. The structure can also grow: a section of `architecture.md` that passes roughly 300 to 400 lines, or gains a second audience, becomes its own file or directory, and `architecture.md` keeps the heading with two sentences plus a link. Splitting a file like this is routine maintenance and needs no separate design decision.

## The canonical CLAUDE.md

The canonical file is `AGENTS.md`; `CLAUDE.md` is a symlink to it so every harness loads the same file, and these standards use the two names interchangeably. The same pattern applies to agent tooling directories: the real directory is `.agents/`, with `.claude` as a symlink to it. CLAUDE.md is the operational entrypoint: the one file always in context. `docs/architecture.md` is not a second entrypoint; it is the system overview CLAUDE.md links to, holding the longer descriptive content that has moved out of CLAUDE.md. Canonical section order:

1. **Purpose** — what the project is and its place in the bigger picture (e.g. "the NestJS API backing Traverse Studio"). A paragraph of orientation, not a technical map.
2. **Stack** — the one-line technology list.
3. **Layout & filing** — repo shape, module layout, and a short summary of these filing rules.
4. **Terminology** — domain vocabulary an agent cannot infer from code. Wrong vocabulary leads to mistakes in everything built on it, so it belongs in the always-loaded file.
5. **Development workflow** — with subsections like "run the API" and "verify your work" (local call tools, DB query wrappers, preview commands).
6. **Testing** — the automated suites, how to run them, and the gates they enforce.
7. **Conventions & patterns** — every convention as a short entry; conventions that have moved to a pattern doc keep a read-more link to it (rule 8, conventions start in CLAUDE.md and move to `patterns/`).
8. **Learnings** — hard-won gotchas that fit nowhere else. This is a temporary holding place, and entries should not pile up here: an entry that becomes stable and general moves into a convention or decision record; an entry describing a gap becomes a tracked issue to fix the gap.

Any section can outgrow the file. The mechanism is always the same as rule 8 (conventions move to `patterns/`): keep a short version of the section plus a read-more link, and move the bulk to its `docs/` home. Purpose, Stack, and Layout bulk goes to `architecture.md`; Terminology to `reference/terminology.md`; conventions to `patterns/`; Testing and workflow depth to `patterns/`.

## Writing

Docs are read by people and agents who were not part of the work. Write so they understand on the first read.

- Use plain, everyday words and the project's own names for things (see Terminology). Don't coin new terms or use metaphors to describe how something works; say what actually happens.
- Explain a technical term the first time a doc uses it, unless it is in the project's terminology (the CLAUDE.md Terminology section or `reference/terminology.md`) or a developer working in this repo would already know it.
- Walk through cause and effect in order, in full sentences.
- No slogans or dramatic wording. State facts and reasons calmly.
- Never refer to a decision record, a rule, or a ticket by its number alone. Say what it is, e.g. "decision 0007 (soft-delete users instead of hard-delete)".

## Rules

1. **Nothing dated in the repo.** A date in a filename means the content is ephemeral and does not belong in the repo.
2. **No HTML or PDF. Mermaid as far as possible.** Anything expressible as a diagram is Mermaid inside markdown, so it diffs, reviews in a PR, and can be read by an agent. A raster image is permitted only when a diagram cannot reasonably be reconstructed, and it lives next to the doc that embeds it. A pre-existing HTML/PDF set that is deliberately kept may stay as a **declared legacy exception**: name it in both CLAUDE.md and `architecture.md`, closed to new entrants. An exception nobody declared is just a violation.
3. **`docs/` root holds exactly one file: `architecture.md`.** Everything else must be classified into a subdirectory. This is what stops flat sprawl from returning. `docs/README.md` is not an exception: merge anything useful into `architecture.md` and delete it.
4. **`lowercase-kebab-case.md`,** no exceptions. No `SCREAMING_SNAKE.md`.
5. **One canonical home per topic.** Cross-link, never duplicate. Two files covering the same subject is a bug.
6. **Every doc that describes code names the files it describes.** Then a doc that no longer matches the code can be detected and checked against the source. Anchor claims to files and stable symbols (classes, methods, exported functions), never to line numbers, because symbols usually survive refactors and line numbers change with almost any edit. A line number may accompany a symbol as a courtesy, but must never be the only anchor.
7. **`README.md` only introduces the repo.** What the repo is, how to run it, links into `docs/`.
8. **Conventions start in `CLAUDE.md` and move to `patterns/` when they grow.** Every convention starts as an entry in CLAUDE.md. When an entry grows its own worked examples, edge cases, or a second code block, it has become a doc in its own right: move the bulk to `docs/patterns/<name>.md` and leave behind a short entry: the rule itself, as it would have been written on day one, plus a read-more ("Read `docs/patterns/pagination.md` before implementing"). The rule stays in every session's context; the mechanics live only in the pattern doc, so the two cannot disagree on details. Every pattern doc must remain reachable from its CLAUDE.md entry, because an agent deciding how to do something will not find a pattern that has no entry.
9. **`domains/` describes how things work; only `patterns/` sets out the approved way to do things.** A domain doc says how the subsystem currently works, neutrally: no "this eliminated N lines", nothing that presents the code as an example to copy. That leaves room to rewrite the code without the docs having endorsed the old design. A pattern is, by definition, the endorsed way.
10. **Prefer documentation that cannot go out of date.** For commands, documentation that sits next to the command itself (`//`-comment script descriptions in `package.json`, `--help` output) stays accurate because it lives in the file people edit; a doc restating it will go out of date. `docs/` is for what cannot self-document: flows, architecture, why.
11. **Point at files, never inline them.** A doc must not reproduce the contents of a file that lives in the repo (env templates, config samples, workflow steps). Reference the authoritative file instead (`cp .env.test.sample .env.test`). The copy will go out of date, and out-of-date instructions can be destructive: a stale inlined env template once pointed a test suite's reset script at the dev database.
12. **Generated output needs a regeneration trigger.** A generated artifact belongs in `reference/` only if its regeneration is wired into CI or a required gate. Generated output nothing regenerates and nothing consumes is ephemeral no matter how mechanical it looks: delete it, and the generator with it, or wire the trigger.

## Decision records

`docs/decisions/` is the highest-value directory and the piece most repos lack. Most of what people reach into old plan documents for is *why*, not *what*. A five-line decision record captures that permanently, and it is what makes deleting landed plans safe.

Format: `docs/decisions/NNNN-short-slug.md`, append-only, never edited after merge. Supersede with a new record that links back rather than rewriting history.

```markdown
# 0007: Soft-delete users instead of hard-delete

**Date:** 2026-07-31
**Status:** Accepted

## Context
Grades and submissions reference users. Hard deletion orphaned historical reporting.

## Decision
Users are soft-deleted via `deletedAt`. All queries filter on it by default.

## Consequences
Every new query must respect the default scope. Unique constraints on email
must account for soft-deleted rows.
```

Keep them short, so that writing one is quick enough to actually happen: a brief record that exists is better than a thorough one nobody writes. Write it plainly enough that someone without the context can follow it.

**The decision-record test.** A decision record answers "why is it like this?"; a pattern answers "how do I do this here?". If a record's body would restate a pattern that already has a canonical example, don't write the record; add a sentence of rationale to the pattern doc instead. A record is worth writing only when it captures a choice (alternatives existed, one was picked). A convention simply existing is not enough.

**Retroactive records** (written during a migration, or taken from plans that have shipped) take the date of the commit that put the decision into the code, not the date of writing.

## While shipping a change

- **Definition of done.** If a change alters a documented flow, contract, or pattern, the doc changes in the same PR. Not a follow-up ticket.
- **Freshness is proactive; normative changes need approval.** The agent updates descriptive docs (architecture, domains, operations, reference) as part of any change without being asked. Changes to `patterns/` or conventions — and new decision records for choices that were not explicitly discussed — are normative: propose them for human approval, in conversation or called out in the PR description, never folded silently into a diff.
- **Decision records land with the change.** Five lines, same PR. Cheap enough that it actually happens.
- **Shaping output stays out of the repo.** The shaping decision log is the plan and lives wherever the work is tracked. The repo gets only content that stays true after the build ships: durable docs in `docs/` and instructions in CLAUDE.md, as the lifetime table at the top describes.
- **Review checks docs.** A PR touching a documented subsystem with no doc change is a review comment.
- **CLAUDE.md carries a short summary of these rules** and points here, so every session inherits them without being told.
