mod index;
mod instruction;
mod receipts;
mod validation;

use index::{Index, Query};
use std::{
    env,
    io::{self, BufRead, Write},
    path::PathBuf,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn serve() -> Result<()> {
    let path = PathBuf::from(env::args_os().nth(1).ok_or("Missing journal path")?);
    let mut index = Index::default();
    let mut out = io::BufWriter::new(io::stdout().lock());
    for request in io::stdin().lock().lines() {
        let query: Query = serde_json::from_str(&request?)?;
        // Any error terminates this instance. No partially updated index or
        // incomplete reply can be reused by the next request.
        index.refresh(&path)?;
        index.query(query, |record| {
            serde_json::to_writer(&mut out, record)?;
            out.write_all(b"\n")?;
            Ok(())
        })?;
        out.write_all(b"null\n")?;
        out.flush()?;
    }
    Ok(())
}
fn main() {
    if serve().is_err() {
        std::process::exit(1);
    }
}
