---

name: semindex
description: How to read semindex results, the similarity leads that appear after an edit ("semindex: functions just written resemble existing ones") and the output of `semindex query`, `similar` and `pairs`. Use when such a message appears, or before writing a helper that may already exist in another folder.
---

# Reading semindex scores

semindex compares code by meaning. After each Edit or Write, a hook compares the functions just written with
the rest of the repository and lists the closest existing ones with a score:

```
semindex: functions just written resemble existing ones. A score is a lead, not a verdict: ...
groupParticipantsByClass (src/lib/registration.ts:120) resembles:
  0.83  src/lambda/lib/registration.ts:45  groupRegistrationsByClass  (other folder)
```

## What a score means

- The score is the cosine similarity of two functions' embeddings (CodeRankEmbed). It says the two read alike,
  not that they do the same job.
- `exact copy` means the same code up to names and literals (identical AST hash).
- A match is listed from 0.80 in the same folder and from 0.75 in another folder. Copies in another folder are
  the ones you cannot see from the file you edit, so they get the softer bar.
- When the repository is in a group, matches can come from the other repositories of the group. They are
  labelled `(other repo)`, with the repository's name before the path (`other-repo/src/geometry.ts:55`), and
  get the other-folder bar. Such a match is the other repository's main checkout, not a file you can import:
  reuse means a shared package or a deliberate copy, so say which.
- Rough guide, from nine replayed tasks: the copies agents merged scored 0.81 to 0.91; matches that did a
  different job scored 0.60 to 0.68. Between 0.75 and 0.81 there is too little data to say.

## What to do with a lead

1. Open the listed function and read it. Compare what it does with what you wrote, not how it looks.
2. Same job: reuse it, or generalize one of the two and call it from both places. Do not keep both.
3. Different job (different inputs, different meaning of the result, a wrapper around yours): keep yours. The
   hook already leaves out functions that call each other.
4. Say in your summary which leads you checked and what you decided, in one line each.

## What no match means

No match is not proof that no duplicate exists. The index finds leads; it does not rule copies out. A copy
shaped differently from yours can score below the bar (one known copy scored 0.67). When you write a helper,
still look for one where it would naturally live (the shared library folders) before writing it.

## Commands

- `semindex query "what the function does"`: hybrid keyword and embedding search. Descriptions match code more
  weakly than code matches code, so try `similar` on the code you wrote as well.
- `semindex similar path/to/file.ts:42`: nearest functions to the function at that line, with scores.
- `semindex pairs`: likely copies over the whole repository, cross-folder first.
- `semindex query --deps "what the dependency function does"`: the same search over the dependency versions
  the lockfile pins, each hit labelled `package@version` with its declaration. Use it before calling a
  dependency's API you are not sure of: it answers for the installed version, not the latest docs.
  `--package NAME` limits it to one dependency.
- `semindex upgrade origin/main`: after a dependency bump, the bumped packages' API diffs and the functions
  that use them in three tiers (named in the changelog, uses a changed or removed declaration, uses the
  package). It is a review order, not a list of breaks; run `tsc` for those.
