import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { userInputAnswersForRequestSchema } from "@seqlane/protocol";
import type { UserInputView } from "../renderer-contract.js";
import { encodeTerminalField } from "../terminal-field.js";

function savedAnswer(answers: Record<string, string>, id: string): string {
  return Object.hasOwn(answers, id) ? (answers[id] ?? "") : "";
}

/** Mounted only while a request is pending; passive runs never read keys. */
export function UserInputForm({
  input,
  redactions,
}: {
  readonly input: UserInputView;
  readonly redactions?: readonly string[];
}): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const submitted = useRef(false);
  if (!input.submitting) submitted.current = false;
  const question = input.questions[index];
  const safe = (text: string) => encodeTerminalField(text, redactions);

  useInput((text, key) => {
    if (key.escape || (key.ctrl && (text === "c" || text === "d"))) {
      input.onCancel();
      return;
    }
    if (question === undefined || input.submitting || submitted.current) return;
    if (key.tab && key.shift && index > 0) {
      setValue(savedAnswer(answers, input.questions[index - 1]?.id ?? ""));
      setIndex(index - 1);
      setError(undefined);
    } else if (key.return) {
      const optionNumber = /^\d+$/.test(value) ? Number(value) : undefined;
      const option =
        optionNumber === undefined
          ? question.options?.find((candidate) => candidate.value === value)
          : question.options?.[optionNumber - 1];
      const answer = option?.value ?? value;
      const parsed = userInputAnswersForRequestSchema({
        questions: [question],
      }).safeParse({ [question.id]: answer });
      if (!parsed.success) {
        setError("Enter a valid answer (1–8192 characters).");
        return;
      }
      const next = { ...answers, [question.id]: answer };
      setAnswers(next);
      setError(undefined);
      if (index + 1 === input.questions.length) {
        submitted.current = true;
        input.onSubmit(next);
      } else {
        setIndex(index + 1);
        setValue(savedAnswer(next, input.questions[index + 1]?.id ?? ""));
      }
    } else if (key.backspace || key.delete) {
      setValue((previous) => [...previous].slice(0, -1).join(""));
    } else if (
      !key.ctrl &&
      !key.meta &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.tab
    ) {
      // Keep pasted text exact. Rendering escapes controls without changing answers.
      setValue((previous) => (previous + text).slice(0, 8193));
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        Waiting for input · {input.pendingCount} pending ·{" "}
        {safe(input.invocationId)}
      </Text>
      <Text>
        {index + 1}/{input.questions.length}: {safe(question?.prompt ?? "")}
      </Text>
      {question?.options?.map((option, optionIndex) => (
        <Text key={option.value}>
          {" "}
          {optionIndex + 1}) {safe(option.label)}
        </Text>
      ))}
      <Text>
        {question?.options === undefined ? "Text" : "Option number or value"}
        {question?.options !== undefined && question.allowFreeText
          ? ", or text"
          : ""}
        : {safe(value)}▌
      </Text>
      <Text>
        {input.submitting
          ? "Sending answer…"
          : "Enter to continue · Shift+Tab to go back · Esc to cancel run"}
      </Text>
      {error === undefined && input.error === undefined ? null : (
        <Text>{safe(error ?? input.error ?? "")}</Text>
      )}
    </Box>
  );
}
