import { z } from "zod";

/** Explicit sources only. Subscription credentials never fall back to API billing. */
export const ContainerAuthenticationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api-key"), file: z.string().startsWith("/") }).strict(),
  z.object({ kind: z.literal("claude-subscription"), tokenFile: z.string().startsWith("/").optional(),
    keychainService: z.string().min(1).optional(),
  }).strict().refine((value) => Number(Boolean(value.tokenFile)) + Number(Boolean(value.keychainService)) === 1,
    "select exactly one Claude subscription source"),
  z.object({ kind: z.literal("codex-subscription"), authFile: z.string().startsWith("/") }).strict(),
]);
export type ContainerAuthentication = z.infer<typeof ContainerAuthenticationSchema>;

export function authenticationMatchesProvider(provider: string, auth: ContainerAuthentication): boolean {
  return auth.kind === "api-key" || auth.kind === `${provider}-subscription`;
}
