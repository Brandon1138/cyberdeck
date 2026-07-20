process.stdout.write("READY\r\n");
process.stdin.setEncoding("utf8");

let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const newlineIndex = pending.indexOf("\n");
    if (newlineIndex === -1) break;
    const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
    pending = pending.slice(newlineIndex + 1);
    process.stdout.write(`ECHO:${line}\r\n`);

    if (line === "/work") {
      setTimeout(() => process.stdout.write("WORK:1\r\n"), 50);
      setTimeout(() => process.stdout.write("WORK:2\r\n"), 100);
      setTimeout(() => process.stdout.write("WORK:DONE\r\n"), 150);
    }
    if (line === "/exit") {
      process.exit(0);
    }
  }
});
