import type { DesktopOpenOptions, DesktopOpenResult } from "./desktop-open.mjs";

export function interactiveInvocation(argv: readonly string[]): boolean;
export function dedicatedRemoteControlInvocation(argv: readonly string[]): boolean;
export function resolveNativeCodex(options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string }): string;
export function openPairingQr(path: string, options?: DesktopOpenOptions): DesktopOpenResult;
export function createPairingQr(pairing: { pairingCode: string; expiresAt: number }, directory: string): Promise<{ path: string; expiresAt: string }>;
