import { CLIPBOARD_TIMEOUT_MS, MAX_CLIPBOARD_IMAGE_BYTES } from "./clipboard-process.js";

/**
 * Fixed STA bridge: no clipboard text, destination path or user input enters PowerShell code.
 * A native timer also ends a wedged Windows clipboard call if WSL kills only its Linux relay.
 * Exit 3 means no image, 4 exceeds the byte cap, 5 means the Windows deadline elapsed.
 */
const WINDOWS_CLIPBOARD_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Threading;
using System.Windows.Forms;
public static class CyberdeckClipboardBridge {
  private sealed class ImageLimitException : Exception {}
  private sealed class LimitedStream : MemoryStream {
    public override void SetLength(long value) {
      if (value > ${MAX_CLIPBOARD_IMAGE_BYTES}) throw new ImageLimitException();
      base.SetLength(value);
    }
    public override void Write(byte[] buffer, int offset, int count) {
      if (Position + count > ${MAX_CLIPBOARD_IMAGE_BYTES}) throw new ImageLimitException();
      base.Write(buffer, offset, count);
    }
    public override void WriteByte(byte value) {
      if (Position >= ${MAX_CLIPBOARD_IMAGE_BYTES}) throw new ImageLimitException();
      base.WriteByte(value);
    }
  }
  public static int Capture() {
    using (var deadline = new System.Threading.Timer(_ => Environment.Exit(5), null, ${CLIPBOARD_TIMEOUT_MS - 1_000}, Timeout.Infinite)) {
      try {
        if (!Clipboard.ContainsImage()) return 3;
        using (Image image = Clipboard.GetImage()) {
          if (image == null) return 3;
          using (var png = new LimitedStream()) {
            image.Save(png, ImageFormat.Png);
            if (png.Length > ${MAX_CLIPBOARD_IMAGE_BYTES}) return 4;
            png.Position = 0;
            using (Stream output = Console.OpenStandardOutput()) png.CopyTo(output);
          }
        }
        return 0;
      } catch (ImageLimitException) { return 4; }
      catch { return 2; }
    }
  }
}
'@
  exit [CyberdeckClipboardBridge]::Capture()
} catch { exit 2 }
`;

export const WINDOWS_CLIPBOARD_ARGS: readonly string[] = [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
  Buffer.from(WINDOWS_CLIPBOARD_SCRIPT, "utf16le").toString("base64"),
];
