import type { ModalAnswerOption } from "./modal-descriptor.js";

/**
 * Answers for the provider startup dialogs whose rows vary, read off the fingerprinted evidence
 * rather than assumed, so a variant the key table was not checked against answers nothing.
 *
 * Renderers position words rather than print the spaces between them, and stripping keeps neither,
 * so every gap below is optional. Labels are the providers' own words, written out here rather than
 * echoed from evidence that has lost its spaces.
 */

/**
 * Claude 2.1.261 onward. Both modes put "Yes, I trust this folder" second; the first row is
 * "No, exit", or "No, continue without these permissions" at the gated-grants backstop.
 */
export function claudeTrustAnswers(evidence: string): readonly ModalAnswerOption[] {
  // Accessible mode draws "y." and "n." rows and reads only y or n.
  if (/Enter\s*y\/n:/iu.test(evidence)) return [];
  const trustAt = evidence.search(/Yes,\s*I\s*trust\s*this\s*folder/iu);
  const exitAt = evidence.search(/No,\s*exit/iu);
  const withoutAt = evidence.search(/No,\s*continue\s*without\s*these\s*permissions/iu);
  const cancelAt = exitAt >= 0 ? exitAt : withoutAt;
  // The key table encodes cancel-first rows; any other order answers nothing.
  if (trustAt < 0 || cancelAt < 0 || cancelAt > trustAt) return [];
  if (withoutAt >= 0) {
    // The backstop's confirm enables everything the folder's config pre-approves, which is a
    // permission approval by keystroke. Only declining those grants is offered.
    return [{ id: "continue-without-permissions", label: "No, continue without these permissions" }];
  }
  const exit = { id: "exit", label: "No, exit" };
  // Trusting a folder whose config pre-approves tools, adds directories, or mints headers accepts
  // all of it without asking; that stays with the operator.
  const warned = /pre-?approves|adds\s*\d+\s*director|headersHelper|These\s*will\s*apply\s*without\s*asking/iu
    .test(evidence);
  return warned ? [exit] : [{ id: "trust", label: "Yes, I trust this folder" }, exit];
}

/** A question alone is not a plan gate: its verified numbered choices establish the key map. */
export function claudePlanAnswers(evidence: string): readonly ModalAnswerOption[] {
  const lines = evidence.split("\n").map((line) => line.trim().replace(/^[❯›>]\s*/u, ""));
  const rows = [
    /^1\.\s*Yes,\s*and\s*auto-accept\s*edits$/iu,
    /^2\.\s*Yes,\s*and\s*manually\s*approve\s*edits$/iu,
    /^3\.\s*No,\s*keep\s*planning$/iu,
  ];
  const numbered = lines.filter((line) => /^\d+\./u.test(line));
  if (numbered.length !== rows.length || !rows.every((row, index) => row.test(numbered[index]!))) return [];
  return [
    { id: "proceed-auto", label: "Yes, and auto-accept edits" },
    { id: "proceed-manual", label: "Yes, and manually approve edits" },
    { id: "keep-planning", label: "No, keep planning" },
  ];
}

const CODEX_FOLDER_DECLINES: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /^[ \t]*[›❯>]?[ \t]*2\.[ \t]*Quit[ \t]*$/imu, label: "Quit" },
  { pattern: /^[ \t]*[›❯>]?[ \t]*2\.[ \t]*Back[ \t]*to[ \t]*Agent[ \t]*Command[ \t]*Center[ \t]*$/imu, label: "Back to Agent Command Center" },
  { pattern: /^[ \t]*[›❯>]?[ \t]*2\.[ \t]*Keep[ \t]*current[ \t]*directory[ \t]*$/imu, label: "Keep current directory" },
];

/**
 * Codex 0.158 onward. Every variant opens "Folder access", but "Open restricted" and "Open
 * existing task" sit on the first row of the restricted ones and change no saved trust, so the
 * trust key would press something it does not name. Only the variant asking to trust answers.
 */
export function codexFolderAccessAnswers(evidence: string): readonly ModalAnswerOption[] {
  if (/Open\s*(?:restricted|existing\s*task)/iu.test(evidence)) return [];
  if (!/Trust\s*this\s*folder\?/iu.test(evidence)) return [];
  if (!/^[ \t]*[›❯>]?[ \t]*1\.[ \t]*Trust[ \t]*and[ \t]*continue[ \t]*$/imu.test(evidence)) return [];
  const trust = { id: "trust", label: "Trust and continue" };
  const decline = CODEX_FOLDER_DECLINES.find(({ pattern }) => pattern.test(evidence));
  return decline === undefined ? [trust] : [trust, { id: "decline", label: decline.label }];
}

/**
 * Codex 0.153.4 onward. Reviewing and trusting all are the operator's; only the third row, which
 * leaves every new or changed hook switched off, is ever offered.
 */
export function codexHookReviewAnswers(evidence: string): readonly ModalAnswerOption[] {
  // "Trust all" in flight disables every row until it settles.
  if (/Trusting\s*hooks\.{3}/iu.test(evidence)) return [];
  return /^[ \t]*[›❯>]?[ \t]*3\.[ \t]*Continue[ \t]*without[ \t]*trusting/imu.test(evidence)
    ? [{ id: "continue-without-hooks", label: "Continue without trusting (hooks won't run)" }]
    : [];
}
