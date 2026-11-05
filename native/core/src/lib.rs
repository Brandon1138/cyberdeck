#![forbid(unsafe_code)]
#![deny(unused_must_use)]

pub mod instruction;
mod validation;
use instruction::{Instruction, js_trim};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub const MAX_RECORD_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub struct ReplayError {
    pub kind: &'static str,
    pub line: usize,
}
impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at line {}", self.kind, self.line)
    }
}
impl std::error::Error for ReplayError {}

/// Only a fully validated replay can be emitted. The constructor is private and
/// every complete historical record is checked, including superseded snapshots.
///
/// ```compile_fail
/// use cyberdeck_core::ValidatedProjection;
/// let unvalidated = ValidatedProjection(Vec::new());
/// ```
/// ```compile_fail
/// let ready = cyberdeck_core::replay(std::io::Cursor::new(b"\n")).unwrap();
/// ready.write(Vec::new()).unwrap();
/// ready.write(Vec::new()).unwrap(); // publication consumes the projection
/// ```
pub struct ValidatedProjection(Vec<Instruction>);
impl ValidatedProjection {
    pub fn write(self, mut output: impl Write) -> Result<()> {
        writeln!(output, "{{\"protocol\":1,\"schema\":\"instruction-v1\"}}")?;
        let count = self.0.len();
        for record in self.0 {
            serde_json::to_writer(&mut output, &record)?;
            writeln!(output)?;
        }
        writeln!(output, "{{\"end\":true,\"records\":{count}}}")?;
        output.flush()?;
        Ok(())
    }
}

/// No filesystem access, process spawning, mutation or authority grant exists in
/// this core slice. The host owns the opened input and validates its identity.
pub fn replay(mut input: impl BufRead) -> Result<ValidatedProjection> {
    let mut records = Vec::new();
    let mut positions = HashMap::<String, usize>::new();
    let mut bytes = Vec::new();
    let mut line = 0;
    loop {
        line += 1;
        bytes.clear();
        let read = input
            .by_ref()
            .take((MAX_RECORD_BYTES + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|_| ReplayError {
                kind: "INPUT_IO",
                line,
            })?;
        if read == 0 {
            break;
        }
        if read > MAX_RECORD_BYTES {
            return Err(ReplayError {
                kind: "RECORD_LIMIT",
                line,
            }
            .into());
        }
        if bytes.last() != Some(&b'\n') {
            break;
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| ReplayError {
            kind: "INVALID_UTF8",
            line,
        })?;
        if js_trim(text).is_empty() {
            continue;
        }
        // Match JSON.parse's last-key-wins behavior, including duplicate keys.
        let raw: serde_json::Value = serde_json::from_str(text).map_err(|_| ReplayError {
            kind: "INVALID_JSON",
            line,
        })?;
        let mut record: Instruction = serde_json::from_value(raw).map_err(|_| ReplayError {
            kind: "INVALID_RECORD",
            line,
        })?;
        record.validate().map_err(|_| ReplayError {
            kind: "INVALID_RECORD",
            line,
        })?;
        if let Some(&index) = positions.get(&record.id) {
            records[index] = record;
        } else {
            positions.insert(record.id.clone(), records.len());
            records.push(record);
        }
    }
    Ok(ValidatedProjection(records))
}
