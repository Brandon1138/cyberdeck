/**
 * The one place the nvim RPC socket convention is written down on the TypeScript side.
 *
 * Cyberdeck never learns an nvim address by being told one: it derives the address from the tmux
 * pane nvim occupies, and the operator's nvim derives the same address from `$TMUX_PANE` when it
 * calls `serverstart`. `contrib/nvim/lua/cyberdeck/init.lua` mirrors this file exactly, and the two
 * must move together — a mismatch strands every open request on a socket nobody is listening to.
 */

/**
 * The uid is in the directory name rather than the socket name so the directory itself can be
 * private: two operators on one host never share a parent directory, and neither can plant a socket
 * the other would connect to.
 */
export const NVIM_SOCKET_DIRECTORY_PREFIX = "/tmp/cyberdeck-nvim-";

export function nvimSocketDirectory(uid: number = currentUid()): string {
  return `${NVIM_SOCKET_DIRECTORY_PREFIX}${uid}`;
}

/**
 * A tmux pane id is `%<index>`. The `%` is dropped from the file name because it is noise in a
 * path, not because anything else is accepted: an id that does not match is a programming error
 * upstream, not something to normalize away.
 */
export function nvimServerAddress(paneId: string, uid: number = currentUid()): string {
  const index = /^%(\d+)$/u.exec(paneId.trim())?.[1];
  if (index === undefined) {
    throw Object.assign(new Error(`Not a tmux pane id: ${paneId}`), { code: "INVALID_PANE_ID" });
  }
  return `${nvimSocketDirectory(uid)}/pane-${index}.sock`;
}

function currentUid(): number {
  return process.getuid?.() ?? 0;
}
