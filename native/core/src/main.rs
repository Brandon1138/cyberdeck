#![forbid(unsafe_code)]
#![deny(unused_must_use)]
use std::io::{self, BufReader, BufWriter};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("cyberdeck-core {} protocol=1", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args != ["instruction-replay-v1"] {
        eprintln!("Usage: cyberdeck-core instruction-replay-v1 < journal.jsonl");
        std::process::exit(64);
    }
    let result = cyberdeck_core::replay(BufReader::with_capacity(64 * 1024, io::stdin().lock()))
        .and_then(|projection| projection.write(BufWriter::new(io::stdout().lock())));
    if let Err(error) = result {
        // Never echo journal text, paths, credentials, or provider output in diagnostics.
        let (kind, line) = error
            .downcast_ref::<cyberdeck_core::ReplayError>()
            .map_or(("OUTPUT_IO", 0), |error| (error.kind, error.line));
        eprintln!(
            "{}",
            serde_json::json!({ "error": kind, "line": line, "protocol": 1 })
        );
        std::process::exit(1);
    }
}
