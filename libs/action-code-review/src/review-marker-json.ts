import { z } from "zod";

/** JSON syntax and decoded property names must be unambiguous before routing. */
export const reviewMarkerJsonSchema = z
  .string()
  .max(65_536)
  .transform((text) => {
    const value: unknown = JSON.parse(text);
    const objects: Set<string>[] = [];
    // Consume every string, including values, so braces and colons inside them
    // cannot affect object scope. JSON.parse above already checked the grammar.
    const tokens = /("(?:[^"\\]|\\.)*")\s*:|"(?:[^"\\]|\\.)*"|[{}]/g;
    for (const token of text.matchAll(tokens)) {
      if (token[0] === "{") objects.push(new Set());
      else if (token[0] === "}") objects.pop();
      else if (token[1] !== undefined) {
        const key = z.string().parse(JSON.parse(token[1]));
        const keys = objects.at(-1);
        if (keys === undefined || keys.has(key))
          throw new Error("Metadata JSON contains duplicate property names");
        keys.add(key);
      }
    }
    return value;
  })
  .pipe(z.json());
