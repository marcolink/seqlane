import { z } from "zod";

const loopbackHostnameSchema = z.custom<string>((hostname) => {
  if (typeof hostname !== "string") return false;
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipv4Parts = normalized.split(".");
  return (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part)) &&
    ipv4Parts.every((part) => Number(part) <= 255) &&
    Number(ipv4Parts[0]) === 127
  );
});

export const privateClassifierConnectionSchema = z
  .strictObject({
    url: z.string().url(),
    model: z.string().trim().min(1),
    apiKey: z.string().optional(),
  })
  .superRefine((connection, context) => {
    const url = new URL(connection.url);
    const loopback = loopbackHostnameSchema.safeParse(url.hostname).success;
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    ) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message:
          "Classifier URL must be HTTPS or an HTTP loopback endpoint without credentials, query, or fragment",
      });
    }
    if (
      !loopback &&
      (connection.apiKey === undefined || connection.apiKey.trim() === "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "A classifier API key is required for non-loopback endpoints",
      });
    }
  })
  .transform(({ url, model, apiKey }) => ({
    url: new URL(url),
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
  }));

export type PrivateClassifierConnection = Readonly<
  z.input<typeof privateClassifierConnectionSchema>
>;

export type ValidatedClassifierConnection = Readonly<
  z.output<typeof privateClassifierConnectionSchema>
>;
