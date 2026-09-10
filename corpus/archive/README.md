# Archived labels

Nothing in this directory is read by any crux command. `corpus status`,
`agreement`, `separability` and `baseline` all scan `corpus/labels/<labeler>/`
only, so moving a labeller here takes it out of every code path.

## machine-labels-2026-09

125 labels over the 7-run spike sample, produced by a model (`machine:claude`)
and kept for one reason: they carry the pipeline probe reported in
`docs/evidence.md` — pairwise precision 0.981 against recall 0.677, and the
finding that exact loose-fingerprint matching almost never merges two causes
wrongly and pays its entire cost in recall.

They were moved out of `corpus/labels/` before human labelling began. The
tooling already excluded them from every Gate 0 count and refused to score them
for agreement or separability, and the labelling tool never displays another
labeller's answers — so this move is belt and braces rather than a fix. It
removes the last way a human labeller could be anchored by a model's opinion:
reading the files.

To score against them again, move the directory back to
`corpus/labels/machine_claude/`. The `machine:` prefix in the stored labeller
name is what the guards key on, and it travels with the files.

Note these labels were made against the *old* sample (digest `27af42dbbb72`,
7 runs / 125 failures). The current selection is `corpus/spike-selection.json`
(digest `7eb102a6886d`, 9 runs / 156 failures), so they are not directly
comparable to labels made now.
